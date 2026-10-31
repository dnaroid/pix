//! Git panel diffs: bounded streaming of `git diff` output.
//!
//! Every Git child here is isolated in its own process group and its stdout is
//! read only up to the remaining diff budget ([`MAX_GIT_DIFF_BYTES`] + 1 byte
//! to detect overflow). At the limit the child is killed instead of letting it
//! produce (and Pix buffer) an arbitrarily large diff. Untracked files come
//! from a lean `git ls-files --others` listing rather than a full status
//! snapshot; staged diffs need no listing at all.

use super::{
    git_command, git_command_error, git_repository_root, native_process,
    read_bounded_process_stream, validate_git_relative_path, GitDiff, GitDiffScope,
    MAX_GIT_DIFF_BYTES,
};
use std::{
    io::Read,
    path::Path,
    process::{ExitStatus, Stdio},
    thread,
};

const MAX_UNTRACKED_DIFF_FILES: usize = 100;
/// Bound for the untracked path listing (NUL-separated paths).
const MAX_UNTRACKED_LISTING_BYTES: usize = 1024 * 1024;
const MAX_GIT_DIFF_STDERR_BYTES: usize = 64 * 1024;

pub(crate) fn git_diff_from(
    workspace: &Path,
    path: Option<&str>,
    scope: GitDiffScope,
) -> Result<GitDiff, String> {
    let root = git_repository_root(workspace)?;
    let path = path.map(validate_git_relative_path).transpose()?;
    let mut content = String::new();

    match scope {
        GitDiffScope::Staged => {
            content.push_str(&git_tracked_diff(&root, path, true, remaining(&content))?);
        }
        GitDiffScope::Unstaged => {
            content.push_str(&git_tracked_diff(&root, path, false, remaining(&content))?);
            append_untracked_diffs(&root, path, &mut content)?;
        }
        GitDiffScope::All => {
            let staged = git_tracked_diff(&root, path, true, remaining(&content))?;
            if !staged.trim().is_empty() {
                content.push_str("# Staged changes\n\n");
                content.push_str(&staged);
            }
            if remaining(&content) > 0 {
                let unstaged = git_tracked_diff(&root, path, false, remaining(&content))?;
                if !unstaged.trim().is_empty() {
                    if !content.is_empty() {
                        content.push_str("\n\n");
                    }
                    content.push_str("# Working tree changes\n\n");
                    content.push_str(&unstaged);
                }
            }
            append_untracked_diffs(&root, path, &mut content)?;
        }
    }

    let (content, truncated) = truncate_git_diff(content);
    Ok(GitDiff {
        path: path.map(str::to_owned),
        scope,
        content,
        truncated,
    })
}

/// Bytes still worth reading: one past the cap, so overflow is detectable and
/// `truncate_git_diff` adds its marker.
fn remaining(content: &str) -> usize {
    (MAX_GIT_DIFF_BYTES + 1).saturating_sub(content.len())
}

fn git_tracked_diff(
    root: &Path,
    path: Option<&str>,
    staged: bool,
    limit: usize,
) -> Result<String, String> {
    let mut args = vec!["diff"];
    if staged {
        args.push("--cached");
    }
    args.extend(["--no-ext-diff", "--no-color"]);
    if let Some(path) = path {
        args.extend(["--", path]);
    }
    let output = run_bounded_git(root, &args, limit, &[])?;
    if !output.truncated && !output.status.success() {
        return Err(output.error(&format!("git {}", args.join(" "))));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn untracked_paths(root: &Path, requested_path: Option<&str>) -> Result<Vec<String>, String> {
    let mut args = vec!["ls-files", "--others", "--exclude-standard", "-z"];
    if let Some(path) = requested_path {
        args.extend(["--", path]);
    }
    // The requested path is a file name, not a glob.
    let output = run_bounded_git(
        root,
        &args,
        MAX_UNTRACKED_LISTING_BYTES,
        &[("GIT_LITERAL_PATHSPECS", "1")],
    )?;
    if !output.truncated && !output.status.success() {
        return Err(output.error("git ls-files --others"));
    }
    let mut records = output.stdout.split(|byte| *byte == 0).collect::<Vec<_>>();
    if output.truncated {
        // The last record may be cut mid-path.
        records.pop();
    }
    Ok(records
        .into_iter()
        .filter(|record| !record.is_empty())
        .map(|record| String::from_utf8_lossy(record).into_owned())
        .filter(|path| requested_path.is_none_or(|requested| path == requested))
        .take(MAX_UNTRACKED_DIFF_FILES)
        .collect())
}

fn append_untracked_diffs(
    root: &Path,
    requested_path: Option<&str>,
    content: &mut String,
) -> Result<(), String> {
    if remaining(content) == 0 {
        return Ok(());
    }
    for path in untracked_paths(root, requested_path)? {
        let limit = remaining(content);
        if limit == 0 {
            break;
        }
        let args = [
            "diff",
            "--no-index",
            "--no-ext-diff",
            "--no-color",
            "--",
            "/dev/null",
            path.as_str(),
        ];
        let output = run_bounded_git(root, &args, limit, &[])?;
        let accepted =
            output.truncated || output.status.success() || output.status.code() == Some(1);
        if !accepted {
            return Err(output.error("git diff --no-index"));
        }
        // Git runs with the workspace as cwd and receives a workspace-relative
        // path, so its diff headers are already relative. Never post-process the
        // whole diff: doing so can corrupt hunk contents that happen to contain
        // the absolute workspace path.
        let diff = String::from_utf8_lossy(&output.stdout);
        if !diff.trim().is_empty() {
            if !content.is_empty() {
                content.push_str("\n\n");
            }
            content.push_str(&diff);
        }
    }
    Ok(())
}

pub(crate) fn truncate_git_diff(mut content: String) -> (String, bool) {
    if content.len() <= MAX_GIT_DIFF_BYTES {
        return (content, false);
    }
    let mut boundary = MAX_GIT_DIFF_BYTES;
    while !content.is_char_boundary(boundary) {
        boundary -= 1;
    }
    content.truncate(boundary);
    content.push_str("\n\n[Diff truncated by Pix Desktop]\n");
    (content, true)
}

struct BoundedGitOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    /// Stdout exceeded the limit and Git was killed.
    truncated: bool,
}

impl BoundedGitOutput {
    fn error(&self, label: &str) -> String {
        git_command_error(
            label,
            &std::process::Output {
                status: self.status,
                stdout: self.stdout.clone(),
                stderr: self.stderr.clone(),
            },
        )
    }
}

/// Run Git, keeping at most `limit` stdout bytes; kill its process group as
/// soon as more arrive.
fn run_bounded_git(
    root: &Path,
    args: &[&str],
    limit: usize,
    env: &[(&str, &str)],
) -> Result<BoundedGitOutput, String> {
    let mut command = git_command(root, args);
    command
        .envs(env.iter().copied())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    native_process::isolate(&mut command);
    let label = args.first().copied().unwrap_or("git");
    let mut child = native_process::spawn(&mut command)
        .map_err(|error| format!("failed to run git {label}: {error}"))?;
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        let _ = native_process::force_stop(&mut child);
        let _ = child.wait();
        return Err(format!("git {label} pipes are unavailable"));
    };
    let stderr_thread =
        thread::spawn(move || read_bounded_process_stream(stderr, MAX_GIT_DIFF_STDERR_BYTES));
    let (stdout, truncated) = read_stdout_prefix(stdout, limit);
    if truncated {
        let _ = native_process::force_stop(&mut child);
    }
    let status = child.wait();
    // Windows job objects keep descendants alive past the leader.
    #[cfg(windows)]
    let _ = native_process::force_stop(&mut child);
    let (stderr, _) = stderr_thread.join().unwrap_or_default();
    let status = status.map_err(|error| format!("failed to wait for git {label}: {error}"))?;
    Ok(BoundedGitOutput {
        status,
        stdout,
        stderr,
        truncated,
    })
}

/// Read at most `limit` bytes; reports whether the stream had more. The
/// reader is dropped on return, so a writer past the limit sees EPIPE.
fn read_stdout_prefix<R: Read>(reader: R, limit: usize) -> (Vec<u8>, bool) {
    let mut retained = Vec::with_capacity(limit.min(64 * 1024));
    let _ = reader
        .take(limit.saturating_add(1) as u64)
        .read_to_end(&mut retained);
    let truncated = retained.len() > limit;
    retained.truncate(limit);
    (retained, truncated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf, process::Command};

    fn repository(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("pix-git-diff-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec!["config", "user.email", "pix@example.invalid"],
            vec!["config", "user.name", "Pix"],
            vec!["config", "commit.gpgsign", "false"],
        ] {
            assert!(Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(&args)
                .status()
                .unwrap()
                .success());
        }
        root
    }

    fn commit_all(root: &Path) {
        for args in [vec!["add", "-A"], vec!["commit", "-q", "-m", "init"]] {
            assert!(Command::new("git")
                .arg("-C")
                .arg(root)
                .args(&args)
                .status()
                .unwrap()
                .success());
        }
    }

    #[test]
    fn prefix_reader_keeps_the_limit_and_detects_overflow() {
        assert_eq!(
            read_stdout_prefix(&b"abcdef"[..], 6),
            (b"abcdef".to_vec(), false)
        );
        assert_eq!(
            read_stdout_prefix(&b"abcdefg"[..], 6),
            (b"abcdef".to_vec(), true)
        );
        assert_eq!(read_stdout_prefix(&b""[..], 0), (Vec::new(), false));
        assert_eq!(read_stdout_prefix(&b"x"[..], 0), (Vec::new(), true));
    }

    #[test]
    fn oversized_diffs_are_truncated_at_the_byte_budget() {
        let root = repository("oversized");
        fs::write(root.join("big.txt"), "old\n").unwrap();
        commit_all(&root);
        // About 1.2 MB of changes: both the tracked and untracked readers
        // must stop at the budget instead of buffering everything.
        let line = "x".repeat(99) + "\n";
        fs::write(root.join("big.txt"), line.repeat(6_000)).unwrap();
        fs::write(root.join("new.txt"), line.repeat(6_000)).unwrap();

        let diff = git_diff_from(&root, None, GitDiffScope::All).unwrap();
        assert!(diff.truncated);
        assert!(diff.content.len() <= MAX_GIT_DIFF_BYTES + 64);
        assert!(diff.content.ends_with("[Diff truncated by Pix Desktop]\n"));

        let staged = git_diff_from(&root, None, GitDiffScope::Staged).unwrap();
        assert!(!staged.truncated);
        assert!(staged.content.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn untracked_listing_is_literal_and_exact() {
        let root = repository("untracked");
        fs::write(root.join("tracked.txt"), "a\n").unwrap();
        commit_all(&root);
        fs::write(root.join("a*.txt"), "glob\n").unwrap();
        fs::write(root.join("ab.txt"), "other\n").unwrap();
        fs::create_dir_all(root.join("dir")).unwrap();
        fs::write(root.join("dir").join("inner.txt"), "inner\n").unwrap();
        fs::write(root.join(".gitignore"), "ignored.txt\n").unwrap();
        fs::write(root.join("ignored.txt"), "ignored\n").unwrap();

        let mut all = untracked_paths(&root, None).unwrap();
        all.sort();
        assert_eq!(all, [".gitignore", "a*.txt", "ab.txt", "dir/inner.txt"]);
        assert_eq!(untracked_paths(&root, Some("a*.txt")).unwrap(), ["a*.txt"]);
        // A directory pathspec does not count as the requested file.
        assert!(untracked_paths(&root, Some("dir")).unwrap().is_empty());

        let diff = git_diff_from(&root, Some("a*.txt"), GitDiffScope::Unstaged).unwrap();
        assert!(diff.content.contains("+glob"));
        assert!(!diff.content.contains("+other"));
        fs::remove_dir_all(root).unwrap();
    }
}
