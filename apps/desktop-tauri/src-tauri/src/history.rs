use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const PIX_SESSION_ENTRY_ID_FIELD: &str = "__pixSessionEntryId";
const PIX_SYSTEM_DISPLAY_ENTRY_CUSTOM_TYPE: &str = "pix:system_message";
const DEFAULT_WINDOW_LIMIT: usize = 120;
const MAX_WINDOW_LIMIT: usize = 500;
const WINDOW_SCAN_BYTES: u64 = 256 * 1024;
const WINDOW_SCAN_BYTES_AROUND_ANCHOR: u64 = 16 * 1024 * 1024;
const MAX_WINDOW_SCAN_BYTES: u64 = 16 * 1024 * 1024;
const VIEWPORT_STATE_FILE: &str = "pix-desktop-viewports.json";
const MAX_VIEWPORTS: usize = 1_024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionList {
    pub sessions: Vec<SessionSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub path: String,
    pub id: String,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_session_path: Option<String>,
    pub created: String,
    pub modified: String,
    pub message_count: usize,
    pub first_message: String,
}

#[derive(Default)]
pub struct HistoryCache {
    viewports: HashMap<String, ViewportCursor>,
    viewports_loaded: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryWindow {
    pub messages: Vec<Value>,
    pub offset: usize,
    pub start_index: usize,
    pub end_index: usize,
    pub total: usize,
    pub has_older: bool,
    pub has_newer: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<ViewportCursor>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryWindow {
    pub messages: Vec<Value>,
    pub offset: usize,
    pub start_index: usize,
    pub end_index: usize,
    pub total: usize,
    pub has_older: bool,
    pub has_newer: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<ViewportCursor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<SessionTailMeta>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTailMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_usage: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewportCursor {
    pub follow_output: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor_offset: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor_entry_offset: Option<u64>,
    pub updated_at: u64,
}

#[allow(clippy::too_many_arguments)]
pub fn read_window(
    cache: &mut HistoryCache,
    session_path: String,
    offset: Option<usize>,
    limit: Option<usize>,
    from_end: Option<bool>,
    anchor_id: Option<String>,
    anchor_entry_offset: Option<u64>,
    before: Option<usize>,
    after: Option<usize>,
    before_offset: Option<bool>,
    restore_viewport: Option<bool>,
) -> Result<HistoryWindow, String> {
    let path = std::fs::canonicalize(PathBuf::from(&session_path))
        .map_err(|e| format!("session path not accessible: {e}"))?;
    let metadata =
        std::fs::metadata(&path).map_err(|e| format!("read session metadata failed: {e}"))?;
    let file_len = metadata.len();
    cache.ensure_viewports_loaded()?;
    let saved_cursor = if restore_viewport.unwrap_or(false) {
        cache.viewports.get(&path_key(&path)).cloned()
    } else {
        None
    };
    let effective_anchor_id = anchor_id.or_else(|| {
        saved_cursor.as_ref().and_then(|cursor| {
            if cursor.follow_output || cursor.anchor_entry_offset.is_none() {
                None
            } else {
                cursor.anchor_id.clone()
            }
        })
    });
    let effective_anchor_entry_offset = anchor_entry_offset.or_else(|| {
        saved_cursor.as_ref().and_then(|cursor| {
            if cursor.follow_output {
                None
            } else {
                cursor.anchor_entry_offset
            }
        })
    });
    let effective_from_end = from_end.unwrap_or(false)
        || saved_cursor
            .as_ref()
            .is_some_and(|cursor| cursor.follow_output);
    let limit = limit
        .unwrap_or(DEFAULT_WINDOW_LIMIT)
        .clamp(1, MAX_WINDOW_LIMIT);

    let mut window = if let Some(anchor_entry_offset) = effective_anchor_entry_offset {
        read_window_around_entry_offset(
            &path,
            file_len,
            anchor_entry_offset,
            before.unwrap_or(limit / 2).min(limit.saturating_sub(1)),
            after.unwrap_or(limit / 2),
            limit,
        )?
    } else if let Some(anchor_id) = effective_anchor_id.as_deref() {
        // Without a byte offset, keep the scan bounded. This can restore recent
        // cursors from legacy localStorage without scanning the whole session.
        read_recent_window_around_anchor_id(
            &path,
            file_len,
            anchor_id,
            before.unwrap_or(limit / 2).min(limit.saturating_sub(1)),
            after.unwrap_or(limit / 2),
            limit,
        )?
    } else if effective_from_end {
        read_tail_window(&path, file_len, limit)?
    } else if before_offset.unwrap_or(false) {
        read_window_before_offset(
            &path,
            file_len,
            offset.map(|value| value as u64).unwrap_or(file_len),
            limit,
        )?
    } else {
        read_window_after_offset(
            &path,
            file_len,
            offset.map(|value| value as u64).unwrap_or(0),
            limit,
        )?
    };
    window.cursor = saved_cursor;
    Ok(window)
}

#[allow(clippy::too_many_arguments)]
pub fn read_chat_window(
    cache: &mut HistoryCache,
    session_path: String,
    offset: Option<usize>,
    limit: Option<usize>,
    from_end: Option<bool>,
    anchor_id: Option<String>,
    anchor_entry_offset: Option<u64>,
    before: Option<usize>,
    after: Option<usize>,
    before_offset: Option<bool>,
    restore_viewport: Option<bool>,
) -> Result<ChatHistoryWindow, String> {
    let path = std::fs::canonicalize(PathBuf::from(&session_path))
        .map_err(|e| format!("session path not accessible: {e}"))?;
    let meta = read_session_tail_meta(&path).ok();
    let window = read_window(
        cache,
        path.to_string_lossy().into_owned(),
        offset,
        limit,
        from_end,
        anchor_id,
        anchor_entry_offset,
        before,
        after,
        before_offset,
        restore_viewport,
    )?;
    Ok(ChatHistoryWindow {
        messages: chat_messages_from_history(window.messages),
        offset: window.offset,
        start_index: window.start_index,
        end_index: window.end_index,
        total: window.total,
        has_older: window.has_older,
        has_newer: window.has_newer,
        cursor: window.cursor,
        meta,
    })
}

pub fn save_viewport(
    cache: &mut HistoryCache,
    session_path: String,
    follow_output: bool,
    anchor_id: Option<String>,
    anchor_offset: Option<f64>,
    anchor_entry_offset: Option<u64>,
) -> Result<ViewportCursor, String> {
    let path = std::fs::canonicalize(PathBuf::from(&session_path))
        .map_err(|e| format!("session path not accessible: {e}"))?;
    cache.ensure_viewports_loaded()?;
    let cursor = ViewportCursor {
        follow_output,
        anchor_id: anchor_id.filter(|id| !id.trim().is_empty()),
        anchor_offset: anchor_offset
            .filter(|value| value.is_finite())
            .map(|value| value.max(0.0)),
        anchor_entry_offset,
        updated_at: now_unix_secs(),
    };
    cache.viewports.insert(path_key(&path), cursor.clone());
    cache.prune_viewports();
    cache.persist_viewports()?;
    Ok(cursor)
}

#[derive(Clone)]
struct WindowEntry {
    start: u64,
    end: u64,
    message: Option<Value>,
}

struct WindowReadResult {
    entries: Vec<WindowEntry>,
    start_offset: u64,
    end_offset: u64,
    has_older: bool,
    has_newer: bool,
}

fn read_tail_window(path: &Path, file_len: u64, limit: usize) -> Result<HistoryWindow, String> {
    history_window_from_result(
        collect_display_entries_before_offset(path, file_len, file_len, limit)?,
        file_len,
    )
}

fn read_window_before_offset(
    path: &Path,
    file_len: u64,
    offset: u64,
    limit: usize,
) -> Result<HistoryWindow, String> {
    history_window_from_result(
        collect_display_entries_before_offset(path, file_len, offset.min(file_len), limit)?,
        file_len,
    )
}

fn read_window_after_offset(
    path: &Path,
    file_len: u64,
    offset: u64,
    limit: usize,
) -> Result<HistoryWindow, String> {
    history_window_from_result(
        collect_display_entries_after_offset(path, file_len, offset.min(file_len), limit)?,
        file_len,
    )
}

fn collect_display_entries_before_offset(
    path: &Path,
    file_len: u64,
    end_offset: u64,
    limit: usize,
) -> Result<WindowReadResult, String> {
    let end_offset = end_offset.min(file_len);
    if end_offset == 0 {
        return Ok(WindowReadResult {
            entries: Vec::new(),
            start_offset: 0,
            end_offset: 0,
            has_older: false,
            has_newer: file_len > 0,
        });
    }

    let max_bytes = end_offset.min(MAX_WINDOW_SCAN_BYTES);
    let mut byte_count = end_offset.min(WINDOW_SCAN_BYTES);
    let (mut collected, scanned_start) = loop {
        let start = end_offset.saturating_sub(byte_count);
        let entries = parse_display_entries_in_range(path, start, end_offset)?;
        if entries.len() >= limit || byte_count >= max_bytes || byte_count >= end_offset {
            break (entries, start);
        }
        byte_count = end_offset
            .min(max_bytes)
            .min(byte_count.saturating_mul(2).max(byte_count + 1));
    };

    let saw_older_extra = collected.len() > limit;
    if saw_older_extra {
        collected = collected.split_off(collected.len() - limit);
    }
    let start_offset = collected
        .first()
        .map(|entry| entry.start)
        .unwrap_or(scanned_start);
    let result_end_offset = collected
        .last()
        .map(|entry| entry.end)
        .unwrap_or(end_offset);
    let has_older = saw_older_extra || scanned_start > 0;
    Ok(WindowReadResult {
        entries: collected,
        start_offset,
        end_offset: result_end_offset,
        has_older,
        has_newer: end_offset < file_len,
    })
}

fn collect_display_entries_after_offset(
    path: &Path,
    file_len: u64,
    start_offset: u64,
    limit: usize,
) -> Result<WindowReadResult, String> {
    let start_offset = start_offset.min(file_len);
    if start_offset >= file_len {
        return Ok(WindowReadResult {
            entries: Vec::new(),
            start_offset,
            end_offset: start_offset,
            has_older: start_offset > 0,
            has_newer: false,
        });
    }

    let available = file_len.saturating_sub(start_offset);
    let max_bytes = available.min(MAX_WINDOW_SCAN_BYTES);
    let mut byte_count = available.min(WINDOW_SCAN_BYTES);
    let (mut collected, scanned_end) = loop {
        let end = start_offset.saturating_add(byte_count).min(file_len);
        let entries = parse_display_entries_in_range(path, start_offset, end)?;
        if entries.len() >= limit || byte_count >= max_bytes || byte_count >= available {
            break (entries, end);
        }
        byte_count = available
            .min(max_bytes)
            .min(byte_count.saturating_mul(2).max(byte_count + 1));
    };

    let saw_newer_extra = collected.len() > limit;
    if saw_newer_extra {
        collected.truncate(limit);
    }
    let has_newer = saw_newer_extra || scanned_end < file_len;
    let result_start_offset = collected
        .first()
        .map(|entry| entry.start)
        .unwrap_or(start_offset);
    let result_end_offset = collected
        .last()
        .map(|entry| entry.end)
        .unwrap_or(scanned_end);
    Ok(WindowReadResult {
        entries: collected,
        start_offset: result_start_offset,
        end_offset: result_end_offset,
        has_older: start_offset > 0,
        has_newer,
    })
}

fn read_window_around_entry_offset(
    path: &Path,
    file_len: u64,
    anchor_entry_offset: u64,
    before_count: usize,
    after_count: usize,
    limit: usize,
) -> Result<HistoryWindow, String> {
    let anchor = anchor_entry_offset.min(file_len);
    let half_scan = WINDOW_SCAN_BYTES_AROUND_ANCHOR / 2;
    let start = anchor.saturating_sub(half_scan);
    let end = anchor.saturating_add(half_scan).min(file_len);
    let entries = parse_display_entries_in_range(path, start, end)?;
    if entries.is_empty() {
        return read_tail_window(path, file_len, limit);
    }
    let anchor_index = entries
        .iter()
        .position(|entry| entry.start == anchor_entry_offset)
        .or_else(|| {
            entries
                .iter()
                .position(|entry| entry.start >= anchor_entry_offset)
        })
        .unwrap_or_else(|| entries.len().saturating_sub(1));
    select_window_around_index(
        entries,
        anchor_index,
        before_count,
        after_count,
        limit,
        file_len,
    )
}

fn read_recent_window_around_anchor_id(
    path: &Path,
    file_len: u64,
    anchor_id: &str,
    before_count: usize,
    after_count: usize,
    limit: usize,
) -> Result<HistoryWindow, String> {
    let start = file_len.saturating_sub(WINDOW_SCAN_BYTES_AROUND_ANCHOR);
    let entries = parse_display_entries_in_range(path, start, file_len)?;
    if entries.is_empty() {
        return read_tail_window(path, file_len, limit);
    }
    let anchor_index = entries
        .iter()
        .position(|entry| {
            entry
                .message
                .as_ref()
                .and_then(message_entry_id)
                .is_some_and(|id| id == anchor_id || format!("h-{id}") == anchor_id)
        })
        .unwrap_or_else(|| entries.len().saturating_sub(limit));
    select_window_around_index(
        entries,
        anchor_index,
        before_count,
        after_count,
        limit,
        file_len,
    )
}

fn select_window_around_index(
    entries: Vec<WindowEntry>,
    anchor_index: usize,
    before_count: usize,
    after_count: usize,
    limit: usize,
    file_len: u64,
) -> Result<HistoryWindow, String> {
    if entries.is_empty() {
        return history_window_from_entries_with_flags(Vec::new(), file_len, false, false);
    }
    let entries_len = entries.len();
    let start_index = anchor_index.saturating_sub(before_count);
    let requested_end = anchor_index
        .saturating_add(after_count)
        .saturating_add(1)
        .max(start_index.saturating_add(limit));
    let selected = entries
        .into_iter()
        .skip(start_index)
        .take(requested_end.saturating_sub(start_index))
        .collect::<Vec<_>>();
    history_window_from_entries_with_flags(
        selected,
        file_len,
        start_index > 0,
        requested_end < entries_len,
    )
}

fn history_window_from_result(
    result: WindowReadResult,
    file_len: u64,
) -> Result<HistoryWindow, String> {
    history_window_from_entries_with_offsets(
        result.entries,
        file_len,
        result.start_offset,
        result.end_offset,
        result.has_older,
        result.has_newer,
    )
}

fn history_window_from_entries_with_flags(
    entries: Vec<WindowEntry>,
    file_len: u64,
    has_older: bool,
    has_newer: bool,
) -> Result<HistoryWindow, String> {
    let start = entries.first().map(|entry| entry.start).unwrap_or(0);
    let end = entries.last().map(|entry| entry.end).unwrap_or(start);
    history_window_from_entries_with_offsets(entries, file_len, start, end, has_older, has_newer)
}

fn history_window_from_entries_with_offsets(
    entries: Vec<WindowEntry>,
    file_len: u64,
    start: u64,
    end: u64,
    has_older: bool,
    has_newer: bool,
) -> Result<HistoryWindow, String> {
    Ok(HistoryWindow {
        messages: entries
            .into_iter()
            .filter_map(|entry| entry.message)
            .collect(),
        offset: usize::try_from(start).unwrap_or(usize::MAX),
        start_index: usize::try_from(start).unwrap_or(usize::MAX),
        end_index: usize::try_from(end).unwrap_or(usize::MAX),
        total: usize::try_from(file_len).unwrap_or(usize::MAX),
        has_older,
        has_newer,
        cursor: None,
    })
}

fn parse_display_entries_in_range(
    path: &Path,
    start: u64,
    end: u64,
) -> Result<Vec<WindowEntry>, String> {
    if end <= start {
        return Ok(Vec::new());
    }
    let mut file = File::open(path).map_err(|e| format!("open session failed: {e}"))?;
    file.seek(SeekFrom::Start(start))
        .map_err(|e| format!("seek session failed: {e}"))?;
    let len = usize::try_from(end - start).map_err(|_| "session window too large".to_string())?;
    let mut bytes = vec![0u8; len];
    file.read_exact(&mut bytes)
        .map_err(|e| format!("read session window failed: {e}"))?;

    let mut base = start;
    let mut slice_start = 0usize;
    let mut slice_end = bytes.len();
    if start > 0 {
        if let Some(pos) = bytes.iter().position(|byte| *byte == b'\n') {
            slice_start = pos + 1;
            base = base.saturating_add(slice_start as u64);
        } else {
            return Ok(Vec::new());
        }
    }
    if end > start
        && end
            != std::fs::metadata(path)
                .map(|metadata| metadata.len())
                .unwrap_or(end)
    {
        if let Some(pos) = bytes.iter().rposition(|byte| *byte == b'\n') {
            slice_end = pos + 1;
        }
    }
    let bytes = &bytes[slice_start..slice_end];

    let mut out = Vec::new();
    let mut line_start_index = 0usize;
    while line_start_index < bytes.len() {
        let relative_line_end = bytes[line_start_index..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|position| line_start_index + position);
        let line_end_index = relative_line_end.unwrap_or(bytes.len());
        let next_line_start_index = relative_line_end.map_or(bytes.len(), |position| position + 1);
        let mut raw_line = &bytes[line_start_index..line_end_index];
        if raw_line.last() == Some(&b'\r') {
            raw_line = &raw_line[..raw_line.len().saturating_sub(1)];
        }
        let line_start = base.saturating_add(line_start_index as u64);
        let line_end = base.saturating_add(next_line_start_index as u64);
        let trimmed = trim_ascii(raw_line);
        line_start_index = next_line_start_index;

        if trimmed.is_empty() {
            continue;
        }
        if contains_json_pair(trimmed, "type", "session") {
            continue;
        }
        if !looks_like_display_entry_line(trimmed) {
            continue;
        }
        let value = match serde_json::from_slice::<Value>(trimmed) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let Some(obj) = value.as_object() else {
            continue;
        };
        if obj.get("type").and_then(Value::as_str) == Some("session") {
            continue;
        }
        let Some(id) = obj
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        let entry = EntryRecord {
            id: id.to_string(),
            offset: line_start,
            value,
        };
        if let Some(message) = display_message_from_entry(&entry) {
            out.push(WindowEntry {
                start: line_start,
                end: line_end,
                message: Some(message),
            });
        }
    }
    Ok(out)
}

fn trim_ascii(mut raw: &[u8]) -> &[u8] {
    while raw.first().is_some_and(u8::is_ascii_whitespace) {
        raw = &raw[1..];
    }
    while raw.last().is_some_and(u8::is_ascii_whitespace) {
        raw = &raw[..raw.len().saturating_sub(1)];
    }
    raw
}

fn looks_like_display_entry_line(raw: &[u8]) -> bool {
    // Session files can contain very large non-display custom entries near the
    // tail. JSON-parsing those just to skip them is the expensive path. The
    // SDK writes compact JSON with `type` near the start, so a small prefix is
    // enough to decide whether a line can produce a visible chat message.
    let prefix = &raw[..raw.len().min(4096)];
    contains_json_pair(prefix, "type", "message")
        || contains_json_pair(prefix, "type", "custom_message")
        || (contains_json_pair(prefix, "type", "custom")
            && contains_json_pair(prefix, "customType", PIX_SYSTEM_DISPLAY_ENTRY_CUSTOM_TYPE))
}

fn contains_json_pair(haystack: &[u8], key: &str, value: &str) -> bool {
    let compact = format!("\"{key}\":\"{value}\"");
    let spaced = format!("\"{key}\": \"{value}\"");
    contains_bytes(haystack, compact.as_bytes()) || contains_bytes(haystack, spaced.as_bytes())
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

fn message_entry_id(message: &Value) -> Option<&str> {
    message
        .as_object()?
        .get(PIX_SESSION_ENTRY_ID_FIELD)?
        .as_str()
}

pub fn list_sessions_for_workspace(cwd: String) -> Result<SessionList, String> {
    let resolved_cwd = resolve_existing_or_raw(PathBuf::from(&cwd));
    let session_dir = default_session_dir_path(&resolved_cwd)?;
    let mut sessions = Vec::new();

    let entries = match std::fs::read_dir(&session_dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SessionList { sessions })
        }
        Err(err) => return Err(format!("read sessions dir failed: {err}")),
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }
        if let Some(summary) = build_session_summary(&path, &resolved_cwd) {
            sessions.push(summary);
        }
    }

    sessions.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(SessionList { sessions })
}

impl HistoryCache {
    fn ensure_viewports_loaded(&mut self) -> Result<(), String> {
        if self.viewports_loaded {
            return Ok(());
        }
        self.viewports_loaded = true;
        let path = viewport_state_path()?;
        let Ok(raw) = std::fs::read_to_string(&path) else {
            return Ok(());
        };
        self.viewports = serde_json::from_str::<HashMap<String, ViewportCursor>>(&raw)
            .map_err(|e| format!("read viewport state failed: {e}"))?;
        Ok(())
    }

    fn persist_viewports(&self) -> Result<(), String> {
        let path = viewport_state_path()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create viewport state dir failed: {e}"))?;
        }
        let raw = serde_json::to_string_pretty(&self.viewports)
            .map_err(|e| format!("serialize viewport state failed: {e}"))?;
        std::fs::write(&path, format!("{raw}\n"))
            .map_err(|e| format!("write viewport state failed: {e}"))
    }

    fn prune_viewports(&mut self) {
        if self.viewports.len() <= MAX_VIEWPORTS {
            return;
        }
        let mut entries = self
            .viewports
            .iter()
            .map(|(path, cursor)| (path.clone(), cursor.updated_at))
            .collect::<Vec<_>>();
        entries.sort_by_key(|(_, updated_at)| *updated_at);
        let remove_count = self.viewports.len().saturating_sub(MAX_VIEWPORTS);
        for (path, _) in entries.into_iter().take(remove_count) {
            self.viewports.remove(&path);
        }
    }
}

fn viewport_state_path() -> Result<PathBuf, String> {
    Ok(agent_dir()?.join(VIEWPORT_STATE_FILE))
}

fn path_key(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[derive(Clone)]
struct EntryRecord {
    id: String,
    offset: u64,
    value: Value,
}

fn build_session_summary(path: &Path, resolved_cwd: &Path) -> Option<SessionSummary> {
    let metadata = std::fs::metadata(path).ok()?;
    let file_len = metadata.len();
    let header_line = read_first_line(path, 64 * 1024)?;
    let header_value = serde_json::from_str::<Value>(header_line.trim()).ok()?;
    let header = header_value.as_object()?;
    if header.get("type").and_then(Value::as_str) != Some("session") {
        return None;
    }

    let cwd = header
        .get("cwd")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if cwd.is_empty() || resolve_existing_or_raw(PathBuf::from(&cwd)) != resolved_cwd {
        return None;
    }

    let id = header.get("id").and_then(Value::as_str)?.to_string();
    let created = header
        .get("timestamp")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| system_time_to_iso(metadata.modified().ok()));
    let parent_session_path = header
        .get("parentSession")
        .and_then(Value::as_str)
        .map(str::to_string);

    // Keep session listing cheap: inspect only the header, a small head sample
    // for the first prompt, and a bounded tail sample for latest name/activity.
    // Exact full-session message counts are intentionally not computed here.
    let head_entries = read_values_in_range(path, 0, file_len.min(256 * 1024));
    let tail_start = file_len.saturating_sub(512 * 1024);
    let tail_entries = if tail_start > 0 {
        read_values_in_range(path, tail_start, file_len)
    } else {
        Vec::new()
    };

    let mut message_count = 0usize;
    let mut first_message = String::new();
    let mut name: Option<String> = None;
    let mut last_activity: Option<SystemTime> = None;

    for entry in head_entries.iter().chain(tail_entries.iter()) {
        let Some(obj) = entry.as_object() else {
            continue;
        };
        if obj.get("type").and_then(Value::as_str) == Some("session_info") {
            name = obj
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
        }
        if obj.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        message_count += 1;
        let Some(message) = obj.get("message").and_then(Value::as_object) else {
            continue;
        };
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if role != "user" && role != "assistant" {
            continue;
        }
        if !message.contains_key("content") {
            continue;
        }
        if let Some(time) = message_activity_time(message, obj) {
            last_activity = Some(match last_activity {
                Some(prev) if prev > time => prev,
                _ => time,
            });
        }
        if first_message.is_empty() && role == "user" {
            first_message = extract_text_content(message.get("content"))
                .trim()
                .to_string();
        }
    }

    let modified = last_activity
        .or_else(|| parse_iso_time(&created))
        .or_else(|| metadata.modified().ok());

    Some(SessionSummary {
        path: path.to_string_lossy().to_string(),
        id,
        cwd,
        name,
        parent_session_path,
        created,
        modified: system_time_to_iso(modified),
        message_count,
        first_message: if first_message.is_empty() {
            "(no messages)".to_string()
        } else {
            first_message
        },
    })
}

fn read_first_line(path: &Path, max_bytes: usize) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let mut bytes = vec![0u8; max_bytes];
    let count = file.read(&mut bytes).ok()?;
    bytes.truncate(count);
    let text = String::from_utf8_lossy(&bytes);
    text.split('\n').next().map(str::to_string)
}

fn read_values_in_range(path: &Path, start: u64, end: u64) -> Vec<Value> {
    if end <= start {
        return Vec::new();
    }
    let Ok(mut file) = File::open(path) else {
        return Vec::new();
    };
    if file.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let Ok(len) = usize::try_from(end - start) else {
        return Vec::new();
    };
    let mut bytes = vec![0u8; len];
    if file.read_exact(&mut bytes).is_err() {
        return Vec::new();
    }
    let mut slice_start = 0usize;
    let mut slice_end = bytes.len();
    if start > 0 {
        if let Some(pos) = bytes.iter().position(|byte| *byte == b'\n') {
            slice_start = pos + 1;
        } else {
            return Vec::new();
        }
    }
    if let Some(pos) = bytes.iter().rposition(|byte| *byte == b'\n') {
        slice_end = pos + 1;
    }
    let bytes = &bytes[slice_start..slice_end];
    let mut out = Vec::new();
    let mut line_start = 0usize;
    while line_start < bytes.len() {
        let line_end = bytes[line_start..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|position| line_start + position)
            .unwrap_or(bytes.len());
        let trimmed = trim_ascii(&bytes[line_start..line_end]);
        if !trimmed.is_empty() && looks_like_summary_entry_line(trimmed) {
            if let Ok(value) = serde_json::from_slice::<Value>(trimmed) {
                out.push(value);
            }
        }
        line_start = if line_end < bytes.len() {
            line_end + 1
        } else {
            bytes.len()
        };
    }
    out
}

fn looks_like_summary_entry_line(raw: &[u8]) -> bool {
    let prefix = &raw[..raw.len().min(4096)];
    contains_json_pair(prefix, "type", "message")
        || contains_json_pair(prefix, "type", "session_info")
}

fn default_session_dir_path(cwd: &Path) -> Result<PathBuf, String> {
    let resolved_cwd = cwd.to_string_lossy();
    let safe_path = format!(
        "--{}--",
        resolved_cwd
            .trim_start_matches(['/', '\\'])
            .replace(['/', '\\', ':'], "-"),
    );
    Ok(agent_dir()?.join("sessions").join(safe_path))
}

fn agent_dir() -> Result<PathBuf, String> {
    if let Ok(value) = std::env::var("PI_CODING_AGENT_DIR") {
        if !value.trim().is_empty() {
            return Ok(expand_tilde(value));
        }
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "home directory not available".to_string())?;
    Ok(home.join(".pi").join("agent"))
}

fn expand_tilde(value: String) -> PathBuf {
    if value == "~" || value.starts_with("~/") || value.starts_with("~\\") {
        if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
            let rest = value
                .trim_start_matches('~')
                .trim_start_matches(['/', '\\']);
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(value)
}

fn resolve_existing_or_raw(path: PathBuf) -> PathBuf {
    std::fs::canonicalize(&path).unwrap_or(path)
}

fn extract_text_content(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|block| {
                let obj = block.as_object()?;
                if obj.get("type").and_then(Value::as_str) == Some("text") {
                    obj.get("text").and_then(Value::as_str).map(str::to_string)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

fn message_activity_time(
    message: &Map<String, Value>,
    entry: &Map<String, Value>,
) -> Option<SystemTime> {
    if let Some(ms) = message
        .get("timestamp")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
    {
        return Some(UNIX_EPOCH + std::time::Duration::from_millis(ms as u64));
    }
    entry
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(parse_iso_time)
}

fn parse_iso_time(value: &str) -> Option<SystemTime> {
    // Avoid adding a Rust date-time crate in this small desktop bridge. The
    // session format writes ISO strings in chronological UTC form; for exact
    // sorting the original ISO text is already stable, and this parser is only
    // needed as a fallback when converting to the serialized output shape.
    let _ = value;
    None
}

fn system_time_to_iso(time: Option<SystemTime>) -> String {
    let Some(time) = time else {
        return String::new();
    };
    match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => format!("{}", duration.as_millis()),
        Err(_) => String::new(),
    }
}

fn display_message_from_entry(entry: &EntryRecord) -> Option<Value> {
    let obj = entry.value.as_object()?;
    match obj.get("type").and_then(Value::as_str) {
        Some("message") => {
            let message = obj.get("message")?.as_object()?.clone();
            if !is_renderable_history_message(&message) {
                return None;
            }
            Some(with_entry_id(message, &entry.id, entry.offset))
        }
        Some("custom_message") => None,
        Some("custom")
            if obj.get("customType").and_then(Value::as_str)
                == Some(PIX_SYSTEM_DISPLAY_ENTRY_CUSTOM_TYPE) =>
        {
            None
        }
        _ => None,
    }
}

fn is_renderable_history_message(message: &Map<String, Value>) -> bool {
    match message.get("role").and_then(Value::as_str) {
        Some("user") => !extract_text_content(message.get("content"))
            .trim()
            .is_empty(),
        Some("assistant") => message
            .get("content")
            .and_then(Value::as_array)
            .is_some_and(|blocks| {
                blocks.iter().any(|block| {
                    let Some(block) = block.as_object() else {
                        return false;
                    };
                    match block.get("type").and_then(Value::as_str) {
                        Some("text") => block
                            .get("text")
                            .and_then(Value::as_str)
                            .is_some_and(|text| !text.is_empty()),
                        Some("toolCall") => {
                            block
                                .get("id")
                                .and_then(Value::as_str)
                                .is_some_and(|id| !id.is_empty())
                                && block
                                    .get("name")
                                    .and_then(Value::as_str)
                                    .is_some_and(|name| !name.is_empty())
                        }
                        _ => false,
                    }
                })
            }),
        Some("toolResult") => message
            .get("toolCallId")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty()),
        _ => false,
    }
}

fn with_entry_id(mut object: Map<String, Value>, entry_id: &str, entry_offset: u64) -> Value {
    object.insert(
        PIX_SESSION_ENTRY_ID_FIELD.to_string(),
        Value::String(entry_id.to_string()),
    );
    object.insert(
        "__pixSessionEntryOffset".to_string(),
        Value::Number(serde_json::Number::from(entry_offset)),
    );
    Value::Object(object)
}

fn chat_messages_from_history(history: Vec<Value>) -> Vec<Value> {
    let mut out = Vec::new();
    for (fallback_index, message) in history.into_iter().enumerate() {
        let stable_id = history_message_stable_id(&message, fallback_index);
        let entry_offset = message
            .as_object()
            .and_then(|obj| obj.get("__pixSessionEntryOffset"))
            .and_then(Value::as_u64);
        let Some(role) = message
            .as_object()
            .and_then(|obj| obj.get("role"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        match role {
            "user" => {
                let text =
                    extract_text_content(message.as_object().and_then(|obj| obj.get("content")));
                if text.is_empty() {
                    continue;
                }
                let mut obj = Map::new();
                obj.insert(
                    "id".to_string(),
                    Value::String(stable_id.unwrap_or_else(|| format!("h-user-{fallback_index}"))),
                );
                obj.insert("role".to_string(), Value::String("user".to_string()));
                obj.insert("text".to_string(), Value::String(text));
                if let Some(offset) = entry_offset {
                    obj.insert(
                        "entryOffset".to_string(),
                        Value::Number(serde_json::Number::from(offset)),
                    );
                }
                out.push(Value::Object(obj));
            }
            "assistant" => {
                let mut parts = Vec::new();
                if let Some(blocks) = message
                    .as_object()
                    .and_then(|obj| obj.get("content"))
                    .and_then(Value::as_array)
                {
                    for block in blocks {
                        let Some(block_obj) = block.as_object() else {
                            continue;
                        };
                        match block_obj.get("type").and_then(Value::as_str) {
                            Some("text") => {
                                if let Some(text) = block_obj
                                    .get("text")
                                    .and_then(Value::as_str)
                                    .filter(|text| !text.is_empty())
                                {
                                    parts.push(json!({ "kind": "text", "text": text }));
                                }
                            }
                            Some("toolCall") => {
                                let Some(id) = block_obj
                                    .get("id")
                                    .and_then(Value::as_str)
                                    .filter(|id| !id.is_empty())
                                else {
                                    continue;
                                };
                                let Some(name) = block_obj
                                    .get("name")
                                    .and_then(Value::as_str)
                                    .filter(|name| !name.is_empty())
                                else {
                                    continue;
                                };
                                parts.push(json!({
                                    "kind": "tool",
                                    "toolCallId": id,
                                    "name": name,
                                    "args": block_obj.get("arguments").cloned().unwrap_or(Value::Null),
                                    "status": "running",
                                }));
                            }
                            _ => {}
                        }
                    }
                }
                if parts.is_empty() {
                    continue;
                }
                let mut obj = Map::new();
                obj.insert(
                    "id".to_string(),
                    Value::String(
                        stable_id.unwrap_or_else(|| format!("h-assistant-{fallback_index}")),
                    ),
                );
                obj.insert("role".to_string(), Value::String("assistant".to_string()));
                obj.insert("parts".to_string(), Value::Array(parts));
                if let Some(offset) = entry_offset {
                    obj.insert(
                        "entryOffset".to_string(),
                        Value::Number(serde_json::Number::from(offset)),
                    );
                }
                out.push(Value::Object(obj));
            }
            "toolResult" => {
                let Some(tool_call_id) = message
                    .as_object()
                    .and_then(|obj| obj.get("toolCallId"))
                    .and_then(Value::as_str)
                else {
                    continue;
                };
                let result = message
                    .as_object()
                    .and_then(|obj| obj.get("details").cloned())
                    .or_else(|| {
                        Some(Value::String(extract_text_content(
                            message.as_object().and_then(|obj| obj.get("content")),
                        )))
                    });
                let is_error = message
                    .as_object()
                    .and_then(|obj| obj.get("isError"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if !update_tool_result_json(
                    &mut out,
                    tool_call_id,
                    result.clone().unwrap_or(Value::Null),
                    is_error,
                ) {
                    if let Some(tool_name) = message
                        .as_object()
                        .and_then(|obj| obj.get("toolName"))
                        .and_then(Value::as_str)
                    {
                        let mut obj = Map::new();
                        obj.insert(
                            "id".to_string(),
                            Value::String(
                                stable_id.unwrap_or_else(|| format!("h-tool-{fallback_index}")),
                            ),
                        );
                        obj.insert("role".to_string(), Value::String("assistant".to_string()));
                        if let Some(offset) = entry_offset {
                            obj.insert(
                                "entryOffset".to_string(),
                                Value::Number(serde_json::Number::from(offset)),
                            );
                        }
                        obj.insert(
                            "parts".to_string(),
                            Value::Array(vec![json!({
                                "kind": "tool",
                                "toolCallId": tool_call_id,
                                "name": tool_name,
                                "args": Value::Null,
                                "result": result.unwrap_or(Value::Null),
                                "status": if is_error { "error" } else { "done" },
                            })]),
                        );
                        out.push(Value::Object(obj));
                    }
                }
            }
            _ => {}
        }
    }
    out
}

fn update_tool_result_json(
    messages: &mut [Value],
    tool_call_id: &str,
    result: Value,
    is_error: bool,
) -> bool {
    for message in messages.iter_mut().rev() {
        let Some(parts) = message
            .as_object_mut()
            .and_then(|obj| obj.get_mut("parts"))
            .and_then(Value::as_array_mut)
        else {
            continue;
        };
        for part in parts.iter_mut() {
            let Some(part_obj) = part.as_object_mut() else {
                continue;
            };
            if part_obj.get("kind").and_then(Value::as_str) == Some("tool")
                && part_obj.get("toolCallId").and_then(Value::as_str) == Some(tool_call_id)
            {
                part_obj.insert("result".to_string(), result);
                part_obj.insert(
                    "status".to_string(),
                    Value::String(if is_error { "error" } else { "done" }.to_string()),
                );
                return true;
            }
        }
    }
    false
}

fn history_message_stable_id(message: &Value, fallback_index: usize) -> Option<String> {
    let obj = message.as_object()?;
    if let Some(entry_id) = obj
        .get(PIX_SESSION_ENTRY_ID_FIELD)
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    {
        return Some(format!("h-{entry_id}"));
    }
    let role = obj.get("role").and_then(Value::as_str)?;
    if let Some(timestamp) = obj.get("timestamp").and_then(|value| {
        value
            .as_str()
            .map(str::to_string)
            .or_else(|| value.as_f64().map(|n| n.to_string()))
    }) {
        return Some(format!("h-{role}-{timestamp}-{fallback_index}"));
    }
    None
}

fn read_session_tail_meta(path: &Path) -> Result<SessionTailMeta, String> {
    let file_len = std::fs::metadata(path)
        .map_err(|e| format!("read session metadata failed: {e}"))?
        .len();
    let tail_start = file_len.saturating_sub(512 * 1024);
    let entries = read_values_in_range(path, tail_start, file_len);
    let mut meta = SessionTailMeta {
        name: None,
        model: None,
        context_usage: None,
    };
    for entry in entries {
        let Some(obj) = entry.as_object() else {
            continue;
        };
        if obj.get("type").and_then(Value::as_str) == Some("session_info") {
            if let Some(name) = obj
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                meta.name = Some(name.to_string());
            }
        }
        if let Some(model) = obj.get("model").cloned() {
            meta.model = Some(model);
        }
        if let Some(context_usage) = obj
            .get("contextUsage")
            .or_else(|| obj.get("context_usage"))
            .cloned()
        {
            meta.context_usage = Some(context_usage);
        }
    }
    Ok(meta)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn read_window_skips_non_renderable_message_entries() {
        let path = write_session(&[
            r#"{"type":"session","id":"s","cwd":"/tmp"}"#,
            r#"{"type":"message","id":"thinking-only","message":{"role":"assistant","content":[{"type":"thinking"}]}}"#,
            r#"{"type":"message","id":"empty-user","message":{"role":"user","content":[{"type":"text","text":""}]}}"#,
            r#"{"type":"message","id":"user-1","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}"#,
            r#"{"type":"message","id":"assistant-1","message":{"role":"assistant","content":[{"type":"text","text":"world"}]}}"#,
        ]);
        let mut cache = HistoryCache::default();

        let window = read_window(
            &mut cache,
            path.to_string_lossy().to_string(),
            Some(0),
            Some(10),
            Some(false),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .expect("read window");

        let roles = window
            .messages
            .iter()
            .filter_map(|message| message.get("role").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert_eq!(roles, vec!["user", "assistant"]);
    }

    #[test]
    fn read_tail_window_limit_counts_renderable_messages_only() {
        let path = write_session(&[
            r#"{"type":"session","id":"s","cwd":"/tmp"}"#,
            r#"{"type":"message","id":"user-1","message":{"role":"user","content":[{"type":"text","text":"first"}]}}"#,
            r#"{"type":"message","id":"thinking-only","message":{"role":"assistant","content":[{"type":"thinking"}]}}"#,
            r#"{"type":"message","id":"user-2","message":{"role":"user","content":[{"type":"text","text":"second"}]}}"#,
        ]);
        assert_tail_texts(path, vec!["first", "second"]);
    }

    #[test]
    fn read_tail_window_limit_ignores_non_display_entries() {
        let path = write_session(&[
            r#"{"type":"session","id":"s","cwd":"/tmp"}"#,
            r#"{"type":"message","id":"user-1","message":{"role":"user","content":[{"type":"text","text":"first"}]}}"#,
            r#"{"type":"custom","customType":"dcp-state","data":{"large":true}}"#,
            r#"{"type":"custom","customType":"dcp-state","data":{"large":true}}"#,
            r#"{"type":"message","id":"user-2","message":{"role":"user","content":[{"type":"text","text":"second"}]}}"#,
        ]);
        assert_tail_texts(path, vec!["first", "second"]);
    }

    fn assert_tail_texts(path: PathBuf, expected: Vec<&str>) {
        let mut cache = HistoryCache::default();
        let window = read_window(
            &mut cache,
            path.to_string_lossy().to_string(),
            None,
            Some(2),
            Some(true),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .expect("read tail window");
        let texts = window
            .messages
            .iter()
            .map(|message| extract_text_content(message.get("content")))
            .collect::<Vec<_>>();
        assert_eq!(texts, expected);
    }

    fn write_session(lines: &[&str]) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "pix-history-test-{}-{}.jsonl",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        let mut file = File::create(&path).expect("create temp session");
        for line in lines {
            writeln!(file, "{line}").expect("write temp session line");
        }
        path
    }
}
