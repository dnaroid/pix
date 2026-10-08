//! Secondary Source Control commands. Mutations deliberately avoid force, clean,
//! implicit merges and dropping user stashes (Update only drops its own
//! auto-stash after it re-applied cleanly); all work runs off the UI thread.
use super::{
    git_command, git_has_head, git_output, git_output_raw, git_repository_root, git_status_from,
    run_blocking, truncate_git_diff, validate_git_relative_path, MAX_GIT_DIFF_BYTES,
};
use serde::Serialize;
use std::{
    io::{BufRead, BufReader, Read},
    path::Path,
    process::{Command, Stdio},
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitHistoryEntry {
    hash: String,
    short_hash: String,
    subject: String,
    author: String,
    date: String,
}

/// Bounded read-only patch and verified metadata for one HEAD-reachable commit.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitCommitDiff {
    commit: GitHistoryEntry,
    content: String,
    truncated: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct GitStashEntry {
    reference: String,
    subject: String,
}

#[tauri::command]
pub(crate) async fn git_fetch(workspace: String) -> Result<(), String> {
    run_blocking(move || fetch_from(Path::new(&workspace))).await
}

#[tauri::command]
pub(crate) async fn git_pull(workspace: String) -> Result<(), String> {
    run_blocking(move || pull_from(Path::new(&workspace))).await
}

/// Result of the one-click "Update project" command.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitUpdateResult {
    /// Incoming commits applied by the fast-forward (0 when already up to date).
    incoming: u32,
    /// Local changes were stashed around the fast-forward and restored.
    stashed: bool,
}

#[tauri::command]
pub(crate) async fn git_update(workspace: String) -> Result<GitUpdateResult, String> {
    run_blocking(move || update_from(Path::new(&workspace))).await
}

#[tauri::command]
pub(crate) async fn git_history(workspace: String) -> Result<Vec<GitHistoryEntry>, String> {
    run_blocking(move || history_from(Path::new(&workspace))).await
}

#[tauri::command]
pub(crate) async fn git_search_history(
    workspace: String,
    query: String,
) -> Result<Vec<GitHistoryEntry>, String> {
    run_blocking(move || search_history_from(Path::new(&workspace), &query)).await
}

#[tauri::command]
pub(crate) async fn git_commit_diff(
    workspace: String,
    hash: String,
) -> Result<GitCommitDiff, String> {
    run_blocking(move || commit_diff_from(Path::new(&workspace), &hash)).await
}

fn commit_diff_from(workspace: &Path, hash: &str) -> Result<GitCommitDiff, String> {
    // The global search returns the full object id. Do not accept revspecs,
    // symbolic refs, option strings, pathspecs or ambiguous abbreviated hashes.
    if !matches!(hash.len(), 40 | 64) || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid commit hash".to_owned());
    }
    let root = git_repository_root(workspace)?;
    let ancestor = git_output_raw(&root, &["merge-base", "--is-ancestor", hash, "HEAD"])?;
    if !ancestor.status.success() {
        return Err("This commit is no longer reachable from HEAD".to_owned());
    }

    let metadata = git_output(
        &root,
        &[
            "log",
            "-1",
            "--no-show-signature",
            "--format=%H%x00%h%x00%s%x00%an%x00%aI",
            hash,
        ],
    )?;
    let line = String::from_utf8_lossy(&metadata.stdout);
    let fields = line.trim_end().split('\0').collect::<Vec<_>>();
    if fields.len() != 5 || !fields[0].eq_ignore_ascii_case(hash) {
        return Err("The selected commit could not be read".to_owned());
    }
    let commit = GitHistoryEntry {
        hash: fields[0].to_owned(),
        short_hash: fields[1].to_owned(),
        subject: fields[2].to_owned(),
        author: fields[3].to_owned(),
        date: fields[4].to_owned(),
    };

    // Show the selected commit against its first parent (including initial
    // commits and merges). A streaming byte cap prevents large/binary history
    // from filling the UI or process memory before response truncation.
    let mut child = git_command(
        &root,
        &[
            "show",
            "--format=",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--root",
            "--first-parent",
            "--find-renames",
            hash,
            "--",
        ],
    )
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .spawn()
    .map_err(|_| "Could not read the selected commit diff".to_owned())?;
    let mut bytes = Vec::new();
    let read = child
        .stdout
        .take()
        .ok_or_else(|| "Could not capture the selected commit diff".to_owned())?
        .take((MAX_GIT_DIFF_BYTES + 1) as u64)
        .read_to_end(&mut bytes);
    let exceeded = bytes.len() > MAX_GIT_DIFF_BYTES;
    if exceeded || read.is_err() {
        let _ = child.kill();
    }
    let status = child.wait();
    if read.is_err() || status.is_err() || (!exceeded && !status.unwrap().success()) {
        return Err("Could not read the selected commit diff".to_owned());
    }
    let (content, truncated) = truncate_git_diff(String::from_utf8_lossy(&bytes).into_owned());
    Ok(GitCommitDiff {
        commit,
        content,
        truncated: exceeded || truncated,
    })
}

#[tauri::command]
pub(crate) async fn git_stash_list(workspace: String) -> Result<Vec<GitStashEntry>, String> {
    run_blocking(move || stash_list_from(Path::new(&workspace))).await
}

#[tauri::command]
pub(crate) async fn git_stash_save(workspace: String) -> Result<(), String> {
    run_blocking(move || stash_save_from(Path::new(&workspace))).await
}

#[tauri::command]
pub(crate) async fn git_stash_apply(workspace: String, reference: String) -> Result<(), String> {
    run_blocking(move || stash_apply_from(Path::new(&workspace), &reference)).await
}

#[tauri::command]
pub(crate) async fn git_discard_file(workspace: String, path: String) -> Result<(), String> {
    run_blocking(move || discard_file_from(Path::new(&workspace), &path)).await
}

fn fetch_from(workspace: &Path) -> Result<(), String> {
    let root = git_repository_root(workspace)?;
    if git_status_from(&root)?.remotes.is_empty() {
        return Err("No Git remote is configured".to_owned());
    }
    git_output(&root, &["fetch", "--all"]).map(|_| ())
}

fn require_clean(root: &Path) -> Result<(), String> {
    if !git_status_from(root)?.changes.is_empty() {
        return Err("Commit or stash your changes before this operation".to_owned());
    }
    Ok(())
}

fn pull_from(workspace: &Path) -> Result<(), String> {
    let root = git_repository_root(workspace)?;
    let snapshot = git_status_from(&root)?;
    if snapshot.detached || snapshot.upstream.is_none() {
        return Err("Pull requires a branch with an upstream".to_owned());
    }
    require_clean(&root)?;
    // Override user autostash/rebase defaults. Divergence is reported, never
    // resolved by an implicit merge, rebase, reset or force push.
    git_output(
        &root,
        &[
            "-c",
            "merge.autostash=false",
            "pull",
            "--ff-only",
            "--no-rebase",
        ],
    )
    .map(|_| ())
}

const UPDATE_STASH_MESSAGE: &str = "Pix: auto-stash before update";

/// JetBrains-style "Update project": fetch the upstream remote, then
/// fast-forward the current branch, carrying uncommitted work across in a
/// temporary stash. Divergence is still reported rather than merged/rebased.
fn update_from(workspace: &Path) -> Result<GitUpdateResult, String> {
    let root = git_repository_root(workspace)?;
    let snapshot = git_status_from(&root)?;
    if snapshot.detached || snapshot.upstream.is_none() {
        return Err("Update requires a branch with an upstream".to_owned());
    }
    if snapshot.changes.iter().any(|change| change.conflicted) {
        return Err("Resolve conflicts before updating".to_owned());
    }
    git_output(&root, &["fetch"])?;
    let snapshot = git_status_from(&root)?;
    if snapshot.behind == 0 {
        return Ok(GitUpdateResult {
            incoming: 0,
            stashed: false,
        });
    }
    if snapshot.ahead > 0 {
        return Err(format!(
            "Branch has diverged ({} outgoing, {} incoming). Update only fast-forwards; merge or rebase manually.",
            snapshot.ahead, snapshot.behind
        ));
    }
    let stash = if snapshot.changes.is_empty() {
        None
    } else {
        git_output(
            &root,
            &[
                "stash",
                "push",
                "--include-untracked",
                "-m",
                UPDATE_STASH_MESSAGE,
            ],
        )?;
        Some(git_stdout_line(&root, &["rev-parse", "refs/stash"])?)
    };
    let merged = git_output(
        &root,
        &[
            "-c",
            "merge.autostash=false",
            "merge",
            "--ff-only",
            "--no-edit",
            "@{upstream}",
        ],
    );
    let restored = match &stash {
        Some(commit) => restore_update_stash(&root, commit),
        None => Ok(()),
    };
    merged?;
    restored?;
    Ok(GitUpdateResult {
        incoming: snapshot.behind,
        stashed: stash.is_some(),
    })
}

fn git_stdout_line(root: &Path, args: &[&str]) -> Result<String, String> {
    let output = git_output(root, args)?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

/// Re-apply the update auto-stash and drop only that exact entry once it has
/// applied cleanly. On conflict the stash is kept so no work can be lost.
fn restore_update_stash(root: &Path, commit: &str) -> Result<(), String> {
    let applied = git_output(root, &["stash", "apply", "--index", commit]).or_else(|error| {
        // --index refuses when staged changes no longer apply to the new base;
        // fall back to a plain apply only while nothing has been touched yet.
        if git_status_from(root)?.changes.is_empty() {
            git_output(root, &["stash", "apply", commit])
        } else {
            Err(error)
        }
    });
    if let Err(error) = applied {
        return Err(format!(
            "Updated, but restoring local changes conflicted. They are kept in the stash \"{UPDATE_STASH_MESSAGE}\". {error}"
        ));
    }
    let listing = git_stdout_line(root, &["stash", "list", "--format=%gd%x00%H"])?;
    if let Some((reference, _)) = listing
        .lines()
        .filter_map(|line| line.split_once('\0'))
        .find(|(_, hash)| *hash == commit)
    {
        git_output(root, &["stash", "drop", reference])?;
    }
    Ok(())
}

fn history_from(workspace: &Path) -> Result<Vec<GitHistoryEntry>, String> {
    let root = git_repository_root(workspace)?;
    if !git_has_head(&root)? {
        return Ok(Vec::new());
    }
    let output = git_output(
        &root,
        &[
            "log",
            "-30",
            "--no-show-signature",
            "--format=%H%x00%h%x00%s%x00%an%x00%aI",
        ],
    )?;
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let fields: Vec<_> = line.split('\0').collect();
            (fields.len() == 5).then(|| GitHistoryEntry {
                hash: fields[0].to_owned(),
                short_hash: fields[1].to_owned(),
                subject: fields[2].to_owned(),
                author: fields[3].to_owned(),
                date: fields[4].to_owned(),
            })
        })
        .collect())
}

fn search_history_from(workspace: &Path, query: &str) -> Result<Vec<GitHistoryEntry>, String> {
    let words: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
    if words.is_empty() {
        return Ok(Vec::new());
    }
    let root = git_repository_root(workspace)?;
    if !git_has_head(&root)? {
        return Ok(Vec::new());
    }

    // Stream all commits reachable from HEAD. Keep only the best twenty rows;
    // unlike `git_history`, this deliberately has no history-depth limit.
    let mut child = Command::new("git")
        .arg("-C")
        .arg(&root)
        .args([
            "-c",
            "color.ui=false",
            "-c",
            "core.quotepath=false",
            "-c",
            "core.pager=cat",
        ])
        .args([
            "log",
            "--no-show-signature",
            "--format=%H%x00%h%x00%s%x00%an%x00%aI%x00",
        ])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("failed to run git log for history search: {error}"))?;
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("failed to capture Git history search output".to_owned());
        }
    };
    let mut reader = BufReader::new(stdout);
    let mut field = Vec::new();
    let mut best: Vec<(usize, usize, GitHistoryEntry)> = Vec::with_capacity(20);
    let mut newest_order = 0usize;
    let read_result = (|| -> std::io::Result<()> {
        loop {
            let mut fields: Vec<String> = Vec::with_capacity(5);
            for _ in 0..5 {
                field.clear();
                if reader.read_until(0, &mut field)? == 0 {
                    return if fields.is_empty()
                        || (fields.len() == 1 && fields[0].trim().is_empty())
                    {
                        Ok(())
                    } else {
                        Err(std::io::Error::new(
                            std::io::ErrorKind::UnexpectedEof,
                            "incomplete Git history record",
                        ))
                    };
                }
                if field.last() == Some(&0) {
                    field.pop();
                }
                fields.push(String::from_utf8_lossy(&field).into_owned());
            }
            fields[0] = fields[0].trim_start_matches(['\n', '\r']).to_owned();
            if fields[0].is_empty() {
                break;
            }
            let entry = GitHistoryEntry {
                hash: fields[0].clone(),
                short_hash: fields[1].clone(),
                subject: fields[2].clone(),
                author: fields[3].clone(),
                date: fields[4].clone(),
            };
            let subject = entry.subject.to_lowercase();
            let metadata = format!("{} {}", entry.hash, entry.author).to_lowercase();
            let score: usize = words
                .iter()
                .map(|word| {
                    if subject.contains(word) {
                        2
                    } else if metadata.contains(word) {
                        1
                    } else {
                        0
                    }
                })
                .sum();
            if score > 0 {
                best.push((score, newest_order, entry));
                best.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
                best.truncate(20);
            }
            newest_order = newest_order.saturating_add(1);
        }
        Ok(())
    })();
    if let Err(error) = read_result {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("failed to read Git history search output: {error}"));
    }
    let status = match child.wait() {
        Ok(status) => status,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("failed to wait for Git history search: {error}"));
        }
    };
    if !status.success() {
        return Err("Git history search failed".to_owned());
    }
    Ok(best.into_iter().map(|(_, _, entry)| entry).collect())
}

fn stash_list_from(workspace: &Path) -> Result<Vec<GitStashEntry>, String> {
    let root = git_repository_root(workspace)?;
    let output = git_output(&root, &["stash", "list", "-30", "--format=%gd%x00%gs"])?;
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            line.split_once('\0')
                .map(|(reference, subject)| GitStashEntry {
                    reference: reference.to_owned(),
                    subject: subject.to_owned(),
                })
        })
        .collect())
}

fn stash_save_from(workspace: &Path) -> Result<(), String> {
    let root = git_repository_root(workspace)?;
    let snapshot = git_status_from(&root)?;
    if snapshot.changes.is_empty() {
        return Err("There are no changes to stash".to_owned());
    }
    if snapshot.changes.iter().any(|change| change.conflicted) {
        return Err("Resolve conflicts before stashing".to_owned());
    }
    git_output(
        &root,
        &[
            "stash",
            "push",
            "--include-untracked",
            "-m",
            "Pix: saved changes",
        ],
    )
    .map(|_| ())
}

fn stash_apply_from(workspace: &Path, reference: &str) -> Result<(), String> {
    let root = git_repository_root(workspace)?;
    let index = reference
        .strip_prefix("stash@{")
        .and_then(|value| value.strip_suffix('}'));
    if !index
        .is_some_and(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return Err("Invalid stash reference".to_owned());
    }
    require_clean(&root)?;
    // Restore staging too. The stash is intentionally kept, including on conflict.
    git_output(&root, &["stash", "apply", "--index", reference]).map(|_| ())
}

fn discard_file_from(workspace: &Path, path: &str) -> Result<(), String> {
    let root = git_repository_root(workspace)?;
    let path = validate_git_relative_path(path)?;
    let snapshot = git_status_from(&root)?;
    let change = snapshot
        .changes
        .iter()
        .find(|change| change.path == path)
        .ok_or_else(|| "No changes for this file".to_owned())?;
    if change.untracked || change.conflicted || !change.unstaged {
        return Err(
            "Only tracked, non-conflicted working-tree changes can be discarded".to_owned(),
        );
    }
    let index = git_output(
        &root,
        &[
            "--literal-pathspecs",
            "ls-files",
            "--stage",
            "-z",
            "--",
            path,
        ],
    )?;
    let entries: Vec<_> = index
        .stdout
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
        .collect();
    if entries.len() != 1 || entries[0].starts_with(b"160000 ") {
        return Err(
            "Discard requires a single tracked file, not a directory or submodule".to_owned(),
        );
    }
    // Default restore source is the index, not HEAD: preserve staged hunks.
    git_output(
        &root,
        &["--literal-pathspecs", "restore", "--worktree", "--", path],
    )
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Repository(PathBuf);
    impl Repository {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "pix-git-operations-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            git_output(&path, &["init", "-b", "main"]).unwrap();
            git_output(&path, &["config", "user.name", "Pix Test"]).unwrap();
            git_output(&path, &["config", "user.email", "pix@example.invalid"]).unwrap();
            git_output(&path, &["config", "commit.gpgsign", "false"]).unwrap();
            Self(path)
        }
        fn commit(&self, text: &str) {
            fs::write(self.0.join("tracked.txt"), text).unwrap();
            git_output(&self.0, &["add", "tracked.txt"]).unwrap();
            git_output(&self.0, &["commit", "-m", text]).unwrap();
        }
    }
    impl Drop for Repository {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn git_secondary_history_handles_unborn_and_limits_results() {
        let repo = Repository::new();
        assert!(history_from(&repo.0).unwrap().is_empty());
        assert!(search_history_from(&repo.0, "change").unwrap().is_empty());
        for index in 0..32 {
            repo.commit(&format!("change {index}"));
        }
        let history = history_from(&repo.0).unwrap();
        assert_eq!(history.len(), 30);
        assert_eq!(history[0].subject, "change 31");
        assert_eq!(history[0].author, "Pix Test");
    }

    #[test]
    fn git_history_search_scans_all_head_ancestors_and_matches_metadata() {
        let repo = Repository::new();
        repo.commit("oldest needle commit");
        let oldest_hash = git_stdout_line(&repo.0, &["rev-parse", "HEAD"]).unwrap();
        for index in 1..36 {
            repo.commit(&format!("ordinary change {index}"));
        }

        let by_subject = search_history_from(&repo.0, "needle").unwrap();
        assert_eq!(by_subject.len(), 1);
        assert_eq!(by_subject[0].hash, oldest_hash);
        assert_eq!(by_subject[0].subject, "oldest needle commit");
        let by_author = search_history_from(&repo.0, "pix test").unwrap();
        assert_eq!(by_author.len(), 20);
        assert_eq!(
            by_author[0].hash,
            git_stdout_line(&repo.0, &["rev-parse", "HEAD"]).unwrap()
        );
        assert_eq!(
            search_history_from(&repo.0, &oldest_hash[..8]).unwrap()[0].hash,
            oldest_hash
        );
        assert!(search_history_from(&repo.0, "  ").unwrap().is_empty());
    }

    #[test]
    fn git_history_search_rejects_non_repositories() {
        let directory = std::env::temp_dir().join(format!(
            "pix-not-git-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&directory).unwrap();
        assert!(search_history_from(&directory, "needle").is_err());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn git_commit_diff_opens_old_and_root_commit_patches_without_touching_worktree() {
        let repo = Repository::new();
        repo.commit("initial payload");
        let oldest = git_stdout_line(&repo.0, &["rev-parse", "HEAD"]).unwrap();
        for index in 0..35 {
            repo.commit(&format!("later revision {index}"));
        }
        assert!(history_from(&repo.0)
            .unwrap()
            .iter()
            .all(|entry| entry.hash != oldest));

        fs::write(repo.0.join("tracked.txt"), "uncommitted local changes\n").unwrap();
        let head_before = git_stdout_line(&repo.0, &["rev-parse", "HEAD"]).unwrap();
        let status_before = git_output(&repo.0, &["status", "--porcelain"])
            .unwrap()
            .stdout;
        let diff = commit_diff_from(&repo.0, &oldest).unwrap();
        assert_eq!(diff.commit.hash, oldest);
        assert_eq!(diff.commit.subject, "initial payload");
        assert!(!diff.truncated);
        assert!(diff
            .content
            .contains("diff --git a/tracked.txt b/tracked.txt"));
        assert!(diff.content.contains("+initial payload"));
        assert!(!diff.content.contains("uncommitted local changes"));
        assert_eq!(
            git_stdout_line(&repo.0, &["rev-parse", "HEAD"]).unwrap(),
            head_before,
        );
        assert_eq!(
            git_output(&repo.0, &["status", "--porcelain"])
                .unwrap()
                .stdout,
            status_before,
        );
        assert_eq!(
            fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
            "uncommitted local changes\n",
        );
    }

    #[test]
    fn git_commit_diff_of_merge_is_against_first_parent() {
        let repo = Repository::new();
        repo.commit("base");
        git_output(&repo.0, &["switch", "-c", "feature"]).unwrap();
        fs::write(repo.0.join("feature.txt"), "from feature\n").unwrap();
        git_output(&repo.0, &["add", "feature.txt"]).unwrap();
        git_output(&repo.0, &["commit", "-m", "feature change"]).unwrap();
        git_output(&repo.0, &["switch", "main"]).unwrap();
        fs::write(repo.0.join("main.txt"), "from main\n").unwrap();
        git_output(&repo.0, &["add", "main.txt"]).unwrap();
        git_output(&repo.0, &["commit", "-m", "main change"]).unwrap();
        git_output(&repo.0, &["merge", "--no-ff", "--no-edit", "feature"]).unwrap();
        let merge_hash = git_stdout_line(&repo.0, &["rev-parse", "HEAD"]).unwrap();
        let diff = commit_diff_from(&repo.0, &merge_hash).unwrap();
        assert!(diff
            .content
            .contains("diff --git a/feature.txt b/feature.txt"));
        assert!(!diff.content.contains("diff --git a/main.txt b/main.txt"));
        assert_eq!(diff.commit.subject, "Merge branch 'feature'");
    }

    #[test]
    fn git_commit_diff_rejects_injected_rev_specs_and_unreachable_commits() {
        let repo = Repository::new();
        repo.commit("main change");
        let first = git_stdout_line(&repo.0, &["rev-parse", "HEAD"]).unwrap();
        for invalid in [
            "", "HEAD", "HEAD~1", "--help", "deadbeef", "../", "abc\0def",
        ] {
            assert!(commit_diff_from(&repo.0, invalid).is_err(), "{invalid:?}");
        }
        let absent = "f".repeat(40);
        assert!(commit_diff_from(&repo.0, &absent).is_err());
        let other = git_output(
            &repo.0,
            &[
                "commit-tree",
                &git_stdout_line(&repo.0, &["mktree"]).unwrap(),
                "-m",
                "orphan",
            ],
        )
        .unwrap();
        let other_hash = String::from_utf8_lossy(&other.stdout).trim().to_owned();
        assert_ne!(other_hash, first);
        assert!(
            commit_diff_from(&repo.0, &other_hash).is_err(),
            "unreachable objects must not be previewed"
        );
    }

    #[test]
    fn git_commit_diff_bounded_output_marks_large_patches_as_truncated() {
        let repo = Repository::new();
        repo.commit("base");
        let large = "many changes\n".repeat(MAX_GIT_DIFF_BYTES / 10);
        fs::write(repo.0.join("tracked.txt"), large).unwrap();
        git_output(&repo.0, &["add", "tracked.txt"]).unwrap();
        git_output(&repo.0, &["commit", "-m", "large patch"]).unwrap();
        let hash = git_stdout_line(&repo.0, &["rev-parse", "HEAD"]).unwrap();
        let diff = commit_diff_from(&repo.0, &hash).unwrap();
        assert!(diff.truncated);
        assert!(diff.content.contains("[Diff truncated by Pix Desktop]"));
        assert!(diff.content.len() <= MAX_GIT_DIFF_BYTES + 100);
    }

    #[test]
    fn git_secondary_stash_restores_index_and_untracked_without_dropping() {
        let repo = Repository::new();
        repo.commit("base");
        fs::write(repo.0.join("tracked.txt"), "staged").unwrap();
        git_output(&repo.0, &["add", "tracked.txt"]).unwrap();
        fs::write(repo.0.join("tracked.txt"), "unstaged").unwrap();
        fs::write(repo.0.join("new.txt"), "untracked").unwrap();
        stash_save_from(&repo.0).unwrap();
        assert!(git_status_from(&repo.0).unwrap().changes.is_empty());
        assert_eq!(stash_list_from(&repo.0).unwrap().len(), 1);
        assert!(stash_apply_from(&repo.0, "--all").is_err());
        stash_apply_from(&repo.0, "stash@{0}").unwrap();
        assert_eq!(
            fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
            "unstaged"
        );
        assert_eq!(
            git_output(&repo.0, &["show", ":tracked.txt"])
                .unwrap()
                .stdout,
            b"staged"
        );
        assert!(repo.0.join("new.txt").exists());
        assert_eq!(stash_list_from(&repo.0).unwrap().len(), 1);
        assert!(stash_apply_from(&repo.0, "stash@{0}").is_err());
    }

    #[test]
    fn git_secondary_discard_preserves_staged_and_rejects_unsafe_targets() {
        let repo = Repository::new();
        repo.commit("base");
        fs::write(repo.0.join("tracked.txt"), "staged").unwrap();
        git_output(&repo.0, &["add", "tracked.txt"]).unwrap();
        fs::write(repo.0.join("tracked.txt"), "unstaged").unwrap();
        discard_file_from(&repo.0, "tracked.txt").unwrap();
        assert_eq!(
            fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
            "staged"
        );
        assert_eq!(
            git_output(&repo.0, &["show", ":tracked.txt"])
                .unwrap()
                .stdout,
            b"staged"
        );
        fs::write(repo.0.join("new.txt"), "keep").unwrap();
        for path in ["new.txt", ".", "../tracked.txt", ":(glob)*", "tracked.txt"] {
            assert!(
                discard_file_from(&repo.0, path).is_err(),
                "must reject {path}"
            );
        }
        assert!(repo.0.join("new.txt").exists());
    }

    #[test]
    fn git_secondary_fetch_pull_are_explicit_and_fast_forward_only() {
        let repo = Repository::new();
        let remote = Repository::new();
        let other = Repository::new();
        repo.commit("base");
        assert!(fetch_from(&repo.0).is_err());
        assert!(pull_from(&repo.0).is_err());
        git_output(&remote.0, &["config", "core.bare", "true"]).unwrap();
        git_output(
            &repo.0,
            &["remote", "add", "origin", remote.0.to_str().unwrap()],
        )
        .unwrap();
        git_output(&repo.0, &["push", "-u", "origin", "main"]).unwrap();
        git_output(
            &other.0,
            &["remote", "add", "origin", remote.0.to_str().unwrap()],
        )
        .unwrap();
        git_output(&other.0, &["pull", "origin", "main"]).unwrap();
        other.commit("remote change");
        git_output(&other.0, &["push", "origin", "main"]).unwrap();
        fetch_from(&repo.0).unwrap();
        assert_eq!(git_status_from(&repo.0).unwrap().behind, 1);
        fs::write(repo.0.join("untracked.txt"), "keep").unwrap();
        assert!(pull_from(&repo.0).is_err());
        fs::remove_file(repo.0.join("untracked.txt")).unwrap();
        pull_from(&repo.0).unwrap();
        assert_eq!(history_from(&repo.0).unwrap()[0].subject, "remote change");
        repo.commit("local divergence");
        other.commit("remote divergence");
        git_output(&other.0, &["push", "origin", "main"]).unwrap();
        assert!(pull_from(&repo.0).is_err());
        assert_eq!(
            history_from(&repo.0).unwrap()[0].subject,
            "local divergence"
        );
    }

    #[test]
    fn git_update_fetches_fast_forwards_and_carries_local_changes() {
        let repo = Repository::new();
        let remote = Repository::new();
        let other = Repository::new();
        repo.commit("base");
        assert!(update_from(&repo.0).is_err(), "no upstream yet");
        git_output(&remote.0, &["config", "core.bare", "true"]).unwrap();
        for clone in [&repo, &other] {
            git_output(
                &clone.0,
                &["remote", "add", "origin", remote.0.to_str().unwrap()],
            )
            .unwrap();
        }
        git_output(&repo.0, &["push", "-u", "origin", "main"]).unwrap();
        git_output(&other.0, &["pull", "origin", "main"]).unwrap();
        assert_eq!(
            update_from(&repo.0).unwrap(),
            GitUpdateResult {
                incoming: 0,
                stashed: false
            }
        );

        fs::write(other.0.join("remote.txt"), "remote").unwrap();
        git_output(&other.0, &["add", "remote.txt"]).unwrap();
        git_output(&other.0, &["commit", "-m", "remote change"]).unwrap();
        git_output(&other.0, &["push", "origin", "main"]).unwrap();
        // A pre-existing user stash is never touched.
        fs::write(repo.0.join("tracked.txt"), "user stash").unwrap();
        stash_save_from(&repo.0).unwrap();
        // Staged, unstaged and untracked work survives the update unchanged.
        fs::write(repo.0.join("tracked.txt"), "staged").unwrap();
        git_output(&repo.0, &["add", "tracked.txt"]).unwrap();
        fs::write(repo.0.join("tracked.txt"), "unstaged").unwrap();
        fs::write(repo.0.join("new.txt"), "untracked").unwrap();
        assert_eq!(
            update_from(&repo.0).unwrap(),
            GitUpdateResult {
                incoming: 1,
                stashed: true
            }
        );
        assert_eq!(history_from(&repo.0).unwrap()[0].subject, "remote change");
        assert_eq!(
            fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
            "unstaged"
        );
        assert_eq!(
            git_output(&repo.0, &["show", ":tracked.txt"])
                .unwrap()
                .stdout,
            b"staged"
        );
        assert!(repo.0.join("new.txt").exists());
        let stashes = stash_list_from(&repo.0).unwrap();
        assert_eq!(stashes.len(), 1);
        assert!(stashes[0].subject.contains("Pix: saved changes"));

        // Divergence is reported and leaves history and local work untouched.
        git_output(&repo.0, &["add", "-A"]).unwrap();
        git_output(&repo.0, &["commit", "-m", "local divergence"]).unwrap();
        other.commit("remote divergence");
        git_output(&other.0, &["push", "origin", "main"]).unwrap();
        assert!(update_from(&repo.0).unwrap_err().contains("diverged"));
        assert_eq!(
            history_from(&repo.0).unwrap()[0].subject,
            "local divergence"
        );
    }

    #[test]
    fn git_update_keeps_auto_stash_when_restore_conflicts() {
        let repo = Repository::new();
        let remote = Repository::new();
        let other = Repository::new();
        repo.commit("base");
        git_output(&remote.0, &["config", "core.bare", "true"]).unwrap();
        for clone in [&repo, &other] {
            git_output(
                &clone.0,
                &["remote", "add", "origin", remote.0.to_str().unwrap()],
            )
            .unwrap();
        }
        git_output(&repo.0, &["push", "-u", "origin", "main"]).unwrap();
        git_output(&other.0, &["pull", "origin", "main"]).unwrap();
        other.commit("remote edit");
        git_output(&other.0, &["push", "origin", "main"]).unwrap();
        fs::write(repo.0.join("tracked.txt"), "local edit").unwrap();
        let error = update_from(&repo.0).unwrap_err();
        assert!(error.contains(UPDATE_STASH_MESSAGE), "{error}");
        assert_eq!(history_from(&repo.0).unwrap()[0].subject, "remote edit");
        let stashes = stash_list_from(&repo.0).unwrap();
        assert!(stashes
            .iter()
            .any(|stash| stash.subject.contains(UPDATE_STASH_MESSAGE)));
    }
}
