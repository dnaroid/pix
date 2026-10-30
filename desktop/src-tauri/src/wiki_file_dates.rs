//! Read-only timestamps for one Wiki comparison side: Git history of the file,
//! the newest commit of the quoted lines, and the file-system fallback for files
//! Git does not know. Never mutates the repository; runs off the UI thread.
use super::{canonical_workspace, git_command, run_blocking, validate_workspace_relative_path};
use serde::Serialize;
use std::{collections::HashMap, fs, path::Path, process::Stdio, time::UNIX_EPOCH};

/// Blame is bounded so a huge quotation cannot make the comparison slow.
const MAX_BLAME_LINES: u32 = 2000;

/// All times are Unix epoch milliseconds; `None` means unknown.
#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WikiFileDates {
    /// Committer time of the oldest commit touching the file, following renames.
    created_at: Option<i64>,
    /// Committer time of the newest commit touching the file.
    committed_at: Option<i64>,
    /// File-system modification time.
    modified_at: Option<i64>,
    /// The file has staged, unstaged or untracked changes.
    uncommitted: bool,
    /// Newest commit time among the requested lines.
    lines_committed_at: Option<i64>,
    /// Some requested lines are not committed yet.
    lines_uncommitted: bool,
    /// Git history contains at least one commit of this file.
    tracked: bool,
}

#[tauri::command]
pub(crate) async fn wiki_file_dates(
    workspace: String,
    path: String,
    start_line: Option<u32>,
    end_line: Option<u32>,
) -> Result<WikiFileDates, String> {
    run_blocking(move || {
        let lines = start_line.zip(end_line);
        dates_from(Path::new(&workspace), &path, lines)
    })
    .await
}

/// Successful stdout of a read-only Git command with literal pathspecs; `None` otherwise.
fn git(root: &Path, args: &[&str]) -> Option<String> {
    let output = git_command(root, args)
        .env("GIT_LITERAL_PATHSPECS", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

fn seconds_to_millis(value: &str) -> Option<i64> {
    value.trim().parse::<i64>().ok()?.checked_mul(1000)
}

fn is_object_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Newest committer time among blamed lines and whether any line is uncommitted.
fn blame_dates(porcelain: &str) -> (Option<i64>, bool) {
    let mut times: HashMap<&str, i64> = HashMap::new();
    let mut hashes: Vec<&str> = Vec::new();
    let mut current: Option<&str> = None;
    for line in porcelain.lines() {
        if line.starts_with('\t') {
            continue;
        }
        let mut fields = line.split(' ');
        let first = fields.next().unwrap_or_default();
        if is_object_id(first) && fields.count() >= 2 {
            current = Some(first);
            hashes.push(first);
        } else if let (Some(hash), Some(time)) = (current, line.strip_prefix("committer-time ")) {
            if let Some(time) = seconds_to_millis(time) {
                times.insert(hash, time);
            }
        }
    }
    let uncommitted = |hash: &&str| hash.bytes().all(|byte| byte == b'0');
    let newest = hashes
        .iter()
        .filter(|hash| !uncommitted(hash))
        .filter_map(|hash| times.get(hash).copied())
        .max();
    (newest, hashes.iter().any(uncommitted))
}

fn dates_from(
    workspace: &Path,
    path: &str,
    lines: Option<(u32, u32)>,
) -> Result<WikiFileDates, String> {
    validate_workspace_relative_path(Path::new(path), "Wiki file path")?;
    if path.contains(['\n', '\r', '\0']) {
        return Err("Wiki file path must be a single-line path".into());
    }
    let root = canonical_workspace(workspace)?;
    let file = fs::canonicalize(root.join(path))
        .map_err(|error| format!("failed to resolve {path}: {error}"))?;
    if !file.starts_with(&root) || !file.is_file() {
        return Err("Wiki file must be a regular file inside the workspace".into());
    }
    let mut dates = WikiFileDates {
        modified_at: fs::metadata(&file)
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .and_then(|duration| i64::try_from(duration.as_millis()).ok()),
        ..WikiFileDates::default()
    };
    // Not a repository, or Git is unavailable: only the file time is known.
    let Some(status) = git(
        &root,
        &["status", "--porcelain=v1", "--untracked-files=all", "--", path],
    ) else {
        return Ok(dates);
    };
    dates.uncommitted = !status.trim().is_empty();
    // `git log` fails in a repository without commits; the file is then untracked.
    let log = git(&root, &["log", "--follow", "--format=%ct", "--", path]).unwrap_or_default();
    let commits: Vec<i64> = log.lines().filter_map(seconds_to_millis).collect();
    dates.committed_at = commits.first().copied();
    dates.created_at = commits.last().copied();
    dates.tracked = !commits.is_empty();
    if let Some((start, end)) = lines {
        if dates.tracked && start >= 1 && end >= start && end - start < MAX_BLAME_LINES {
            let range = format!("{start},{end}");
            // A stale range past the end of the file fails; dates stay unknown.
            if let Some(blame) = git(&root, &["blame", "--porcelain", "-L", &range, "--", path]) {
                (dates.lines_committed_at, dates.lines_uncommitted) = blame_dates(&blame);
            }
        }
    }
    Ok(dates)
}

#[cfg(test)]
mod tests {
    use super::super::git_output;
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct Directory(PathBuf);
    impl Directory {
        fn new(repository: bool) -> Self {
            let root = std::env::temp_dir().join(format!(
                "pix-wiki-dates-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&root).unwrap();
            if repository {
                git_output(&root, &["init", "-b", "main"]).unwrap();
            }
            Self(root)
        }
        fn commit(&self, at: &str) {
            git_output(&self.0, &["add", "-A"]).unwrap();
            let output = git_command(
                &self.0,
                &[
                    "-c", "user.name=Pix", "-c", "user.email=pix@example.invalid",
                    "-c", "commit.gpgsign=false", "commit", "--no-verify", "-qm", at,
                ],
            )
            .env("GIT_AUTHOR_DATE", at)
            .env("GIT_COMMITTER_DATE", at)
            .output()
            .unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const FIRST: i64 = 1_704_067_200_000; // 2024-01-01T00:00:00Z
    const SECOND: i64 = 1_706_745_600_000; // 2024-02-01T00:00:00Z

    #[test]
    fn wiki_file_dates_report_file_and_quoted_line_history() {
        let repo = Directory::new(true);
        fs::create_dir_all(repo.0.join("wiki")).unwrap();
        fs::write(repo.0.join("wiki/page [a].md"), "one\ntwo\nthree\n").unwrap();
        repo.commit("2024-01-01T00:00:00Z");
        fs::write(repo.0.join("wiki/page [a].md"), "one\ntwo\nTHREE\n").unwrap();
        repo.commit("2024-02-01T00:00:00Z");

        let dates = dates_from(&repo.0, "wiki/page [a].md", Some((1, 2))).unwrap();
        assert!(dates.tracked && !dates.uncommitted && !dates.lines_uncommitted);
        assert_eq!(dates.created_at, Some(FIRST));
        assert_eq!(dates.committed_at, Some(SECOND));
        assert_eq!(dates.lines_committed_at, Some(FIRST));
        let third = dates_from(&repo.0, "wiki/page [a].md", Some((3, 3))).unwrap();
        assert_eq!(third.lines_committed_at, Some(SECOND));

        fs::write(repo.0.join("wiki/page [a].md"), "one\nTWO\nTHREE\n").unwrap();
        let edited = dates_from(&repo.0, "wiki/page [a].md", Some((2, 3))).unwrap();
        assert!(edited.uncommitted && edited.lines_uncommitted);
        assert_eq!(edited.lines_committed_at, Some(SECOND));
        assert!(edited.modified_at.is_some());

        // A range past the end of the file leaves the line dates unknown.
        let stale = dates_from(&repo.0, "wiki/page [a].md", Some((40, 41))).unwrap();
        assert_eq!(stale.lines_committed_at, None);
        assert_eq!(stale.committed_at, Some(SECOND));
    }

    #[test]
    fn wiki_file_dates_fall_back_to_file_time_outside_git_history() {
        let repo = Directory::new(true);
        fs::write(repo.0.join("new.md"), "draft\n").unwrap();
        let untracked = dates_from(&repo.0, "new.md", Some((1, 1))).unwrap();
        assert!(!untracked.tracked && untracked.uncommitted);
        assert_eq!((untracked.created_at, untracked.lines_committed_at), (None, None));
        assert!(untracked.modified_at.is_some());

        let plain = Directory::new(false);
        fs::write(plain.0.join("page.md"), "text\n").unwrap();
        let outside = dates_from(&plain.0, "page.md", None).unwrap();
        assert!(!outside.tracked && !outside.uncommitted && outside.modified_at.is_some());
    }

    #[test]
    fn wiki_file_dates_reject_paths_outside_the_workspace() {
        let repo = Directory::new(false);
        assert!(dates_from(&repo.0, "../escape.md", None).is_err());
        assert!(dates_from(&repo.0, "/etc/hosts", None).is_err());
        assert!(dates_from(&repo.0, "missing.md", None).is_err());
        fs::create_dir_all(repo.0.join("folder")).unwrap();
        assert!(dates_from(&repo.0, "folder", None).is_err());
    }

    #[test]
    fn blame_porcelain_parsing_ignores_quoted_content() {
        let zero = "0".repeat(40);
        let real = "a".repeat(40);
        let porcelain = format!(
            "{real} 1 1 1\ncommitter-time 100\n\t{real} 1 1 1\n{zero} 2 2 1\ncommitter-time 999\n\tcommitter-time 5\n"
        );
        assert_eq!(blame_dates(&porcelain), (Some(100_000), true));
    }
}
