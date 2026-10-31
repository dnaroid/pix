//! Reversible explorer mutations. Data slots and recovery journals are durable,
//! not harness artifacts. Nothing in this module permanently deletes user data.
use crate::{
    copy_project_path, project_tree_entry_from_path, ProjectTreeEntry, ProjectTreeEntryKind,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Component, Path, PathBuf},
    sync::{Arc, LazyLock, Mutex, PoisonError},
};

#[path = "project_file_history_lock.rs"]
mod lock;

/// Runtime history tokens. The map lock is only held to look up, insert or
/// remove an entry; filesystem work is serialized per workspace by
/// `WORKSPACES` (in process) and the storage `flock` (across processes).
static MUTATIONS: LazyLock<Mutex<std::collections::HashMap<String, Arc<Entry>>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));
static WORKSPACES: LazyLock<lock::WorkspaceLocks> = LazyLock::new(Default::default);
const STORAGE: &str = ".pi/file-history";

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum Request {
    Create {
        parent: String,
        name: String,
        kind: ProjectTreeEntryKind,
    },
    Rename {
        path: String,
        name: String,
    },
    Move {
        paths: Vec<String>,
        destination: String,
    },
    ImportMove {
        paths: Vec<String>,
        destination: String,
        #[serde(rename = "sourceWorkspace")]
        source_workspace: String,
    },
    Copy {
        paths: Vec<String>,
        destination: String,
        #[serde(rename = "sourceWorkspace")]
        source_workspace: Option<String>,
    },
    Delete {
        paths: Vec<String>,
    },
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
struct Identity {
    directory: bool,
    device: u64,
    inode: u64,
    birth: i64,
    birth_nsec: i64,
}

fn identity(path: &Path) -> Result<Identity, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if metadata.file_type().is_symlink() || (!metadata.is_file() && !metadata.is_dir()) {
        return Err("File history does not follow symbolic links or special files.".into());
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::macos::fs::MetadataExt;
        Ok(Identity {
            directory: metadata.is_dir(),
            device: metadata.st_dev() as u64,
            inode: metadata.st_ino(),
            birth: metadata.st_birthtime(),
            birth_nsec: metadata.st_birthtime_nsec(),
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Explorer file history is supported on macOS only.".into())
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Step {
    before: Option<String>,
    after: Option<String>,
    slot: String,
    identity: Option<Identity>,
    done: bool,
}

#[derive(Serialize, Deserialize)]
struct Record {
    workspace: PathBuf,
    root_identity: Identity,
    // Runtime-only capability: journals are never loaded as executable history.
    source_workspace: Option<PathBuf>,
    source_root_identity: Option<Identity>,
    steps: Vec<Step>,
}

/// A replayable record plus the workspaces it touches, readable without
/// locking the record so callers can take workspace locks first.
struct Entry {
    workspace: PathBuf,
    source_workspace: Option<PathBuf>,
    record: Mutex<Record>,
}

fn mutations() -> std::sync::MutexGuard<'static, std::collections::HashMap<String, Arc<Entry>>> {
    MUTATIONS.lock().unwrap_or_else(PoisonError::into_inner)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Change {
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Receipt {
    token: String,
    entries: Vec<ProjectTreeEntry>,
    changes: Vec<Change>,
    warning: Option<String>,
    complete: bool,
}

fn relative(path: &str, allow_root: bool) -> Result<(), String> {
    if (!allow_root && path.is_empty())
        || path.contains(['\\', '\0'])
        || (!path.is_empty()
            && path
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == ".."))
        || Path::new(path)
            .components()
            .any(|p| !matches!(p, Component::Normal(_)))
    {
        return Err("Expected a workspace-relative file path.".into());
    }
    Ok(())
}

fn editable(path: &str) -> Result<(), String> {
    relative(path, false)?;
    let path = path.to_ascii_lowercase();
    if path == ".pi"
        || path == STORAGE
        || path.starts_with(&format!("{STORAGE}/"))
        || path == ".git"
        || path.starts_with(".git/")
    {
        return Err(
            "The project metadata and file-history storage cannot be mutated in Files.".into(),
        );
    }
    Ok(())
}

/// Inspect every ancestor, rather than canonicalizing through an internal link.
fn resolve(root: &Path, path: &str, missing_leaf: bool) -> Result<PathBuf, String> {
    relative(path, true)?;
    let mut current = root.to_path_buf();
    let parts: Vec<_> = path.split('/').filter(|p| !p.is_empty()).collect();
    for (index, part) in parts.iter().enumerate() {
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err("File history does not follow symbolic links.".into())
            }
            Ok(meta) if index + 1 < parts.len() && !meta.is_dir() => {
                return Err("A parent is not a directory.".into())
            }
            Ok(_) => {}
            Err(e)
                if missing_leaf
                    && index + 1 == parts.len()
                    && e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Cannot access {}: {e}", current.display())),
        }
    }
    Ok(current)
}

fn directory(root: &Path, path: &str) -> Result<PathBuf, String> {
    let folded = path.to_ascii_lowercase();
    if folded == STORAGE
        || folded.starts_with(&format!("{STORAGE}/"))
        || folded == ".git"
        || folded.starts_with(".git/")
    {
        return Err("Cannot write into protected project metadata.".into());
    }
    let target = resolve(root, path, false)?;
    if !target.is_dir() {
        return Err("The destination is not a folder.".into());
    }
    Ok(target)
}

fn ensure_storage(root: &Path) -> Result<PathBuf, String> {
    let mut current = root.to_path_buf();
    for part in [".pi", "file-history"] {
        current.push(part);
        match fs::create_dir(&current) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(format!("Cannot create recovery storage: {e}")),
        }
        let meta = fs::symlink_metadata(&current).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err("Recovery storage must be a project-owned directory.".into());
        }
    }
    let ignore = current.join(".gitignore");
    use std::io::Write;
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&ignore)
    {
        Ok(mut file) => {
            file.write_all(b"*\n").map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let meta = fs::symlink_metadata(&ignore).map_err(|e| e.to_string())?;
            if meta.file_type().is_symlink()
                || !meta.is_file()
                || fs::read(&ignore).map_err(|e| e.to_string())? != b"*\n"
            {
                return Err("File history requires its own .gitignore containing '*'.".into());
            }
        }
        Err(e) => return Err(e.to_string()),
    }
    Ok(current)
}

// Also serialize independently running Pix processes. Never follow a lock symlink.
#[cfg(unix)]
fn lock_storage(storage: &Path) -> Result<fs::File, String> {
    use std::os::unix::{fs::OpenOptionsExt, io::AsRawFd};
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .mode(0o600)
        .open(storage.join(".lock"))
        .map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Invalid file-history lock.".into());
    }
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err("Another Pix process is changing files; retry when it finishes.".into());
    }
    Ok(file)
}

#[cfg(not(unix))]
fn lock_storage(_storage: &Path) -> Result<fs::File, String> {
    Err("Explorer file history is supported on macOS only.".into())
}

fn save(folder: &Path, record: &Record) -> Result<(), String> {
    use std::io::Write;
    let next = folder.join(format!("journal-{}.tmp", uuid::Uuid::new_v4()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&next)
        .map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec_pretty(record).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    fs::rename(&next, folder.join("journal.json")).map_err(|e| e.to_string())?;
    crate::sync_directory(folder)
}

fn rename_exclusive(source: &Path, target: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let from = CString::new(source.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
        let to = CString::new(target.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
        if unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) } != 0 {
            return Err(format!(
                "Cannot move {} to {} (nothing was overwritten): {}",
                source.display(),
                target.display(),
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (source, target);
        Err("Explorer file history is supported on macOS only.".into())
    }
}

fn join(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.into()
    } else {
        format!("{parent}/{name}")
    }
}

fn workspace_relative_source(root: &Path, source: &Path) -> Option<String> {
    source.strip_prefix(root).ok()?.to_str().map(str::to_owned)
}

fn validate_import_source(source: &Path, root: &Path, storage: &Path) -> Result<(), String> {
    let parts: Vec<_> = source
        .components()
        .map(|part| part.as_os_str().to_string_lossy().to_ascii_lowercase())
        .collect();
    if root.starts_with(source)
        || storage.starts_with(source)
        || parts.iter().any(|part| part == ".git")
        || parts.last().is_some_and(|part| part == ".pi")
        || parts
            .windows(2)
            .any(|pair| pair[0] == ".pi" && pair[1] == "file-history")
    {
        return Err("Cannot move a workspace, its ancestors or protected project metadata.".into());
    }
    Ok(())
}

fn roots(paths: Vec<String>) -> Result<Vec<String>, String> {
    if paths.is_empty() || paths.len() > 1000 {
        return Err("Select between 1 and 1000 entries.".into());
    }
    for path in &paths {
        editable(path)?;
    }
    let mut unique = Vec::new();
    for path in &paths {
        if !unique.contains(path)
            && !paths
                .iter()
                .any(|parent| path.starts_with(&format!("{parent}/")))
        {
            unique.push(path.clone());
        }
    }
    Ok(unique)
}

pub(crate) fn execute(workspace: &Path, request: Request) -> Result<Receipt, String> {
    execute_with(workspace, request, |_| {})
}

fn execute_with(
    workspace: &Path,
    request: Request,
    mut before_step: impl FnMut(usize),
) -> Result<Receipt, String> {
    let root = crate::canonical_workspace(workspace)?;
    let source_root = match &request {
        Request::ImportMove {
            source_workspace, ..
        } => Some(crate::canonical_workspace(Path::new(source_workspace))?),
        Request::Copy {
            source_workspace: Some(source_workspace),
            ..
        } => Some(crate::canonical_workspace(Path::new(source_workspace))?),
        _ => None,
    };
    let _workspaces = WORKSPACES.acquire(std::iter::once(root.clone()).chain(source_root.clone()));
    let storage = ensure_storage(&root)?;
    let _disk_lock = lock_storage(&storage)?;
    let root_identity = identity(&root)?;
    let mut copy_source = root.clone();
    let mut create_kind = None;
    let mut copy = false;
    let mut import_move = false;
    let pairs: Vec<(Option<String>, Option<String>)> = match request {
        Request::Create { parent, name, kind } => {
            crate::validate_project_entry_name(&name)?;
            directory(&root, &parent)?;
            create_kind = Some(kind);
            vec![(None, Some(join(&parent, &name)))]
        }
        Request::Rename { path, name } => {
            editable(&path)?;
            crate::validate_project_entry_name(&name)?;
            let parent = path.rsplit_once('/').map(|p| p.0).unwrap_or("");
            vec![(Some(path.clone()), Some(join(parent, &name)))]
        }
        Request::Move { paths, destination } => {
            directory(&root, &destination)?;
            roots(paths)?
                .into_iter()
                .map(|path| {
                    let target = join(&destination, path.rsplit('/').next().unwrap());
                    (Some(path), Some(target))
                })
                .collect()
        }
        Request::ImportMove {
            paths,
            destination,
            source_workspace,
        } => {
            let _ = source_workspace;
            import_move = true;
            copy_source = source_root.clone().expect("import source was resolved");
            let destination_path = directory(&root, &destination)?;
            let mut pairs = Vec::new();
            for path in roots(paths)? {
                let source = resolve(&copy_source, &path, false)?;
                validate_import_source(&source, &root, &storage)?;
                if destination_path.starts_with(&source) {
                    return Err("Cannot move a folder into itself.".into());
                }
                let target = join(&destination, path.rsplit('/').next().unwrap());
                if source == root.join(&target) {
                    continue;
                }
                pairs.push((Some(path), Some(target)));
            }
            pairs
        }
        Request::Delete { paths } => roots(paths)?
            .into_iter()
            .map(|path| (Some(path), None))
            .collect(),
        Request::Copy {
            paths,
            destination,
            source_workspace,
        } => {
            let _ = source_workspace;
            copy = true;
            copy_source = source_root.clone().unwrap_or_else(|| root.clone());
            let destination_path = directory(&root, &destination)?;
            let mut reserved = std::collections::HashSet::new();
            let mut pairs = Vec::new();
            for path in roots(paths)? {
                let source = resolve(&copy_source, &path, false)?;
                let meta = fs::symlink_metadata(&source).map_err(|e| e.to_string())?;
                if meta.is_dir()
                    && (destination_path.starts_with(&source) || storage.starts_with(&source))
                {
                    return Err("Cannot copy a folder into itself or its recovery storage.".into());
                }
                let name = path.rsplit('/').next().unwrap();
                let mut target = join(&destination, name);
                let mut sequence = 0;
                while fs::symlink_metadata(root.join(&target)).is_ok() || reserved.contains(&target)
                {
                    sequence += 1;
                    if sequence > 10_000 {
                        return Err("No available copy name.".into());
                    }
                    target = join(
                        &destination,
                        &crate::project_copy_name(name, meta.is_dir(), sequence),
                    );
                }
                reserved.insert(target.clone());
                pairs.push((Some(path), Some(target)));
            }
            pairs
        }
    };
    let mut targets = std::collections::HashSet::new();
    for (before, after) in &pairs {
        if let Some(path) = before {
            identity(&resolve(&copy_source, path, false)?)?;
        }
        if let Some(path) = after {
            editable(path)?;
            let target = resolve(&root, path, true)?;
            if fs::symlink_metadata(&target).is_ok() || !targets.insert(path.clone()) {
                return Err(format!("{path} already exists or is targeted twice."));
            }
            if let Some(source) = before {
                if !copy && !import_move && path.starts_with(&format!("{source}/")) {
                    return Err("Cannot move a folder into itself.".into());
                }
            }
        }
    }
    let token = uuid::Uuid::new_v4().to_string();
    let folder = storage.join(&token);
    fs::create_dir(&folder).map_err(|e| e.to_string())?;
    let mut record = Record {
        workspace: root.clone(),
        root_identity,
        source_workspace: import_move.then(|| copy_source.clone()),
        source_root_identity: if import_move {
            Some(identity(&copy_source)?)
        } else {
            None
        },
        steps: Vec::new(),
    };
    let mut warning = None;
    let mut changes = Vec::new();
    let mut entries = Vec::new();
    for (index, (before, after)) in pairs.iter().enumerate() {
        before_step(index);
        let prepared = (|| -> Result<_, String> {
            let source = before
                .as_ref()
                .map(|path| resolve(&copy_source, path, false))
                .transpose()?;
            let target = after
                .as_ref()
                .map(|path| resolve(&root, path, true))
                .transpose()?
                .unwrap_or(folder.join(format!("data-{index}")));
            let id = if copy || before.is_none() {
                None
            } else {
                Some(identity(source.as_ref().unwrap())?)
            };
            Ok((source, target, id))
        })();
        let (source, target, id) = match prepared {
            Ok(value) => value,
            Err(error) => {
                warning = Some(error);
                break;
            }
        };
        record.steps.push(Step {
            before: if copy { None } else { before.clone() },
            after: after.clone(),
            slot: format!("data-{index}"),
            identity: id,
            done: false,
        });
        if let Err(error) = save(&folder, &record) {
            record.steps.pop();
            warning = Some(error);
            break;
        } // Write intent before moving user data.
        let result = if copy {
            let staged = folder.join(format!("stage-{index}"));
            let copied = copy_project_path(source.as_ref().unwrap(), &staged)
                .and_then(|_| rename_exclusive(&staged, &target));
            if copied.is_err() {
                // The stage is Pix's own duplicate; the source is untouched.
                remove_stage(&staged, &root);
            }
            copied
        } else if before.is_none() {
            match create_kind.as_ref().unwrap() {
                ProjectTreeEntryKind::Directory => {
                    fs::create_dir(&target).map_err(|e| e.to_string())
                }
                ProjectTreeEntryKind::File => fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&target)
                    .map(|_| ())
                    .map_err(|e| e.to_string()),
            }
        } else {
            rename_exclusive(source.as_ref().unwrap(), &target)
        };
        if let Err(error) = result {
            record.steps.pop();
            warning = Some(error);
            break;
        }
        let step = record.steps.last_mut().unwrap();
        step.done = true;
        changes.push(Change {
            before: if import_move {
                workspace_relative_source(&root, source.as_ref().unwrap())
            } else {
                step.before.clone()
            },
            after: after.clone(),
        });
        let finish = (|| -> Result<(), String> {
            record.steps.last_mut().unwrap().identity = Some(identity(&target)?);
            if after.is_some() {
                entries.push(project_tree_entry_from_path(&root, &target)?);
            }
            crate::sync_directory(target.parent().unwrap())?;
            if let Some(source) = &source {
                crate::sync_directory(source.parent().unwrap())?;
            }
            save(&folder, &record)
        })();
        if let Err(error) = finish {
            warning = Some(format!("Recovery journal needs attention: {error}"));
            break;
        }
    }
    if changes.is_empty() {
        remove_unused_token_folder(&folder, &root);
        return Err(warning.unwrap_or_else(|| "No files changed.".into()));
    }
    // Runtime tokens are capabilities. Journals are retained for manual recovery,
    // never deserialized into executable filesystem instructions after restart.
    mutations().insert(
        token.clone(),
        Arc::new(Entry {
            workspace: root.clone(),
            source_workspace: record.source_workspace.clone(),
            record: Mutex::new(record),
        }),
    );
    Ok(Receipt {
        token,
        entries,
        changes,
        warning,
        complete: true,
    })
}

pub(crate) fn replay(workspace: &Path, token: &str, undo: bool) -> Result<Receipt, String> {
    replay_with(workspace, token, undo, |_| {})
}

fn replay_with(
    workspace: &Path,
    token: &str,
    undo: bool,
    mut before_step: impl FnMut(usize),
) -> Result<Receipt, String> {
    if uuid::Uuid::parse_str(token)
        .map(|id| id.to_string() != token)
        .unwrap_or(true)
    {
        return Err("Invalid history token.".into());
    }
    let root = crate::canonical_workspace(workspace)?;
    let entry = mutations().get(token).cloned().ok_or("File history belongs to a closed panel or earlier app session; recovery data is retained on disk.")?;
    // Workspace locks before the record lock, matching `execute_with`.
    let _workspaces = WORKSPACES.acquire(
        [root.clone(), entry.workspace.clone()]
            .into_iter()
            .chain(entry.source_workspace.clone()),
    );
    let mut record = entry
        .record
        .lock()
        .map_err(|_| "File history record is unavailable.")?;
    let record = &mut *record;
    let storage = resolve(&root, STORAGE, false)?;
    let _disk_lock = lock_storage(&storage)?;
    let folder = resolve(&root, &format!("{STORAGE}/{token}"), false)?;
    if record.workspace != root || record.root_identity != identity(&root)? {
        return Err("The workspace was replaced; history cannot be replayed.".into());
    }
    if let Some(source_root) = &record.source_workspace {
        if record.source_root_identity.as_ref() != Some(&identity(source_root)?) {
            return Err("The source workspace was replaced; history cannot be replayed.".into());
        }
    }
    let mut indices: Vec<_> = (0..record.steps.len())
        .filter(|i| record.steps[*i].done == undo)
        .collect();
    if undo {
        indices.reverse();
    }
    // Preflight the entire remaining batch. Races are still guarded by RENAME_EXCL.
    for index in &indices {
        check_step(
            &root,
            record.source_workspace.as_deref(),
            &folder,
            &record.steps[*index],
            undo,
        )?;
    }
    let mut changes = Vec::new();
    let mut entries = Vec::new();
    let mut warning = None;
    for index in indices {
        before_step(index);
        let step = &record.steps[index];
        let (source, target) = match check_step(
            &root,
            record.source_workspace.as_deref(),
            &folder,
            step,
            undo,
        ) {
            Ok(paths) => paths,
            Err(error) => {
                warning = Some(error);
                break;
            }
        };
        if let Err(error) = rename_exclusive(&source, &target) {
            warning = Some(error);
            break;
        }
        changes.push(Change {
            before: (if undo { &step.after } else { &step.before })
                .as_ref()
                .and_then(|_| workspace_relative_source(&root, &source)),
            after: (if undo { &step.before } else { &step.after })
                .as_ref()
                .and_then(|_| workspace_relative_source(&root, &target)),
        });
        record.steps[index].done = !undo;
        let finish = (|| -> Result<(), String> {
            record.steps[index].identity = Some(identity(&target)?);
            if let Some(path) = changes.last().unwrap().after.as_ref() {
                entries.push(project_tree_entry_from_path(&root, &root.join(path))?);
            }
            crate::sync_directory(source.parent().unwrap())?;
            crate::sync_directory(target.parent().unwrap())?;
            save(&folder, record)
        })();
        if let Err(error) = finish {
            warning = Some(format!("Recovery journal needs attention: {error}"));
            break;
        }
    }
    let complete = record.steps.iter().all(|step| step.done != undo);
    Ok(Receipt {
        token: token.into(),
        entries,
        changes,
        warning,
        complete,
    })
}

fn check_step(
    root: &Path,
    source_root: Option<&Path>,
    folder: &Path,
    step: &Step,
    undo: bool,
) -> Result<(PathBuf, PathBuf), String> {
    // Journals are data, not trusted absolute-path capabilities.
    if step.slot.contains('/') || !step.slot.starts_with("data-") {
        return Err("Invalid recovery slot.".into());
    }
    let location = |path: &Option<String>, missing, external| -> Result<PathBuf, String> {
        match path {
            Some(path) => {
                editable(path)?;
                let location = resolve(
                    if external {
                        source_root.unwrap_or(root)
                    } else {
                        root
                    },
                    path,
                    missing,
                )?;
                if external && source_root.is_some() {
                    validate_import_source(&location, root, &root.join(STORAGE))?;
                }
                Ok(location)
            }
            None => resolve(
                root,
                folder
                    .join(&step.slot)
                    .strip_prefix(root)
                    .unwrap()
                    .to_str()
                    .ok_or("Invalid slot path")?,
                missing,
            ),
        }
    };
    let (source, target) = if undo {
        (
            location(&step.after, false, false)?,
            location(&step.before, true, true)?,
        )
    } else {
        (
            location(&step.before, false, true)?,
            location(&step.after, true, false)?,
        )
    };
    let actual = identity(&source)?;
    let expected = step.identity.as_ref().ok_or(
        "Recovery identity is missing; inspect the retained journal before recovering manually.",
    )?;
    // Safe-save editors replace file inodes. Move the current file without
    // destroying its contents; directories must still be the original object.
    if actual.directory != expected.directory || (actual.directory && actual != *expected) {
        return Err(
            "The entry was replaced outside Files; history will not move the replacement.".into(),
        );
    }
    if fs::symlink_metadata(&target).is_ok() {
        return Err(format!(
            "{} is occupied; history will not overwrite it.",
            target.display()
        ));
    }
    Ok((source, target))
}

/// In-flight undo/redo keeps its own reference and finishes; later calls fail.
pub(crate) fn forget(tokens: Vec<String>) {
    let mut records = mutations();
    for token in tokens {
        records.remove(&token);
    }
}

fn remove_stage(staged: &Path, root: &Path) {
    let result = match fs::symlink_metadata(staged) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(staged),
        Ok(_) => fs::remove_file(staged),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => Err(error),
    };
    if let Err(error) = result {
        crate::logging::record(
            "warn",
            "files",
            "file-history:stage-cleanup-failed",
            serde_json::json!({ "error": error.to_string() }),
            root.to_str(),
        );
    }
}

/// A batch that changed nothing leaves only Pix's own intent journal behind.
/// Remove exactly those files; any other content keeps the folder for recovery.
fn remove_unused_token_folder(folder: &Path, root: &Path) {
    let result = (|| -> std::io::Result<()> {
        for entry in fs::read_dir(folder)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let journal =
                name == "journal.json" || (name.starts_with("journal-") && name.ends_with(".tmp"));
            if journal && entry.file_type()?.is_file() {
                fs::remove_file(entry.path())?;
            }
        }
        fs::remove_dir(folder)
    })();
    if let Err(error) = result {
        crate::logging::record(
            "warn",
            "files",
            "file-history:empty-batch-cleanup-failed",
            serde_json::json!({ "error": error.to_string() }),
            root.to_str(),
        );
    }
}

#[cfg(all(test, target_os = "macos"))]
#[path = "project_file_history_tests.rs"]
mod tests;
