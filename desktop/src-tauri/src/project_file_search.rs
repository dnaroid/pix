//! Project Explorer literal search: a bounded walk that a newer search from
//! the same window supersedes, so debounced keystrokes never pile up scans.
use super::{canonical_workspace, run_blocking};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};

const MAX_PROJECT_SEARCH_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_PROJECT_SEARCH_FILES: usize = 20_000;
const MAX_PROJECT_SEARCH_RESULTS: usize = 500;
const SUPERSEDED: &str = "Project search was superseded";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectSearchMatch {
    pub(crate) path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) column: Option<usize>,
    pub(crate) preview: String,
}

/// Latest search generation per window. A walk stops as soon as its window
/// starts another search or cancels; entries are dropped with the window.
#[derive(Default)]
pub(crate) struct ProjectFileSearchState {
    windows: Mutex<HashMap<String, Arc<AtomicU64>>>,
}

impl ProjectFileSearchState {
    fn counter(&self, label: &str) -> Arc<AtomicU64> {
        let mut windows = self
            .windows
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        windows.entry(label.to_owned()).or_default().clone()
    }

    fn begin(&self, label: &str) -> SearchTicket {
        let latest = self.counter(label);
        let generation = latest.fetch_add(1, Ordering::SeqCst) + 1;
        SearchTicket { latest, generation }
    }

    fn cancel(&self, label: &str) {
        self.counter(label).fetch_add(1, Ordering::SeqCst);
    }

    pub(crate) fn destroyed(&self, label: &str) {
        let removed = self
            .windows
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(label);
        if let Some(latest) = removed {
            latest.fetch_add(1, Ordering::SeqCst);
        }
    }
}

struct SearchTicket {
    latest: Arc<AtomicU64>,
    generation: u64,
}

impl SearchTicket {
    fn superseded(&self) -> bool {
        self.latest.load(Ordering::SeqCst) != self.generation
    }
}

#[tauri::command]
pub(crate) async fn search_project_files(
    window: tauri::Window,
    state: tauri::State<'_, ProjectFileSearchState>,
    workspace: String,
    query: String,
) -> Result<Vec<ProjectSearchMatch>, String> {
    let ticket = state.begin(window.label());
    run_blocking(move || {
        search_project_files_with(Path::new(&workspace), &query, &|| ticket.superseded())
    })
    .await
}

#[tauri::command]
pub(crate) fn cancel_search_project_files(
    window: tauri::Window,
    state: tauri::State<'_, ProjectFileSearchState>,
) {
    state.cancel(window.label());
}

#[cfg(test)]
pub(crate) fn search_project_files_from(
    workspace: &Path,
    query: &str,
) -> Result<Vec<ProjectSearchMatch>, String> {
    search_project_files_with(workspace, query, &|| false)
}

fn search_project_files_with(
    workspace: &Path,
    query: &str,
    superseded: &dyn Fn() -> bool,
) -> Result<Vec<ProjectSearchMatch>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let root = canonical_workspace(workspace)?;
    let mut walk = SearchWalk {
        root: &root,
        folded_query: ascii_fold(query),
        superseded,
        files_scanned: 0,
        results: Vec::new(),
    };
    walk.directory(&root)?;
    Ok(walk.results)
}

struct SearchWalk<'a> {
    root: &'a Path,
    folded_query: String,
    superseded: &'a dyn Fn() -> bool,
    files_scanned: usize,
    results: Vec<ProjectSearchMatch>,
}

impl SearchWalk<'_> {
    fn exhausted(&self) -> bool {
        self.results.len() >= MAX_PROJECT_SEARCH_RESULTS
            || self.files_scanned >= MAX_PROJECT_SEARCH_FILES
    }

    fn directory(&mut self, directory: &Path) -> Result<(), String> {
        if self.exhausted() {
            return Ok(());
        }
        if (self.superseded)() {
            return Err(SUPERSEDED.to_owned());
        }
        // An unreadable subdirectory is skipped like an unreadable file; only
        // the workspace root itself is a hard failure.
        let mut entries = match fs::read_dir(directory) {
            Ok(entries) => entries.filter_map(Result::ok).collect::<Vec<_>>(),
            Err(error) if directory == self.root => {
                return Err(format!("failed to read {}: {error}", directory.display()))
            }
            Err(_) => return Ok(()),
        };
        entries.sort_by_key(|entry| entry.file_name());

        for entry in entries {
            if self.exhausted() {
                break;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == ".git" || name == ".DS_Store" {
                continue;
            }
            if directory == self.root.join(".pi") && name.eq_ignore_ascii_case("file-history") {
                continue;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                if matches!(
                    name.as_str(),
                    "node_modules"
                        | "target"
                        | "dist"
                        | "build"
                        | "coverage"
                        | ".next"
                        | ".svelte-kit"
                ) {
                    continue;
                }
                self.directory(&entry.path())?;
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            if (self.superseded)() {
                return Err(SUPERSEDED.to_owned());
            }
            self.file(&entry)?;
        }
        Ok(())
    }

    fn file(&mut self, entry: &fs::DirEntry) -> Result<(), String> {
        self.files_scanned += 1;
        let relative = entry
            .path()
            .strip_prefix(self.root)
            .map_err(|_| "project search path resolves outside the workspace".to_owned())?
            .to_string_lossy()
            .replace('\\', "/");
        if ascii_fold(&relative).contains(&self.folded_query) {
            self.results.push(ProjectSearchMatch {
                path: relative.clone(),
                line: None,
                column: None,
                preview: "File path match".to_owned(),
            });
            if self.results.len() >= MAX_PROJECT_SEARCH_RESULTS {
                return Ok(());
            }
        }

        let Ok(metadata) = entry.metadata() else {
            return Ok(());
        };
        if metadata.len() > MAX_PROJECT_SEARCH_FILE_BYTES {
            return Ok(());
        }
        let Ok(bytes) = fs::read(entry.path()) else {
            return Ok(());
        };
        let Ok(content) = String::from_utf8(bytes) else {
            return Ok(());
        };
        let folded_query = self.folded_query.as_str();
        for (line_index, line) in content.lines().enumerate() {
            let folded_line = ascii_fold(line);
            let mut offset = 0usize;
            while offset <= folded_line.len() {
                let Some(found) = folded_line[offset..].find(folded_query) else {
                    break;
                };
                let byte_index = offset + found;
                let column = line[..byte_index].chars().count() + 1;
                self.results.push(ProjectSearchMatch {
                    path: relative.clone(),
                    line: Some(line_index + 1),
                    column: Some(column),
                    preview: line.trim().chars().take(240).collect(),
                });
                if self.results.len() >= MAX_PROJECT_SEARCH_RESULTS {
                    return Ok(());
                }
                offset = byte_index + folded_query.len().max(1);
            }
        }
        Ok(())
    }
}

fn ascii_fold(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_uppercase() {
                character.to_ascii_lowercase()
            } else {
                character
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn temporary_workspace(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "pix-project-file-search-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&path).expect("create temporary workspace");
        path
    }

    #[test]
    fn superseded_walk_stops_before_reading_more_files() {
        let workspace = temporary_workspace("superseded");
        for index in 0..20 {
            fs::write(workspace.join(format!("file-{index:02}.txt")), "needle\n")
                .expect("write file");
        }
        let checks = Cell::new(0usize);
        let result = search_project_files_with(&workspace, "needle", &|| {
            checks.set(checks.get() + 1);
            checks.get() > 3
        });
        assert_eq!(result, Err(SUPERSEDED.to_owned()));
        assert!(checks.get() < 10, "walk kept scanning after supersession");
        fs::remove_dir_all(workspace).expect("remove temporary workspace");
    }

    #[test]
    fn newer_search_from_same_window_supersedes_older_ticket() {
        let state = ProjectFileSearchState::default();
        let first = state.begin("main");
        let other_window = state.begin("second");
        assert!(!first.superseded());
        let second = state.begin("main");
        assert!(first.superseded());
        assert!(!second.superseded());
        assert!(!other_window.superseded());
        state.cancel("main");
        assert!(second.superseded());
        let third = state.begin("main");
        state.destroyed("main");
        assert!(third.superseded());
        assert!(state.windows.lock().unwrap().get("main").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_subdirectory_does_not_fail_the_whole_search() {
        use std::os::unix::fs::PermissionsExt;
        let workspace = temporary_workspace("unreadable");
        let locked = workspace.join("locked");
        fs::create_dir_all(&locked).expect("create locked directory");
        fs::write(workspace.join("readable.txt"), "needle\n").expect("write readable file");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).expect("lock directory");
        let results = search_project_files_from(&workspace, "needle");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).expect("unlock directory");
        let results = results.expect("search skips unreadable directory");
        assert!(results.iter().any(|result| result.path == "readable.txt"));
        fs::remove_dir_all(workspace).expect("remove temporary workspace");
    }
}
