//! Explorer ignore actions: local Git checks and literal, append-only rules.
use super::{git_output_raw, git_repository_root, run_blocking, validate_workspace_relative_path};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

static IGNORE_WRITE: Mutex<()> = Mutex::new(());

#[tauri::command]
pub(crate) async fn git_can_ignore(workspace: String, path: String) -> Result<bool, String> {
    run_blocking(move || can_ignore_from(Path::new(&workspace), &path)).await
}

#[tauri::command]
pub(crate) async fn git_ignore_entry(workspace: String, path: String) -> Result<(), String> {
    run_blocking(move || ignore_from(Path::new(&workspace), &path)).await
}

fn target(workspace: &Path, path: &str) -> Result<(PathBuf, PathBuf), String> {
    validate_workspace_relative_path(Path::new(path), "Git ignore target")?;
    if path.is_empty() || path.contains(['\n', '\r']) {
        return Err("Git ignore target must be a nonempty single-line path".into());
    }
    let root = git_repository_root(workspace)?;
    let mut current = root.clone();
    for component in Path::new(path).components() {
        current.push(component);
        let metadata = fs::symlink_metadata(&current).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink()
            || component
                .as_os_str()
                .to_string_lossy()
                .eq_ignore_ascii_case(".git")
        {
            return Err("Cannot ignore symbolic links or Git metadata".into());
        }
    }
    if current == root {
        return Err("Cannot ignore the repository root".into());
    }
    Ok((root, current))
}

fn eligible(root: &Path, path: &str) -> Result<bool, String> {
    // Check rules independently of tracking: adding a rule never untracks files.
    let ignored = git_output_raw(root, &["check-ignore", "--no-index", "-q", "--", path])?;
    match ignored.status.code() {
        Some(0) => Ok(false),
        Some(1) => Ok(true),
        _ => Err(String::from_utf8_lossy(&ignored.stderr).trim().to_owned()),
    }
}

fn can_ignore_from(workspace: &Path, path: &str) -> Result<bool, String> {
    let (root, _) = target(workspace, path)?;
    eligible(&root, path)
}

fn literal_rule(path: &Path, directory: bool) -> Result<String, String> {
    let text = path.to_str().ok_or("Git ignore path is not UTF-8")?;
    let mut rule = String::from("/");
    for character in text.chars() {
        if matches!(character, '\\' | '*' | '?' | '[' | ']' | ' ' | '#' | '!') {
            rule.push('\\');
        }
        rule.push(character);
    }
    if directory {
        rule.push('/');
    }
    Ok(rule)
}

fn ignore_from(workspace: &Path, path: &str) -> Result<(), String> {
    let _guard = IGNORE_WRITE.lock().map_err(|error| error.to_string())?;
    let (root, target) = target(workspace, path)?;
    // Recheck on invocation: status/menu eligibility may have changed meanwhile.
    if !eligible(&root, path)? {
        return Err("Entry already matches Git ignore rules".into());
    }
    // Use the nearest existing .gitignore, falling back to the repository root.
    // Appending after existing negations makes the selected literal rule win.
    let mut directory = target
        .parent()
        .ok_or("Missing target parent")?
        .to_path_buf();
    let ignore = loop {
        let candidate = directory.join(".gitignore");
        match fs::symlink_metadata(&candidate) {
            Ok(metadata) => {
                if !metadata.is_file() || metadata.file_type().is_symlink() {
                    return Err(".gitignore must be a regular file, not a symbolic link".into());
                }
                break candidate;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        if directory == root {
            break candidate;
        }
        directory.pop();
    };
    let relative = target
        .strip_prefix(&directory)
        .map_err(|error| error.to_string())?;
    let rule = literal_rule(relative, target.is_dir())?;
    let existing = match fs::read(&ignore) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error.to_string()),
    };
    let newline = if existing.windows(2).any(|bytes| bytes == b"\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let separator = if existing.is_empty() || existing.ends_with(b"\n") {
        ""
    } else {
        newline
    };
    let mut options = fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(&ignore).map_err(|error| error.to_string())?;
    file.write_all(format!("{separator}{rule}{newline}").as_bytes())
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::super::git_output;
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Repository(PathBuf);
    impl Repository {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "pix-ignore-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&root).unwrap();
            git_output(&root, &["init", "-b", "main"]).unwrap();
            Self(root)
        }
    }
    impl Drop for Repository {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn git_ignore_preserves_rules_and_refreshes_git_status() {
        let repo = Repository::new();
        fs::create_dir_all(repo.0.join("cache")).unwrap();
        fs::write(repo.0.join("cache/file.txt"), "data").unwrap();
        fs::write(repo.0.join(".gitignore"), "# existing\r\nother").unwrap();
        assert!(can_ignore_from(&repo.0, "cache").unwrap());
        ignore_from(&repo.0, "cache").unwrap();
        assert_eq!(
            fs::read_to_string(repo.0.join(".gitignore")).unwrap(),
            "# existing\r\nother\r\n/cache/\r\n"
        );
        assert!(!can_ignore_from(&repo.0, "cache").unwrap());
        assert!(!can_ignore_from(&repo.0, "cache/file.txt").unwrap());
        let status = super::super::git_status_from(&repo.0).unwrap();
        assert!(status
            .changes
            .iter()
            .all(|change| !change.path.starts_with("cache")));
        assert!(status
            .changes
            .iter()
            .any(|change| change.path == ".gitignore"));
        assert!(ignore_from(&repo.0, "cache").is_err());
    }

    #[test]
    fn git_ignore_escapes_literal_names_and_respects_nested_negations() {
        let repo = Repository::new();
        fs::create_dir(repo.0.join("nested")).unwrap();
        let name = "nested/a[*]? .txt";
        fs::write(repo.0.join(name), "data").unwrap();
        fs::write(
            repo.0.join("nested/.gitignore"),
            "# nested\n*.txt\n!/a\\[\\*\\]\\?\\ .txt\n",
        )
        .unwrap();
        assert!(can_ignore_from(&repo.0, name).unwrap());
        ignore_from(&repo.0, name).unwrap();
        assert!(!can_ignore_from(&repo.0, name).unwrap());
        assert!(!repo.0.join(".gitignore").exists());
        fs::write(repo.0.join("nested/another.bin"), "data").unwrap();
        assert!(can_ignore_from(&repo.0, "nested/another.bin").unwrap());
        assert!(fs::read_to_string(repo.0.join("nested/.gitignore"))
            .unwrap()
            .contains("/a\\[\\*\\]\\?\\ .txt\n"));
    }

    #[test]
    fn git_ignore_allows_tracked_files_and_folders_without_changing_index() {
        for path in ["src/tracked.txt", "src"] {
            let repo = Repository::new();
            fs::create_dir(repo.0.join("src")).unwrap();
            fs::write(repo.0.join("src/tracked.txt"), "data").unwrap();
            fs::write(repo.0.join("src/untracked.txt"), "data").unwrap();
            git_output(&repo.0, &["add", "src/tracked.txt"]).unwrap();
            let index = fs::read(repo.0.join(".git/index")).unwrap();
            assert!(can_ignore_from(&repo.0, path).unwrap());
            ignore_from(&repo.0, path).unwrap();
            assert!(!can_ignore_from(&repo.0, path).unwrap());
            assert!(ignore_from(&repo.0, path).is_err());
            assert_eq!(fs::read(repo.0.join(".git/index")).unwrap(), index);
            assert_eq!(
                fs::read_to_string(repo.0.join(".gitignore")).unwrap(),
                if path == "src" {
                    "/src/\n"
                } else {
                    "/src/tracked.txt\n"
                }
            );
            let status = super::super::git_status_from(&repo.0).unwrap();
            assert!(status
                .changes
                .iter()
                .any(|change| change.path == "src/tracked.txt"));
            if path == "src" {
                assert!(!status
                    .changes
                    .iter()
                    .any(|change| change.path == "src/untracked.txt"));
            }
        }
    }

    #[test]
    fn git_ignore_rejects_unsafe_targets() {
        let repo = Repository::new();
        fs::create_dir(repo.0.join("src")).unwrap();
        fs::write(repo.0.join("src/tracked.txt"), "data").unwrap();
        git_output(&repo.0, &["add", "src/tracked.txt"]).unwrap();
        for path in [
            "",
            ".",
            "../outside",
            "/absolute",
            ".git",
            "src/line\nbreak",
        ] {
            assert!(ignore_from(&repo.0, path).is_err());
        }
        assert!(!repo.0.join(".gitignore").exists());
        assert!(can_ignore_from(&repo.0.join("src"), "tracked.txt").is_err());
    }

    #[test]
    fn git_ignore_creates_root_rules_and_honors_global_excludes() {
        let repo = Repository::new();
        fs::write(repo.0.join("new.txt"), "data").unwrap();
        fs::write(repo.0.join("exclude"), "new.txt\n").unwrap();
        let excludes = repo.0.join("exclude");
        git_output(
            &repo.0,
            &["config", "core.excludesFile", excludes.to_str().unwrap()],
        )
        .unwrap();
        assert!(!can_ignore_from(&repo.0, "new.txt").unwrap());
        git_output(&repo.0, &["config", "--unset", "core.excludesFile"]).unwrap();
        ignore_from(&repo.0, "new.txt").unwrap();
        assert_eq!(
            fs::read_to_string(repo.0.join(".gitignore")).unwrap(),
            "/new.txt\n"
        );
        fs::remove_dir_all(repo.0.join(".git")).unwrap();
        assert!(can_ignore_from(&repo.0, "new.txt").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn git_ignore_rejects_symlink_targets_ancestors_and_ignore_files() {
        use std::os::unix::fs::symlink;
        let repo = Repository::new();
        fs::create_dir(repo.0.join("real")).unwrap();
        fs::write(repo.0.join("real/file"), "data").unwrap();
        symlink("real", repo.0.join("link")).unwrap();
        assert!(can_ignore_from(&repo.0, "link/file").is_err());
        assert!(can_ignore_from(&repo.0, "link").is_err());
        symlink("real/file", repo.0.join(".gitignore")).unwrap();
        assert!(ignore_from(&repo.0, "real/file").is_err());
        assert_eq!(
            fs::read_to_string(repo.0.join("real/file")).unwrap(),
            "data"
        );
    }
}
