//! Stable project identity (`.pi/project-id`) and relocation of path-keyed Pi
//! state after a project folder is renamed or moved outside Pix.
//!
//! Pi keys sessions by the encoded absolute cwd and stores the cwd in every
//! session header; the TUI/Desktop queue snapshot is keyed by a hash of the cwd.
//! Relocation moves both to the new path without overwriting existing state.
use super::run_blocking;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, FileTimes, OpenOptions},
    io::{self, BufRead, BufReader, Read, Write},
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

const PROJECT_ID_FILE: &str = "project-id";
const MAX_HEADER_BYTES: u64 = 1024 * 1024;
const MAX_TAB_SNAPSHOT_BYTES: u64 = 16 * 1024 * 1024;
static RELOCATION: Mutex<()> = Mutex::new(());

#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RelocationReport {
    pub moved_sessions: usize,
    /// Entries left at the old location because the destination already had them.
    pub conflicts: Vec<String>,
    /// Entries left in place because they do not belong to the old project
    /// (the SDK encoding is lossy: `/a-b` and `/a/b` share a directory).
    pub skipped: Vec<String>,
    pub tab_snapshot_moved: bool,
    /// ACP session-map records rewritten to the new paths (IDs preserved).
    pub session_map_updated: usize,
}

#[tauri::command]
pub(crate) async fn project_identity(workspace: String) -> Result<Option<String>, String> {
    run_blocking(move || read_or_create_identity(Path::new(&workspace))).await
}

#[tauri::command]
pub(crate) async fn relocate_project_state(
    window: tauri::WebviewWindow,
    from: String,
    to: String,
) -> Result<RelocationReport, String> {
    use tauri::Manager;
    // Another window may still append to the old sessions; never move them underneath it.
    if window
        .state::<super::window_restore::WindowRestoreState>()
        .workspace_open_elsewhere(window.label(), &from)
    {
        return Err(format!(
            "{from} is still open in another Pix window; close it there and try again"
        ));
    }
    run_blocking(move || {
        let agent_dir = super::native_repository_semantic_config::pi_agent_dir()
            .ok_or("the Pi agent directory is unavailable")?;
        relocate_state(&agent_dir, Path::new(&from), Path::new(&to))
    })
    .await
}

/// Returns the project's UUID. It is created only inside an existing, real
/// `.pi` directory: opening a project never creates project storage.
pub(crate) fn read_or_create_identity(root: &Path) -> Result<Option<String>, String> {
    if !root.is_absolute() {
        return Err("project path must be absolute".into());
    }
    let directory = root.join(".pi");
    match fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        Ok(_) => return Ok(None),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "failed to inspect {}: {error}",
                directory.display()
            ))
        }
    }
    let path = directory.join(PROJECT_ID_FILE);
    if let Some(id) = read_identity(&path)? {
        return Ok(Some(id));
    }
    let id = uuid::Uuid::new_v4().hyphenated().to_string();
    let temporary = directory.join(format!(".{PROJECT_ID_FILE}.{id}.tmp"));
    let written = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(format!("{id}\n").as_bytes())?;
        file.sync_all()
    })();
    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);
        return Err(format!("failed to write {}: {error}", path.display()));
    }
    // Publish atomically and never replace an identity created concurrently.
    let linked = fs::hard_link(&temporary, &path);
    let _ = fs::remove_file(&temporary);
    match linked {
        Ok(()) => Ok(Some(id)),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => read_identity(&path),
        Err(error) => Err(format!("failed to write {}: {error}", path.display())),
    }
}

fn read_identity(path: &Path) -> Result<Option<String>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("failed to inspect {}: {error}", path.display())),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(".pi/project-id must be a regular file".into());
    }
    let mut content = String::new();
    File::open(path)
        .and_then(|file| file.take(256).read_to_string(&mut content))
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    uuid::Uuid::parse_str(content.trim())
        .map(|id| Some(id.hyphenated().to_string()))
        .map_err(|_| ".pi/project-id does not contain a valid project ID".into())
}

/// Moves Pi sessions and the tab/queue snapshot from `from` to `to`.
/// `from` must no longer exist, so live state can never be split between two folders.
pub(crate) fn relocate_state(
    agent_dir: &Path,
    from: &Path,
    to: &Path,
) -> Result<RelocationReport, String> {
    let from = normalized_absolute(from)?;
    let to = normalized_absolute(to)?;
    if from == to {
        return Err("the old and new project folders are the same".into());
    }
    if fs::symlink_metadata(&from).is_ok() {
        return Err(format!(
            "{} still exists; only a moved or renamed project can be relocated",
            from.display()
        ));
    }
    if !fs::metadata(&to)
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false)
    {
        return Err(format!("{} is not a folder", to.display()));
    }
    let from_text = utf8(&from)?;
    let to_text = utf8(&to)?;
    let source_dir = agent_dir.join("sessions").join(session_dir_name(from_text));
    let target_dir = agent_dir.join("sessions").join(session_dir_name(to_text));
    if source_dir == target_dir {
        return Err("both folders map to the same Pi session directory".into());
    }

    let _guard = RELOCATION
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut report = RelocationReport::default();
    let mut moved_paths: Vec<(PathBuf, PathBuf)> = Vec::new();
    if is_real_directory(&source_dir) {
        fs::create_dir_all(&target_dir)
            .map_err(|error| format!("failed to create {}: {error}", target_dir.display()))?;
        let entries = fs::read_dir(&source_dir)
            .map_err(|error| format!("failed to read {}: {error}", source_dir.display()))?;
        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            let name = entry.file_name();
            let display_name = name.to_string_lossy().into_owned();
            if !entry
                .file_type()
                .map(|kind| kind.is_file())
                .unwrap_or(false)
            {
                report.conflicts.push(display_name);
                continue;
            }
            let source = entry.path();
            if !display_name.ends_with(".jsonl") {
                report.skipped.push(display_name);
                continue;
            }
            let destination = target_dir.join(&name);
            match move_session(&source, &destination, from_text, to_text)
                .map_err(|error| format!("failed to move {}: {error}", source.display()))?
            {
                SessionMove::Moved => {
                    report.moved_sessions += 1;
                    moved_paths.push((source.clone(), destination.clone()));
                }
                SessionMove::Conflict => report.conflicts.push(display_name),
                SessionMove::Foreign => report.skipped.push(display_name),
            }
        }
        // Leave the directory in place when conflicting entries remain.
        let _ = fs::remove_dir(&source_dir);
    }
    report.tab_snapshot_moved = relocate_tab_snapshot(
        agent_dir,
        from_text,
        to_text,
        &source_dir,
        &target_dir,
        &mut report.conflicts,
    )?;
    report.session_map_updated =
        relocate_session_map(&acp_session_map_path(), from_text, to_text, &moved_paths)?;
    Ok(report)
}

/// Mirrors `defaultSessionMapPath` / `PIX_ACP_SESSION_MAP` in acp/src/config.ts.
fn acp_session_map_path() -> PathBuf {
    if let Some(path) = std::env::var("PIX_ACP_SESSION_MAP")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    {
        return PathBuf::from(path);
    }
    let home = std::env::var("HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .or_else(std::env::home_dir)
        .unwrap_or_default();
    home.join(".pi/agent/pix-acp/sessions.json")
}

/// Rewrites ACP map records of moved sessions under the same `<file>.lock`
/// directory lock that proper-lockfile uses, so ACP IDs (and Desktop tabs) survive.
pub(crate) fn relocate_session_map(
    map_path: &Path,
    from: &str,
    to: &str,
    moved: &[(PathBuf, PathBuf)],
) -> Result<usize, String> {
    if moved.is_empty() || !map_path.is_file() {
        return Ok(0);
    }
    let lock = PathBuf::from(format!("{}.lock", map_path.display()));
    let mut acquired = false;
    for _ in 0..240 {
        match fs::create_dir(&lock) {
            Ok(()) => {
                acquired = true;
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err(error) => return Err(format!("failed to lock {}: {error}", map_path.display())),
        }
    }
    if !acquired {
        return Err(
            "the ACP session map is busy; sessions moved but their tab IDs may change".into(),
        );
    }
    let result = (|| -> Result<usize, String> {
        let content = fs::read_to_string(map_path).map_err(|error| error.to_string())?;
        let mut value: serde_json::Value = serde_json::from_str(&content)
            .map_err(|error| format!("invalid ACP session map: {error}"))?;
        let rename: std::collections::HashMap<String, String> = moved
            .iter()
            .filter_map(|(a, b)| Some((a.to_str()?.to_owned(), b.to_str()?.to_owned())))
            .collect();
        let mut updated = 0;
        if let Some(records) = value.get_mut("sessions").and_then(|s| s.as_array_mut()) {
            for record in records {
                let Some(object) = record.as_object_mut() else {
                    continue;
                };
                let mut changed = false;
                for key in ["piSessionPath", "parentSessionPath"] {
                    let next = object
                        .get(key)
                        .and_then(|v| v.as_str())
                        .and_then(|v| rename.get(v))
                        .cloned();
                    if let Some(next) = next {
                        object.insert(key.into(), serde_json::Value::String(next));
                        changed = key == "piSessionPath" || changed;
                    }
                }
                if changed && object.get("cwd").and_then(|v| v.as_str()) == Some(from) {
                    object.insert("cwd".into(), serde_json::Value::String(to.to_owned()));
                }
                if changed {
                    updated += 1;
                }
            }
        }
        if updated == 0 {
            return Ok(0);
        }
        let directory = map_path.parent().unwrap_or(Path::new("."));
        let temporary = directory.join(format!(".relocate-{}.tmp", uuid::Uuid::new_v4().simple()));
        let mut serialized =
            serde_json::to_string_pretty(&value).map_err(|error| error.to_string())?;
        serialized.push('\n');
        fs::write(&temporary, serialized)
            .and_then(|()| fs::rename(&temporary, map_path))
            .map_err(|error| {
                let _ = fs::remove_file(&temporary);
                error.to_string()
            })?;
        Ok(updated)
    })();
    let _ = fs::remove_dir(&lock);
    result
}

fn normalized_absolute(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("project paths must be absolute".into());
    }
    // Lexical like Node's `resolve`: drops trailing separators and `.`, folds `..`.
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => {}
            other => normalized.push(other),
        }
    }
    Ok(normalized)
}

fn utf8(path: &Path) -> Result<&str, String> {
    path.to_str()
        .ok_or_else(|| format!("{} is not valid UTF-8", path.display()))
}

/// Mirrors the Pi SDK `getDefaultSessionDirPath` encoding.
fn session_dir_name(cwd: &str) -> String {
    let trimmed = cwd
        .strip_prefix('/')
        .or_else(|| cwd.strip_prefix('\\'))
        .unwrap_or(cwd);
    format!("--{}--", trimmed.replace(['/', '\\', ':'], "-"))
}

/// Mirrors `tuiTabSnapshotPath` in the ACP queue store.
fn tab_snapshot_path(agent_dir: &Path, cwd: &str) -> PathBuf {
    let digest = Sha256::digest(cwd.as_bytes());
    let key: String = digest[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    agent_dir
        .join("pix")
        .join("tabs")
        .join(format!("{key}.json"))
}

fn is_real_directory(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
        .unwrap_or(false)
}

enum SessionMove {
    Moved,
    Conflict,
    Foreign,
}

/// Copies a session of `from` with its header `cwd` rewritten, preserving
/// timestamps so ordering is unchanged, then publishes it without overwriting.
/// Sessions whose header belongs to another cwd are left untouched.
fn move_session(
    source: &Path,
    destination: &Path,
    from: &str,
    to: &str,
) -> io::Result<SessionMove> {
    let file = File::open(source)?;
    let metadata = file.metadata()?;
    let mut reader = BufReader::new(file);
    let mut header = Vec::new();
    (&mut reader)
        .take(MAX_HEADER_BYTES)
        .read_until(b'\n', &mut header)?;
    let Some(rewritten) = rewrite_header(&header, from, to) else {
        return Ok(SessionMove::Foreign);
    };
    if fs::symlink_metadata(destination).is_ok() {
        return Ok(SessionMove::Conflict);
    }
    let directory = destination.parent().unwrap_or(Path::new("."));
    let temporary = directory.join(format!(".relocate-{}.tmp", uuid::Uuid::new_v4().simple()));
    let written = (|| {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        output.write_all(&rewritten)?;
        io::copy(&mut reader, &mut output)?;
        output.set_permissions(metadata.permissions())?;
        output.set_times(
            FileTimes::new()
                .set_accessed(metadata.accessed()?)
                .set_modified(metadata.modified()?),
        )?;
        output.sync_all()
    })();
    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    let linked = fs::hard_link(&temporary, destination);
    let _ = fs::remove_file(&temporary);
    if let Err(error) = linked {
        return if error.kind() == io::ErrorKind::AlreadyExists {
            Ok(SessionMove::Conflict)
        } else {
            Err(error)
        };
    }
    // A concurrent append after the copy would be lost: keep the source instead.
    let after = fs::metadata(source)?;
    if after.len() != metadata.len() || after.modified()? != metadata.modified()? {
        let _ = fs::remove_file(destination);
        return Err(io::Error::other("session changed during relocation; retry"));
    }
    fs::remove_file(source).map(|()| SessionMove::Moved)
}

/// Rewrites the header line only when it is a session header for `from`.
fn rewrite_header(line: &[u8], from: &str, to: &str) -> Option<Vec<u8>> {
    let text = std::str::from_utf8(line).ok()?;
    let body = text.trim_end_matches(['\n', '\r']);
    let ending = &text[body.len()..];
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let object = value.as_object()?;
    if object.get("type")?.as_str()? != "session" || object.get("cwd")?.as_str()? != from {
        return None;
    }
    // Prefer an exact textual replacement so field order is preserved.
    let old_field = format!("\"cwd\":{}", serde_json::to_string(from).ok()?);
    let new_field = format!("\"cwd\":{}", serde_json::to_string(to).ok()?);
    let replaced = if body.matches(&old_field).count() == 1 {
        body.replacen(&old_field, &new_field, 1)
    } else {
        let mut value = value;
        value["cwd"] = serde_json::Value::String(to.to_owned());
        serde_json::to_string(&value).ok()?
    };
    Some(format!("{replaced}{ending}").into_bytes())
}

fn relocate_tab_snapshot(
    agent_dir: &Path,
    from: &str,
    to: &str,
    source_dir: &Path,
    target_dir: &Path,
    conflicts: &mut Vec<String>,
) -> Result<bool, String> {
    let source = tab_snapshot_path(agent_dir, from);
    let destination = tab_snapshot_path(agent_dir, to);
    match fs::symlink_metadata(&source) {
        Ok(metadata) if metadata.is_file() && metadata.len() <= MAX_TAB_SNAPSHOT_BYTES => {}
        _ => return Ok(false),
    }
    if fs::symlink_metadata(&destination).is_ok() {
        conflicts.push("tab snapshot".into());
        return Ok(false);
    }
    let content = fs::read_to_string(&source).map_err(|error| error.to_string())?;
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&content) else {
        return Ok(false);
    };
    let (Some(source_prefix), Some(target_prefix)) = (source_dir.to_str(), target_dir.to_str())
    else {
        return Ok(false);
    };
    let rebase = |path: &mut serde_json::Value| {
        if let Some(rest) = path
            .as_str()
            .and_then(|text| text.strip_prefix(source_prefix))
            .filter(|rest| rest.starts_with('/'))
        {
            *path = serde_json::Value::String(format!("{target_prefix}{rest}"));
        }
    };
    if let Some(object) = value.as_object_mut() {
        if object.contains_key("cwd") {
            object.insert("cwd".into(), serde_json::Value::String(to.to_owned()));
        }
        if let Some(active) = object.get_mut("activePath") {
            rebase(active);
        }
        if let Some(tabs) = object.get_mut("tabs").and_then(|tabs| tabs.as_array_mut()) {
            for tab in tabs {
                if let Some(path) = tab.get_mut("path") {
                    rebase(path);
                }
            }
        }
    }
    let directory = destination.parent().unwrap_or(agent_dir);
    let temporary = directory.join(format!(".relocate-{}.tmp", uuid::Uuid::new_v4().simple()));
    let serialized = serde_json::to_vec_pretty(&value).map_err(|error| error.to_string())?;
    let written = fs::write(&temporary, serialized);
    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    let linked = fs::hard_link(&temporary, &destination);
    let _ = fs::remove_file(&temporary);
    match linked {
        Ok(()) => fs::remove_file(&source)
            .map(|()| true)
            .map_err(|error| error.to_string()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            conflicts.push("tab snapshot".into());
            Ok(false)
        }
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
#[path = "project_relocation_tests.rs"]
mod tests;
