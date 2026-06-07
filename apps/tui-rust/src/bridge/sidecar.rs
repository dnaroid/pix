//! Locate the pix-desktop-sidecar entrypoint.

use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum SidecarLocatorError {
    #[error("could not locate pix-desktop-sidecar main.js; build apps/desktop-tauri/sidecar or set PIX_SIDECAR_PATH. checked: {0}")]
    NotFound(String),
    #[error("PIX_SIDECAR_PATH or sidecar dist is missing main.js: {0}")]
    MissingEntry(PathBuf),
}

/// Locate the compiled sidecar `main.js`.
///
/// Order:
/// 1. `PIX_SIDECAR_PATH` env var (absolute path to `main.js`).
/// 2. `apps/desktop-tauri/sidecar/dist/main.js` relative to the
///    repository root (auto-detected by walking up from the current
///    executable and the current working directory).
pub fn locate_sidecar_main() -> Result<PathBuf, SidecarLocatorError> {
    let env_override = std::env::var("PIX_SIDECAR_PATH").ok().map(PathBuf::from);
    if let Some(path) = env_override.as_ref() {
        if path.is_file() {
            return Ok(path.clone());
        }
    }

    let candidates = repo_root_candidates();
    let mut tried = Vec::new();
    if let Some(path) = env_override {
        tried.push(path);
    }
    for root in &candidates {
        let candidate = root.join("apps/desktop-tauri/sidecar/dist/main.js");
        tried.push(candidate.clone());
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    let tried = tried
        .iter()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    Err(SidecarLocatorError::NotFound(tried))
}

fn repo_root_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();

    // CWD and its ancestors
    if let Ok(cwd) = std::env::current_dir() {
        for ancestor in cwd.ancestors() {
            if looks_like_repo_root(ancestor) {
                out.push(ancestor.to_path_buf());
                break;
            }
        }
        out.push(cwd);
    }

    // Current executable and its ancestors
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            for ancestor in parent.ancestors() {
                if looks_like_repo_root(ancestor) {
                    out.push(ancestor.to_path_buf());
                    break;
                }
            }
        }
    }

    out
}

fn looks_like_repo_root(path: &Path) -> bool {
    // Look for a marker file that is unique to the pi-ui-extend repo layout.
    path.join("apps/desktop-tauri/sidecar/package.json")
        .is_file()
        && path.join("package.json").is_file()
}
