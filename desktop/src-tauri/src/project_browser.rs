//! Open saved project HTML in the default HTTP browser, not the HTML file handler.
use std::path::{Path, PathBuf};

fn resolve_html(workspace: &Path, path: &Path) -> Result<PathBuf, String> {
    let (_, file) = super::resolve_project_entry_path(workspace, path)?;
    let extension = file
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if !file.is_file()
        || !(extension.eq_ignore_ascii_case("html") || extension.eq_ignore_ascii_case("htm"))
    {
        return Err("browser opening requires a project HTML file".to_owned());
    }
    Ok(file)
}

#[tauri::command]
pub(crate) async fn open_project_html_in_browser(
    workspace: String,
    path: String,
) -> Result<(), String> {
    super::run_blocking(move || {
        let file = resolve_html(Path::new(&workspace), Path::new(&path))?;
        #[cfg(target_os = "macos")]
        {
            use objc2_app_kit::NSWorkspace;
            use objc2_foundation::{NSString, NSURL};
            // Resolve the HTTPS handler rather than the user's .html editor association.
            let browser = objc2::rc::autoreleasepool(|_| {
                let url = NSURL::URLWithString(&NSString::from_str("https://example.com"))
                    .ok_or_else(|| "failed to construct browser lookup URL".to_owned())?;
                NSWorkspace::sharedWorkspace()
                    .URLForApplicationToOpenURL(&url)
                    .and_then(|app| app.path())
                    .map(|path| path.to_string())
                    .ok_or_else(|| "no default browser is configured".to_owned())
            })?;
            let status = std::process::Command::new("/usr/bin/open")
                .arg("-a")
                .arg(browser)
                .arg(&file)
                .status()
                .map_err(|error| format!("failed to open HTML in browser: {error}"))?;
            if status.success() {
                Ok(())
            } else {
                Err(format!(
                    "browser could not open HTML (exit status {status})"
                ))
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = file;
            Err("project browser opening is supported only on macOS".to_owned())
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_existing_workspace_html_files_are_allowed() {
        let root = std::env::temp_dir().join(format!("pix-browser-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("folder.html")).unwrap();
        for name in ["page [1] #.HTML", "page.htm", "plain.txt"] {
            std::fs::write(root.join(name), b"test").unwrap();
        }
        assert!(resolve_html(&root, Path::new("page [1] #.HTML")).is_ok());
        assert!(resolve_html(&root, Path::new("page.htm")).is_ok());
        for name in [
            "plain.txt",
            "folder.html",
            "missing.html",
            "../outside.html",
        ] {
            assert!(resolve_html(&root, Path::new(name)).is_err(), "{name}");
        }
        assert!(resolve_html(&root, &root.join("page.htm")).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("page.htm"), root.join("link.html")).unwrap();
            assert!(resolve_html(&root, Path::new("link.html")).is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
