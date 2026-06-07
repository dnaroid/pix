//! Session tabs + picker state for the Rust TUI.

use std::path::Path;

use ratatui::style::Modifier;
use ratatui::text::{Line, Span};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use unicode_width::UnicodeWidthStr;

use crate::ui::theme::{Theme, ThemeRole};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct SessionSummary {
    pub path: String,
    pub id: String,
    pub cwd: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(rename = "parentSessionPath", default)]
    pub parent_session_path: Option<String>,
    pub created: String,
    pub modified: String,
    #[serde(rename = "messageCount", default)]
    pub message_count: usize,
    #[serde(rename = "firstMessage", default)]
    pub first_message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionListStatus {
    Idle,
    Loading,
    Ready(usize),
    Error(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionListState {
    pub query: String,
    pub sessions: Vec<SessionSummary>,
    pub filtered: Vec<usize>,
    pub focus: usize,
    pub status: SessionListStatus,
}

impl Default for SessionListState {
    fn default() -> Self {
        Self {
            query: String::new(),
            sessions: Vec::new(),
            filtered: Vec::new(),
            focus: 0,
            status: SessionListStatus::Idle,
        }
    }
}

impl SessionListState {
    pub fn open(&mut self, current_path: Option<&str>) {
        self.query.clear();
        self.recompute(current_path);
    }

    pub fn begin_refresh(&mut self) {
        self.status = SessionListStatus::Loading;
    }

    pub fn set_sessions(&mut self, sessions: Vec<SessionSummary>, current_path: Option<&str>) {
        self.sessions = sessions;
        self.recompute(current_path);
        self.status = SessionListStatus::Ready(self.filtered.len());
    }

    pub fn set_error(&mut self, error: impl Into<String>) {
        self.status = SessionListStatus::Error(error.into());
    }

    pub fn set_query(&mut self, query: impl Into<String>, current_path: Option<&str>) {
        self.query = query.into();
        self.recompute(current_path);
        self.status = SessionListStatus::Ready(self.filtered.len());
    }

    pub fn push_query_char(&mut self, c: char, current_path: Option<&str>) {
        self.query.push(c);
        self.recompute(current_path);
        self.status = SessionListStatus::Ready(self.filtered.len());
    }

    pub fn pop_query_char(&mut self, current_path: Option<&str>) -> bool {
        let changed = self.query.pop().is_some();
        if changed {
            self.recompute(current_path);
            self.status = SessionListStatus::Ready(self.filtered.len());
        }
        changed
    }

    pub fn move_focus_up(&mut self) -> bool {
        let old = self.focus;
        self.focus = self.focus.saturating_sub(1);
        old != self.focus
    }

    pub fn move_focus_down(&mut self) -> bool {
        if self.filtered.is_empty() {
            return false;
        }
        let old = self.focus;
        self.focus = self.focus.saturating_add(1).min(self.filtered.len() - 1);
        old != self.focus
    }

    pub fn move_focus_home(&mut self) -> bool {
        let old = self.focus;
        self.focus = 0;
        old != self.focus
    }

    pub fn move_focus_end(&mut self) -> bool {
        if self.filtered.is_empty() {
            return false;
        }
        let old = self.focus;
        self.focus = self.filtered.len() - 1;
        old != self.focus
    }

    pub fn page_up(&mut self, page_size: usize) -> bool {
        let old = self.focus;
        self.focus = self.focus.saturating_sub(page_size.max(1));
        old != self.focus
    }

    pub fn page_down(&mut self, page_size: usize) -> bool {
        if self.filtered.is_empty() {
            return false;
        }
        let old = self.focus;
        self.focus = self
            .focus
            .saturating_add(page_size.max(1))
            .min(self.filtered.len() - 1);
        old != self.focus
    }

    pub fn selected_session(&self) -> Option<&SessionSummary> {
        self.filtered
            .get(self.focus)
            .and_then(|idx| self.sessions.get(*idx))
    }

    pub fn visible_start(&self, capacity: usize) -> usize {
        if capacity == 0 || self.filtered.len() <= capacity {
            return 0;
        }
        if self.focus >= capacity {
            self.focus + 1 - capacity
        } else {
            0
        }
    }

    pub fn recent_tabs(&self, current_path: Option<&str>, limit: usize) -> Vec<&SessionSummary> {
        if limit == 0 {
            return Vec::new();
        }

        let mut out = Vec::new();
        if let Some(current_path) = current_path {
            if let Some(current) = self
                .sessions
                .iter()
                .find(|session| session.path == current_path)
            {
                out.push(current);
            }
        }

        for session in &self.sessions {
            if out.iter().any(|existing| existing.path == session.path) {
                continue;
            }
            out.push(session);
            if out.len() >= limit {
                break;
            }
        }

        out
    }

    fn recompute(&mut self, current_path: Option<&str>) {
        let needle = self.query.trim().to_ascii_lowercase();
        self.filtered = self
            .sessions
            .iter()
            .enumerate()
            .filter(|(_, session)| needle.is_empty() || session_matches(session, &needle))
            .map(|(idx, _)| idx)
            .collect();

        if let Some(current_path) = current_path {
            if let Some(pos) = self
                .filtered
                .iter()
                .position(|idx| self.sessions[*idx].path == current_path)
            {
                let current = self.filtered.remove(pos);
                self.filtered.insert(0, current);
            }
        }

        if self.filtered.is_empty() {
            self.focus = 0;
        } else if let Some(current_path) = current_path {
            if let Some(pos) = self
                .filtered
                .iter()
                .position(|idx| self.sessions[*idx].path == current_path)
            {
                self.focus = pos;
            } else {
                self.focus = self.focus.min(self.filtered.len() - 1);
            }
        } else {
            self.focus = self.focus.min(self.filtered.len() - 1);
        }
    }
}

#[derive(Debug, Deserialize)]
struct SessionListPayload {
    #[serde(default)]
    sessions: Vec<SessionSummary>,
}

pub fn parse_session_list_response(value: Value) -> Result<Vec<SessionSummary>, String> {
    serde_json::from_value::<SessionListPayload>(value)
        .map(|payload| payload.sessions)
        .map_err(|err| format!("parse session list: {err}"))
}

pub fn popup_lines(
    state: &SessionListState,
    theme: &Theme,
    current_path: Option<&str>,
    current_name: Option<&str>,
    max_rows: usize,
) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    lines.push(Line::from(vec![
        Span::styled("filter: ", theme.style_for(ThemeRole::StatusDim)),
        Span::styled(
            if state.query.is_empty() {
                "name, id, workspace, or first message".to_string()
            } else {
                state.query.clone()
            },
            theme.style_for(ThemeRole::CodeInline),
        ),
    ]));
    lines.push(Line::from(Span::styled(
        status_text(state),
        theme.style_for(ThemeRole::StatusDim),
    )));

    if max_rows <= 2 {
        return lines.into_iter().take(max_rows).collect();
    }

    lines.push(tabs_line(
        state,
        theme,
        usize::MAX,
        current_path,
        None,
        current_name,
    ));
    lines.push(Line::from(""));

    let header_rows = lines.len();
    let capacity = max_rows.saturating_sub(header_rows).max(1);
    if state.filtered.is_empty() {
        let empty = match state.status {
            SessionListStatus::Loading => "  Loading sessions…",
            SessionListStatus::Error(_) => "  Could not load sessions",
            _ if state.sessions.is_empty() => "  No saved sessions",
            _ => "  No matches",
        };
        lines.push(Line::from(Span::styled(
            empty,
            theme
                .style_for(ThemeRole::StatusDim)
                .add_modifier(Modifier::DIM),
        )));
        return lines.into_iter().take(max_rows).collect();
    }

    let start = state.visible_start(capacity);
    for (visible_idx, session_idx) in state.filtered.iter().enumerate().skip(start).take(capacity) {
        let session = &state.sessions[*session_idx];
        let focused = visible_idx == state.focus;
        let current = current_path == Some(session.path.as_str());
        lines.push(render_session_line(
            session,
            theme,
            focused,
            current,
            current_name,
        ));
    }

    lines.into_iter().take(max_rows).collect()
}

pub fn tabs_line(
    state: &SessionListState,
    theme: &Theme,
    width: usize,
    current_path: Option<&str>,
    current_id: Option<&str>,
    current_name: Option<&str>,
) -> Line<'static> {
    let prefix = " sessions ";
    let hint = "Ctrl+T picker";
    let hint_width = UnicodeWidthStr::width(hint);
    let max_width = if width == 0 { usize::MAX } else { width };
    let mut used = UnicodeWidthStr::width(prefix);
    let mut spans = vec![Span::styled(
        prefix.to_string(),
        theme.style_for(ThemeRole::StatusDim),
    )];

    let mut labels: Vec<(String, bool)> = state
        .recent_tabs(current_path, 4)
        .into_iter()
        .map(|session| {
            (
                session_label(session, current_path, current_name),
                current_path == Some(session.path.as_str()),
            )
        })
        .collect();

    if labels.is_empty() {
        labels.push((current_session_label(current_name, current_id), true));
    }

    let total_labels = labels.len();
    let mut shown = 0usize;
    for (idx, (label, active)) in labels.iter().enumerate() {
        let chip = format!("[{}]", compact_label(label, 18));
        let chip_width = UnicodeWidthStr::width(chip.as_str()) + 1;
        let overflow = total_labels.saturating_sub(idx + 1);
        let overflow_width = if overflow > 0 {
            UnicodeWidthStr::width(format!("+{overflow}").as_str()) + 1
        } else {
            0
        };
        let remaining = max_width.saturating_sub(used);
        let reserved_hint = if max_width == usize::MAX || remaining > hint_width {
            hint_width + 1
        } else {
            0
        };
        if max_width != usize::MAX && used + chip_width + overflow_width + reserved_hint > max_width
        {
            break;
        }

        spans.push(render_chip(theme, &chip, *active));
        spans.push(Span::raw(" "));
        used += chip_width;
        shown += 1;
    }

    let hidden = total_labels.saturating_sub(shown);
    if hidden > 0 {
        let overflow = format!("+{hidden}");
        spans.push(Span::styled(
            overflow,
            theme.style_for(ThemeRole::StatusDim),
        ));
        spans.push(Span::raw(" "));
        used += UnicodeWidthStr::width(format!("+{hidden} ").as_str());
    }

    if max_width == usize::MAX || used + hint_width <= max_width {
        spans.push(Span::styled(
            hint.to_string(),
            theme.style_for(ThemeRole::ModelAccent),
        ));
    }

    Line::from(spans)
}

fn render_session_line(
    session: &SessionSummary,
    theme: &Theme,
    focused: bool,
    current: bool,
    current_name: Option<&str>,
) -> Line<'static> {
    let arrow = if focused { "› " } else { "  " };
    let marker = if current { "● " } else { "○ " };
    let label_style = if focused {
        theme
            .style_for(ThemeRole::AssistantText)
            .add_modifier(Modifier::BOLD)
    } else {
        theme.style_for(ThemeRole::AssistantText)
    };
    let meta = session_meta(session);

    let mut spans = vec![
        Span::styled(
            arrow.to_string(),
            theme
                .style_for(ThemeRole::StatusDim)
                .add_modifier(Modifier::DIM),
        ),
        Span::styled(
            marker.to_string(),
            theme.style_for(ThemeRole::SessionAccent),
        ),
        Span::styled(
            compact_label(
                &session_label(
                    session,
                    current.then_some(session.path.as_str()),
                    current_name,
                ),
                28,
            ),
            label_style,
        ),
    ];
    if !meta.is_empty() {
        spans.push(Span::raw("  "));
        spans.push(Span::styled(meta, theme.style_for(ThemeRole::StatusDim)));
    }
    Line::from(spans)
}

fn render_chip(theme: &Theme, chip: &str, active: bool) -> Span<'static> {
    let style = if active {
        theme
            .style_for(ThemeRole::SessionAccent)
            .add_modifier(Modifier::BOLD)
    } else {
        theme.style_for(ThemeRole::AssistantText)
    };
    Span::styled(chip.to_string(), style)
}

fn status_text(state: &SessionListState) -> String {
    match &state.status {
        SessionListStatus::Idle => {
            "Type to filter · Enter switches · Ctrl+R refreshes · Ctrl+N starts a session"
                .to_string()
        }
        SessionListStatus::Loading => {
            "Loading sessions… · Enter switches · Ctrl+R refreshes · Ctrl+N starts a session"
                .to_string()
        }
        SessionListStatus::Ready(0) if state.sessions.is_empty() => {
            "No saved sessions yet · Ctrl+N starts the first one".to_string()
        }
        SessionListStatus::Ready(0) => "0 matches · Edit the filter and try again".to_string(),
        SessionListStatus::Ready(count) => format!(
            "{} match{} · Enter switches · Ctrl+N starts a session · Ctrl+R refreshes",
            count,
            if *count == 1 { "" } else { "es" }
        ),
        SessionListStatus::Error(message) => format!("error: {message}"),
    }
}

fn session_matches(session: &SessionSummary, query: &str) -> bool {
    [
        session.name.as_deref().unwrap_or_default(),
        session.first_message.as_str(),
        session.cwd.as_str(),
        session.id.as_str(),
        session.path.as_str(),
    ]
    .into_iter()
    .any(|field| field.to_ascii_lowercase().contains(query))
}

fn session_label(
    session: &SessionSummary,
    current_path: Option<&str>,
    current_name: Option<&str>,
) -> String {
    if current_path == Some(session.path.as_str()) {
        if let Some(name) = current_name.filter(|name| !name.trim().is_empty()) {
            return name.trim().to_string();
        }
    }
    if let Some(name) = session
        .name
        .as_deref()
        .filter(|name| !name.trim().is_empty())
    {
        return name.trim().to_string();
    }
    if !session.first_message.trim().is_empty() {
        return session.first_message.trim().to_string();
    }
    short_path_or_id(&session.path, &session.id)
}

fn current_session_label(current_name: Option<&str>, current_id: Option<&str>) -> String {
    if let Some(name) = current_name.filter(|name| !name.trim().is_empty()) {
        return name.trim().to_string();
    }
    if let Some(id) = current_id.filter(|id| !id.trim().is_empty()) {
        return short_id(id);
    }
    "No session".to_string()
}

fn session_meta(session: &SessionSummary) -> String {
    let workspace = Path::new(&session.cwd)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(session.cwd.as_str());
    let count = format!(
        "{} msg{}",
        session.message_count,
        if session.message_count == 1 { "" } else { "s" }
    );
    let modified = format_timestamp(&session.modified);
    let mut parts = vec![workspace.to_string(), count, modified];
    if session.parent_session_path.is_some() {
        parts.push("branch".to_string());
    }
    parts.join(" · ")
}

fn format_timestamp(input: &str) -> String {
    let trimmed = input.trim();
    if let Some((date, time)) = trimmed.split_once('T') {
        let hhmm = time
            .split(['.', 'Z', '+'])
            .next()
            .unwrap_or(time)
            .chars()
            .take(5)
            .collect::<String>();
        if !date.is_empty() && !hhmm.is_empty() {
            return format!("{date} {hhmm}");
        }
    }
    trimmed.to_string()
}

fn short_path_or_id(path: &str, id: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| short_id(id))
}

fn short_id(id: &str) -> String {
    id.chars().take(8).collect()
}

fn compact_label(text: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }
    let mut chars = text.chars();
    let mut out: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() && max_chars > 1 {
        out.pop();
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_sessions() -> Vec<SessionSummary> {
        vec![
            SessionSummary {
                path: "/tmp/a.jsonl".to_string(),
                id: "aaaa1111".to_string(),
                cwd: "/repo/alpha".to_string(),
                name: Some("Auth polish".to_string()),
                parent_session_path: None,
                created: "2026-06-07T12:00:00.000Z".to_string(),
                modified: "2026-06-07T14:30:00.000Z".to_string(),
                message_count: 12,
                first_message: "Tighten auth prompts".to_string(),
            },
            SessionSummary {
                path: "/tmp/b.jsonl".to_string(),
                id: "bbbb2222".to_string(),
                cwd: "/repo/beta".to_string(),
                name: None,
                parent_session_path: Some("/tmp/a.jsonl".to_string()),
                created: "2026-06-06T12:00:00.000Z".to_string(),
                modified: "2026-06-06T14:30:00.000Z".to_string(),
                message_count: 3,
                first_message: "Investigate session picker UX".to_string(),
            },
            SessionSummary {
                path: "/tmp/c.jsonl".to_string(),
                id: "cccc3333".to_string(),
                cwd: "/repo/gamma".to_string(),
                name: Some("Scratchpad".to_string()),
                parent_session_path: None,
                created: "2026-06-05T12:00:00.000Z".to_string(),
                modified: "2026-06-05T14:30:00.000Z".to_string(),
                message_count: 1,
                first_message: "quick note".to_string(),
            },
        ]
    }

    fn text_of(lines: &[Line<'static>]) -> String {
        lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn parses_session_list_payload() {
        let parsed = parse_session_list_response(serde_json::json!({
            "sessions": sample_sessions(),
        }))
        .expect("session list should parse");
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0].id, "aaaa1111");
    }

    #[test]
    fn query_filters_across_name_message_and_workspace() {
        let mut state = SessionListState::default();
        state.set_sessions(sample_sessions(), Some("/tmp/b.jsonl"));

        state.set_query("beta", Some("/tmp/b.jsonl"));
        assert_eq!(state.filtered.len(), 1);
        assert_eq!(
            state.selected_session().map(|session| session.id.as_str()),
            Some("bbbb2222")
        );

        state.set_query("auth", Some("/tmp/b.jsonl"));
        assert_eq!(state.filtered.len(), 1);
        assert_eq!(
            state.selected_session().map(|session| session.id.as_str()),
            Some("aaaa1111")
        );
    }

    #[test]
    fn current_session_bubbles_to_top() {
        let mut state = SessionListState::default();
        state.set_sessions(sample_sessions(), Some("/tmp/b.jsonl"));

        assert_eq!(state.filtered[0], 1);
        assert_eq!(state.focus, 0);
        assert_eq!(
            state
                .selected_session()
                .map(|session| session.path.as_str()),
            Some("/tmp/b.jsonl")
        );
    }

    #[test]
    fn popup_lines_include_filter_status_tabs_and_rows() {
        let mut state = SessionListState::default();
        state.set_sessions(sample_sessions(), Some("/tmp/a.jsonl"));
        state.set_query("", Some("/tmp/a.jsonl"));

        let text = text_of(&popup_lines(
            &state,
            &Theme::default(),
            Some("/tmp/a.jsonl"),
            Some("Current auth pass"),
            10,
        ));

        assert!(text.contains("filter:"));
        assert!(text.contains("name, id, workspace"));
        assert!(text.contains("Enter switches"));
        assert!(text.contains("Ctrl+T picker"));
        assert!(text.contains("Current auth pass"));
        assert!(text.contains("12 msgs"));
    }

    #[test]
    fn tabs_line_shows_overflow_and_hint() {
        let mut state = SessionListState::default();
        let mut sessions = sample_sessions();
        sessions.push(SessionSummary {
            path: "/tmp/d.jsonl".to_string(),
            id: "dddd4444".to_string(),
            cwd: "/repo/delta".to_string(),
            name: Some("Longer follow-up session".to_string()),
            parent_session_path: None,
            created: "2026-06-04T12:00:00.000Z".to_string(),
            modified: "2026-06-04T14:30:00.000Z".to_string(),
            message_count: 6,
            first_message: "delta".to_string(),
        });
        state.set_sessions(sessions, Some("/tmp/a.jsonl"));

        let line = tabs_line(
            &state,
            &Theme::default(),
            54,
            Some("/tmp/a.jsonl"),
            Some("aaaa1111"),
            Some("Current auth pass"),
        );
        let text = text_of(&[line]);

        assert!(text.contains("Current auth pass"));
        assert!(text.contains("Ctrl+T picker"));
        assert!(text.contains('+'));
    }
}
