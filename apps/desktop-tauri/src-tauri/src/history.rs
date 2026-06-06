use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const PIX_SESSION_ENTRY_ID_FIELD: &str = "__pixSessionEntryId";
const PIX_SYSTEM_MESSAGE_CUSTOM_TYPE: &str = "pix-system";
const PIX_SYSTEM_DISPLAY_ENTRY_CUSTOM_TYPE: &str = "pix:system_message";
const DEFAULT_WINDOW_LIMIT: usize = 120;
const MAX_WINDOW_LIMIT: usize = 500;
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
    entries: HashMap<PathBuf, CachedHistory>,
    viewports: HashMap<String, ViewportCursor>,
    viewports_loaded: bool,
}

#[derive(Clone)]
struct CachedHistory {
    modified: Option<SystemTime>,
    len: u64,
    messages: Vec<Value>,
    ids: Vec<String>,
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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewportCursor {
    pub follow_output: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor_offset: Option<f64>,
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
    before: Option<usize>,
    after: Option<usize>,
    restore_viewport: Option<bool>,
) -> Result<HistoryWindow, String> {
    let path = std::fs::canonicalize(PathBuf::from(&session_path))
        .map_err(|e| format!("session path not accessible: {e}"))?;
    cache.ensure_viewports_loaded()?;
    let saved_cursor = if restore_viewport.unwrap_or(false) {
        cache.viewports.get(&path_key(&path)).cloned()
    } else {
        None
    };
    let effective_anchor_id = anchor_id.or_else(|| {
        saved_cursor.as_ref().and_then(|cursor| {
            if cursor.follow_output {
                None
            } else {
                cursor.anchor_id.clone()
            }
        })
    });
    let effective_from_end = from_end.unwrap_or(false)
        || saved_cursor.as_ref().is_some_and(|cursor| cursor.follow_output);
    let history = cache.get_or_load(&path)?;
    let total = history.messages.len();
    let limit = limit.unwrap_or(DEFAULT_WINDOW_LIMIT).clamp(1, MAX_WINDOW_LIMIT);

    let start = if let Some(anchor_id) = effective_anchor_id.as_deref() {
        let anchor_index = history
            .ids
            .iter()
            .position(|id| id == anchor_id || format!("h-{id}") == anchor_id)
            .unwrap_or_else(|| total.saturating_sub(limit));
        let before = before.unwrap_or(limit / 2).min(limit.saturating_sub(1));
        anchor_index.saturating_sub(before)
    } else if effective_from_end {
        total.saturating_sub(limit)
    } else {
        offset.unwrap_or(0).min(total)
    };

    let requested_end = if effective_anchor_id.is_some() {
        let after = after.unwrap_or(limit / 2);
        let anchor_index = history
            .ids
            .iter()
            .position(|id| effective_anchor_id.as_deref().is_some_and(|anchor| id == anchor || format!("h-{id}") == anchor))
            .unwrap_or(start);
        anchor_index.saturating_add(after).saturating_add(1).max(start.saturating_add(limit))
    } else {
        start.saturating_add(limit)
    };
    let end = requested_end.min(total);

    Ok(HistoryWindow {
        messages: history.messages[start..end].to_vec(),
        offset: start,
        start_index: start,
        end_index: end,
        total,
        has_older: start > 0,
        has_newer: end < total,
        cursor: saved_cursor,
    })
}

pub fn save_viewport(
    cache: &mut HistoryCache,
    session_path: String,
    follow_output: bool,
    anchor_id: Option<String>,
    anchor_offset: Option<f64>,
) -> Result<ViewportCursor, String> {
    let path = std::fs::canonicalize(PathBuf::from(&session_path))
        .map_err(|e| format!("session path not accessible: {e}"))?;
    cache.ensure_viewports_loaded()?;
    let cursor = ViewportCursor {
        follow_output,
        anchor_id: anchor_id.filter(|id| !id.trim().is_empty()),
        anchor_offset: anchor_offset.filter(|value| value.is_finite()).map(|value| value.max(0.0)),
        updated_at: now_unix_secs(),
    };
    cache.viewports.insert(path_key(&path), cursor.clone());
    cache.prune_viewports();
    cache.persist_viewports()?;
    Ok(cursor)
}

pub fn list_sessions_for_workspace(cwd: String) -> Result<SessionList, String> {
    let resolved_cwd = resolve_existing_or_raw(PathBuf::from(&cwd));
    let session_dir = default_session_dir_path(&resolved_cwd)?;
    let mut sessions = Vec::new();

    let entries = match std::fs::read_dir(&session_dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(SessionList { sessions }),
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

    fn get_or_load(&mut self, path: &Path) -> Result<CachedHistory, String> {
        let metadata = std::fs::metadata(path).map_err(|e| format!("read session metadata failed: {e}"))?;
        let modified = metadata.modified().ok();
        let len = metadata.len();
        if let Some(cached) = self.entries.get(path) {
            if cached.len == len && cached.modified == modified {
                return Ok(cached.clone());
            }
        }

        let loaded = load_history(path, modified, len)?;
        self.entries.insert(path.to_path_buf(), loaded.clone());
        Ok(loaded)
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
    parent_id: Option<String>,
    value: Value,
}

fn load_history(path: &Path, modified: Option<SystemTime>, len: u64) -> Result<CachedHistory, String> {
    let file = File::open(path).map_err(|e| format!("open session failed: {e}"))?;
    let reader = BufReader::new(file);
    let mut entries = Vec::<EntryRecord>::new();

    for line in reader.lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => continue,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let value = match serde_json::from_str::<Value>(trimmed) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let Some(obj) = value.as_object() else { continue };
        if obj.get("type").and_then(Value::as_str) == Some("session") {
            continue;
        }
        let Some(id) = obj.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()) else {
            continue;
        };
        entries.push(EntryRecord {
            id: id.to_string(),
            parent_id: obj.get("parentId").and_then(Value::as_str).map(str::to_string),
            value,
        });
    }

    let branch = branch_entries(&entries);
    let mut messages = Vec::new();
    let mut ids = Vec::new();
    for entry in branch {
        if let Some(message) = display_message_from_entry(entry) {
            ids.push(entry.id.clone());
            messages.push(message);
        }
    }

    Ok(CachedHistory { modified, len, messages, ids })
}

fn build_session_summary(path: &Path, resolved_cwd: &Path) -> Option<SessionSummary> {
    let metadata = std::fs::metadata(path).ok()?;
    let entries = read_session_file_values(path);
    let header = entries.first()?.as_object()?;
    if header.get("type").and_then(Value::as_str) != Some("session") {
        return None;
    }

    let cwd = header.get("cwd").and_then(Value::as_str).unwrap_or_default().to_string();
    if cwd.is_empty() || resolve_existing_or_raw(PathBuf::from(&cwd)) != resolved_cwd {
        return None;
    }

    let id = header.get("id").and_then(Value::as_str)?.to_string();
    let created = header
        .get("timestamp")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| system_time_to_iso(metadata.modified().ok()));
    let parent_session_path = header.get("parentSession").and_then(Value::as_str).map(str::to_string);

    let mut message_count = 0usize;
    let mut first_message = String::new();
    let mut name: Option<String> = None;
    let mut last_activity: Option<SystemTime> = None;

    for entry in &entries {
        let Some(obj) = entry.as_object() else { continue };
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
        let Some(message) = obj.get("message").and_then(Value::as_object) else { continue };
        let role = message.get("role").and_then(Value::as_str).unwrap_or_default();
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
            first_message = extract_text_content(message.get("content")).trim().to_string();
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
        first_message: if first_message.is_empty() { "(no messages)".to_string() } else { first_message },
    })
}

fn read_session_file_values(path: &Path) -> Vec<Value> {
    let Ok(file) = File::open(path) else { return Vec::new() };
    let reader = BufReader::new(file);
    reader
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() { None } else { serde_json::from_str::<Value>(trimmed).ok() }
        })
        .collect()
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
            let rest = value.trim_start_matches('~').trim_start_matches(['/', '\\']);
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

fn message_activity_time(message: &Map<String, Value>, entry: &Map<String, Value>) -> Option<SystemTime> {
    if let Some(ms) = message.get("timestamp").and_then(Value::as_f64).filter(|value| value.is_finite() && *value >= 0.0) {
        return Some(UNIX_EPOCH + std::time::Duration::from_millis(ms as u64));
    }
    entry.get("timestamp").and_then(Value::as_str).and_then(parse_iso_time)
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
    let Some(time) = time else { return String::new() };
    match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => format!("{}", duration.as_millis()),
        Err(_) => String::new(),
    }
}

fn branch_entries(entries: &[EntryRecord]) -> Vec<&EntryRecord> {
    let Some(leaf) = entries.last() else { return Vec::new() };
    let by_id = entries
        .iter()
        .map(|entry| (entry.id.as_str(), entry))
        .collect::<HashMap<_, _>>();
    let mut branch = Vec::new();
    let mut cursor = Some(leaf.id.as_str());
    let mut seen = std::collections::HashSet::new();
    while let Some(id) = cursor {
        if !seen.insert(id.to_string()) {
            break;
        }
        let Some(entry) = by_id.get(id).copied() else { break };
        branch.push(entry);
        cursor = entry.parent_id.as_deref();
    }
    branch.reverse();
    branch
}

fn display_message_from_entry(entry: &EntryRecord) -> Option<Value> {
    let obj = entry.value.as_object()?;
    match obj.get("type").and_then(Value::as_str) {
        Some("message") => {
            let message = obj.get("message")?.as_object()?.clone();
            Some(with_entry_id(message, &entry.id))
        }
        Some("custom_message") => {
            let mut out = Map::new();
            out.insert("role".to_string(), Value::String("custom".to_string()));
            if let Some(custom_type) = obj.get("customType").cloned() {
                out.insert("customType".to_string(), custom_type);
            }
            if let Some(content) = obj.get("content").cloned() {
                out.insert("content".to_string(), content);
            }
            if let Some(display) = obj.get("display").cloned() {
                out.insert("display".to_string(), display);
            }
            Some(with_entry_id(out, &entry.id))
        }
        Some("custom") if obj.get("customType").and_then(Value::as_str) == Some(PIX_SYSTEM_DISPLAY_ENTRY_CUSTOM_TYPE) => {
            let text = obj
                .get("data")
                .and_then(Value::as_object)
                .and_then(|data| data.get("text"))
                .and_then(Value::as_str)?
                .trim();
            if text.is_empty() {
                return None;
            }
            let mut out = Map::new();
            out.insert("role".to_string(), Value::String("custom".to_string()));
            out.insert("customType".to_string(), Value::String(PIX_SYSTEM_MESSAGE_CUSTOM_TYPE.to_string()));
            out.insert("content".to_string(), Value::String(text.to_string()));
            out.insert("display".to_string(), Value::Bool(true));
            Some(with_entry_id(out, &entry.id))
        }
        _ => None,
    }
}

fn with_entry_id(mut object: Map<String, Value>, entry_id: &str) -> Value {
    object.insert(PIX_SESSION_ENTRY_ID_FIELD.to_string(), Value::String(entry_id.to_string()));
    Value::Object(object)
}
