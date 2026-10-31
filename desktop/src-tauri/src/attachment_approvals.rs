//! User-approved attachment/media paths and their persisted registry.
//!
//! Approval adds a canonical path to the in-memory set and to Tauri's
//! asset-protocol scope, and records it in `approved-attachments.json` so
//! previews of earlier messages keep working after a restart.
//!
//! The registry is bounded: it keeps the newest [`MAX_APPROVED_ATTACHMENTS`]
//! paths by insertion order, drops entries whose files no longer exist when it
//! is loaded, and is replaced atomically (temporary file + rename) so a crash
//! cannot leave a truncated registry that silently loses every approval.
//!
//! Evicted paths leave the in-memory set and the registry, but stay in the
//! asset-protocol scope until the app exits. Tauri's scope cannot un-allow a
//! single path: `forbid_file` is a permanent deny that a later re-approval
//! could not lift. Keeping the grant for the session never widens access
//! beyond what the user already approved in this process, and it is not
//! restored on the next launch, so eviction only ever narrows access.

use super::logging;
use std::{
    collections::{HashSet, VecDeque},
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{AppHandle, Manager};

/// Upper bound on remembered approvals (about 200 KB of JSON).
const MAX_APPROVED_ATTACHMENTS: usize = 2048;

/// Approved canonical paths in insertion order, bounded by `capacity`.
#[derive(Clone, Debug)]
struct ApprovedPaths {
    order: VecDeque<PathBuf>,
    members: HashSet<PathBuf>,
    capacity: usize,
}

impl ApprovedPaths {
    fn new(capacity: usize) -> Self {
        Self {
            order: VecDeque::new(),
            members: HashSet::new(),
            capacity,
        }
    }

    fn contains(&self, path: &Path) -> bool {
        self.members.contains(path)
    }

    /// Insert unless present; evicts the oldest entries beyond capacity.
    fn insert(&mut self, path: PathBuf) -> bool {
        if self.members.contains(&path) {
            return false;
        }
        self.members.insert(path.clone());
        self.order.push_back(path);
        while self.order.len() > self.capacity {
            if let Some(evicted) = self.order.pop_front() {
                self.members.remove(&evicted);
            }
        }
        true
    }

    fn serialized(&self) -> Result<Vec<u8>, String> {
        let paths = self
            .order
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        serde_json::to_vec(&paths)
            .map_err(|error| format!("failed to encode the attachment registry: {error}"))
    }
}

pub(crate) struct AttachmentPathState {
    approved: Mutex<ApprovedPaths>,
    pub(crate) cache_lock: Mutex<()>,
    /// Serializes registry loading and every registry mutation/write.
    registry_lock: Mutex<()>,
    registry_loaded: AtomicBool,
    registry_path: PathBuf,
}

impl AttachmentPathState {
    pub(crate) fn new(app: &AppHandle) -> Self {
        let cache_dir = app
            .path()
            .app_cache_dir()
            .unwrap_or_else(|_| std::env::temp_dir());
        Self {
            approved: Mutex::new(ApprovedPaths::new(MAX_APPROVED_ATTACHMENTS)),
            cache_lock: Mutex::new(()),
            registry_lock: Mutex::new(()),
            registry_loaded: AtomicBool::new(false),
            registry_path: cache_dir.join("approved-attachments.json"),
        }
    }

    fn ensure_registry_loaded(&self, app: &AppHandle) -> Result<(), String> {
        if self.registry_loaded.load(Ordering::Acquire) {
            return Ok(());
        }
        let _registry_guard = self
            .registry_lock
            .lock()
            .map_err(|_| "attachment registry state is poisoned".to_owned())?;
        if self.registry_loaded.load(Ordering::Relaxed) {
            return Ok(());
        }

        let (restored, compacted) = load_registry(&self.registry_path, MAX_APPROVED_ATTACHMENTS);
        for path in &restored.order {
            let _ = app.asset_protocol_scope().allow_file(path);
        }
        if compacted {
            // Best effort: the in-memory set is already correct.
            if let Err(error) = restored
                .serialized()
                .and_then(|bytes| write_registry_atomically(&self.registry_path, &bytes))
            {
                logging::error(module_path!(), error);
            }
        }
        {
            let mut approved = self
                .approved
                .lock()
                .map_err(|_| "attachment path state is poisoned".to_owned())?;
            for path in restored.order {
                approved.insert(path);
            }
        }
        self.registry_loaded.store(true, Ordering::Release);
        Ok(())
    }

    pub(crate) fn approve_selected_batch(
        &self,
        app: &AppHandle,
        paths: &[String],
    ) -> Result<Vec<PathBuf>, String> {
        self.ensure_registry_loaded(app)?;
        let canonical = paths
            .iter()
            .map(|path| {
                fs::canonicalize(path).map_err(|error| format!("failed to resolve {path}: {error}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        {
            let approved = self
                .approved
                .lock()
                .map_err(|_| "attachment path state is poisoned".to_owned())?;
            for (source, path) in paths.iter().zip(&canonical) {
                if !approved.contains(path) && !app.asset_protocol_scope().is_allowed(path) {
                    return Err(format!("{source} was not selected by the user"));
                }
            }
        }
        self.approve_paths(app, canonical.iter().cloned())?;
        Ok(canonical)
    }

    pub(crate) fn approve_cached(&self, app: &AppHandle, path: &Path) -> Result<PathBuf, String> {
        let canonical = fs::canonicalize(path)
            .map_err(|error| format!("failed to resolve {}: {error}", path.display()))?;
        self.approve(app, canonical.clone())?;
        Ok(canonical)
    }

    pub(crate) fn approved_path(&self, app: &AppHandle, path: &Path) -> Result<PathBuf, String> {
        self.ensure_registry_loaded(app)?;
        let canonical = fs::canonicalize(path)
            .map_err(|error| format!("failed to resolve {}: {error}", path.display()))?;
        let approved = self
            .approved
            .lock()
            .map_err(|_| "attachment path state is poisoned".to_owned())?;
        if approved.contains(&canonical) {
            Ok(canonical)
        } else {
            Err(format!("{} is not an approved attachment", path.display()))
        }
    }

    pub(crate) fn approve(&self, app: &AppHandle, path: PathBuf) -> Result<(), String> {
        self.approve_paths(app, std::iter::once(path))
    }

    fn approve_paths(
        &self,
        app: &AppHandle,
        paths: impl IntoIterator<Item = PathBuf>,
    ) -> Result<(), String> {
        self.ensure_registry_loaded(app)?;
        let paths = paths.into_iter().collect::<Vec<_>>();
        for path in &paths {
            app.asset_protocol_scope()
                .allow_file(path)
                .map_err(|error| format!("failed to allow attachment preview: {error}"))?;
        }
        let _registry_guard = self
            .registry_lock
            .lock()
            .map_err(|_| "attachment registry state is poisoned".to_owned())?;
        // Writers are serialized by the registry lock; readers keep using the
        // current set while the candidate is written.
        let mut candidate = self
            .approved
            .lock()
            .map_err(|_| "attachment path state is poisoned".to_owned())?
            .clone();
        let mut changed = false;
        for path in paths {
            changed |= candidate.insert(path);
        }
        if !changed {
            return Ok(());
        }
        candidate
            .serialized()
            .and_then(|bytes| write_registry_atomically(&self.registry_path, &bytes))
            .inspect_err(|error| logging::error(module_path!(), error.clone()))?;
        *self
            .approved
            .lock()
            .map_err(|_| "attachment path state is poisoned".to_owned())? = candidate;
        Ok(())
    }
}

/// Read the registry, keeping the newest `capacity` paths that still exist.
/// Returns whether the file should be rewritten (stale, duplicate, overflow or
/// unreadable entries were dropped).
fn load_registry(path: &Path, capacity: usize) -> (ApprovedPaths, bool) {
    let mut restored = ApprovedPaths::new(capacity);
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return (restored, false),
        Err(error) => {
            logging::error(
                module_path!(),
                format!("failed to read the attachment registry: {error}"),
            );
            return (restored, false);
        }
    };
    let entries = match serde_json::from_str::<Vec<String>>(&raw) {
        Ok(entries) => entries,
        Err(error) => {
            logging::error(
                module_path!(),
                format!("ignoring an unreadable attachment registry: {error}"),
            );
            return (restored, true);
        }
    };
    let total = entries.len();
    // Only the newest entries can survive the cap: skip resolving the rest.
    for entry in entries.into_iter().skip(total.saturating_sub(capacity)) {
        if let Ok(canonical) = fs::canonicalize(entry) {
            restored.insert(canonical);
        }
    }
    let compacted = restored.order.len() != total;
    (restored, compacted)
}

fn write_registry_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "attachment registry path has no parent directory".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create the attachment registry directory: {error}"))?;
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "approved-attachments.json".to_owned());
    let temporary = parent.join(format!(".{file_name}.{}.tmp", std::process::id()));
    let result = (|| {
        let mut file = fs::File::create(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(format!("failed to save the attachment registry: {error}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_directory(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "pix-attachment-approvals-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();
        fs::canonicalize(directory).unwrap()
    }

    #[test]
    fn approvals_are_bounded_by_insertion_order() {
        let mut approved = ApprovedPaths::new(3);
        for name in ["a", "b", "c"] {
            assert!(approved.insert(PathBuf::from(name)));
        }
        assert!(!approved.insert(PathBuf::from("a")));
        assert!(approved.insert(PathBuf::from("d")));
        assert!(!approved.contains(Path::new("a")));
        for name in ["b", "c", "d"] {
            assert!(approved.contains(Path::new(name)));
        }
        assert_eq!(approved.order.len(), 3);
        assert_eq!(approved.members.len(), 3);
    }

    #[test]
    fn loading_drops_missing_files_and_keeps_only_the_newest_entries() {
        let directory = temporary_directory("load");
        let files = (0..4)
            .map(|n| {
                let file = directory.join(format!("file-{n}.png"));
                fs::write(&file, b"x").unwrap();
                file
            })
            .collect::<Vec<_>>();
        fs::remove_file(&files[3]).unwrap();
        let registry = directory.join("approved-attachments.json");
        let entries = files
            .iter()
            .map(|file| file.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        fs::write(&registry, serde_json::to_vec(&entries).unwrap()).unwrap();

        let (restored, compacted) = load_registry(&registry, 3);
        // file-0 is beyond the newest three; file-3 no longer exists.
        assert_eq!(
            restored.order,
            VecDeque::from(vec![files[1].clone(), files[2].clone()])
        );
        assert!(compacted);

        write_registry_atomically(&registry, &restored.serialized().unwrap()).unwrap();
        let (reloaded, compacted) = load_registry(&registry, 3);
        assert_eq!(reloaded.order, restored.order);
        assert!(!compacted);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn atomic_write_replaces_the_registry_without_leaving_temporary_files() {
        let directory = temporary_directory("atomic");
        let registry = directory.join("nested").join("approved-attachments.json");
        write_registry_atomically(&registry, b"[\"one\"]").unwrap();
        write_registry_atomically(&registry, b"[\"two\"]").unwrap();
        assert_eq!(fs::read(&registry).unwrap(), b"[\"two\"]");
        let leftovers = fs::read_dir(registry.parent().unwrap())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn missing_or_corrupt_registry_loads_empty() {
        let directory = temporary_directory("corrupt");
        let registry = directory.join("approved-attachments.json");
        assert!(load_registry(&registry, 8).0.order.is_empty());
        fs::write(&registry, b"[\"truncat").unwrap();
        let (restored, compacted) = load_registry(&registry, 8);
        assert!(restored.order.is_empty());
        assert!(compacted);
        fs::remove_dir_all(directory).unwrap();
    }
}
