//! Repository-only commit identity. Update both keys under Git's config lock.
use super::{git_command_error, git_output, git_output_raw, git_repository_root, run_blocking};
use serde::Serialize;
use std::{fs, io::Write, path::Path};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitIdentity {
    name: String,
    email: String,
    local_name: Option<String>,
    local_email: Option<String>,
}

#[tauri::command]
pub(crate) async fn git_identity(workspace: String) -> Result<GitIdentity, String> {
    run_blocking(move || identity_from(Path::new(&workspace))).await
}

#[tauri::command]
pub(crate) async fn git_save_identity(
    workspace: String,
    name: String,
    email: String,
) -> Result<(), String> {
    run_blocking(move || save_from(Path::new(&workspace), &name, &email)).await
}

fn config_value(root: &Path, key: &str, local: bool) -> Result<Option<String>, String> {
    let args = if local {
        vec!["config", "--local", "--get", key]
    } else {
        vec!["config", "--get", key]
    };
    let output = git_output_raw(root, &args)?;
    if output.status.success() {
        return Ok(Some(
            String::from_utf8_lossy(&output.stdout)
                .trim_end_matches(['\n', '\r'])
                .to_owned(),
        ));
    }
    if output.status.code() == Some(1) {
        return Ok(None);
    }
    Err(git_command_error("Git identity", &output))
}

fn identity_from(workspace: &Path) -> Result<GitIdentity, String> {
    let root = git_repository_root(workspace)?;
    Ok(GitIdentity {
        name: config_value(&root, "user.name", false)?.unwrap_or_default(),
        email: config_value(&root, "user.email", false)?.unwrap_or_default(),
        local_name: config_value(&root, "user.name", true)?,
        local_email: config_value(&root, "user.email", true)?,
    })
}

fn validate(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 320
        || value
            .chars()
            .any(|c| c.is_control() || c == '<' || c == '>')
    {
        return Err(format!("{label} must be nonempty, at most 320 bytes, without control characters or angle brackets"));
    }
    Ok(value.to_owned())
}

fn save_from(workspace: &Path, name: &str, email: &str) -> Result<(), String> {
    let name = validate(name, "Name")?;
    let email = validate(email, "Email")?;
    let root = git_repository_root(workspace)?;
    let output = git_output(&root, &["rev-parse", "--git-common-dir"])?;
    let config = root
        .join(String::from_utf8_lossy(&output.stdout).trim())
        .join("config");
    let lock = config.with_file_name("config.lock");
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock)
        .map_err(|error| {
            format!("Cannot lock Git config; finish other Git operations and retry: {error}")
        })?;
    let result = (|| {
        let permissions = fs::metadata(&config)
            .map_err(|error| format!("Cannot inspect Git config: {error}"))?
            .permissions();
        file.set_permissions(permissions)
            .map_err(|error| format!("Cannot preserve Git config permissions: {error}"))?;
        let contents =
            fs::read(&config).map_err(|error| format!("Cannot read Git config: {error}"))?;
        file.write_all(&contents)
            .map_err(|error| format!("Cannot copy Git config: {error}"))?;
        drop(file);
        let lock_path = lock.to_str().ok_or("Git config path is not UTF-8")?;
        for (key, value) in [("user.name", name.as_str()), ("user.email", email.as_str())] {
            git_output(
                &root,
                &["config", "--file", lock_path, "--replace-all", key, value],
            )?;
        }
        fs::rename(&lock, &config).map_err(|error| format!("Cannot save Git config: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&lock);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Repo(std::path::PathBuf);
    impl Repo {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "pix-git-identity-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            git_output(&path, &["init", "-b", "main"]).unwrap();
            Self(path)
        }
    }
    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn git_identity_saves_local_pair_and_preserves_other_config() {
        let repo = Repo::new();
        git_output(&repo.0, &["config", "--local", "pix.test", "keep"]).unwrap();
        save_from(&repo.0, " dnaroid ", " dnaroid@gmail.com ").unwrap();
        let identity = identity_from(&repo.0).unwrap();
        assert_eq!(identity.local_name.as_deref(), Some("dnaroid"));
        assert_eq!(identity.local_email.as_deref(), Some("dnaroid@gmail.com"));
        assert_eq!(
            config_value(&repo.0, "pix.test", true).unwrap().as_deref(),
            Some("keep")
        );
        save_from(&repo.0, "Another name", "local-email").unwrap();
        assert_eq!(
            config_value(&repo.0, "user.name", true).unwrap().as_deref(),
            Some("Another name")
        );
        assert!(!repo.0.join(".git/config.lock").exists());
    }

    #[test]
    fn git_identity_validation_and_lock_failures_preserve_config() {
        let repo = Repo::new();
        let config = repo.0.join(".git/config");
        let original = fs::read(&config).unwrap();
        for (name, email) in [
            ("", "a@b"),
            ("valid", "a\nb"),
            ("a<b", "a@b"),
            ("valid", ""),
        ] {
            assert!(save_from(&repo.0, name, email).is_err());
            assert_eq!(fs::read(&config).unwrap(), original);
        }
        fs::write(repo.0.join(".git/config.lock"), "owned by another process").unwrap();
        assert!(save_from(&repo.0, "name", "email").is_err());
        assert_eq!(fs::read(&config).unwrap(), original);
        assert_eq!(
            fs::read_to_string(repo.0.join(".git/config.lock")).unwrap(),
            "owned by another process"
        );
    }

    #[test]
    fn git_identity_rejects_nested_workspace() {
        let repo = Repo::new();
        let child = repo.0.join("child");
        fs::create_dir(&child).unwrap();
        assert!(identity_from(&child).is_err());
        assert!(save_from(&child, "name", "email").is_err());
    }

    #[test]
    fn git_identity_reads_inherited_values_without_creating_local_overrides() {
        let repo = Repo::new();
        let included = repo.0.join("defaults.gitconfig");
        fs::write(
            &included,
            "[user]\nname = Personal\nemail = personal@example.invalid\n",
        )
        .unwrap();
        git_output(
            &repo.0,
            &[
                "config",
                "--local",
                "include.path",
                included.to_str().unwrap(),
            ],
        )
        .unwrap();
        let identity = identity_from(&repo.0).unwrap();
        assert_eq!(identity.name, "Personal");
        assert_eq!(identity.email, "personal@example.invalid");
        assert!(identity.local_name.is_none());
        assert!(identity.local_email.is_none());
        save_from(&repo.0, "dnaroid", "dnaroid@gmail.com").unwrap();
        assert_eq!(identity_from(&repo.0).unwrap().email, "dnaroid@gmail.com");
        assert_eq!(
            fs::read_to_string(included).unwrap(),
            "[user]\nname = Personal\nemail = personal@example.invalid\n"
        );
    }

    #[test]
    fn git_identity_failed_staging_write_cleans_owned_lock_only() {
        let repo = Repo::new();
        let config = repo.0.join(".git/config");
        let original = fs::read(&config).unwrap();
        let nested_lock = repo.0.join(".git/config.lock.lock");
        fs::write(&nested_lock, "foreign lock").unwrap();
        assert!(save_from(&repo.0, "Personal", "personal@example.invalid").is_err());
        assert_eq!(fs::read(&config).unwrap(), original);
        assert!(!repo.0.join(".git/config.lock").exists());
        assert_eq!(fs::read_to_string(nested_lock).unwrap(), "foreign lock");
    }

    #[test]
    fn git_identity_linked_worktree_updates_common_config_without_rewriting_history() {
        let repo = Repo::new();
        save_from(&repo.0, "Old identity", "old@example.invalid").unwrap();
        git_output(
            &repo.0,
            &[
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-m",
                "old",
            ],
        )
        .unwrap();
        let old_commit = git_output(&repo.0, &["log", "-1", "--format=%H %an <%ae>"])
            .unwrap()
            .stdout;
        let worktree = repo.0.join("linked");
        git_output(
            &repo.0,
            &[
                "worktree",
                "add",
                "-b",
                "linked",
                worktree.to_str().unwrap(),
            ],
        )
        .unwrap();
        save_from(&worktree, "Personal", "personal@example.invalid").unwrap();
        assert_eq!(identity_from(&repo.0).unwrap().name, "Personal");
        assert_eq!(
            identity_from(&worktree).unwrap().email,
            "personal@example.invalid"
        );
        assert_eq!(
            git_output(&repo.0, &["log", "-1", "--format=%H %an <%ae>"])
                .unwrap()
                .stdout,
            old_commit
        );
        git_output(
            &repo.0,
            &["config", "--local", "extensions.worktreeConfig", "true"],
        )
        .unwrap();
        git_output(
            &worktree,
            &["config", "--worktree", "user.name", "Worktree override"],
        )
        .unwrap();
        save_from(&worktree, "New common identity", "new@example.invalid").unwrap();
        assert_eq!(identity_from(&worktree).unwrap().name, "Worktree override");
        assert_eq!(identity_from(&repo.0).unwrap().name, "New common identity");
    }

    #[cfg(unix)]
    #[test]
    fn git_identity_preserves_config_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let repo = Repo::new();
        let config = repo.0.join(".git/config");
        fs::set_permissions(&config, fs::Permissions::from_mode(0o600)).unwrap();
        save_from(&repo.0, "Personal", "personal@example.invalid").unwrap();
        assert_eq!(
            fs::metadata(config).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
