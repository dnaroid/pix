//! Shared JSONL contract; each process owns its segments, never rotates another writer.
use chrono::{Datelike, Timelike};
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const MAX_BYTES: usize = 10 * 1024 * 1024;
const RETENTION_MS: u64 = 24 * 60 * 60 * 1000;
static LOGGER: OnceLock<mpsc::SyncSender<Message>> = OnceLock::new();
static DIRECTORY: OnceLock<PathBuf> = OnceLock::new();
static DROPPED: AtomicU64 = AtomicU64::new(0);
enum Message {
    Record(Value),
    Shutdown(mpsc::Sender<()>),
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn redact(text: &str) -> String {
    let mut hide_next = false;
    text.chars()
        .take(8192)
        .collect::<String>()
        .split_inclusive(char::is_whitespace)
        .map(|part| {
            let word = part.trim_end();
            if word.is_empty() {
                return part.to_owned();
            }
            let lower = word.to_ascii_lowercase();
            let hide = hide_next
                || lower.contains("https://")
                || lower.contains("http://")
                || ["sk-", "ghp_", "github_pat_"].iter().any(|prefix| {
                    lower.match_indices(prefix).any(|(start, _)| {
                        start == 0
                            || (!lower.as_bytes()[start - 1].is_ascii_alphanumeric()
                                && lower.as_bytes()[start - 1] != b'_')
                    })
                })
                || [
                    "token=",
                    "token:",
                    "secret=",
                    "password=",
                    "api_key=",
                    "apikey=",
                ]
                .iter()
                .any(|key| lower.contains(key));
            hide_next = [
                "bearer",
                "basic",
                "authorization:",
                "token:",
                "secret:",
                "password:",
                "api_key:",
                "apikey:",
            ]
            .contains(&lower.as_str());
            if hide {
                format!("[REDACTED]{}", &part[word.len()..])
            } else {
                part.to_owned()
            }
        })
        .collect::<String>()
}

fn sanitize(value: &mut Value, depth: usize) {
    if depth >= 6 {
        *value = json!("[TRUNCATED]");
        return;
    }
    match value {
        Value::String(text) => *text = redact(text),
        Value::Array(items) => {
            items.truncate(40);
            for item in items {
                sanitize(item, depth + 1);
            }
        }
        Value::Object(items) => {
            for (key, item) in items {
                let key = key.to_ascii_lowercase().replace(['-', '_'], "");
                if [
                    "authorization",
                    "cookie",
                    "password",
                    "secret",
                    "token",
                    "apikey",
                    "accesstoken",
                    "refreshtoken",
                    "prompt",
                    "message",
                    "messages",
                    "content",
                    "body",
                    "input",
                    "output",
                    "args",
                    "arguments",
                    "request",
                    "response",
                    "headers",
                ]
                .contains(&key.as_str())
                {
                    *item = json!("[REDACTED]");
                } else {
                    sanitize(item, depth + 1);
                }
            }
        }
        _ => {}
    }
}

pub(crate) fn init(home: PathBuf) {
    LOGGER.get_or_init(|| {
        let (tx, rx) = mpsc::sync_channel(256);
        let directory = home.join(".config/pi/logs");
        let _ = DIRECTORY.set(directory.clone());
        let _ = std::thread::Builder::new()
            .name("pix-log".into())
            .spawn(move || {
                let mut writer = Writer::new(directory, MAX_BYTES);
                loop {
                    match rx.recv_timeout(Duration::from_secs(60)) {
                        Ok(Message::Record(record)) => {
                            if writer.write(record, now_ms()).is_err() {
                                DROPPED.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                        Ok(Message::Shutdown(done)) => {
                            let _ = done.send(());
                            break;
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => writer.cleanup(now_ms()),
                        Err(_) => break,
                    }
                }
            });
        tx
    });
}

pub(crate) fn record(
    level: &str,
    module: &str,
    event: &str,
    details: Value,
    workspace: Option<&str>,
) {
    record_scoped(level, module, event, details, workspace, None);
}

fn record_scoped(
    level: &str,
    module: &str,
    event: &str,
    details: Value,
    workspace: Option<&str>,
    session_id: Option<&str>,
) {
    let debug = std::env::var("PIX_LOG_LEVEL").as_deref() == Ok("debug");
    if level == "debug" && !debug {
        return;
    }
    let record = make_record(level, module, event, details, workspace, session_id);
    if let Some(sender) = LOGGER.get() {
        if sender.try_send(Message::Record(record)).is_err() {
            DROPPED.fetch_add(1, Ordering::Relaxed);
        }
    }
}

fn make_record(
    level: &str,
    module: &str,
    event: &str,
    details: Value,
    workspace: Option<&str>,
    session_id: Option<&str>,
) -> Value {
    let project = workspace.filter(|p| std::path::Path::new(p).is_absolute()).map(|path| json!({
        "name": std::path::Path::new(path).file_name().unwrap_or_default().to_string_lossy(), "path": path
    }));
    let date = chrono::DateTime::from_timestamp_millis(now_ms() as i64).unwrap_or_default();
    let time = format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        date.year(),
        date.month(),
        date.day(),
        date.hour(),
        date.minute(),
        date.second(),
        date.timestamp_subsec_millis()
    );
    let mut record = json!({ "v": 1, "time": time,
        "level": level, "source": "desktop", "module": module, "pid": std::process::id(),
        "project": project, "sessionId": session_id, "event": event, "details": details });
    sanitize(&mut record, 0);
    let dropped = DROPPED.load(Ordering::Relaxed);
    if dropped > 0 {
        record["dropped"] = json!(dropped);
    }
    record
}

/// Panic teardown cannot rely on the asynchronous worker surviving.
pub(crate) fn panic(diagnostic: String) {
    if let Some(directory) = DIRECTORY.get() {
        let record = make_record(
            "error",
            "panic",
            "native:panic",
            json!({"diagnostic": diagnostic}),
            None,
            None,
        );
        let _ = Writer::new(directory.clone(), MAX_BYTES).write(record, now_ms());
    }
}

#[tauri::command]
pub(crate) fn log_desktop_diagnostic(
    event: String,
    diagnostic: String,
    workspace: Option<String>,
    session_id: Option<String>,
) -> Result<(), String> {
    if diagnostic.len() > 32 * 1024
        || workspace.as_ref().is_some_and(|p| p.len() > 4096)
        || session_id.as_ref().is_some_and(|id| id.len() > 256)
        || ![
            "frontend:error",
            "frontend:uncaught",
            "frontend:unhandled-rejection",
            "media:playback-unavailable",
        ]
        .contains(&event.as_str())
    {
        return Err("invalid diagnostic".into());
    }
    let media_warning = event == "media:playback-unavailable";
    record_scoped(
        if media_warning { "warn" } else { "error" },
        if media_warning {
            "frontend.media"
        } else {
            "frontend"
        },
        &event,
        json!({"diagnostic": diagnostic}),
        workspace.as_deref(),
        session_id.as_deref(),
    );
    Ok(())
}

/// Explicit payload-free lifecycle events from the webview. Do not accept
/// arbitrary event names or metadata across this IPC boundary.
fn frontend_event_level(event: &str) -> Option<&'static str> {
    match event {
        "acp:unexpected-exit"
        | "acp:connect-failed"
        | "updater:check-failed"
        | "updater:install-failed"
        | "updater:restart-failed" => Some("warn"),
        "acp:ready" | "acp:stopped" | "updater:available" | "updater:ready" => Some("info"),
        "acp:connecting" | "acp:reconnecting" | "updater:checking" | "updater:current"
        | "updater:installing" | "media:ogg-fallback" => Some("debug"),
        _ => None,
    }
}

#[tauri::command]
pub(crate) fn log_desktop_event(
    event: String,
    workspace: Option<String>,
    session_id: Option<String>,
) -> Result<(), String> {
    let level = frontend_event_level(&event).ok_or("invalid diagnostic event")?;
    if workspace.as_ref().is_some_and(|p| p.len() > 4096)
        || session_id.as_ref().is_some_and(|id| id.len() > 256)
    {
        return Err("invalid diagnostic context".into());
    }
    let module = if event.starts_with("acp:") {
        "frontend.acp"
    } else if event.starts_with("media:") {
        "frontend.media"
    } else {
        "frontend.updater"
    };
    record_scoped(
        level,
        module,
        &event,
        json!({}),
        workspace.as_deref(),
        session_id.as_deref(),
    );
    Ok(())
}

pub(crate) fn error(module: &str, diagnostic: String) {
    record(
        "error",
        module,
        "native:error",
        json!({"diagnostic": diagnostic}),
        None,
    );
}

pub(crate) fn shutdown() {
    if let Some(sender) = LOGGER.get() {
        let (tx, rx) = mpsc::channel();
        // Exit worker only, never the UI thread. Bound even a wedged disk.
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut message = Message::Shutdown(tx);
        loop {
            match sender.try_send(message) {
                Ok(()) => {
                    let _ = rx.recv_timeout(deadline.saturating_duration_since(Instant::now()));
                    break;
                }
                Err(mpsc::TrySendError::Full(returned)) if Instant::now() < deadline => {
                    message = returned;
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(_) => break,
            }
        }
    }
}

struct Writer {
    directory: PathBuf,
    id: String,
    sequence: u64,
    segment: Option<(PathBuf, u64, usize)>,
    max_bytes: usize,
    cleanup_at: u64,
}
impl Writer {
    fn new(directory: PathBuf, max_bytes: usize) -> Self {
        Self {
            directory,
            id: format!("{}-{}", std::process::id(), uuid::Uuid::new_v4()),
            sequence: 0,
            segment: None,
            max_bytes,
            cleanup_at: 0,
        }
    }
    fn cleanup(&self, now: u64) {
        let Ok(entries) = fs::read_dir(&self.directory) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(stamp) = segment_stamp(&name) {
                if now.saturating_sub(stamp) >= RETENTION_MS
                    && entry.file_type().is_ok_and(|kind| kind.is_file())
                {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }
    fn write(&mut self, record: Value, now: u64) -> std::io::Result<()> {
        let mut result = self.write_record(&record, now);
        // Explicit log clearing can remove the current segment between records (or
        // between create and append). Recover this record rather than dropping it.
        if result
            .as_ref()
            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
        {
            self.segment = None;
            result = self.write_record(&record, now);
        }
        if result.is_err() {
            self.segment = None;
        }
        result
    }

    fn write_record(&mut self, record: &Value, now: u64) -> std::io::Result<()> {
        fs::create_dir_all(&self.directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.directory, fs::Permissions::from_mode(0o700))?;
        }
        if now >= self.cleanup_at {
            self.cleanup(now);
            self.cleanup_at = now.saturating_add(60_000);
        }
        let mut line = serde_json::to_vec(record)?;
        if line.len() + 1 > self.max_bytes.min(32 * 1024) {
            DROPPED.fetch_add(1, Ordering::Relaxed);
            return Ok(());
        }
        line.push(b'\n');
        let rotate = self.segment.as_ref().is_none_or(|(_, start, bytes)| {
            *bytes + line.len() > self.max_bytes || now < *start || now - *start >= 3_600_000
        });
        if rotate {
            let path = self.directory.join(format!(
                "pix-v1-{now}-desktop-{}-{}.jsonl",
                self.id, self.sequence
            ));
            self.sequence += 1;
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            options.open(&path)?;
            self.segment = Some((path, now, 0));
        }
        let (path, _, bytes) = self.segment.as_mut().unwrap();
        OpenOptions::new()
            .append(true)
            .open(path)?
            .write_all(&line)?;
        *bytes += line.len();
        Ok(())
    }
}

pub(super) fn segment_stamp(name: &str) -> Option<u64> {
    let rest = name.strip_prefix("pix-v1-")?.strip_suffix(".jsonl")?;
    let (stamp, rest) = rest.split_once('-')?;
    if !["backend-", "acp-", "desktop-"]
        .iter()
        .any(|prefix| rest.starts_with(prefix))
    {
        return None;
    }
    if !rest.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return None;
    }
    stamp.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frontend_events_are_allowlisted_without_request_payloads() {
        assert_eq!(frontend_event_level("acp:connecting"), Some("debug"));
        assert_eq!(frontend_event_level("acp:ready"), Some("info"));
        assert_eq!(frontend_event_level("acp:unexpected-exit"), Some("warn"));
        assert_eq!(frontend_event_level("media:ogg-fallback"), Some("debug"));
        assert_eq!(frontend_event_level("updater:install-failed"), Some("warn"));
        assert_eq!(frontend_event_level("frontend:error"), None);
        assert_eq!(frontend_event_level("acp:ready token=private"), None);
        assert!(log_desktop_event("unknown".into(), None, None).is_err());
        assert!(log_desktop_diagnostic(
            "media:playback-unavailable".into(),
            "Audio unavailable".into(),
            None,
            None,
        )
        .is_ok());
        assert!(log_desktop_event("acp:ready".into(), None, Some("x".repeat(257))).is_err());
    }
    #[test]
    fn concurrent_writers_keep_private_bounded_segments() {
        let dir =
            std::env::temp_dir().join(format!("pix-logging-writers-{}", uuid::Uuid::new_v4()));
        let workers: Vec<_> = (0..2)
            .map(|worker| {
                let directory = dir.clone();
                std::thread::spawn(move || {
                    let mut writer = Writer::new(directory, 512);
                    for index in 0..50 {
                        writer
                            .write(json!({"worker": worker, "index": index}), RETENTION_MS)
                            .unwrap();
                    }
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        let mut count = 0;
        for entry in fs::read_dir(&dir).unwrap().flatten() {
            assert!(entry.metadata().unwrap().len() <= 512);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    entry.metadata().unwrap().permissions().mode() & 0o777,
                    0o600
                );
            }
            for line in fs::read_to_string(entry.path()).unwrap().lines() {
                let record: Value = serde_json::from_str(line).unwrap();
                assert!(record["worker"].is_number());
                count += 1;
            }
        }
        assert_eq!(count, 100);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn idle_writer_rotates_before_reopening_an_expired_segment() {
        let dir = std::env::temp_dir().join(format!("pix-logging-idle-{}", uuid::Uuid::new_v4()));
        let mut writer = Writer::new(dir.clone(), 1024);
        writer.write(json!({"event": "old"}), RETENTION_MS).unwrap();
        writer.cleanup(2 * RETENTION_MS);
        writer
            .write(json!({"event": "new"}), 2 * RETENTION_MS)
            .unwrap();
        let files: Vec<_> = fs::read_dir(&dir).unwrap().flatten().collect();
        assert_eq!(files.len(), 1);
        assert!(fs::read_to_string(files[0].path()).unwrap().contains("new"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn deleted_segment_recovers_without_dropping_the_next_record() {
        let dir =
            std::env::temp_dir().join(format!("pix-logging-recovery-{}", uuid::Uuid::new_v4()));
        let mut writer = Writer::new(dir.clone(), 1024);
        writer
            .write(json!({"event": "before"}), RETENTION_MS)
            .unwrap();
        let path = writer.segment.as_ref().unwrap().0.clone();
        fs::remove_file(path).unwrap();
        writer
            .write(json!({"event": "recovered"}), RETENTION_MS)
            .unwrap();
        let files: Vec<_> = fs::read_dir(&dir).unwrap().flatten().collect();
        assert_eq!(files.len(), 1);
        assert!(fs::read_to_string(files[0].path())
            .unwrap()
            .contains("recovered"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rotation_retention_and_privacy() {
        let dir = std::env::temp_dir().join(format!("pix-logging-{}", uuid::Uuid::new_v4()));
        let mut writer = Writer::new(dir.clone(), 100);
        for _ in 0..5 {
            writer
                .write(json!({"event": "x".repeat(55)}), RETENTION_MS)
                .unwrap();
        }
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 5);
        fs::write(dir.join("unrelated.txt"), "keep").unwrap();
        writer.cleanup(2 * RETENTION_MS);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        let mut record = json!({"token":"secret", "nested":{"prompt":"chat"}, "diagnostic":"Bearer secret https://host/private"});
        sanitize(&mut record, 0);
        assert!(!record.to_string().contains("chat"));
        assert!(!record.to_string().contains("secret"));
        assert_eq!(
            redact("/some/project  name/файлы"),
            "/some/project  name/файлы"
        );
        assert_eq!(redact("/projects/task-manager"), "/projects/task-manager");
        assert_eq!(redact("key=sk-secret"), "[REDACTED]");
        fs::remove_dir_all(dir).unwrap();
    }
}
