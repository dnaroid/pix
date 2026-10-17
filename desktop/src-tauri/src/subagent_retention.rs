//! Parent-scoped retention for `.pi/subagents/<parentSessionId>/` (decision 0072).
//!
//! Async sub-agent child sessions live in a project directory named after the
//! parent session id. Background cleanup keeps such a directory while its
//! parent session file exists, and removes it once the parent is gone and the
//! subtree has been idle for [`SUBAGENT_ORPHAN_GRACE`]. Timestamp-named legacy
//! run directories keep the ordinary background TTL. Manual Clean ignores this
//! policy and empties `.pi/subagents/` immediately, except owned-launch records.
//!
//! Owned-launch records (`<parentSessionId>/owned/`) are written by the native
//! launchd supervisor and must survive parent death until the sub-agent tooling
//! proves the launch drained and retired. Neither cleanup path removes them:
//! background cleanup keeps the whole parent-scoped directory, Manual Clean
//! removes everything in it except `owned/` (unknown ownership fails closed).

use serde_json::Value;
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};

/// Idle time before an orphaned parent-scoped directory is reclaimed. Covers
/// headless parents that never persisted a session file and long tool calls.
pub(crate) const SUBAGENT_ORPHAN_GRACE: Duration = Duration::from_secs(24 * 60 * 60);
/// `subagent_meta` is appended at child session start, so the head suffices.
const META_SCAN_LIMIT: u64 = 256 * 1024;
const SUBAGENT_META_ENTRY: &str = "subagent_meta";
/// Owned-launch records inside a parent-scoped directory.
pub(crate) const OWNED_RECORDS_DIR: &str = "owned";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SubagentDirRetention {
    /// Not a parent-scoped directory (legacy run dir) or not inspectable: ordinary TTL.
    Legacy,
    /// Holds owned-launch records: never auto-clean (fail closed).
    OwnedRecords,
    /// The parent session file still exists: never auto-clean.
    ParentPresent,
    /// No parent session file could be found: reclaim after the orphan grace.
    ParentMissing,
}

/// Parent session ids are UUIDs (`8-4-4-4-12` hex); legacy run dirs are timestamp-named.
pub(crate) fn is_parent_session_dir_name(name: &str) -> bool {
    let groups: Vec<&str> = name.split('-').collect();
    groups.len() == 5
        && groups
            .iter()
            .zip([8usize, 4, 4, 4, 12])
            .all(|(group, len)| group.len() == len && group.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Pi's default session directory name for `cwd` (`--<path with / \ : as ->--`).
pub(crate) fn pi_session_dir_name(cwd: &Path) -> String {
    let text = cwd.to_string_lossy();
    let trimmed = text
        .strip_prefix('/')
        .or_else(|| text.strip_prefix('\\'))
        .unwrap_or(&text);
    format!("--{}--", trimmed.replace(['/', '\\', ':'], "-"))
}

/// Lazily-built set of session ids in the project's default Pi session directories.
pub(crate) struct ParentSessionIndex {
    session_dirs: Vec<PathBuf>,
    ids: Option<HashSet<String>>,
}

impl ParentSessionIndex {
    pub(crate) fn new(agent_dir: Option<&Path>, workspaces: &[&Path]) -> Self {
        let mut session_dirs: Vec<PathBuf> = Vec::new();
        if let Some(agent_dir) = agent_dir {
            for workspace in workspaces {
                let dir = agent_dir
                    .join("sessions")
                    .join(pi_session_dir_name(workspace));
                if !session_dirs.contains(&dir) {
                    session_dirs.push(dir);
                }
            }
        }
        Self {
            session_dirs,
            ids: None,
        }
    }

    fn contains(&mut self, id: &str) -> bool {
        let session_dirs = &self.session_dirs;
        self.ids
            .get_or_insert_with(|| {
                let mut ids = HashSet::new();
                for dir in session_dirs {
                    let Ok(entries) = fs::read_dir(dir) else {
                        continue;
                    };
                    for entry in entries.flatten() {
                        let name = entry.file_name();
                        let Some(stem) = name.to_str().and_then(|n| n.strip_suffix(".jsonl"))
                        else {
                            continue;
                        };
                        if let Some((_, session_id)) = stem.rsplit_once('_') {
                            ids.insert(session_id.to_owned());
                        }
                    }
                }
                ids
            })
            .contains(id)
    }
}

/// Classify a direct child of `.pi/subagents/` for background cleanup.
pub(crate) fn classify_subagent_dir(
    dir: &Path,
    index: &mut ParentSessionIndex,
) -> SubagentDirRetention {
    let Some(name) = dir.file_name().and_then(|name| name.to_str()) else {
        return SubagentDirRetention::Legacy;
    };
    if !is_parent_session_dir_name(name) {
        return SubagentDirRetention::Legacy;
    }
    match fs::symlink_metadata(dir) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        _ => return SubagentDirRetention::Legacy,
    }
    if has_owned_records(dir) {
        return SubagentDirRetention::OwnedRecords;
    }
    if index.contains(name) {
        return SubagentDirRetention::ParentPresent;
    }
    let Some(recorded) = recorded_parent_sessions(dir) else {
        return SubagentDirRetention::Legacy;
    };
    if recorded
        .iter()
        .any(|parent| fs::metadata(parent).is_ok_and(|metadata| metadata.is_file()))
    {
        return SubagentDirRetention::ParentPresent;
    }
    SubagentDirRetention::ParentMissing
}

/// True when a parent-scoped directory holds owned-launch records. An
/// unreadable or non-directory `owned` entry counts as present (fail closed).
pub(crate) fn has_owned_records(scope_dir: &Path) -> bool {
    let owned = scope_dir.join(OWNED_RECORDS_DIR);
    match fs::symlink_metadata(&owned) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            match fs::read_dir(&owned) {
                Ok(mut entries) => entries.next().is_some(),
                Err(_) => true,
            }
        }
        _ => true,
    }
}

/// Absolute parent session paths recorded in children's `subagent_meta` entries.
/// `None` when the directory cannot be read (callers fall back to the ordinary TTL).
fn recorded_parent_sessions(dir: &Path) -> Option<Vec<PathBuf>> {
    let entries = fs::read_dir(dir).ok()?;
    let mut parents = Vec::new();
    for entry in entries {
        let entry = entry.ok()?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            continue;
        }
        let mut head = Vec::new();
        let Ok(file) = fs::File::open(&path) else {
            continue;
        };
        if file.take(META_SCAN_LIMIT).read_to_end(&mut head).is_err() {
            continue;
        }
        for line in String::from_utf8_lossy(&head).lines() {
            if !line.contains(SUBAGENT_META_ENTRY) {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            if value.get("type").and_then(Value::as_str) != Some("custom")
                || value.get("customType").and_then(Value::as_str) != Some(SUBAGENT_META_ENTRY)
            {
                continue;
            }
            let Some(parent) = value
                .get("data")
                .and_then(|data| data.get("parentSession"))
                .and_then(Value::as_str)
            else {
                continue;
            };
            let parent = PathBuf::from(parent);
            if parent.is_absolute() && parent.extension().and_then(|e| e.to_str()) == Some("jsonl")
            {
                parents.push(parent);
            }
        }
    }
    Some(parents)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    const PARENT: &str = "0199f0c2-1111-7222-8333-944445555666";

    fn temporary_dir(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "pix-subagent-retention-{name}-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create temporary directory");
        fs::canonicalize(path).expect("canonicalize temporary directory")
    }

    fn write_child(dir: &Path, parent_session: &Path) {
        fs::create_dir_all(dir).expect("create parent-scoped dir");
        let header = serde_json::json!({ "type": "session", "id": "child", "cwd": "/p" });
        let meta = serde_json::json!({
            "type": "custom",
            "customType": SUBAGENT_META_ENTRY,
            "data": { "version": 1, "agentId": "a1", "parentSession": parent_session },
        });
        fs::write(dir.join("child.jsonl"), format!("{header}\n{meta}\n")).expect("write child");
    }

    #[test]
    fn recognizes_only_uuid_parent_dirs() {
        assert!(is_parent_session_dir_name(PARENT));
        assert!(!is_parent_session_dir_name(
            "2026-10-17T12-59-54-subagent-redesign-risks"
        ));
        assert!(!is_parent_session_dir_name("old-run"));
        assert!(!is_parent_session_dir_name(&format!("{PARENT}x")));
    }

    #[test]
    fn encodes_pi_default_session_dir_names() {
        assert_eq!(
            pi_session_dir_name(Path::new("/Users/u/proj")),
            "--Users-u-proj--"
        );
    }

    #[test]
    fn classifies_by_recorded_parent_and_default_session_dir() {
        let root = temporary_dir("classify");
        let workspace = root.join("workspace");
        let agent_dir = root.join("agent");
        let subagents = workspace.join(".pi/subagents");
        fs::create_dir_all(&subagents).unwrap();
        let mut index = ParentSessionIndex::new(Some(&agent_dir), &[&workspace]);

        let legacy = subagents.join("2026-10-17T00-00-00-run");
        fs::create_dir_all(&legacy).unwrap();
        assert_eq!(
            classify_subagent_dir(&legacy, &mut index),
            SubagentDirRetention::Legacy
        );

        let parent_file = root.join("custom-store/2026-10-17T00-00-00-000Z_parent.jsonl");
        fs::create_dir_all(parent_file.parent().unwrap()).unwrap();
        fs::write(&parent_file, "{}\n").unwrap();
        let recorded = subagents.join(PARENT);
        write_child(&recorded, &parent_file);
        assert_eq!(
            classify_subagent_dir(&recorded, &mut index),
            SubagentDirRetention::ParentPresent
        );
        fs::remove_file(&parent_file).unwrap();
        assert_eq!(
            classify_subagent_dir(&recorded, &mut index),
            SubagentDirRetention::ParentMissing
        );

        // A parent in the default session dir keeps a child without metadata.
        let unflushed = "0199f0c2-aaaa-7222-8333-944445555666";
        fs::create_dir_all(subagents.join(unflushed)).unwrap();
        let sessions = agent_dir
            .join("sessions")
            .join(pi_session_dir_name(&workspace));
        fs::create_dir_all(&sessions).unwrap();
        fs::write(
            sessions.join(format!("2026-10-17T00-00-00-000Z_{unflushed}.jsonl")),
            "{}\n",
        )
        .unwrap();
        let mut index = ParentSessionIndex::new(Some(&agent_dir), &[&workspace]);
        assert_eq!(
            classify_subagent_dir(&subagents.join(unflushed), &mut index),
            SubagentDirRetention::ParentPresent
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn owned_records_keep_parent_scoped_dir() {
        let root = temporary_dir("owned");
        let subagents = root.join("workspace/.pi/subagents");
        let scope = subagents.join(PARENT);
        write_child(&scope, &root.join("missing-parent.jsonl"));
        let mut index = ParentSessionIndex::new(None, &[]);
        assert_eq!(
            classify_subagent_dir(&scope, &mut index),
            SubagentDirRetention::ParentMissing
        );
        // An empty owned/ directory is not a record.
        fs::create_dir_all(scope.join(OWNED_RECORDS_DIR)).unwrap();
        assert!(!has_owned_records(&scope));
        fs::create_dir_all(scope.join("owned/batch/a1/owned-launch")).unwrap();
        assert!(has_owned_records(&scope));
        assert_eq!(
            classify_subagent_dir(&scope, &mut index),
            SubagentDirRetention::OwnedRecords
        );
        fs::remove_dir_all(root).unwrap();
    }
}
