//! Minimal, write-only project storage setup. Opening a workspace never calls this.
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub(super) fn ensure_directory(root: &Path) -> Result<PathBuf, String> {
    let directory = root.join(".pi");
    match fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(".pi must be a project-owned directory".into());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // Ignore before creating private state. Failure leaves no unignored .pi.
            ensure_ignored(root)?;
            match fs::create_dir(&directory) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => {
                    return Err(format!("failed to create {}: {error}", directory.display()))
                }
            }
        }
        Err(error) => {
            return Err(format!(
                "failed to inspect {}: {error}",
                directory.display()
            ))
        }
    }
    let metadata = fs::symlink_metadata(&directory).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(".pi must be a project-owned directory".into());
    }
    super::canonical_project_directory(root, &directory)
}

fn ensure_ignored(root: &Path) -> Result<(), String> {
    append_ignore_rule(root)
        .map_err(|error| format!("failed to update .gitignore for .pi/: {error}"))
}

fn append_ignore_rule(root: &Path) -> Result<(), String> {
    let path = root.join(".gitignore");
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(".gitignore must be a regular file, not a symbolic link".into());
        }
    }
    let mut options = fs::OpenOptions::new();
    options.read(true).append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = options.open(&path).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err(".gitignore must be a regular file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::{fs::MetadataExt, io::AsRawFd};
        if metadata.nlink() != 1 {
            return Err(".gitignore must not be hard-linked".into());
        }
        // Serialize concurrent initializers across windows/processes. The kernel
        // releases this lock when the descriptor is dropped, including on error.
        // SAFETY: file owns a valid descriptor for the duration of the call.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    let mut content = String::new();
    (&mut file)
        .take(1024 * 1024 + 1)
        .read_to_string(&mut content)
        .map_err(|error| error.to_string())?;
    if content.len() > 1024 * 1024 {
        return Err(".gitignore is too large (maximum 1 MB)".into());
    }
    if content
        .lines()
        .any(|line| matches!(line.trim(), ".pi" | ".pi/" | "/.pi" | "/.pi/"))
    {
        return Ok(());
    }
    let newline = if content.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let separator = if content.is_empty() || content.ends_with('\n') {
        ""
    } else {
        newline
    };
    file.write_all(format!("{separator}/.pi/{newline}").as_bytes())
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())
}
