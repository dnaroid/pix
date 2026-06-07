//! Inline sub-agent tool state and compact card rendering.
//!
//! The sidecar already delivers tool-call args and tool-result text. This
//! module deliberately stays on that surface: no bridge protocol changes, no
//! filesystem reads, and no dependency on the TypeScript extension runtime.

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use serde_json::{json, Map, Value};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::ui::theme::{Theme, ThemeRole};

pub const WIDGET_KEY: &str = "__pix_subagents_widget";

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SubagentsState {
    pub agents: HashMap<String, SubagentEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentEntry {
    pub agent_id: String,
    pub agent_type: Option<String>,
    pub status: SubagentStatus,
    pub task_summary: Option<String>,
    pub started_at: Option<String>,
    pub last_heartbeat: Option<String>,
    pub exit_code: Option<i64>,
    pub run_dir: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentStatus {
    Spawning,
    Running,
    Completed,
    Failed,
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSubagentsArgs {
    pub action: Option<String>,
    pub task_summary: Option<String>,
    pub agent_id: Option<String>,
    pub task_ids: Vec<String>,
    pub run_dir: Option<String>,
    pub agent_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentResultUpdate {
    pub entries: Vec<SubagentEntry>,
    pub run_dir: Option<String>,
}

impl SubagentsState {
    pub fn clear(&mut self) {
        self.agents.clear();
    }

    pub fn record_tool_call(&mut self, tool_name: &str, args: &mut Value) -> bool {
        if !is_subagents_tool_name(tool_name) {
            return false;
        }
        let parsed = parse_subagents_args(args);
        if parsed.action.as_deref() != Some("spawn") {
            return false;
        }
        let entries = entries_from_spawn_args(args, &parsed);
        if entries.is_empty() {
            return false;
        }
        for entry in &entries {
            self.upsert(entry.clone());
        }
        write_widget_entries(args, &entries);
        true
    }

    pub fn update_from_tool_result(
        &mut self,
        tool_name: &str,
        args: &mut Value,
        result_text: &str,
        ok: bool,
    ) -> bool {
        if !is_subagents_tool_name(tool_name) {
            return false;
        }
        let parsed = parse_subagents_args(args);
        let Some(action) = parsed.action.as_deref() else {
            return false;
        };
        let update = parse_tool_result_text(result_text);
        let mut entries = update
            .as_ref()
            .map(|u| u.entries.clone())
            .unwrap_or_default();
        if entries.is_empty() && action == "spawn" {
            entries = entries_from_spawn_args(args, &parsed)
                .into_iter()
                .map(|mut entry| {
                    entry.status = if ok {
                        SubagentStatus::Running
                    } else {
                        SubagentStatus::Failed
                    };
                    entry
                })
                .collect();
        }
        if entries.is_empty() {
            return false;
        }

        let task_lookup = task_lookup_from_args(args);
        for entry in &mut entries {
            if entry.task_summary.is_none() {
                entry.task_summary = task_lookup
                    .get(&entry.agent_id)
                    .and_then(|t| t.task.clone());
            }
            if entry.agent_type.is_none() {
                entry.agent_type = task_lookup
                    .get(&entry.agent_id)
                    .and_then(|t| t.agent_type.clone());
            }
            if !ok && !matches!(entry.status, SubagentStatus::Stopped) {
                entry.status = SubagentStatus::Failed;
            }
            self.upsert(entry.clone());
        }
        if action == "spawn" {
            write_widget_entries(args, &entries);
        }
        true
    }

    pub fn upsert(&mut self, entry: SubagentEntry) -> String {
        if let Some(run_dir) = entry.run_dir.as_deref().filter(|s| !s.trim().is_empty()) {
            self.agents.remove(&entry.agent_id);
            let key = state_key(&entry.agent_id, Some(run_dir));
            self.agents.insert(key.clone(), entry);
            key
        } else {
            let key = state_key(&entry.agent_id, None);
            self.agents.insert(key.clone(), entry);
            key
        }
    }
}

impl SubagentStatus {
    pub fn from_tool_status(value: Option<&str>) -> Self {
        match value.unwrap_or("").trim().to_lowercase().as_str() {
            "done" | "completed" | "complete" | "success" | "succeeded" => Self::Completed,
            "failed" | "error" | "errored" | "launch_failed" => Self::Failed,
            "stopped" | "cancelled" | "canceled" | "killed" => Self::Stopped,
            "running" | "retrying" | "active" => Self::Running,
            _ => Self::Spawning,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Spawning => "spawning",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Stopped => "stopped",
        }
    }
}

pub fn is_subagents_tool_name(name: &str) -> bool {
    let normalized = name
        .chars()
        .filter(|c| *c != '-' && *c != ' ')
        .flat_map(char::to_lowercase)
        .collect::<String>();
    normalized == "subagents"
        || normalized == "async_subagents"
        || normalized.starts_with("async_subagents_")
}

pub fn parse_subagents_args(args: &Value) -> ParsedSubagentsArgs {
    let action = get_str_any(args, &["action", "command", "op"])
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    let task_lookup = task_lookup_from_args(args);
    let first_task = task_lookup.values().next().cloned();
    let task_summary = first_task
        .as_ref()
        .and_then(|t| t.task.clone())
        .or_else(|| {
            get_str_any(args, &["task", "prompt", "description", "task_summary"])
                .map(str::to_string)
        });
    let agent_id = get_str_any(args, &["agentId", "agent_id", "id"])
        .map(str::to_string)
        .or_else(|| first_agent_id(args));
    let mut task_ids = task_lookup.keys().cloned().collect::<Vec<_>>();
    task_ids.sort();
    ParsedSubagentsArgs {
        action,
        task_summary,
        agent_id,
        task_ids,
        run_dir: get_str_any(args, &["runDir", "run_dir"]).map(str::to_string),
        agent_type: first_task.and_then(|t| t.agent_type),
    }
}

pub fn parse_tool_result_text(text: &str) -> Option<SubagentResultUpdate> {
    let root: Value = serde_json::from_str(text.trim()).ok()?;
    parse_result_value(&root).or_else(|| parse_registry_value(&root))
}

pub fn tool_display_for_subagents(name: &str, args: &Value) -> (String, Option<String>) {
    let parsed = parse_subagents_args(args);
    if parsed.action.as_deref() == Some("spawn") {
        if let Some(entry) = widget_entries(args).into_iter().next() {
            let summary = entry
                .task_summary
                .clone()
                .or(parsed.task_summary)
                .unwrap_or_else(|| "sub-agent task".to_string());
            let elapsed =
                elapsed_label(entry.started_at.as_deref()).unwrap_or_else(|| "0s".to_string());
            let mut title = format!(
                "👥 {} {} · {}",
                status_icon(entry.status),
                entry.agent_id,
                entry.status.as_str()
            );
            if !elapsed.is_empty() {
                title.push_str(&format!(" · {elapsed}"));
            }
            let mut details = format!("task={}", quote_preview(&summary));
            if let Some(run_dir) = entry.run_dir.as_deref().filter(|s| !s.is_empty()) {
                details.push_str(&format!(" runDir={}", quote_preview(run_dir)));
            }
            return (title, Some(details));
        }
        let agent_id = parsed
            .agent_id
            .clone()
            .or_else(|| parsed.task_ids.first().cloned())
            .unwrap_or_else(|| "agent-1".to_string());
        let summary = parsed
            .task_summary
            .clone()
            .unwrap_or_else(|| "sub-agent task".to_string());
        return (
            format!(
                "👥 {} {} · spawning · 0s",
                status_icon(SubagentStatus::Spawning),
                agent_id
            ),
            Some(format!("task={}", quote_preview(&summary))),
        );
    }

    let action = parsed.action.as_deref();
    let task_count = args.get("tasks").and_then(Value::as_array).map(Vec::len);
    let title = match (action, parsed.agent_id.as_deref(), task_count) {
        (Some(action), Some(agent_id), _) => format!("👥 {action} · {agent_id}"),
        (Some(action), None, Some(count)) => {
            format!("👥 {action} · {count} {}", plural(count, "task"))
        }
        (Some(action), None, None) => format!("👥 {action}"),
        (None, Some(agent_id), _) => format!("👥 {agent_id}"),
        (None, None, Some(count)) => format!("👥 {count} {}", plural(count, "task")),
        (None, None, None) => format!("👥 {name}"),
    };
    let details = compact_subagent_fields(args);
    (title, details)
}

pub fn render_card_lines(entry: &SubagentEntry, width: usize, theme: &Theme) -> Vec<Line<'static>> {
    render_card_lines_at(entry, width, theme, now_unix_seconds())
}

pub fn render_card_lines_at(
    entry: &SubagentEntry,
    width: usize,
    theme: &Theme,
    now_seconds: u64,
) -> Vec<Line<'static>> {
    let width = width.max(1);
    let icon = status_icon(entry.status);
    let color = status_color(entry.status, theme);
    let elapsed = elapsed_label_at(entry.started_at.as_deref(), now_seconds)
        .unwrap_or_else(|| "0s".to_string());
    let mut header = format!(
        "  {icon} {} · {} · {elapsed}",
        entry.agent_id,
        entry.status.as_str()
    );
    if let Some(agent_type) = entry.agent_type.as_deref().filter(|s| !s.is_empty()) {
        header.push_str(&format!(" · {agent_type}"));
    }
    let header = truncate_to_width(&header, width);
    let task = entry
        .task_summary
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("sub-agent task");
    let task_prefix = "    task ";
    let task_width = width
        .saturating_sub(UnicodeWidthStr::width(task_prefix))
        .max(1);
    vec![
        Line::from(vec![Span::styled(
            header,
            Style::default().fg(color).add_modifier(Modifier::BOLD),
        )]),
        Line::from(vec![
            Span::styled(
                task_prefix.to_string(),
                theme.style_for(ThemeRole::StatusDim),
            ),
            Span::styled(
                truncate_to_width(task, task_width),
                theme.style_for(ThemeRole::StatusDim),
            ),
        ]),
    ]
}

fn entries_from_spawn_args(args: &Value, parsed: &ParsedSubagentsArgs) -> Vec<SubagentEntry> {
    let lookup = task_lookup_from_args(args);
    if lookup.is_empty() {
        return parsed
            .task_summary
            .as_ref()
            .map(|summary| SubagentEntry {
                agent_id: parsed
                    .agent_id
                    .clone()
                    .unwrap_or_else(|| "agent-1".to_string()),
                agent_type: parsed.agent_type.clone(),
                status: SubagentStatus::Spawning,
                task_summary: Some(summary.clone()),
                started_at: Some(now_unix_seconds().to_string()),
                last_heartbeat: None,
                exit_code: None,
                run_dir: parsed.run_dir.clone(),
            })
            .into_iter()
            .collect();
    }
    lookup
        .into_iter()
        .map(|(agent_id, task)| SubagentEntry {
            agent_id,
            agent_type: task.agent_type,
            status: SubagentStatus::Spawning,
            task_summary: task.task,
            started_at: Some(now_unix_seconds().to_string()),
            last_heartbeat: None,
            exit_code: None,
            run_dir: parsed.run_dir.clone(),
        })
        .collect()
}

fn parse_result_value(root: &Value) -> Option<SubagentResultUpdate> {
    let details = root.get("details").unwrap_or(root);
    let run_dir = get_str_any(details, &["runDir", "run_dir"]).map(str::to_string);
    let tasks = task_lookup_from_result_details(details);
    let mut entries = Vec::new();
    if let Some(agents) = details.get("agents").and_then(Value::as_array) {
        for agent in agents {
            if let Some(entry) = entry_from_agent_value(agent, run_dir.clone(), &tasks) {
                entries.push(entry);
            }
        }
    }
    if entries.is_empty() {
        if let Some(state) = details.get("state") {
            if let Some(entry) = entry_from_agent_value(state, run_dir.clone(), &tasks) {
                entries.push(entry);
            }
        }
    }
    (!entries.is_empty()).then_some(SubagentResultUpdate { entries, run_dir })
}

fn parse_registry_value(root: &Value) -> Option<SubagentResultUpdate> {
    let agents = root.get("agents")?.as_object()?;
    let mut entries = Vec::new();
    for (fallback_id, agent) in agents {
        let agent_id = get_str_any(agent, &["agentId", "agent_id", "id"])
            .unwrap_or(fallback_id)
            .to_string();
        entries.push(SubagentEntry {
            agent_id,
            agent_type: None,
            status: SubagentStatus::Running,
            task_summary: None,
            started_at: None,
            last_heartbeat: get_str_any(agent, &["updatedAt", "updated_at"]).map(str::to_string),
            exit_code: None,
            run_dir: get_str_any(agent, &["runDir", "run_dir"]).map(str::to_string),
        });
    }
    (!entries.is_empty()).then_some(SubagentResultUpdate {
        entries,
        run_dir: get_str_any(root, &["latestRunDir", "latest_run_dir"]).map(str::to_string),
    })
}

fn entry_from_agent_value(
    agent: &Value,
    run_dir: Option<String>,
    tasks: &HashMap<String, TaskInfo>,
) -> Option<SubagentEntry> {
    let agent_id =
        get_str_any(agent, &["id", "agentId", "agent_id", "name"]).map(str::to_string)?;
    let task = tasks.get(&agent_id);
    Some(SubagentEntry {
        agent_id,
        agent_type: get_str_any(agent, &["subagentType", "agentType", "agent_type", "type"])
            .map(str::to_string)
            .or_else(|| task.and_then(|t| t.agent_type.clone())),
        status: SubagentStatus::from_tool_status(get_str_any(agent, &["status", "state"])),
        task_summary: task.and_then(|t| t.task.clone()),
        started_at: get_str_any(agent, &["startedAt", "started_at"]).map(str::to_string),
        last_heartbeat: get_str_any(
            agent,
            &["lastHeartbeat", "last_heartbeat", "updatedAt", "updated_at"],
        )
        .map(str::to_string),
        exit_code: agent
            .get("exitCode")
            .or_else(|| agent.get("exit_code"))
            .and_then(Value::as_i64),
        run_dir: get_str_any(agent, &["runDir", "run_dir"])
            .map(str::to_string)
            .or(run_dir),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TaskInfo {
    task: Option<String>,
    agent_type: Option<String>,
}

fn task_lookup_from_args(args: &Value) -> HashMap<String, TaskInfo> {
    let mut out = HashMap::new();
    let Some(tasks) = args.get("tasks").and_then(Value::as_array) else {
        return out;
    };
    for (idx, task) in tasks.iter().enumerate() {
        let agent_id = get_str_any(task, &["id", "agentId", "agent_id"])
            .map(str::to_string)
            .unwrap_or_else(|| format!("agent-{}", idx + 1));
        out.insert(agent_id, task_info(task));
    }
    out
}

fn task_lookup_from_result_details(details: &Value) -> HashMap<String, TaskInfo> {
    let mut out = HashMap::new();
    let Some(tasks) = details.get("tasks").and_then(Value::as_array) else {
        return out;
    };
    for task in tasks {
        if let Some(agent_id) = get_str_any(task, &["id", "agentId", "agent_id"]) {
            out.insert(agent_id.to_string(), task_info(task));
        }
    }
    out
}

fn task_info(value: &Value) -> TaskInfo {
    TaskInfo {
        task: get_str_any(
            value,
            &[
                "task",
                "prompt",
                "description",
                "taskSummary",
                "task_summary",
            ],
        )
        .map(str::to_string),
        agent_type: get_str_any(value, &["subagentType", "agentType", "agent_type", "type"])
            .map(str::to_string),
    }
}

fn write_widget_entries(args: &mut Value, entries: &[SubagentEntry]) {
    let Some(obj) = args.as_object_mut() else {
        return;
    };
    let values = entries.iter().map(entry_to_value).collect::<Vec<_>>();
    obj.insert(
        WIDGET_KEY.to_string(),
        json!({
            "agents": values,
            "updated_at": now_unix_seconds(),
        }),
    );
}

fn widget_entries(args: &Value) -> Vec<SubagentEntry> {
    args.get(WIDGET_KEY)
        .and_then(|w| w.get("agents"))
        .and_then(Value::as_array)
        .map(|agents| {
            agents
                .iter()
                .filter_map(entry_from_widget_value)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn entry_from_widget_value(value: &Value) -> Option<SubagentEntry> {
    Some(SubagentEntry {
        agent_id: get_str_any(value, &["agent_id", "agentId", "id"])?.to_string(),
        agent_type: get_str_any(value, &["agent_type", "agentType", "subagentType"])
            .map(str::to_string),
        status: SubagentStatus::from_tool_status(get_str_any(value, &["status"])),
        task_summary: get_str_any(value, &["task_summary", "taskSummary", "task"])
            .map(str::to_string),
        started_at: get_str_any(value, &["started_at", "startedAt"]).map(str::to_string),
        last_heartbeat: get_str_any(value, &["last_heartbeat", "lastHeartbeat"])
            .map(str::to_string),
        exit_code: value
            .get("exit_code")
            .or_else(|| value.get("exitCode"))
            .and_then(Value::as_i64),
        run_dir: get_str_any(value, &["run_dir", "runDir"]).map(str::to_string),
    })
}

fn entry_to_value(entry: &SubagentEntry) -> Value {
    let mut obj = Map::new();
    obj.insert(
        "agent_id".to_string(),
        Value::String(entry.agent_id.clone()),
    );
    if let Some(v) = &entry.agent_type {
        obj.insert("agent_type".to_string(), Value::String(v.clone()));
    }
    obj.insert(
        "status".to_string(),
        Value::String(entry.status.as_str().to_string()),
    );
    if let Some(v) = &entry.task_summary {
        obj.insert("task_summary".to_string(), Value::String(v.clone()));
    }
    if let Some(v) = &entry.started_at {
        obj.insert("started_at".to_string(), Value::String(v.clone()));
    }
    if let Some(v) = &entry.last_heartbeat {
        obj.insert("last_heartbeat".to_string(), Value::String(v.clone()));
    }
    if let Some(v) = entry.exit_code {
        obj.insert("exit_code".to_string(), Value::Number(v.into()));
    }
    if let Some(v) = &entry.run_dir {
        obj.insert("run_dir".to_string(), Value::String(v.clone()));
    }
    Value::Object(obj)
}

fn status_icon(status: SubagentStatus) -> &'static str {
    match status {
        SubagentStatus::Spawning => "○",
        SubagentStatus::Running => "◑",
        SubagentStatus::Completed => "✓",
        SubagentStatus::Failed => "✖",
        SubagentStatus::Stopped => "■",
    }
}

fn status_color(status: SubagentStatus, theme: &Theme) -> Color {
    match status {
        SubagentStatus::Spawning => theme.tool_pending,
        SubagentStatus::Running => theme.tool_running,
        SubagentStatus::Completed => theme.tool_completed,
        SubagentStatus::Failed | SubagentStatus::Stopped => theme.tool_failed,
    }
}

fn elapsed_label(started_at: Option<&str>) -> Option<String> {
    elapsed_label_at(started_at, now_unix_seconds())
}

fn elapsed_label_at(started_at: Option<&str>, now_seconds: u64) -> Option<String> {
    let start = parse_epoch_seconds(started_at?)?;
    let total = now_seconds.saturating_sub(start);
    let minutes = total / 60;
    let seconds = total % 60;
    Some(if minutes > 0 {
        format!("{minutes}m {seconds}s")
    } else {
        format!("{seconds}s")
    })
}

fn parse_epoch_seconds(value: &str) -> Option<u64> {
    let trimmed = value.trim();
    let numeric = trimmed.parse::<u64>().ok()?;
    Some(if numeric > 1_000_000_000_000 {
        numeric / 1000
    } else {
        numeric
    })
}

fn now_unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn state_key(agent_id: &str, run_dir: Option<&str>) -> String {
    match run_dir.filter(|s| !s.trim().is_empty()) {
        Some(run_dir) => format!("{run_dir}\u{1f}{agent_id}"),
        None => agent_id.to_string(),
    }
}

fn first_agent_id(args: &Value) -> Option<String> {
    args.get("agentIds")
        .or_else(|| args.get("agent_ids"))
        .and_then(Value::as_array)
        .and_then(|ids| ids.iter().find_map(Value::as_str))
        .map(str::to_string)
}

fn get_str_any<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| value.get(*key)?.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn compact_subagent_fields(args: &Value) -> Option<String> {
    let obj = args.as_object()?;
    let parts = obj
        .iter()
        .filter(|(key, _)| key.as_str() != WIDGET_KEY)
        .filter(|(key, _)| !matches!(key.as_str(), "action" | "command" | "op" | "tasks"))
        .filter_map(|(key, value)| preview_value(value).map(|preview| format!("{key}={preview}")))
        .collect::<Vec<_>>();
    (!parts.is_empty()).then(|| parts.join(" "))
}

fn preview_value(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::Bool(v) => Some(v.to_string()),
        Value::Number(v) => Some(v.to_string()),
        Value::String(v) => Some(quote_preview(v)),
        Value::Array(v) => Some(format!("[{}]", v.len())),
        Value::Object(v) => Some(format!("{{{}}}", v.len())),
    }
}

fn plural(count: usize, singular: &str) -> String {
    if count == 1 {
        singular.to_string()
    } else {
        format!("{singular}s")
    }
}

fn quote_preview(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| format!("\"{value}\""))
}

fn truncate_to_width(text: &str, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    if UnicodeWidthStr::width(text) <= width {
        return text.to_string();
    }
    if width == 1 {
        return "…".to_string();
    }
    let target = width - 1;
    let mut out = String::new();
    let mut used = 0;
    for ch in text.chars() {
        let w = UnicodeWidthChar::width(ch).unwrap_or(0);
        if used + w > target {
            break;
        }
        out.push(ch);
        used += w;
    }
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn line_text(line: &Line<'_>) -> String {
        line.spans.iter().map(|s| s.content.as_ref()).collect()
    }

    #[test]
    fn parse_spawn_args_extracts_action_and_task() {
        let parsed = parse_subagents_args(&json!({
            "action": "spawn",
            "tasks": [{"id": "agent-a", "task": "Inspect auth", "subagentType": "reviewer"}],
            "runDir": "/tmp/run"
        }));
        assert_eq!(parsed.action.as_deref(), Some("spawn"));
        assert_eq!(parsed.task_summary.as_deref(), Some("Inspect auth"));
        assert_eq!(parsed.task_ids, vec!["agent-a"]);
        assert_eq!(parsed.run_dir.as_deref(), Some("/tmp/run"));
        assert_eq!(parsed.agent_type.as_deref(), Some("reviewer"));
    }

    #[test]
    fn parse_status_args_extracts_agent_id() {
        let parsed = parse_subagents_args(&json!({"action": "status", "agentIds": ["agent-b"]}));
        assert_eq!(parsed.action.as_deref(), Some("status"));
        assert_eq!(parsed.agent_id.as_deref(), Some("agent-b"));
    }

    #[test]
    fn parse_result_args_extracts_agent_id() {
        let parsed = parse_subagents_args(&json!({"action": "result", "agentId": "agent-c"}));
        assert_eq!(parsed.action.as_deref(), Some("result"));
        assert_eq!(parsed.agent_id.as_deref(), Some("agent-c"));
    }

    #[test]
    fn update_state_on_tool_result_details() {
        let mut state = SubagentsState::default();
        let mut args =
            json!({"action": "spawn", "tasks": [{"id": "agent-a", "task": "Inspect auth"}]});
        state.record_tool_call("subagents", &mut args);
        let text = json!({
            "content": [{"type": "text", "text": "Started"}],
            "details": {
                "runDir": "/tmp/run-1",
                "mode": "spawn",
                "tasks": [{"id": "agent-a", "task": "Inspect auth"}],
                "agents": [{"id": "agent-a", "status": "running", "startedAt": "1000"}]
            }
        })
        .to_string();
        assert!(state.update_from_tool_result("subagents", &mut args, &text, true));
        assert_eq!(state.agents.len(), 1);
        let entry = state.agents.values().next().unwrap();
        assert_eq!(entry.agent_id, "agent-a");
        assert_eq!(entry.status, SubagentStatus::Running);
        assert_eq!(entry.run_dir.as_deref(), Some("/tmp/run-1"));
        assert!(args.get(WIDGET_KEY).is_some());
    }

    #[test]
    fn render_card_lines_include_id_status_elapsed_and_task() {
        let entry = SubagentEntry {
            agent_id: "agent-a".to_string(),
            agent_type: Some("review".to_string()),
            status: SubagentStatus::Running,
            task_summary: Some("Inspect authentication middleware carefully".to_string()),
            started_at: Some("1000".to_string()),
            last_heartbeat: None,
            exit_code: None,
            run_dir: None,
        };
        let lines = render_card_lines_at(&entry, 80, &Theme::default(), 1090);
        assert_eq!(lines.len(), 2);
        assert!(line_text(&lines[0]).contains("◑ agent-a · running · 1m 30s"));
        assert!(line_text(&lines[1]).contains("Inspect authentication"));
    }

    #[test]
    fn status_icon_mapping_is_stable() {
        assert_eq!(status_icon(SubagentStatus::Spawning), "○");
        assert_eq!(status_icon(SubagentStatus::Running), "◑");
        assert_eq!(status_icon(SubagentStatus::Completed), "✓");
        assert_eq!(status_icon(SubagentStatus::Failed), "✖");
        assert_eq!(status_icon(SubagentStatus::Stopped), "■");
    }

    #[test]
    fn malformed_args_fallback_does_not_panic() {
        let parsed = parse_subagents_args(&json!("not-an-object"));
        assert_eq!(parsed.action, None);
        let (title, details) = tool_display_for_subagents("subagents", &json!("bad"));
        assert_eq!(title, "👥 subagents");
        assert_eq!(details, None);
    }

    #[test]
    fn hash_key_collisions_keep_same_agent_id_in_different_runs() {
        let mut state = SubagentsState::default();
        state.upsert(SubagentEntry {
            agent_id: "agent-a".to_string(),
            agent_type: None,
            status: SubagentStatus::Running,
            task_summary: None,
            started_at: None,
            last_heartbeat: None,
            exit_code: None,
            run_dir: Some("/tmp/run-1".to_string()),
        });
        state.upsert(SubagentEntry {
            agent_id: "agent-a".to_string(),
            agent_type: None,
            status: SubagentStatus::Completed,
            task_summary: None,
            started_at: None,
            last_heartbeat: None,
            exit_code: Some(0),
            run_dir: Some("/tmp/run-2".to_string()),
        });
        assert_eq!(state.agents.len(), 2);
        assert!(state
            .agents
            .values()
            .any(|e| e.run_dir.as_deref() == Some("/tmp/run-1")));
        assert!(state
            .agents
            .values()
            .any(|e| e.run_dir.as_deref() == Some("/tmp/run-2")));
    }
}
