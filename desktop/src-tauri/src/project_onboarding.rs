use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use crate::{canonical_workspace, run_blocking};

fn receipt_directory(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|path| path.join("project-onboarding"))
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) async fn project_onboarding_available(
    app: AppHandle,
    workspace: String,
) -> Result<Option<String>, String> {
    let receipts = receipt_directory(&app)?;
    run_blocking(move || offer(&canonical_workspace(Path::new(&workspace))?, &receipts)).await
}

#[tauri::command]
pub(crate) async fn claim_project_onboarding(
    app: AppHandle,
    workspace: String,
    folder_id: String,
) -> Result<bool, String> {
    let receipts = receipt_directory(&app)?;
    run_blocking(move || {
        claim(
            &canonical_workspace(Path::new(&workspace))?,
            &receipts,
            &folder_id,
        )
    })
    .await
}

fn folder_identity(root: &Path) -> Result<String, String> {
    let metadata = fs::metadata(root).map_err(|err| err.to_string())?;
    // The same directory may be opened under an alias or moved. A newly created
    // directory at the old path must not inherit the previous setup decision.
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        (metadata.dev(), metadata.ino())
    };
    #[cfg(not(unix))]
    let identity = root;
    let key = Sha256::digest(format!("{identity:?}/{:?}", metadata.created().ok()));
    Ok(format!("{key:x}"))
}

fn offer(root: &Path, receipts: &Path) -> Result<Option<String>, String> {
    let folder_id = folder_identity(root)?;
    match fs::symlink_metadata(receipts.join(&folder_id)) {
        Ok(_) => Ok(None),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            Ok(empty_for_setup(root)?.then_some(folder_id))
        }
        Err(err) => Err(err.to_string()),
    }
}

fn empty_for_setup(root: &Path) -> Result<bool, String> {
    let walk = |path: &Path| fs::read_dir(path).map_err(|err| format!("{}: {err}", path.display()));
    for entry in walk(root)? {
        let entry = entry.map_err(|err| err.to_string())?;
        match entry.file_name().to_str() {
            Some(".DS_Store") if entry.file_type().map_err(|err| err.to_string())?.is_file() => {}
            Some(".pi") if entry.file_type().map_err(|err| err.to_string())?.is_dir() => {
                for child in walk(&entry.path())? {
                    let child = child.map_err(|err| err.to_string())?;
                    if !matches!(
                        child.file_name().to_str(),
                        Some("project-id" | "registry-project-key")
                    ) || !child.file_type().map_err(|err| err.to_string())?.is_file()
                    {
                        return Ok(false);
                    }
                }
            }
            _ => return Ok(false),
        }
    }
    Ok(true)
}

fn claim(root: &Path, receipts: &Path, folder_id: &str) -> Result<bool, String> {
    // Recheck after displaying the dialog: another window or external tool may
    // have started using this folder in the meantime.
    let current = folder_identity(root)?;
    if current != folder_id || !empty_for_setup(root)? {
        return Ok(false);
    }
    fs::create_dir_all(receipts).map_err(|err| err.to_string())?;
    // The file's existence is the whole receipt, including for Skip. Only the
    // winning window may apply changes; retries stay in that window's dialog.
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(receipts.join(current))
    {
        Ok(_) => Ok(true),
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(err) => Err(format!(
            "Could not remember the project setup decision: {err}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("pix-onboarding-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn only_empty_folders_and_incidental_metadata_are_eligible() {
        let dir = Fixture::new();
        let root = &dir.0;
        assert!(empty_for_setup(root).unwrap());
        fs::create_dir(root.join(".pi")).unwrap();
        fs::write(root.join(".pi/project-id"), "identity").unwrap();
        fs::write(root.join(".DS_Store"), "metadata").unwrap();
        assert!(empty_for_setup(root).unwrap());
        for path in [".git", ".gitignore", "README.md", ".pi/workspace.jsonc"] {
            fs::write(root.join(path), "content").unwrap();
            assert!(!empty_for_setup(root).unwrap(), "{path}");
            fs::remove_file(root.join(path)).unwrap();
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("absent"), root.join("link")).unwrap();
            assert!(!empty_for_setup(root).unwrap());
        }
    }

    #[test]
    fn only_one_window_can_claim_and_the_choice_persists() {
        let dir = Fixture::new();
        let receipts = &dir.0.join("receipts");
        let root = &dir.0.join("workspace");
        fs::create_dir(root).unwrap();
        let folder_id = &offer(root, receipts).unwrap().unwrap();
        let barrier = std::sync::Barrier::new(2);
        let count = std::thread::scope(|scope| {
            let handles = (0..2)
                .map(|_| {
                    scope.spawn(|| {
                        barrier.wait();
                        claim(root, receipts, folder_id).unwrap()
                    })
                })
                .collect::<Vec<_>>();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .filter(|won| *won)
                .count()
        });
        assert_eq!(count, 1);
        assert!(offer(root, receipts).unwrap().is_none());
        assert!(!claim(root, receipts, folder_id).unwrap());
        assert_eq!(fs::read_dir(root).unwrap().count(), 0);
    }

    #[test]
    fn a_replacement_folder_does_not_inherit_an_open_offer() {
        let dir = Fixture::new();
        let receipts = dir.0.join("receipts");
        let root = dir.0.join("workspace");
        fs::create_dir(&root).unwrap();
        let folder_id = offer(&root, &receipts).unwrap().unwrap();
        fs::rename(&root, dir.0.join("old-workspace")).unwrap();
        fs::create_dir(&root).unwrap();
        assert!(!claim(&root, &receipts, &folder_id).unwrap());
        assert!(offer(&root, &receipts).unwrap().is_some());
    }
}
