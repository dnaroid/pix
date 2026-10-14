//! Read-only bounded snapshots of the shared diagnostic stream. No caller-supplied paths.
use serde::Serialize;
use serde_json::Value;
use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::Path,
};
use tauri::Manager;

const MAX_FILES: usize = 64;
const MAX_DIRECTORY_ENTRIES: usize = 4096;
const MAX_BYTES: usize = 1024 * 1024;
const FILE_BYTES: usize = 256 * 1024;
const MAX_ROWS: usize = 500;

#[derive(Serialize)]
pub(crate) struct LogEntry {
    id: String,
    record: Value,
    #[serde(skip)]
    offset: u64,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LogSnapshot {
    entries: Vec<LogEntry>,
    limited: bool,
    skipped: usize,
}

#[tauri::command]
pub(crate) async fn read_diagnostic_logs(app: tauri::AppHandle) -> Result<LogSnapshot, String> {
    let directory = app
        .path()
        .home_dir()
        .map_err(|e| e.to_string())?
        .join(".config/pi/logs");
    super::run_blocking(move || snapshot(&directory)).await
}

fn snapshot(directory: &Path) -> Result<LogSnapshot, String> {
    let mut result = LogSnapshot::default();
    match fs::symlink_metadata(directory) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(result),
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {}
        Ok(_) => return Err("Diagnostic log directory must be a real directory".into()),
        Err(e) => return Err(format!("Cannot read diagnostic logs: {e}")),
    }
    let mut files = Vec::new();
    for (index, item) in fs::read_dir(directory)
        .map_err(|e| e.to_string())?
        .enumerate()
    {
        if index == MAX_DIRECTORY_ENTRIES {
            result.limited = true;
            break;
        }
        let Ok(item) = item else {
            result.skipped += 1;
            continue;
        };
        let name = item.file_name().to_string_lossy().into_owned();
        let Some(stamp) = super::logging::segment_stamp(&name) else {
            continue;
        };
        if !item.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        files.push((stamp, name, item.path()));
    }
    files.sort_unstable_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    result.limited |= files.len() > MAX_FILES;
    let mut budget = MAX_BYTES;
    for (_, name, path) in files.into_iter().take(MAX_FILES) {
        if budget == 0 {
            result.limited = true;
            break;
        }
        // O_NOFOLLOW closes the metadata/open symlink race on the supported native host.
        let mut options = fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let read = (|| -> std::io::Result<(u64, Vec<u8>)> {
            let mut file = options.open(path)?;
            let meta = file.metadata()?;
            if !meta.is_file() {
                return Err(std::io::Error::other("not a regular log"));
            }
            let count = (meta.len().min(FILE_BYTES.min(budget) as u64)) as usize;
            let start = meta.len() - count as u64;
            file.seek(SeekFrom::Start(start))?;
            let mut bytes = Vec::with_capacity(count);
            file.take(count as u64).read_to_end(&mut bytes)?;
            Ok((start, bytes))
        })();
        let Ok((start, bytes)) = read else {
            result.skipped += 1;
            continue;
        };
        budget -= bytes.len();
        result.limited |= start > 0;
        let mut offset = 0;
        // A nonzero tail begins inside an unknown line; never expose a partial record.
        if start > 0 {
            offset = bytes
                .iter()
                .position(|b| *b == b'\n')
                .map_or(bytes.len(), |i| i + 1);
        }
        while offset < bytes.len() {
            let Some(length) = bytes[offset..].iter().position(|b| *b == b'\n') else {
                break;
            };
            let line = &bytes[offset..offset + length];
            if line.len() <= 32 * 1024 {
                if let Ok(record) = serde_json::from_slice::<Value>(line) {
                    if valid_record(&record) {
                        let offset = start + offset as u64;
                        result.entries.push(LogEntry {
                            id: format!("{name}:{offset}"),
                            record,
                            offset,
                        });
                    } else {
                        result.skipped += 1;
                    }
                } else {
                    result.skipped += 1;
                }
            } else {
                result.skipped += 1;
            }
            offset += length + 1;
        }
    }
    result.entries.sort_by(|a, b| {
        b.record["time"]
            .as_str()
            .cmp(&a.record["time"].as_str())
            .then_with(|| b.offset.cmp(&a.offset))
            .then_with(|| b.id.cmp(&a.id))
    });
    result.limited |= result.entries.len() > MAX_ROWS;
    result.entries.truncate(MAX_ROWS);
    Ok(result)
}

fn valid_record(value: &Value) -> bool {
    value["v"] == 1
        && ["debug", "info", "warn", "error"].contains(&value["level"].as_str().unwrap_or(""))
        && ["backend", "acp", "desktop"].contains(&value["source"].as_str().unwrap_or(""))
        && ["time", "module", "event"]
            .iter()
            .all(|key| value[key].as_str().is_some_and(|s| s.len() <= 512))
        && (value["project"].is_null()
            || (value["project"]["path"].is_string() && value["project"]["name"].is_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_complete_owned_records_and_bounds_rows() {
        let dir = std::env::temp_dir().join(format!("pix-log-reader-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let row = serde_json::json!({"v":1,"time":"2026-10-14T12:00:00.000Z","level":"error","source":"backend","module":"test","event":"failure","project":null});
        let line = format!("{row}\n");
        fs::write(
            dir.join("pix-v1-123-backend-test-0.jsonl"),
            format!("{}bad\n{{\"partial\"", line.repeat(510)),
        )
        .unwrap();
        fs::write(dir.join("unrelated.jsonl"), &line).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            dir.join("unrelated.jsonl"),
            dir.join("pix-v1-124-backend-link-0.jsonl"),
        )
        .unwrap();
        let snapshot = snapshot(&dir).unwrap();
        assert_eq!(snapshot.entries.len(), MAX_ROWS);
        assert!(snapshot.limited);
        assert_eq!(snapshot.skipped, 1);
        assert!(snapshot
            .entries
            .iter()
            .all(|e| e.id.starts_with("pix-v1-123-")));
        assert_eq!(snapshot.entries[0].offset, 509 * line.len() as u64);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn missing_directory_is_empty() {
        let dir = std::env::temp_dir().join(format!("pix-log-reader-{}", uuid::Uuid::new_v4()));
        assert!(snapshot(&dir).unwrap().entries.is_empty());
    }

    #[test]
    fn reads_bounded_tail_without_partial_or_oversized_records() {
        let dir = std::env::temp_dir().join(format!("pix-log-reader-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let row = serde_json::json!({"v":1,"time":"2026-10-14T12:00:00.000Z","level":"error","source":"desktop","module":"test","event":"last","project":null});
        // Tail begins halfway through the first oversized line, then sees a complete
        // oversized line, one valid row, and an unfinished append.
        let content = format!(
            "{}\n{}\n{row}\n{{\"v\":",
            "x".repeat(FILE_BYTES),
            "x".repeat(40 * 1024)
        );
        fs::write(dir.join("pix-v1-123-desktop-test-0.jsonl"), content).unwrap();
        let result = snapshot(&dir).unwrap();
        assert!(result.limited);
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].record["event"], "last");
        assert_eq!(result.skipped, 1);
        fs::remove_dir_all(dir).unwrap();
    }
}
