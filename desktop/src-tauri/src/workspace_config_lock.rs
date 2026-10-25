//! Cross-runtime workspace writer mutex; matches search/source-policy-lock.js.
//! Permanent SQLite ownership is released by the kernel on process death.
use rusqlite::{Connection, OpenFlags};
use std::{fs, path::Path, time::Duration};

pub(super) struct WorkspaceConfigLock(Connection);

impl WorkspaceConfigLock {
    pub(super) fn acquire(project: &Path) -> Result<Self, String> {
        let directory = project.join("workspace.jsonc.lock");
        match fs::create_dir(&directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(format!("failed to create workspace lock: {error}")),
        }
        let info = fs::symlink_metadata(&directory).map_err(|error| error.to_string())?;
        if !info.is_dir() || info.file_type().is_symlink() {
            return Err("unsafe .pi/workspace.jsonc.lock directory".to_owned());
        }
        let path = directory.join("writer.sqlite");
        for suffix in ["", "-journal", "-wal", "-shm"] {
            let candidate = directory.join(format!("writer.sqlite{suffix}"));
            match fs::symlink_metadata(&candidate) {
                Ok(info) => {
                    #[cfg(unix)]
                    let single_link = {
                        use std::os::unix::fs::MetadataExt;
                        info.nlink() == 1
                    };
                    #[cfg(not(unix))]
                    let single_link = true;
                    if !info.is_file() || info.file_type().is_symlink() || !single_link {
                        return Err("unsafe workspace lock database".to_owned());
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
        }
        let db = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(|error| format!("failed to open workspace lock: {error}"))?;
        db.busy_timeout(Duration::from_millis(600))
            .map_err(|error| error.to_string())?;
        db.execute_batch("BEGIN IMMEDIATE").map_err(|error| {
            format!("Workspace configuration busy; retry after the other writer finishes: {error}")
        })?;
        Ok(Self(db))
    }
}

impl Drop for WorkspaceConfigLock {
    fn drop(&mut self) {
        if let Err(error) = self.0.execute_batch("ROLLBACK") {
            super::logging::error(
                module_path!(),
                format!("failed to release workspace lock: {error}"),
            );
        }
        // Never remove the permanent directory/database: that would split locks.
    }
}
