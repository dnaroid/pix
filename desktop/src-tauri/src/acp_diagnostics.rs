//! Bounded stderr capture and project-local crash receipts. No protocol stdout.
use std::collections::VecDeque;
use std::fs;
use std::io::{self, Read, Write};
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

const MAX_BYTES: usize = 64 * 1024;
// UTF-8 encoding, lossy decoding and redaction can expand the captured bytes.
const MAX_RECEIPT_BYTES: usize = 512 * 1024;

#[derive(Default)]
struct State {
    bytes: VecDeque<u8>,
    finished: bool,
}

#[derive(Clone, Default)]
pub struct Capture(Arc<(Mutex<State>, Condvar)>);

impl Capture {
    pub fn reader<R: Read>(&self, reader: R) -> CapturedReader<R> {
        CapturedReader {
            reader,
            capture: self.clone(),
        }
    }

    // Called on the supervisor thread, never the UI thread. A broken inherited
    // pipe must not keep reconnect/teardown waiting indefinitely.
    pub fn tail(&self) -> String {
        let (lock, wake) = &*self.0;
        let Ok(state) = lock.lock() else {
            return String::new();
        };
        let Ok((state, _)) =
            wake.wait_timeout_while(state, Duration::from_millis(250), |s| !s.finished)
        else {
            return String::new();
        };
        let bytes: Vec<u8> = state.bytes.iter().copied().collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

pub struct CapturedReader<R> {
    reader: R,
    capture: Capture,
}

impl<R: Read> Read for CapturedReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let result = self.reader.read(buffer);
        if let Ok(count) = result.as_ref() {
            let (lock, _) = &*self.capture.0;
            if let Ok(mut state) = lock.lock() {
                for byte in &buffer[..*count] {
                    if state.bytes.len() == MAX_BYTES {
                        state.bytes.pop_front();
                    }
                    state.bytes.push_back(*byte);
                }
            }
        }
        result
    }
}

impl<R> Drop for CapturedReader<R> {
    fn drop(&mut self) {
        let (lock, wake) = &*self.capture.0;
        if let Ok(mut state) = lock.lock() {
            state.finished = true;
            wake.notify_all();
        }
    }
}

pub fn save(workspace: &Path, content: &str) -> Result<String, String> {
    if !workspace.is_absolute() || content.len() > MAX_RECEIPT_BYTES {
        return Err("invalid ACP crash log workspace or size".into());
    }
    let root = fs::canonicalize(workspace).map_err(|e| e.to_string())?;
    let mut directory = root.clone();
    for name in [".pi", "artifacts"] {
        directory.push(name);
        match fs::create_dir(&directory) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.to_string()),
        }
        let metadata = fs::symlink_metadata(&directory).map_err(|e| e.to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("ACP crash logs require real project-local directories".into());
        }
    }
    let id = uuid::Uuid::new_v4();
    directory.push(format!("acp-crash-{id}"));
    fs::create_dir(&directory).map_err(|e| e.to_string())?;
    let path = directory.join("stderr.log");
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(|e| e.to_string())?;
    file.write_all(content.as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_is_bounded_and_available_before_stderr_events() {
        let capture = Capture::default();
        let mut bytes = vec![b'x'; MAX_BYTES * 2];
        bytes.extend_from_slice(b"\nfatal: startup failed\n");
        let mut reader = capture.reader(io::Cursor::new(bytes));
        io::copy(&mut reader, &mut io::sink()).unwrap();
        drop(reader);
        let tail = capture.tail();
        assert_eq!(tail.len(), MAX_BYTES);
        assert!(tail.ends_with("fatal: startup failed\n"));
        assert!(Capture::default().tail().is_empty());
    }

    #[test]
    fn receipts_are_unique_project_local_and_bounded() {
        let root =
            std::env::temp_dir().join(format!("pix-acp-diagnostics-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let first = save(&root, "fatal: first").unwrap();
        let second = save(&root, "fatal: second").unwrap();
        assert_ne!(first, second);
        assert!(Path::new(&first).starts_with(root.join(".pi/artifacts")));
        assert_eq!(fs::read_to_string(first).unwrap(), "fatal: first");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&second).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert!(save(&root, &"x".repeat(MAX_RECEIPT_BYTES + 1)).is_err());
        assert!(save(Path::new("relative"), "fatal").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinked_artifact_directories() {
        let root = std::env::temp_dir().join(format!("pix-acp-symlink-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(".pi")).unwrap();
        fs::create_dir(root.join("outside")).unwrap();
        std::os::unix::fs::symlink(root.join("outside"), root.join(".pi/artifacts")).unwrap();
        assert!(save(&root, "fatal").is_err());
        assert_eq!(fs::read_dir(root.join("outside")).unwrap().count(), 0);
        fs::remove_dir_all(root).unwrap();
    }
}
