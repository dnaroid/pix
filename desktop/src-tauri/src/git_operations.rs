//! Secondary Source Control commands. Mutations deliberately avoid force, clean,
//! implicit merges and dropping stashes; all work runs off the UI thread.
use super::{
    git_has_head, git_output, git_repository_root, git_status_from, run_blocking,
    validate_git_relative_path,
};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitHistoryEntry {
    hash: String,
    short_hash: String,
    subject: String,
    author: String,
    date: String,
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

#[tauri::command]
pub(crate) async fn git_history(workspace: String) -> Result<Vec<GitHistoryEntry>, String> {
    run_blocking(move || history_from(Path::new(&workspace))).await
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
        for index in 0..32 {
            repo.commit(&format!("change {index}"));
        }
        let history = history_from(&repo.0).unwrap();
        assert_eq!(history.len(), 30);
        assert_eq!(history[0].subject, "change 31");
        assert_eq!(history[0].author, "Pix Test");
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
}
