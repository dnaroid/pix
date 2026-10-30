//! Metadata-only, paged inventory for the project-owned Wiki background checker.
//!
//! The caller owns the breadth-first traversal. A cursor retains only one directory
//! iterator, never Markdown bodies or a recursively materialized tree. Commands
//! invoking these functions must run on a blocking worker.
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

const MAX_CURSORS: usize = 32;
const CURSOR_TTL: Duration = Duration::from_secs(120);
const MAX_PATH_BYTES: usize = 4096;
const MAX_PAGE_ENTRIES: usize = 128;
const MAX_PAGE_SCANNED: usize = 512;
const PAGE_SLICE: Duration = Duration::from_millis(25);
// Matches MAX_KNOWLEDGE_DOCUMENT_CHARS; the judge reviews at most 48k per chunk.
const MAX_DOCUMENT_BYTES: u64 = 128_000 * 4 + 384 * 1024 + 4096;

#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum WikiCheckEntryKind {
    Directory,
    File,
}

#[derive(Debug, Serialize)]
pub(super) struct WikiCheckInventoryEntry {
    pub path: String,
    pub kind: WikiCheckEntryKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WikiCheckDirectoryPage {
    pub entries: Vec<WikiCheckInventoryEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize)]
pub(super) struct WikiCheckDocument {
    pub path: String,
    pub content: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum InventoryMode {
    Automatic,
    TreeStatus,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Owner {
    workspace: PathBuf,
    requested_workspace: PathBuf,
    wiki_path: PathBuf,
    directory: PathBuf,
    mode: InventoryMode,
}

struct Cursor {
    owner: Owner,
    directory_identity: String,
    iterator: fs::ReadDir,
    touched: Instant,
}

struct CursorRegistry {
    cursors: HashMap<String, Cursor>,
    in_flight: usize,
    capacity: usize,
}

impl CursorRegistry {
    fn new(capacity: usize) -> Self {
        Self {
            cursors: HashMap::new(),
            in_flight: 0,
            capacity,
        }
    }

    fn expire(&mut self, now: Instant) {
        self.cursors
            .retain(|_, cursor| now.saturating_duration_since(cursor.touched) < CURSOR_TTL);
    }
}

fn registry() -> &'static Mutex<CursorRegistry> {
    static REGISTRY: OnceLock<Mutex<CursorRegistry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(CursorRegistry::new(MAX_CURSORS)))
}

fn registry_error() -> String {
    "Wiki inventory state is unavailable.".to_owned()
}

/// An operation reserves its iterator slot while filesystem I/O runs outside the mutex.
struct Operation<'a> {
    registry: &'a Mutex<CursorRegistry>,
}

impl Drop for Operation<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.registry.lock() {
            state.in_flight = state.in_flight.saturating_sub(1);
        }
    }
}

#[derive(Clone, Copy)]
struct PageLimits {
    entries: usize,
    scanned: usize,
    slice: Duration,
}

/// The opaque cursor is single-use. A consumed page always returns a new token.
pub(super) fn list_directory(
    workspace: &Path,
    wiki_path: &Path,
    path: &Path,
    cursor: Option<&str>,
) -> Result<WikiCheckDirectoryPage, String> {
    list_with_registry(
        workspace,
        wiki_path,
        path,
        cursor,
        registry(),
        PageLimits {
            entries: MAX_PAGE_ENTRIES,
            scanned: MAX_PAGE_SCANNED,
            slice: PAGE_SLICE,
        },
    )
}

/// The status view includes Markdown shown by the Wiki tree, without changing
/// which pages are eligible for automatic model requests.
pub(super) fn list_status_directory(
    workspace: &Path,
    wiki_path: &Path,
    path: &Path,
    cursor: Option<&str>,
) -> Result<WikiCheckDirectoryPage, String> {
    list_with_registry_mode(
        workspace,
        wiki_path,
        path,
        cursor,
        registry(),
        PageLimits {
            entries: MAX_PAGE_ENTRIES,
            scanned: MAX_PAGE_SCANNED,
            slice: PAGE_SLICE,
        },
        InventoryMode::TreeStatus,
    )
}

fn validate_relative(path: &Path) -> Result<(), String> {
    super::validate_workspace_relative_path(path, "Wiki inventory path")?;
    let raw = path
        .to_str()
        .ok_or_else(|| "Wiki inventory paths must be valid UTF-8.".to_owned())?;
    if raw.is_empty()
        || raw.len() > MAX_PATH_BYTES
        || raw.contains('\\')
        || raw.contains(':')
        || raw.chars().any(char::is_control)
    {
        return Err("Invalid Wiki inventory path.".to_owned());
    }
    let mut previous_pi = false;
    for component in path.components() {
        let Component::Normal(name) = component else {
            return Err("Wiki inventory paths must remain inside the project.".to_owned());
        };
        let text = name
            .to_str()
            .ok_or_else(|| "Wiki inventory paths must be valid UTF-8.".to_owned())?;
        if text.eq_ignore_ascii_case(".git")
            || (previous_pi
                && (text.eq_ignore_ascii_case("artifacts")
                    || text.eq_ignore_ascii_case("subagents")))
        {
            return Err(
                "Wiki inventory cannot include Git metadata or disposable storage.".to_owned(),
            );
        }
        previous_pi = text.eq_ignore_ascii_case(".pi");
    }
    Ok(())
}

fn owner(
    workspace: &Path,
    wiki_path: &Path,
    path: &Path,
    mode: InventoryMode,
) -> Result<Owner, String> {
    validate_relative(wiki_path)?;
    validate_relative(path)?;
    if !path.starts_with(wiki_path) {
        return Err("The directory is outside the configured Wiki.".to_owned());
    }
    if mode == InventoryMode::TreeStatus
        && !path.strip_prefix(wiki_path).unwrap().components().all(|component| {
            matches!(component, Component::Normal(name) if name.to_str().is_some_and(|name| eligible_name(name, mode)))
        })
    {
        return Err("Wiki status inventory excludes hidden directories.".to_owned());
    }
    let root = super::canonical_workspace(workspace)?;
    Ok(Owner {
        workspace: root,
        requested_workspace: workspace.to_owned(),
        wiki_path: wiki_path.to_owned(),
        directory: path.to_owned(),
        mode,
    })
}

/// Walk every relative ancestor without following a symlink, then verify the final directory.
fn safe_directory(owner: &Owner) -> Result<(PathBuf, String), String> {
    let mut directory = owner.workspace.clone();
    let root_metadata = fs::symlink_metadata(&directory)
        .map_err(|error| format!("Cannot inspect Wiki workspace: {error}"))?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err("Wiki inventory refuses a replaced workspace directory.".to_owned());
    }
    let mut identities = Sha256::new();
    identities.update(directory_identity(&root_metadata));
    identities.update([0]);
    for component in owner.directory.components() {
        let Component::Normal(name) = component else {
            return Err("Invalid Wiki directory.".to_owned());
        };
        directory.push(name);
        let metadata = fs::symlink_metadata(&directory)
            .map_err(|error| format!("Cannot inspect Wiki directory: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(
                "Wiki inventory refuses symbolic links and non-directory ancestors.".to_owned(),
            );
        }
        identities.update(directory_identity(&metadata));
        identities.update([0]);
    }
    if fs::canonicalize(&directory)
        .map_err(|error| format!("Cannot resolve Wiki directory: {error}"))?
        != directory
    {
        return Err("Wiki directory changed while it was being inspected.".to_owned());
    }
    Ok((directory, format!("{:x}", identities.finalize())))
}

// Ordinary child creation and atomic report replacement change directory times,
// but not its identity. Fence every ancestor's identity while accepting a weakly
// consistent listing; the next metadata pass discovers concurrent entry changes.
fn directory_identity(metadata: &fs::Metadata) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        format!("{}:{}", metadata.dev(), metadata.ino())
    }
    #[cfg(not(unix))]
    {
        // Desktop is macOS-only. Without Unix identity metadata, remain conservative.
        revision(metadata)
    }
}

fn revision(metadata: &fs::Metadata) -> String {
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        format!(
            "{}:{}:{}:{}:{}:{}:{}:{}",
            metadata.len(),
            metadata.mtime(),
            metadata.mtime_nsec(),
            metadata.ctime(),
            metadata.ctime_nsec(),
            metadata.dev(),
            metadata.ino(),
            metadata.mode()
        )
    };
    #[cfg(not(unix))]
    let identity = format!(
        "{}:{:?}:{:?}:{:?}",
        metadata.len(),
        metadata.modified().ok(),
        metadata.created().ok(),
        metadata.permissions()
    );
    format!("{:x}", Sha256::digest(identity.as_bytes()))
}

fn eligible_name(name: &str, mode: InventoryMode) -> bool {
    !name.contains('\\')
        && !name.contains(':')
        && !name.chars().any(char::is_control)
        && match mode {
            InventoryMode::Automatic => {
                !name.starts_with('.') && !matches!(name, "node_modules" | "__pycache__")
            }
            InventoryMode::TreeStatus => !name.starts_with('.'),
        }
}

/// Independently validate a scheduled file: inventory is a hint, never authority to read later.
pub(super) fn read_document(
    workspace: &Path,
    wiki_path: &Path,
    path: &Path,
) -> Result<WikiCheckDocument, String> {
    read_with(workspace, wiki_path, path, |root, relative, limit| {
        super::read_project_file_from(root, relative, limit).map(|document| document.content)
    })
}

/// Status inspection remains read-only and uses the same containment, byte and
/// replacement guards as an automatic check. Dot-prefixed entries are excluded
/// from both the Wiki tree and its recursive status summary.
pub(super) fn read_status_document(
    workspace: &Path,
    wiki_path: &Path,
    path: &Path,
) -> Result<WikiCheckDocument, String> {
    read_with_mode(
        workspace,
        wiki_path,
        path,
        InventoryMode::TreeStatus,
        |root, relative, limit| {
            super::read_project_file_from(root, relative, limit).map(|document| document.content)
        },
    )
}

fn read_with(
    workspace: &Path,
    wiki_path: &Path,
    path: &Path,
    read: impl FnOnce(&Path, &Path, u64) -> Result<String, String>,
) -> Result<WikiCheckDocument, String> {
    read_with_mode(workspace, wiki_path, path, InventoryMode::Automatic, read)
}

fn read_with_mode(
    workspace: &Path,
    wiki_path: &Path,
    path: &Path,
    mode: InventoryMode,
    read: impl FnOnce(&Path, &Path, u64) -> Result<String, String>,
) -> Result<WikiCheckDocument, String> {
    validate_relative(path)?;
    let below_wiki = path
        .strip_prefix(wiki_path)
        .map_err(|_| "The document is outside the configured Wiki.".to_owned())?;
    if below_wiki.as_os_str().is_empty() || !below_wiki.components().all(|component| {
        matches!(component, Component::Normal(name) if name.to_str().is_some_and(|name| eligible_name(name, mode)))
    }) || !path.extension().and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown")) {
        return Err("Wiki inventory reads accept only eligible Markdown documents.".to_owned());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "A Wiki document path is required.".to_owned())?;
    let owner = owner(workspace, wiki_path, parent, mode)?;
    let (_, directory_before) = safe_directory(&owner)?;
    let target = owner.workspace.join(path);
    let inspect_file = || -> Result<fs::Metadata, String> {
        let metadata = fs::symlink_metadata(&target)
            .map_err(|error| format!("Cannot inspect Wiki document: {error}"))?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || fs::canonicalize(&target)
                .map_err(|error| format!("Cannot resolve Wiki document: {error}"))?
                != target
        {
            return Err(
                "Background Wiki checks refuse symbolic links and non-regular files.".to_owned(),
            );
        }
        Ok(metadata)
    };
    let before = inspect_file()?;
    if before.len() > MAX_DOCUMENT_BYTES {
        return Err("Wiki document exceeds the background-check read limit.".to_owned());
    }
    let content = read(&owner.workspace, path, MAX_DOCUMENT_BYTES)?;
    let (_, directory_after) = safe_directory(&owner)?;
    let after = inspect_file()?;
    if directory_before != directory_after
        || revision(&before) != revision(&after)
        || content.len() as u64 != before.len()
        || content.len() as u64 > MAX_DOCUMENT_BYTES
    {
        return Err(
            "Wiki document changed while it was being read; retry its current version.".to_owned(),
        );
    }
    Ok(WikiCheckDocument {
        path: path.to_string_lossy().replace('\\', "/"),
        content,
    })
}

fn list_with_registry(
    workspace: &Path,
    wiki_path: &Path,
    path: &Path,
    token: Option<&str>,
    registry: &Mutex<CursorRegistry>,
    limits: PageLimits,
) -> Result<WikiCheckDirectoryPage, String> {
    list_with_registry_mode(
        workspace,
        wiki_path,
        path,
        token,
        registry,
        limits,
        InventoryMode::Automatic,
    )
}

fn list_with_registry_mode(
    workspace: &Path,
    wiki_path: &Path,
    path: &Path,
    token: Option<&str>,
    registry: &Mutex<CursorRegistry>,
    limits: PageLimits,
    mode: InventoryMode,
) -> Result<WikiCheckDirectoryPage, String> {
    let owner = owner(workspace, wiki_path, path, mode)?;
    let (directory, before) = safe_directory(&owner)?;
    let now = Instant::now();
    let continuation = {
        let mut state = registry.lock().map_err(|_| registry_error())?;
        state.expire(now);
        if let Some(token) = token {
            let saved = state.cursors.get(token).ok_or_else(|| {
                "Wiki inventory cursor expired or was already consumed.".to_owned()
            })?;
            if saved.owner != owner {
                return Err(
                    "Wiki inventory cursor belongs to another project or directory.".to_owned(),
                );
            }
            let saved = state.cursors.remove(token).expect("validated cursor");
            state.in_flight += 1;
            Some(saved)
        } else {
            if state.cursors.len() + state.in_flight >= state.capacity {
                return Err(
                    "Too many Wiki inventory scans are open; release an unused cursor and retry."
                        .to_owned(),
                );
            }
            state.in_flight += 1;
            None
        }
    };
    let _operation = Operation { registry };
    let mut current = match continuation {
        Some(current) if current.directory_identity == before => current,
        Some(_) => {
            return Err(
                "Wiki directory changed during pagination; restart its inventory.".to_owned(),
            )
        }
        None => Cursor {
            owner,
            directory_identity: before.clone(),
            iterator: fs::read_dir(&directory)
                .map_err(|error| format!("Cannot list Wiki directory: {error}"))?,
            touched: now,
        },
    };
    let mut entries = Vec::new();
    let mut scanned = 0;
    let mut finished = false;
    // A page may be empty while still carrying a continuation (for example, images only).
    while scanned < limits.scanned && entries.len() < limits.entries {
        let Some(item) = current.iterator.next() else {
            finished = true;
            break;
        };
        scanned += 1;
        let item = item.map_err(|error| format!("Cannot enumerate Wiki directory: {error}"))?;
        let name = item.file_name();
        if let Some(name) = name.to_str().filter(|name| eligible_name(name, mode)) {
            let relative = current.owner.directory.join(name);
            if relative.as_os_str().len() <= MAX_PATH_BYTES {
                let metadata = match fs::symlink_metadata(directory.join(name)) {
                    Ok(metadata) => Some(metadata),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                    Err(error) => return Err(format!("Cannot inspect Wiki entry: {error}")),
                };
                if let Some(metadata) =
                    metadata.filter(|metadata| !metadata.file_type().is_symlink())
                {
                    let markdown = relative
                        .extension()
                        .and_then(|extension| extension.to_str())
                        .is_some_and(|extension| {
                            extension.eq_ignore_ascii_case("md")
                                || extension.eq_ignore_ascii_case("markdown")
                        });
                    if metadata.is_dir() || (metadata.is_file() && markdown) {
                        entries.push(WikiCheckInventoryEntry {
                            path: relative.to_string_lossy().replace('\\', "/"),
                            kind: if metadata.is_dir() {
                                WikiCheckEntryKind::Directory
                            } else {
                                WikiCheckEntryKind::File
                            },
                            revision: metadata.is_file().then(|| revision(&metadata)),
                            size: metadata.is_file().then_some(metadata.len()),
                        });
                    }
                }
            }
        }
        if now.elapsed() >= limits.slice {
            break;
        }
    }
    let (_, after) = safe_directory(&current.owner)?;
    if before != after {
        return Err(
            "Wiki directory changed while it was being listed; restart its inventory.".to_owned(),
        );
    }
    let next_cursor = if finished {
        None
    } else {
        let token = uuid::Uuid::new_v4().to_string();
        current.touched = Instant::now();
        // Our in-flight reservation still owns this slot until Operation drops.
        registry
            .lock()
            .map_err(|_| registry_error())?
            .cursors
            .insert(token.clone(), current);
        Some(token)
    };
    Ok(WikiCheckDirectoryPage {
        entries,
        next_cursor,
    })
}

/// Release only the caller's cursor. A deleted project can still release its original handle.
pub(super) fn release(workspace: &Path, cursor: &str) -> Result<(), String> {
    release_with_registry(workspace, cursor, registry())
}

fn release_with_registry(
    workspace: &Path,
    token: &str,
    registry: &Mutex<CursorRegistry>,
) -> Result<(), String> {
    let canonical = super::canonical_workspace(workspace).ok();
    let mut state = registry.lock().map_err(|_| registry_error())?;
    state.expire(Instant::now());
    let Some(cursor) = state.cursors.get(token) else {
        return Ok(());
    };
    let owns = match canonical {
        Some(canonical) => canonical == cursor.owner.workspace,
        None => workspace == cursor.owner.requested_workspace,
    };
    if !owns {
        return Err("Wiki inventory cursor belongs to another project.".to_owned());
    }
    state.cursors.remove(token);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("pix-wiki-inventory-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(root.join("wiki")).unwrap();
            Self(root)
        }
        fn file(&self, path: &str, bytes: &[u8]) {
            let target = self.0.join(path);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(target, bytes).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn limits(size: usize) -> PageLimits {
        PageLimits {
            entries: size,
            scanned: size,
            slice: Duration::from_secs(60),
        }
    }
    fn page(
        fixture: &Fixture,
        state: &Mutex<CursorRegistry>,
        cursor: Option<&str>,
        size: usize,
    ) -> WikiCheckDirectoryPage {
        list_with_registry(
            &fixture.0,
            Path::new("wiki"),
            Path::new("wiki"),
            cursor,
            state,
            limits(size),
        )
        .unwrap()
    }
    fn all(
        fixture: &Fixture,
        state: &Mutex<CursorRegistry>,
        size: usize,
    ) -> Vec<WikiCheckInventoryEntry> {
        let mut cursor = None;
        let mut entries = Vec::new();
        loop {
            let next = page(fixture, state, cursor.as_deref(), size);
            entries.extend(next.entries);
            cursor = next.next_cursor;
            if cursor.is_none() {
                return entries;
            }
        }
    }

    #[test]
    fn status_view_hides_dot_names_and_counts_visible_generated_markdown() {
        let fixture = Fixture::new();
        for path in [
            "wiki/rules.md",
            "wiki/.draft.md",
            "wiki/.notes/rules.md",
            "wiki/node_modules/package.md",
            "wiki/__pycache__/cached.markdown",
            "wiki/.git/ignored.md",
            "wiki/.DS_Store/ignored.md",
        ] {
            fixture.file(path, b"<!-- pix:wiki-report {} -->\n# Exact saved body\r\n");
        }
        let state = Mutex::new(CursorRegistry::new(4));
        let mut cursor = None;
        let mut status_paths = BTreeSet::new();
        loop {
            let next = list_with_registry_mode(
                &fixture.0,
                Path::new("wiki"),
                Path::new("wiki"),
                cursor.as_deref(),
                &state,
                limits(2),
                InventoryMode::TreeStatus,
            )
            .unwrap();
            status_paths.extend(next.entries.into_iter().map(|entry| entry.path));
            cursor = next.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(
            status_paths,
            BTreeSet::from(
                ["wiki/rules.md", "wiki/node_modules", "wiki/__pycache__"].map(str::to_owned)
            )
        );
        assert_eq!(
            all(&fixture, &state, 16)
                .into_iter()
                .map(|entry| entry.path)
                .collect::<Vec<_>>(),
            vec!["wiki/rules.md"]
        );
        for path in [
            "wiki/node_modules/package.md",
            "wiki/__pycache__/cached.markdown",
        ] {
            let status =
                read_status_document(&fixture.0, Path::new("wiki"), Path::new(path)).unwrap();
            assert_eq!(status.path, path);
            assert_eq!(
                status.content,
                "<!-- pix:wiki-report {} -->\n# Exact saved body\r\n"
            );
            assert!(read_document(&fixture.0, Path::new("wiki"), Path::new(path)).is_err());
        }
        assert!(state.lock().unwrap().cursors.is_empty());
    }

    #[test]
    fn status_view_excludes_hidden_entries_at_every_depth_and_rejects_direct_reads() {
        let fixture = Fixture::new();
        for path in [
            "wiki/section/page.md",
            "wiki/section/.draft.md",
            "wiki/section/.notes/page.md",
            "wiki/.draft.md",
            "wiki/.notes/page.md",
        ] {
            fixture.file(path, b"body");
        }
        let page = list_status_directory(
            &fixture.0,
            Path::new("wiki"),
            Path::new("wiki/section"),
            None,
        )
        .unwrap();
        assert_eq!(
            page.entries
                .into_iter()
                .map(|entry| entry.path)
                .collect::<Vec<_>>(),
            vec!["wiki/section/page.md"]
        );
        for path in [
            "wiki/.draft.md",
            "wiki/.notes/page.md",
            "wiki/section/.draft.md",
            "wiki/section/.notes/page.md",
        ] {
            assert!(read_status_document(&fixture.0, Path::new("wiki"), Path::new(path)).is_err());
        }
        for path in ["wiki/.notes", "wiki/section/.notes"] {
            assert!(
                list_status_directory(&fixture.0, Path::new("wiki"), Path::new(path), None)
                    .is_err()
            );
        }
    }

    #[test]
    fn cursor_identity_includes_status_or_automatic_mode() {
        let fixture = Fixture::new();
        fixture.file("wiki/a.md", b"a");
        fixture.file("wiki/b.md", b"b");
        let state = Mutex::new(CursorRegistry::new(4));
        for (original, other) in [
            (InventoryMode::Automatic, InventoryMode::TreeStatus),
            (InventoryMode::TreeStatus, InventoryMode::Automatic),
        ] {
            let first = list_with_registry_mode(
                &fixture.0,
                Path::new("wiki"),
                Path::new("wiki"),
                None,
                &state,
                limits(1),
                original,
            )
            .unwrap();
            let token = first.next_cursor.unwrap();
            assert!(list_with_registry_mode(
                &fixture.0,
                Path::new("wiki"),
                Path::new("wiki"),
                Some(&token),
                &state,
                limits(1),
                other
            )
            .is_err());
            assert!(state.lock().unwrap().cursors.contains_key(&token));
            let resumed = list_with_registry_mode(
                &fixture.0,
                Path::new("wiki"),
                Path::new("wiki"),
                Some(&token),
                &state,
                limits(1),
                original,
            )
            .unwrap();
            if let Some(cursor) = resumed.next_cursor {
                release_with_registry(&fixture.0, &cursor, &state).unwrap();
            }
        }
        assert!(state.lock().unwrap().cursors.is_empty());
    }

    #[test]
    fn status_mode_retains_private_storage_and_containment_guards() {
        let fixture = Fixture::new();
        for path in [
            "wiki/.pi/artifacts/secret.md",
            "wiki/.pi/subagents/secret.md",
            "wiki/.git/secret.md",
            "outside/secret.md",
        ] {
            fixture.file(path, b"private");
            assert!(read_status_document(&fixture.0, Path::new("wiki"), Path::new(path)).is_err());
            assert!(list_status_directory(
                &fixture.0,
                Path::new("wiki"),
                Path::new(path).parent().unwrap(),
                None
            )
            .is_err());
        }
        for path in [
            "wiki/../outside/secret.md",
            "/wiki/rules.md",
            "wiki/bad:page.md",
            "wiki/bad\\page.md",
            "wiki/image.png",
        ] {
            assert!(read_status_document(&fixture.0, Path::new("wiki"), Path::new(path)).is_err());
        }
        fixture.file("wiki/.pi/notes.md", b"hidden project notes");
        assert!(read_status_document(
            &fixture.0,
            Path::new("wiki"),
            Path::new("wiki/.pi/notes.md")
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn status_mode_never_follows_symlink_files_or_ancestors() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        fixture.file("wiki/real/page.md", b"inside");
        fixture.file("outside/page.md", b"outside");
        symlink(fixture.0.join("outside"), fixture.0.join("wiki/linked")).unwrap();
        symlink(
            fixture.0.join("wiki/real/page.md"),
            fixture.0.join("wiki/linked.md"),
        )
        .unwrap();
        let page =
            list_status_directory(&fixture.0, Path::new("wiki"), Path::new("wiki"), None).unwrap();
        assert_eq!(
            page.entries
                .into_iter()
                .map(|entry| entry.path)
                .collect::<Vec<_>>(),
            vec!["wiki/real"]
        );
        assert!(
            read_status_document(&fixture.0, Path::new("wiki"), Path::new("wiki/linked.md"))
                .is_err()
        );
        assert!(read_status_document(
            &fixture.0,
            Path::new("wiki"),
            Path::new("wiki/linked/page.md")
        )
        .is_err());
        assert!(list_status_directory(
            &fixture.0,
            Path::new("wiki"),
            Path::new("wiki/linked"),
            None
        )
        .is_err());
    }

    #[test]
    fn status_reads_retain_byte_limits_and_replacement_fences() {
        let fixture = Fixture::new();
        fixture.file(
            "wiki/large.md",
            &vec![b'x'; MAX_DOCUMENT_BYTES as usize + 1],
        );
        assert!(
            read_status_document(&fixture.0, Path::new("wiki"), Path::new("wiki/large.md"))
                .is_err()
        );
        fixture.file("wiki/page.md", b"old");
        let read = read_with_mode(
            &fixture.0,
            Path::new("wiki"),
            Path::new("wiki/page.md"),
            InventoryMode::TreeStatus,
            |root, path, _| {
                let content = fs::read_to_string(root.join(path)).unwrap();
                fixture.file("replacement", b"new");
                fs::rename(fixture.0.join("replacement"), root.join(path)).unwrap();
                Ok(content)
            },
        );
        assert!(read.is_err());
    }

    #[test]
    fn lists_only_visible_markdown_and_child_directories_without_reading_file_bodies() {
        let fixture = Fixture::new();
        fixture.file("wiki/a.md", b"# Body");
        fixture.file("wiki/RULES.MARKDOWN", &[0xff, 0xfe]);
        fixture.file("wiki/правила.md", b"unicode filename");
        fixture.file("wiki/section/nested.md", b"nested");
        fixture.file("wiki/image.png", b"image");
        fixture.file("wiki/.private.md", b"private");
        fixture.file("wiki/.hidden/secret.md", b"secret");
        fixture.file("wiki/node_modules/package.md", b"generated");
        fixture.file("wiki/__pycache__/generated.md", b"generated");
        let state = Mutex::new(CursorRegistry::new(4));
        let entries = all(&fixture, &state, 2);
        let paths = entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<BTreeSet<_>>();
        assert_eq!(
            paths,
            BTreeSet::from([
                "wiki/a.md",
                "wiki/RULES.MARKDOWN",
                "wiki/правила.md",
                "wiki/section"
            ])
        );
        let binary_markdown = entries
            .iter()
            .find(|entry| entry.path == "wiki/RULES.MARKDOWN")
            .unwrap();
        assert_eq!(binary_markdown.size, Some(2));
        assert_eq!(binary_markdown.revision.as_ref().unwrap().len(), 64);
        let directory = entries
            .iter()
            .find(|entry| entry.kind == WikiCheckEntryKind::Directory)
            .unwrap();
        assert!(directory.revision.is_none() && directory.size.is_none());
        assert_eq!(state.lock().unwrap().cursors.len(), 0);
        assert_eq!(state.lock().unwrap().in_flight, 0);
    }

    #[test]
    fn pages_stream_without_duplicates_and_tokens_are_single_use() {
        let fixture = Fixture::new();
        for index in 0..9 {
            fixture.file(&format!("wiki/{index}.md"), b"x");
        }
        let state = Mutex::new(CursorRegistry::new(2));
        let first = page(&fixture, &state, None, 2);
        assert_eq!(first.entries.len(), 2);
        let old_token = first.next_cursor.unwrap();
        let second = page(&fixture, &state, Some(&old_token), 2);
        assert_ne!(second.next_cursor.as_deref(), Some(old_token.as_str()));
        assert!(list_with_registry(
            &fixture.0,
            Path::new("wiki"),
            Path::new("wiki"),
            Some(&old_token),
            &state,
            limits(2)
        )
        .is_err());
        let mut paths = first
            .entries
            .into_iter()
            .chain(second.entries)
            .map(|entry| entry.path)
            .collect::<BTreeSet<_>>();
        let mut cursor = second.next_cursor;
        while let Some(token) = cursor {
            let next = page(&fixture, &state, Some(&token), 2);
            for entry in next.entries {
                assert!(paths.insert(entry.path));
            }
            cursor = next.next_cursor;
        }
        assert_eq!(paths.len(), 9);
        assert!(state.lock().unwrap().cursors.is_empty());
    }

    #[test]
    fn empty_filtered_pages_still_continue() {
        let fixture = Fixture::new();
        for index in 0..5 {
            fixture.file(&format!("wiki/{index}.png"), b"image");
        }
        let state = Mutex::new(CursorRegistry::new(2));
        let first = page(&fixture, &state, None, 1);
        assert!(first.entries.is_empty() && first.next_cursor.is_some());
        let mut cursor = first.next_cursor;
        while let Some(token) = cursor {
            let next = page(&fixture, &state, Some(&token), 1);
            assert!(next.entries.is_empty());
            cursor = next.next_cursor;
        }
        assert!(state.lock().unwrap().cursors.is_empty());
    }

    #[test]
    fn revisions_are_stable_and_detect_same_size_atomic_replacements() {
        let fixture = Fixture::new();
        fixture.file("wiki/rules.md", b"old");
        let state = Mutex::new(CursorRegistry::new(2));
        let before = all(&fixture, &state, 8).remove(0);
        let same = all(&fixture, &state, 8).remove(0);
        assert_eq!(before.revision, same.revision);
        fixture.file("replacement", b"new");
        fs::rename(
            fixture.0.join("replacement"),
            fixture.0.join("wiki/rules.md"),
        )
        .unwrap();
        let after = all(&fixture, &state, 8).remove(0);
        assert_eq!(before.size, after.size);
        assert_ne!(before.revision, after.revision);
    }

    #[test]
    fn fresh_pass_observes_creation_rename_and_deletion() {
        let fixture = Fixture::new();
        fixture.file("wiki/old.md", b"old");
        let state = Mutex::new(CursorRegistry::new(2));
        assert_eq!(all(&fixture, &state, 8)[0].path, "wiki/old.md");
        fs::rename(
            fixture.0.join("wiki/old.md"),
            fixture.0.join("wiki/renamed.md"),
        )
        .unwrap();
        fixture.file("wiki/new.markdown", b"new");
        let paths = all(&fixture, &state, 8)
            .into_iter()
            .map(|entry| entry.path)
            .collect::<BTreeSet<_>>();
        assert_eq!(
            paths,
            BTreeSet::from(["wiki/new.markdown".to_owned(), "wiki/renamed.md".to_owned()])
        );
        fs::remove_file(fixture.0.join("wiki/renamed.md")).unwrap();
        assert_eq!(all(&fixture, &state, 8)[0].path, "wiki/new.markdown");
    }

    #[test]
    fn rejects_path_escapes_private_roots_and_cross_directory_cursors() {
        let fixture = Fixture::new();
        fixture.file("wiki/a.md", b"a");
        fixture.file("wiki/b.md", b"b");
        fs::create_dir_all(fixture.0.join("outside")).unwrap();
        let state = Mutex::new(CursorRegistry::new(2));
        for (wiki, path) in [
            ("wiki", "outside"),
            ("wiki", "wiki/../outside"),
            ("wiki", "/wiki"),
            (".git", ".git"),
            (".pi/artifacts/wiki", ".pi/artifacts/wiki"),
            (".pi/subagents/wiki", ".pi/subagents/wiki"),
            ("wiki", "wiki\\outside"),
            ("wiki", "wiki/a:b"),
        ] {
            assert!(
                list_with_registry(
                    &fixture.0,
                    Path::new(wiki),
                    Path::new(path),
                    None,
                    &state,
                    limits(1)
                )
                .is_err(),
                "{wiki}: {path}"
            );
        }
        let first = page(&fixture, &state, None, 1);
        let token = first.next_cursor.unwrap();
        let other = list_with_registry(
            &fixture.0,
            Path::new("outside"),
            Path::new("outside"),
            Some(&token),
            &state,
            limits(1),
        );
        assert!(other.is_err());
        assert_eq!(state.lock().unwrap().cursors.len(), 1);
        release_with_registry(&fixture.0, &token, &state).unwrap();
    }

    #[test]
    fn cursor_and_release_are_owned_by_the_original_workspace() {
        let first = Fixture::new();
        let second = Fixture::new();
        first.file("wiki/a.md", b"a");
        first.file("wiki/b.md", b"b");
        let state = Mutex::new(CursorRegistry::new(2));
        let token = page(&first, &state, None, 1).next_cursor.unwrap();
        assert!(list_with_registry(
            &second.0,
            Path::new("wiki"),
            Path::new("wiki"),
            Some(&token),
            &state,
            limits(1)
        )
        .is_err());
        assert!(release_with_registry(&second.0, &token, &state).is_err());
        assert_eq!(state.lock().unwrap().cursors.len(), 1);
        release_with_registry(&first.0, &token, &state).unwrap();
        release_with_registry(&first.0, &token, &state).unwrap();
        assert!(state.lock().unwrap().cursors.is_empty());
    }

    #[test]
    fn bounds_live_handles_and_expires_abandoned_cursors_without_evicting_live_ones() {
        let fixture = Fixture::new();
        fixture.file("wiki/a.md", b"a");
        fixture.file("wiki/b.md", b"b");
        let state = Mutex::new(CursorRegistry::new(1));
        let token = page(&fixture, &state, None, 1).next_cursor.unwrap();
        assert!(list_with_registry(
            &fixture.0,
            Path::new("wiki"),
            Path::new("wiki"),
            None,
            &state,
            limits(1)
        )
        .is_err());
        assert!(state.lock().unwrap().cursors.contains_key(&token));
        let expires_at = state.lock().unwrap().cursors[&token].touched + CURSOR_TTL;
        state.lock().unwrap().expire(expires_at);
        assert!(state.lock().unwrap().cursors.is_empty());
        assert_eq!(state.lock().unwrap().in_flight, 0);
        assert!(list_with_registry(
            &fixture.0,
            Path::new("wiki"),
            Path::new("wiki"),
            Some(&token),
            &state,
            limits(1)
        )
        .is_err());
    }

    #[test]
    fn invalidates_a_cursor_when_its_directory_is_replaced() {
        let fixture = Fixture::new();
        fixture.file("wiki/a.md", b"a");
        fixture.file("wiki/b.md", b"b");
        let state = Mutex::new(CursorRegistry::new(2));
        let token = page(&fixture, &state, None, 1).next_cursor.unwrap();
        fs::rename(fixture.0.join("wiki"), fixture.0.join("old-wiki")).unwrap();
        fixture.file("wiki/new.md", b"new");
        assert!(list_with_registry(
            &fixture.0,
            Path::new("wiki"),
            Path::new("wiki"),
            Some(&token),
            &state,
            limits(1)
        )
        .is_err());
        assert!(state.lock().unwrap().cursors.is_empty());
        assert_eq!(state.lock().unwrap().in_flight, 0);
        assert_eq!(all(&fixture, &state, 8)[0].path, "wiki/new.md");
    }

    #[cfg(unix)]
    #[test]
    fn ordinary_atomic_report_writes_do_not_interrupt_a_paged_inventory() {
        let fixture = Fixture::new();
        for index in 0..5 {
            fixture.file(&format!("wiki/{index}.md"), b"body");
        }
        let state = Mutex::new(CursorRegistry::new(2));
        let mut cursor = page(&fixture, &state, None, 1).next_cursor;
        fixture.file("report-temporary", b"<!-- pix:wiki-report {} -->\nbody");
        fs::rename(
            fixture.0.join("report-temporary"),
            fixture.0.join("wiki/3.md"),
        )
        .unwrap();
        fixture.file("wiki/new.md", b"new page");
        while let Some(token) = cursor {
            cursor = page(&fixture, &state, Some(&token), 1).next_cursor;
        }
        assert!(state.lock().unwrap().cursors.is_empty());
        let paths = all(&fixture, &state, 8)
            .into_iter()
            .map(|entry| entry.path)
            .collect::<BTreeSet<_>>();
        assert_eq!(paths.len(), 6);
        assert!(paths.contains("wiki/3.md") && paths.contains("wiki/new.md"));
    }

    #[cfg(unix)]
    #[test]
    fn a_reparented_directory_cannot_continue_through_a_replaced_ancestor() {
        let fixture = Fixture::new();
        fixture.file("wiki/section/nested/a.md", b"a");
        fixture.file("wiki/section/nested/b.md", b"b");
        let state = Mutex::new(CursorRegistry::new(2));
        let path = Path::new("wiki/section/nested");
        let token =
            list_with_registry(&fixture.0, Path::new("wiki"), path, None, &state, limits(1))
                .unwrap()
                .next_cursor
                .unwrap();
        fs::rename(
            fixture.0.join("wiki/section"),
            fixture.0.join("old-section"),
        )
        .unwrap();
        fs::create_dir(fixture.0.join("wiki/section")).unwrap();
        fs::rename(fixture.0.join("old-section/nested"), fixture.0.join(path)).unwrap();
        assert!(list_with_registry(
            &fixture.0,
            Path::new("wiki"),
            path,
            Some(&token),
            &state,
            limits(1)
        )
        .is_err());
        assert!(state.lock().unwrap().cursors.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn excludes_symlink_entries_and_refuses_every_symlink_ancestor() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        fixture.file("outside/private.md", b"private");
        fixture.file("wiki/safe.md", b"safe");
        symlink(
            fixture.0.join("outside/private.md"),
            fixture.0.join("wiki/link.md"),
        )
        .unwrap();
        symlink(
            fixture.0.join("outside"),
            fixture.0.join("wiki/linked-directory"),
        )
        .unwrap();
        symlink(fixture.0.join("outside"), fixture.0.join("linked-root")).unwrap();
        let state = Mutex::new(CursorRegistry::new(2));
        let entries = all(&fixture, &state, 8);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "wiki/safe.md");
        assert!(list_with_registry(
            &fixture.0,
            Path::new("wiki"),
            Path::new("wiki/linked-directory"),
            None,
            &state,
            limits(1)
        )
        .is_err());
        assert!(list_with_registry(
            &fixture.0,
            Path::new("linked-root"),
            Path::new("linked-root"),
            None,
            &state,
            limits(1)
        )
        .is_err());
    }

    #[test]
    fn serializes_the_small_camel_case_wire_contract() {
        let page = WikiCheckDirectoryPage {
            entries: vec![WikiCheckInventoryEntry {
                path: "wiki/rules.md".to_owned(),
                kind: WikiCheckEntryKind::File,
                revision: Some("hash".to_owned()),
                size: Some(7),
            }],
            next_cursor: Some("cursor".to_owned()),
        };
        let wire = serde_json::to_value(page).unwrap();
        assert_eq!(wire["nextCursor"], "cursor");
        assert_eq!(wire["entries"][0]["kind"], "file");
        assert_eq!(wire["entries"][0]["size"], 7);
        let empty = serde_json::to_value(WikiCheckDirectoryPage {
            entries: vec![],
            next_cursor: None,
        })
        .unwrap();
        assert!(empty.get("nextCursor").is_none());
    }

    #[test]
    fn reads_exact_unicode_bytes_and_retains_metadata_for_logical_hashing() {
        let fixture = Fixture::new();
        let content = "<!-- pix:wiki-report {} -->\n# Правила\r\nТекст 💙\r\n";
        fixture.file("wiki/правила.MD", content.as_bytes());
        let result =
            read_document(&fixture.0, Path::new("wiki"), Path::new("wiki/правила.MD")).unwrap();
        assert_eq!(result.path, "wiki/правила.MD");
        assert_eq!(result.content, content);
    }

    #[test]
    fn bounds_document_reads_in_bytes_without_returning_partial_content() {
        let fixture = Fixture::new();
        fixture.file("wiki/large.md", &vec![b'x'; MAX_DOCUMENT_BYTES as usize]);
        assert_eq!(
            read_document(&fixture.0, Path::new("wiki"), Path::new("wiki/large.md"))
                .unwrap()
                .content
                .len(),
            MAX_DOCUMENT_BYTES as usize
        );
        fs::OpenOptions::new()
            .write(true)
            .open(fixture.0.join("wiki/large.md"))
            .unwrap()
            .set_len(MAX_DOCUMENT_BYTES + 1)
            .unwrap();
        let called = std::cell::Cell::new(false);
        let result = read_with(
            &fixture.0,
            Path::new("wiki"),
            Path::new("wiki/large.md"),
            |_, _, _| {
                called.set(true);
                Ok(String::new())
            },
        );
        assert!(result.is_err());
        assert!(!called.get());
        fixture.file("wiki/small.md", b"whole");
        assert!(read_with(
            &fixture.0,
            Path::new("wiki"),
            Path::new("wiki/small.md"),
            |_, _, limit| {
                assert_eq!(limit, MAX_DOCUMENT_BYTES);
                Ok("part".to_owned())
            }
        )
        .is_err());
    }

    #[test]
    fn rejects_outside_hidden_generated_and_non_markdown_reads() {
        let fixture = Fixture::new();
        for path in [
            "outside/private.md",
            "wiki/.secret.md",
            "wiki/.hidden/page.md",
            "wiki/node_modules/package.md",
            "wiki/image.txt",
        ] {
            fixture.file(path, b"content");
            assert!(
                read_document(&fixture.0, Path::new("wiki"), Path::new(path)).is_err(),
                "{path}"
            );
        }
    }

    #[test]
    fn refuses_an_atomic_replacement_during_a_document_read() {
        let fixture = Fixture::new();
        fixture.file("wiki/rules.md", b"old");
        fixture.file("replacement", b"new");
        let result = read_with(
            &fixture.0,
            Path::new("wiki"),
            Path::new("wiki/rules.md"),
            |root, relative, _| {
                let content = fs::read_to_string(root.join(relative)).unwrap();
                fs::rename(root.join("replacement"), root.join(relative)).unwrap();
                Ok(content)
            },
        );
        assert!(result.is_err());
    }

    #[cfg(unix)]
    #[test]
    fn an_unrelated_pages_report_write_does_not_invalidate_the_read_document() {
        let fixture = Fixture::new();
        fixture.file("wiki/rules.md", b"current rules");
        fixture.file("wiki/other.md", b"other page");
        fixture.file(
            "report-temporary",
            b"<!-- pix:wiki-report {} -->\nother page",
        );
        let result = read_with(
            &fixture.0,
            Path::new("wiki"),
            Path::new("wiki/rules.md"),
            |root, relative, _| {
                let content = fs::read_to_string(root.join(relative)).unwrap();
                fs::rename(root.join("report-temporary"), root.join("wiki/other.md")).unwrap();
                Ok(content)
            },
        )
        .unwrap();
        assert_eq!(result.content, "current rules");
    }

    #[cfg(unix)]
    #[test]
    fn revalidates_symlinks_independently_of_an_earlier_inventory() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        fixture.file("wiki/rules.md", b"public");
        fixture.file("private/secret.md", b"secret");
        let state = Mutex::new(CursorRegistry::new(2));
        assert_eq!(all(&fixture, &state, 8)[0].path, "wiki/rules.md");
        fs::remove_file(fixture.0.join("wiki/rules.md")).unwrap();
        symlink(
            fixture.0.join("private/secret.md"),
            fixture.0.join("wiki/rules.md"),
        )
        .unwrap();
        let called = std::cell::Cell::new(false);
        assert!(read_with(
            &fixture.0,
            Path::new("wiki"),
            Path::new("wiki/rules.md"),
            |_, _, _| {
                called.set(true);
                Ok("secret".to_owned())
            }
        )
        .is_err());
        assert!(!called.get());
        symlink(fixture.0.join("private"), fixture.0.join("wiki/linked")).unwrap();
        assert!(read_document(
            &fixture.0,
            Path::new("wiki"),
            Path::new("wiki/linked/secret.md")
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlink_ancestor_installed_while_reading() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        fixture.file("wiki/section/rules.md", b"public");
        fixture.file("private/rules.md", b"secret");
        let result = read_with(
            &fixture.0,
            Path::new("wiki"),
            Path::new("wiki/section/rules.md"),
            |root, _, _| {
                fs::rename(root.join("wiki/section"), root.join("original-section")).unwrap();
                symlink(root.join("private"), root.join("wiki/section")).unwrap();
                Ok("secret".to_owned())
            },
        );
        assert!(result.is_err());
    }
}
