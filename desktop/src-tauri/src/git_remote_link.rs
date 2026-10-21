//! Explorer "Open on GitHub/GitLab": derive a browser URL for a project entry
//! from the selected Git remote and the current branch (or detached HEAD).
use super::{
    git_ci::{resolve_remote, GitCiProvider},
    git_output, git_repository_root, run_blocking, validate_workspace_relative_path,
};
use serde::Serialize;
use std::{fs, path::Path};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitRemoteEntryLink {
    provider: GitCiProvider,
    url: String,
}

/// Returns `None` when the workspace has no supported GitHub/GitLab remote.
#[tauri::command]
pub(crate) async fn git_remote_entry_link(
    workspace: String,
    path: String,
) -> Result<Option<GitRemoteEntryLink>, String> {
    run_blocking(move || remote_entry_link_from(Path::new(&workspace), &path)).await
}

fn remote_entry_link_from(
    workspace: &Path,
    path: &str,
) -> Result<Option<GitRemoteEntryLink>, String> {
    if !path.is_empty() {
        validate_workspace_relative_path(Path::new(path), "Git remote link target")?;
    }
    let root = git_repository_root(workspace)?;
    // Unsupported hosts/URLs mean "no remote link", not a user-facing failure.
    let Some(remote) = resolve_remote(&root).ok().flatten() else {
        return Ok(None);
    };
    let url = git_output(&root, &["remote", "get-url", &remote.name])?;
    let remote_url = String::from_utf8_lossy(&url.stdout).trim().to_owned();
    let branch = git_output(&root, &["branch", "--show-current"])?;
    let mut reference = String::from_utf8_lossy(&branch.stdout).trim().to_owned();
    if reference.is_empty() {
        let head = git_output(&root, &["rev-parse", "HEAD"])?;
        reference = String::from_utf8_lossy(&head.stdout).trim().to_owned();
    }
    if reference.is_empty() {
        return Ok(None);
    }
    let directory = path.is_empty()
        || fs::symlink_metadata(root.join(path))
            .map(|metadata| metadata.is_dir())
            .map_err(|error| error.to_string())?;
    Ok(Some(GitRemoteEntryLink {
        provider: remote.provider,
        url: entry_url(
            remote.provider,
            &web_base(&remote_url, &remote.host),
            &remote.project,
            &reference,
            path,
            directory,
        ),
    }))
}

/// HTTP(S) remotes keep their scheme and port; SSH ports never serve the web UI.
fn web_base(remote_url: &str, host: &str) -> String {
    let lower = remote_url.to_ascii_lowercase();
    if lower.starts_with("http://") {
        return format!("http://{host}");
    }
    if lower.starts_with("https://") {
        return format!("https://{host}");
    }
    let host = host.rsplit_once(':').map_or(host, |(name, _)| name);
    format!("https://{host}")
}

fn entry_url(
    provider: GitCiProvider,
    base: &str,
    project: &str,
    reference: &str,
    path: &str,
    directory: bool,
) -> String {
    let kind = if directory { "tree" } else { "blob" };
    let separator = match provider {
        GitCiProvider::Github => "",
        GitCiProvider::Gitlab => "-/",
    };
    let mut url = format!(
        "{base}/{project}/{separator}{kind}/{}",
        encode_segments(reference)
    );
    if !path.is_empty() {
        url.push('/');
        url.push_str(&encode_segments(&path.replace('\\', "/")));
    }
    url
}

fn encode_segments(value: &str) -> String {
    value
        .split('/')
        .map(|segment| {
            let mut encoded = String::with_capacity(segment.len());
            for byte in segment.bytes() {
                if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
                    encoded.push(byte as char);
                } else {
                    encoded.push_str(&format!("%{byte:02X}"));
                }
            }
            encoded
        })
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_github_and_gitlab_file_and_directory_urls() {
        assert_eq!(
            entry_url(
                GitCiProvider::Github,
                "https://github.com",
                "o/r",
                "main",
                "src/a b.ts",
                false
            ),
            "https://github.com/o/r/blob/main/src/a%20b.ts"
        );
        assert_eq!(
            entry_url(
                GitCiProvider::Github,
                "https://github.com",
                "o/r",
                "feat/x",
                "src",
                true
            ),
            "https://github.com/o/r/tree/feat/x/src"
        );
        assert_eq!(
            entry_url(
                GitCiProvider::Gitlab,
                "https://gitlab.com",
                "g/sub/r",
                "main",
                "docs/#1.md",
                false
            ),
            "https://gitlab.com/g/sub/r/-/blob/main/docs/%231.md"
        );
        assert_eq!(
            entry_url(
                GitCiProvider::Gitlab,
                "https://gitlab.com",
                "g/r",
                "main",
                "",
                true
            ),
            "https://gitlab.com/g/r/-/tree/main"
        );
    }

    #[test]
    fn web_base_drops_ssh_ports_but_keeps_http_ports() {
        assert_eq!(
            web_base("git@github.com:o/r.git", "github.com"),
            "https://github.com"
        );
        assert_eq!(
            web_base(
                "ssh://git@gitlab.example.com:2222/g/r.git",
                "gitlab.example.com:2222"
            ),
            "https://gitlab.example.com"
        );
        assert_eq!(
            web_base("http://gitlab.local:8080/g/r.git", "gitlab.local:8080"),
            "http://gitlab.local:8080"
        );
    }

    #[test]
    fn rejects_paths_outside_the_workspace() {
        assert!(remote_entry_link_from(Path::new("."), "../x").is_err());
    }
}
