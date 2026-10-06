use std::path::Path;

/// Directory links use the explorer's confinement policy, not the OS opener.
fn directory_exists(workspace: &Path, path: &Path) -> bool {
    if super::validate_workspace_relative_path(path, "project directory").is_err() {
        return false;
    }
    let mut target = workspace.to_path_buf();
    for component in path.components() {
        target.push(component);
        match std::fs::symlink_metadata(&target) {
            Ok(metadata) if !metadata.file_type().is_symlink() => {}
            _ => return false,
        }
    }
    super::resolve_project_directory_path(workspace, Some(path)).is_ok()
}

#[tauri::command]
pub async fn project_directory_exists(workspace: String, path: String) -> Result<bool, String> {
    super::run_blocking(move || Ok(directory_exists(Path::new(&workspace), Path::new(&path)))).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn directory_links_are_confined_and_do_not_accept_files() {
        let root = std::env::temp_dir().join(format!("pix-directory-link-{}", uuid::Uuid::new_v4()));
        let workspace = root.join("project");
        fs::create_dir_all(workspace.join("nested/folder.png")).unwrap();
        fs::write(workspace.join("file.txt"), "text").unwrap();
        assert!(directory_exists(&workspace, Path::new("nested/folder.png")));
        for path in ["file.txt", "missing", "../", "/tmp"] {
            assert!(!directory_exists(&workspace, Path::new(path)), "{path}");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&root, workspace.join("escape")).unwrap();
            std::os::unix::fs::symlink(workspace.join("nested"), workspace.join("alias")).unwrap();
            assert!(!directory_exists(&workspace, Path::new("escape")));
            assert!(!directory_exists(&workspace, Path::new("alias")));
            assert!(!directory_exists(&workspace, Path::new("alias/folder.png")));
        }
        fs::remove_dir_all(root).unwrap();
    }
}
