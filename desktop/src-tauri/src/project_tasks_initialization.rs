//! Publish a complete SQLite database, never an observable version-zero file.
//! An exclusive rename (macOS RENAME_EXCL, Linux RENAME_NOREPLACE) never
//! overwrites another initializer and avoids transient hard-link aliases.
use std::{ffi::CString, fs, os::unix::ffi::OsStrExt, path::Path};

/// Returns false with errno set when the rename failed.
fn rename_exclusive(from: &CString, to: &CString) -> bool {
    // SAFETY: the C strings are valid for the syscall. Exclusive rename never
    // overwrites another initializer's database (or any other existing object).
    #[cfg(target_os = "macos")]
    let status = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
    #[cfg(target_os = "linux")]
    let status = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    status == 0
}

pub(super) fn initialize(directory: &Path) -> Result<(), String> {
    if super::exists(directory)? {
        return super::inspect(directory).map(|_| ());
    }
    let staging = directory.join(format!(".tasks-init-{}.tmp", uuid::Uuid::new_v4()));
    fs::create_dir(&staging)
        .map_err(|error| format!("failed to prepare project task database: {error}"))?;
    let result = (|| {
        let connection = super::open(&staging, true)?;
        // Do not rely on close() to report checkpoint failures. Only the main
        // database file is published, so every WAL frame must be durable there.
        let busy: i64 = connection
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))
            .map_err(super::sql_error)?;
        if busy != 0 {
            return Err("new project task database checkpoint is busy; retry saving".into());
        }
        connection
            .close()
            .map_err(|(_, error)| super::sql_error(error))?;
        // Flush before publishing; no writer ever opens the private staging DB.
        let source = staging.join("tasks.sqlite");
        fs::File::open(&source)
            .and_then(|file| file.sync_all())
            .map_err(|error| format!("failed to flush new project task database: {error}"))?;
        let from =
            CString::new(source.as_os_str().as_bytes()).map_err(|error| error.to_string())?;
        let to = CString::new(directory.join("tasks.sqlite").as_os_str().as_bytes())
            .map_err(|error| error.to_string())?;
        if !rename_exclusive(&from, &to) {
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::AlreadyExists {
                return Err(format!("failed to publish project task database: {error}"));
            }
        }
        super::super::sync_directory(directory)?;
        super::inspect(directory).and_then(|present| {
            if present {
                Ok(())
            } else {
                Err("project task database disappeared during initialization".into())
            }
        })
    })();
    if let Err(error) = fs::remove_dir_all(&staging) {
        super::super::logging::record(
            "warn",
            module_path!(),
            "project_tasks.initialization_cleanup_failed",
            serde_json::json!({ "error": error.to_string() }),
            None,
        );
    }
    result
}
