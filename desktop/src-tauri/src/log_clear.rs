//! Explicit shared-log deletion. No caller paths, recursion, or UI-thread filesystem work.
use serde::Serialize;
use std::{fs, io, path::Path};
use tauri::Manager;

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClearLogResult {
    cleared_files: usize,
    failed_files: usize,
}

#[tauri::command]
pub(crate) async fn clear_diagnostic_logs(app: tauri::AppHandle) -> Result<ClearLogResult, String> {
    let directory = app
        .path()
        .home_dir()
        .map_err(|e| e.to_string())?
        .join(".config/pi/logs");
    super::run_blocking(move || clear_directory(&directory).map_err(|e| e.to_string())).await
}

fn clear_directory(path: &Path) -> io::Result<ClearLogResult> {
    let mut result = ClearLogResult::default();
    let directory = match LogDirectory::open(path) {
        Ok(directory) => directory,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(result),
        Err(error) => return Err(error),
    };
    // Stream the entire directory: clearing is not restricted to the reader's recent-file cap.
    for entry in fs::read_dir(path)? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                result.failed_files += 1;
                continue;
            }
        };
        let name = entry.file_name();
        if name
            .to_str()
            .and_then(super::logging::segment_stamp)
            .is_none()
        {
            continue;
        }
        match directory.remove_regular(path, &name) {
            Ok(true) => result.cleared_files += 1,
            Ok(false) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => result.failed_files += 1,
        }
    }
    Ok(result)
}

struct LogDirectory {
    #[cfg(unix)]
    file: fs::File,
}

impl LogDirectory {
    fn open(path: &Path) -> io::Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            let file = fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
                .open(path)?;
            Ok(Self { file })
        }
        #[cfg(not(unix))]
        {
            let metadata = fs::symlink_metadata(path)?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(io::Error::other(
                    "Diagnostic log directory must be a real directory",
                ));
            }
            Ok(Self {})
        }
    }

    fn remove_regular(&self, _path: &Path, name: &std::ffi::OsStr) -> io::Result<bool> {
        #[cfg(unix)]
        {
            use std::{
                ffi::CString,
                mem::MaybeUninit,
                os::{fd::AsRawFd, unix::ffi::OsStrExt},
            };
            let name = CString::new(name.as_bytes()).map_err(io::Error::other)?;
            let mut metadata = MaybeUninit::<libc::stat>::uninit();
            // SAFETY: live directory descriptor, NUL-terminated single entry name, valid stat output.
            let status = unsafe {
                libc::fstatat(
                    self.file.as_raw_fd(),
                    name.as_ptr(),
                    metadata.as_mut_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            };
            if status != 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: fstatat initialized metadata on success.
            let metadata = unsafe { metadata.assume_init() };
            if metadata.st_mode & libc::S_IFMT != libc::S_IFREG {
                return Ok(false);
            }
            // SAFETY: descriptor and name remain valid. unlinkat never follows the final symlink;
            // renaming/replacing the directory path cannot redirect deletion outside this descriptor.
            if unsafe { libc::unlinkat(self.file.as_raw_fd(), name.as_ptr(), 0) } != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(true)
        }
        #[cfg(not(unix))]
        {
            let path = _path.join(name);
            let metadata = fs::symlink_metadata(&path)?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Ok(false);
            }
            fs::remove_file(path)?;
            Ok(true)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_directory() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("pix-log-clear-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn clears_all_sources_beyond_snapshot_limits_and_preserves_unrelated_entries() {
        let path = temporary_directory();
        for index in 0..80 {
            for source in ["backend", "acp", "desktop"] {
                fs::write(
                    path.join(format!("pix-v1-123-{source}-writer-{index}.jsonl")),
                    "old\n",
                )
                .unwrap();
            }
        }
        fs::write(
            path.join("pix-v1-123-backend-writer-fatal-81.jsonl"),
            "fatal\n",
        )
        .unwrap();
        fs::write(path.join("pix.log"), "legacy").unwrap();
        fs::write(path.join("unrelated.jsonl"), "keep").unwrap();
        fs::create_dir(path.join("pix-v1-123-desktop-directory-0.jsonl")).unwrap();
        let result = clear_directory(&path).unwrap();
        assert_eq!(result.cleared_files, 241);
        assert_eq!(result.failed_files, 0);
        assert_eq!(fs::read_dir(&path).unwrap().count(), 3);
        assert_eq!(clear_directory(&path).unwrap().cleared_files, 0);
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn missing_directory_is_already_clear() {
        let path = temporary_directory();
        fs::remove_dir(&path).unwrap();
        assert_eq!(clear_directory(&path).unwrap().cleared_files, 0);
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_directory_symlinks_and_preserves_file_symlink_targets() {
        use std::os::unix::fs::symlink;
        let root = temporary_directory();
        let logs = root.join("logs");
        fs::create_dir(&logs).unwrap();
        let outside = root.join("outside.jsonl");
        fs::write(&outside, "keep").unwrap();
        symlink(&outside, logs.join("pix-v1-123-backend-link-0.jsonl")).unwrap();
        assert_eq!(clear_directory(&logs).unwrap().cleared_files, 0);
        symlink(&logs, root.join("linked-logs")).unwrap();
        assert!(clear_directory(&root.join("linked-logs")).is_err());
        assert_eq!(fs::read_to_string(outside).unwrap(), "keep");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn deletion_remains_anchored_if_directory_path_is_replaced() {
        let root = temporary_directory();
        let logs = root.join("logs");
        let outside = root.join("outside");
        fs::create_dir(&logs).unwrap();
        fs::create_dir(&outside).unwrap();
        let name = std::ffi::OsStr::new("pix-v1-123-desktop-writer-0.jsonl");
        fs::write(logs.join(name), "delete").unwrap();
        fs::write(outside.join(name), "keep").unwrap();
        let directory = LogDirectory::open(&logs).unwrap();
        fs::rename(&logs, root.join("moved")).unwrap();
        std::os::unix::fs::symlink(&outside, &logs).unwrap();
        assert!(directory.remove_regular(&logs, name).unwrap());
        assert_eq!(fs::read_to_string(outside.join(name)).unwrap(), "keep");
        assert_eq!(
            directory.remove_regular(&logs, name).unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
        fs::remove_dir_all(root).unwrap();
    }
}
