//! Todo tool state/parser plus inline task-list rendering.
//!
//! This stays on the bridge surface the Rust TUI already has: tool-call args
//! and tool-result text. Result details are cached back into the tool-call args
//! under a private widget key so the existing viewport can re-render the block.

use std::collections::HashMap;

use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use serde_json::{json, Value};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::ui::app::ToolStatus;
use crate::ui::theme::{Theme, ThemeRole};

pub const WIDGET_KEY: &str = "__pix_todo_widget";

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct TodoState {
    pub tasks: Vec<TodoTask>,
    pub by_id: HashMap<i64, usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TodoTask {
    pub id: i64,
    pub subject: String,
    pub description: String,
    pub status: TodoStatus,
    pub active_form: Option<String>,
    pub owner: Option<String>,
    pub parent_id: Option<i64>,
    pub blocked_by: Vec<i64>,
    pub thinking: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TodoStatus {
    Pending,
    InProgress,
    Deferred,
    Completed,
    Deleted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TodoAction {
    Create,
    Update,
    BatchCreate,
    BatchUpdate,
    List,
    Get,
    Delete,
    Clear,
    Export,
    Import,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct TodoMutation {
    pub id: Option<i64>,
    pub subject: Option<String>,
    pub description: Option<String>,
    pub status: Option<TodoStatus>,
    pub active_form: Option<String>,
    pub owner: Option<String>,
    pub parent_id: Option<i64>,
    pub clear_parent: bool,
    pub blocked_by: Option<Vec<i64>>,
    pub add_blocked_by: Vec<i64>,
    pub remove_blocked_by: Vec<i64>,
    pub thinking: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedTodoArgs {
    pub action: Option<TodoAction>,
    pub primary: TodoMutation,
    pub items: Vec<TodoMutation>,
    pub replace: bool,
    pub include_deleted: bool,
    pub blocked_only: bool,
}

impl TodoState {
    pub fn clear(&mut self) {
        self.tasks.clear();
        self.by_id.clear();
    }

    pub fn set_tasks(&mut self, tasks: Vec<TodoTask>) {
        self.tasks = tasks;
        self.reindex();
    }

    pub fn record_tool_call(&mut self, tool_name: &str, args: &mut Value) -> bool {
        if !is_todo_tool_name(tool_name) {
            return false;
        }
        let parsed = parse_todo_args(args);
        let tasks = match parsed.action {
            Some(TodoAction::List | TodoAction::Get) => self.filtered_tasks(&parsed),
            Some(TodoAction::BatchCreate) => self.preview_batch_create(&parsed),
            _ => Vec::new(),
        };
        if tasks.is_empty() && parsed.action != Some(TodoAction::List) {
            return false;
        }
        write_widget_tasks(args, parsed.action, &tasks, Some(self.next_id()));
        true
    }

    pub fn update_from_tool_result(
        &mut self,
        tool_name: &str,
        args: &mut Value,
        result_text: &str,
        ok: bool,
    ) -> bool {
        if !is_todo_tool_name(tool_name) {
            return false;
        }
        let parsed = parse_todo_args(args);
        let mut display_override = Vec::new();
        let changed = ok
            && (self.apply_json_details(result_text)
                || {
                    display_override = parse_human_task_lines(result_text);
                    if display_override.is_empty() {
                        false
                    } else {
                        for task in &display_override {
                            self.upsert(task.clone());
                        }
                        true
                    }
                }
                || self.apply_args_fallback(&parsed, result_text));

        if changed || should_render_inline_task_list(args) {
            let tasks = if display_override.is_empty() {
                self.filtered_tasks(&parsed)
            } else {
                display_override
            };
            write_widget_tasks(args, parsed.action, &tasks, Some(self.next_id()));
            if let Some(obj) = args.as_object_mut() {
                obj.insert("__pix_todo_widget_result".into(), json!(true));
            }
            return true;
        }
        false
    }

    pub fn upsert(&mut self, task: TodoTask) {
        if let Some(idx) = self.by_id.get(&task.id).copied() {
            self.tasks[idx] = task;
        } else {
            self.by_id.insert(task.id, self.tasks.len());
            self.tasks.push(task);
        }
    }

    fn reindex(&mut self) {
        self.by_id = self
            .tasks
            .iter()
            .enumerate()
            .map(|(i, t)| (t.id, i))
            .collect();
    }
    fn next_id(&self) -> i64 {
        self.tasks.iter().map(|t| t.id).max().unwrap_or(0) + 1
    }

    fn preview_batch_create(&self, parsed: &ParsedTodoArgs) -> Vec<TodoTask> {
        let mut next = if parsed.replace { 1 } else { self.next_id() };
        parsed
            .items
            .iter()
            .filter_map(|m| {
                let id = m.id.unwrap_or_else(|| {
                    let id = next;
                    next += 1;
                    id
                });
                task_from_mutation(m, id)
            })
            .collect()
    }

    fn apply_json_details(&mut self, text: &str) -> bool {
        let root: Value = serde_json::from_str(text.trim()).unwrap_or(Value::Null);
        let details = root.get("details").unwrap_or(&root);
        let Some(values) = details
            .get("tasks")
            .or_else(|| root.get("tasks"))
            .and_then(Value::as_array)
        else {
            return false;
        };
        self.set_tasks(
            values
                .iter()
                .enumerate()
                .filter_map(|(idx, value)| task_from_value(value, idx as i64 + 1))
                .collect(),
        );
        true
    }

    fn apply_args_fallback(&mut self, parsed: &ParsedTodoArgs, text: &str) -> bool {
        match parsed.action {
            Some(TodoAction::Create) => {
                if let Some(task) = task_from_mutation(
                    &parsed.primary,
                    first_id(text).unwrap_or_else(|| self.next_id()),
                ) {
                    self.upsert(task);
                    true
                } else {
                    false
                }
            }
            Some(TodoAction::Update) => self.apply_update(&parsed.primary),
            Some(TodoAction::BatchCreate) => {
                if parsed.replace {
                    self.clear();
                }
                let ids = scan_ids(text);
                let mut next = self.next_id();
                let mut changed = false;
                for (idx, item) in parsed.items.iter().enumerate() {
                    let id = item
                        .id
                        .or_else(|| ids.get(idx).copied())
                        .unwrap_or_else(|| {
                            let id = next;
                            next += 1;
                            id
                        });
                    if let Some(task) = task_from_mutation(item, id) {
                        self.upsert(task);
                        changed = true;
                    }
                }
                changed
            }
            Some(TodoAction::BatchUpdate) => parsed
                .items
                .iter()
                .fold(false, |c, m| self.apply_update(m) || c),
            Some(TodoAction::Delete) => {
                parsed
                    .primary
                    .id
                    .or_else(|| first_id(text))
                    .is_some_and(|id| {
                        if let Some(idx) = self.by_id.get(&id).copied() {
                            self.tasks[idx].status = TodoStatus::Deleted;
                            true
                        } else {
                            false
                        }
                    })
            }
            Some(TodoAction::Clear) => {
                self.clear();
                true
            }
            _ => false,
        }
    }

    fn apply_update(&mut self, m: &TodoMutation) -> bool {
        let Some(idx) = m.id.and_then(|id| self.by_id.get(&id).copied()) else {
            return false;
        };
        let mut task = self.tasks[idx].clone();
        if let Some(v) = &m.subject {
            task.subject = v.clone();
        }
        if let Some(v) = &m.description {
            task.description = v.clone();
        }
        if let Some(v) = m.status {
            task.status = v;
        }
        if let Some(v) = &m.owner {
            task.owner = Some(v.clone());
        }
        if m.clear_parent {
            task.parent_id = None;
        } else if let Some(v) = m.parent_id {
            task.parent_id = Some(v);
        }
        if let Some(v) = &m.blocked_by {
            task.blocked_by = v.clone();
        }
        task.blocked_by
            .retain(|id| !m.remove_blocked_by.contains(id));
        for id in &m.add_blocked_by {
            if !task.blocked_by.contains(id) {
                task.blocked_by.push(*id);
            }
        }
        if let Some(v) = &m.thinking {
            task.thinking = Some(v.clone());
        }
        self.tasks[idx] = task;
        true
    }

    fn filtered_tasks(&self, parsed: &ParsedTodoArgs) -> Vec<TodoTask> {
        self.tasks
            .iter()
            .filter(|t| parsed.include_deleted || t.status != TodoStatus::Deleted)
            .filter(|t| !parsed.blocked_only || !t.blocked_by.is_empty())
            .filter(|t| parsed.action != Some(TodoAction::Get) || parsed.primary.id == Some(t.id))
            .filter(|t| {
                parsed.action != Some(TodoAction::List)
                    || parsed.primary.status.is_none()
                    || parsed.primary.status == Some(t.status)
            })
            .cloned()
            .collect()
    }
}

impl TodoStatus {
    pub fn from_str(value: &str) -> Option<Self> {
        match token(value).as_str() {
            "pending" => Some(Self::Pending),
            "inprogress" | "in_progress" | "running" | "active" => Some(Self::InProgress),
            "deferred" | "blocked" => Some(Self::Deferred),
            "completed" | "complete" | "done" => Some(Self::Completed),
            "deleted" | "removed" => Some(Self::Deleted),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InProgress => "in_progress",
            Self::Deferred => "deferred",
            Self::Completed => "completed",
            Self::Deleted => "deleted",
        }
    }
    pub fn icon(self) -> &'static str {
        match self {
            Self::Pending => "□",
            Self::Deferred => "○",
            Self::InProgress => "▶",
            Self::Completed => "✓",
            Self::Deleted => "✖",
        }
    }
}

impl TodoAction {
    pub fn from_str(value: &str) -> Option<Self> {
        match token(value).as_str() {
            "create" => Some(Self::Create),
            "update" => Some(Self::Update),
            "batchcreate" | "batch_create" => Some(Self::BatchCreate),
            "batchupdate" | "batch_update" => Some(Self::BatchUpdate),
            "list" => Some(Self::List),
            "get" => Some(Self::Get),
            "delete" => Some(Self::Delete),
            "clear" => Some(Self::Clear),
            "export" => Some(Self::Export),
            "import" => Some(Self::Import),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Update => "update",
            Self::BatchCreate => "batch_create",
            Self::BatchUpdate => "batch_update",
            Self::List => "list",
            Self::Get => "get",
            Self::Delete => "delete",
            Self::Clear => "clear",
            Self::Export => "export",
            Self::Import => "import",
        }
    }
}

pub fn is_todo_tool_name(name: &str) -> bool {
    matches!(
        token(name).as_str(),
        "todo" | "updatetodolist" | "update_todo_list"
    )
}

pub fn parse_todo_args(args: &Value) -> ParsedTodoArgs {
    let value = normalized_value(args);
    let items = value
        .get("items")
        .or_else(|| value.get("tasks"))
        .or_else(|| value.get("todos"))
        .and_then(Value::as_array)
        .map(|items| items.iter().map(mutation_from_value).collect())
        .unwrap_or_default();
    ParsedTodoArgs {
        action: str_any(&value, &["action", "command", "op"]).and_then(TodoAction::from_str),
        primary: mutation_from_value(&value),
        items,
        replace: bool_any(&value, &["replace"]),
        include_deleted: bool_any(&value, &["includeDeleted", "include_deleted"]),
        blocked_only: bool_any(&value, &["blockedOnly", "blocked_only"]),
    }
}

pub fn should_render_inline_task_list(args: &Value) -> bool {
    args.get("__pix_todo_widget_result")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && args.get(WIDGET_KEY).is_some()
}

pub fn tool_display_for_todo(name: &str, args: &Value) -> (String, Option<String>) {
    let parsed = parse_todo_args(args);
    let count = item_count(args);
    let header_args = [
        parsed.action.map(TodoAction::as_str),
        parsed.primary.subject.as_deref(),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" · ");

    if header_args.is_empty() {
        match count {
            Some(n) => (format!("{name} {n} {}", plural(n, "item")), None),
            None => (name.to_string(), None),
        }
    } else {
        (format!("{name} {header_args}"), None)
    }
}

pub fn render_todo_tool_call_with_theme(
    _name: &str,
    args: &Value,
    status: ToolStatus,
    width: usize,
    theme: &Theme,
) -> Vec<Line<'static>> {
    let width = width.max(1);
    let (icon, color) = tool_icon(status, theme);
    let header_args = widget_action(args).map(|action| match widget_next_id(args) {
        Some(next_id) => format!("action={action} nextId={next_id}"),
        None => format!("action={action}"),
    });
    let mut out = vec![header_line(icon, color, "todo", header_args.as_deref(), width, theme)];
    let tasks = visible_task_rows(&widget_tasks(args));
    if tasks.is_empty() {
        out.push(Line::from(Span::styled(
            "    todo: no tasks",
            theme.style_for(ThemeRole::StatusDim),
        )));
    } else {
        out.extend(
            tasks
                .iter()
                .map(|(task, depth)| task_line(task, *depth, width, theme)),
        );
    }
    out
}

fn mutation_from_value(v: &Value) -> TodoMutation {
    TodoMutation {
        id: i64_any(v, &["id"]),
        subject: str_any(v, &["subject", "title", "text"]).map(str::to_string),
        description: str_any(v, &["description", "desc"]).map(str::to_string),
        status: str_any(v, &["status"]).and_then(TodoStatus::from_str),
        active_form: str_any(v, &["activeForm", "active_form"]).map(str::to_string),
        owner: str_any(v, &["owner", "assignee"]).map(str::to_string),
        parent_id: i64_any(v, &["parentId", "parent_id"]),
        clear_parent: bool_any(v, &["clearParent", "clear_parent"]),
        blocked_by: i64_array_any(v, &["blockedBy", "blocked_by"]),
        add_blocked_by: i64_array_any(v, &["addBlockedBy", "add_blocked_by"]).unwrap_or_default(),
        remove_blocked_by: i64_array_any(v, &["removeBlockedBy", "remove_blocked_by"])
            .unwrap_or_default(),
        thinking: str_any(v, &["thinking"]).map(str::to_string),
    }
}

fn task_from_mutation(m: &TodoMutation, id: i64) -> Option<TodoTask> {
    Some(TodoTask {
        id,
        subject: m.subject.clone()?,
        description: m.description.clone().unwrap_or_default(),
        status: m.status.unwrap_or(TodoStatus::Pending),
        active_form: m.active_form.clone(),
        owner: m.owner.clone(),
        parent_id: m.parent_id,
        blocked_by: m.blocked_by.clone().unwrap_or_default(),
        thinking: m.thinking.clone(),
    })
}

fn task_from_value(v: &Value, fallback_id: i64) -> Option<TodoTask> {
    let m = mutation_from_value(v);
    task_from_mutation(&m, m.id.unwrap_or(fallback_id))
}

fn parse_human_task_lines(text: &str) -> Vec<TodoTask> {
    text.lines().filter_map(parse_human_task_line).collect()
}

fn parse_human_task_line(line: &str) -> Option<TodoTask> {
    let s = line.trim();
    let (status, id, rest) = if s.starts_with('[') {
        let end = s.find(']')?;
        let status = TodoStatus::from_str(&s[1..end])?;
        let (id, rest) = parse_hash_id(s[end + 1..].trim())?;
        (status, id, rest)
    } else {
        let (id, rest) = parse_hash_id(s)?;
        let start = rest.find('[')?;
        let end = rest.find(']')?;
        (
            TodoStatus::from_str(&rest[start + 1..end])?,
            id,
            rest[end + 1..].trim(),
        )
    };
    let parent_id = rest.split('↳').nth(1).and_then(first_id);
    let blocked_by = rest.split('⛓').nth(1).map(scan_ids).unwrap_or_default();
    let thinking = rest
        .split("{thinking:")
        .nth(1)
        .and_then(|x| x.split('}').next())
        .map(str::to_string);
    let mut subject = rest
        .split("{thinking:")
        .next()
        .unwrap_or(rest)
        .split('↳')
        .next()
        .unwrap_or(rest)
        .split('⛓')
        .next()
        .unwrap_or(rest)
        .trim()
        .to_string();
    if status == TodoStatus::InProgress {
        if let Some(idx) = subject.rfind(" (") {
            subject.truncate(idx);
        }
    }
    Some(TodoTask {
        id,
        subject,
        description: String::new(),
        status,
        active_form: (status == TodoStatus::InProgress)
            .then(|| rest.to_string())
            .filter(|value| !value.is_empty()),
        owner: None,
        parent_id,
        blocked_by,
        thinking,
    })
}

fn write_widget_tasks(args: &mut Value, action: Option<TodoAction>, tasks: &[TodoTask], next_id: Option<i64>) {
    if let Some(obj) = args.as_object_mut() {
        obj.insert(WIDGET_KEY.into(), json!({
            "action": action.map(TodoAction::as_str),
            "nextId": next_id,
            "tasks": tasks.iter().map(task_to_value).collect::<Vec<_>>()
        }));
    }
}

fn widget_tasks(args: &Value) -> Vec<TodoTask> {
    args.get(WIDGET_KEY)
        .and_then(|w| w.get("tasks"))
        .and_then(Value::as_array)
        .map(|tasks| {
            tasks
                .iter()
                .enumerate()
                .filter_map(|(i, t)| task_from_value(t, i as i64 + 1))
                .collect()
        })
        .unwrap_or_default()
}

fn task_to_value(t: &TodoTask) -> Value {
    json!({"id":t.id,"subject":t.subject,"description":t.description,"status":t.status.as_str(),"activeForm":t.active_form,"owner":t.owner,"parentId":t.parent_id,"blockedBy":t.blocked_by,"thinking":t.thinking})
}

fn header_line(
    icon: &str,
    color: Color,
    label: &str,
    args_text: Option<&str>,
    width: usize,
    theme: &Theme,
) -> Line<'static> {
    let prefix = format!("  {icon} ");
    let pw = UnicodeWidthStr::width(prefix.as_str());
    if width <= pw {
        return Line::from(Span::styled(
            truncate(prefix.as_str(), width),
            Style::default().fg(color).add_modifier(Modifier::BOLD),
        ));
    }

    let available = width.saturating_sub(pw);
    let full_title = match args_text.filter(|text| !text.is_empty()) {
        Some(args) => format!("{label} {args}"),
        None => label.to_string(),
    };
    let truncated = truncate(full_title.as_str(), available);
    let label_end = display_prefix_byte_index(
        truncated.as_str(),
        UnicodeWidthStr::width(label).min(UnicodeWidthStr::width(truncated.as_str())),
    );
    let (visible_label, visible_rest) = truncated.split_at(label_end);

    let mut spans = vec![Span::styled(
        prefix,
        Style::default().fg(color).add_modifier(Modifier::BOLD),
    )];
    spans.push(Span::styled(
        visible_label.to_string(),
        theme
            .style_for(ThemeRole::ToolRunning)
            .add_modifier(Modifier::BOLD),
    ));
    if !visible_rest.is_empty() {
        spans.push(Span::styled(
            visible_rest.to_string(),
            theme.style_for(ThemeRole::StatusDim),
        ));
    }
    Line::from(spans)
}

fn task_line(t: &TodoTask, depth: usize, width: usize, theme: &Theme) -> Line<'static> {
    let text = truncate(&task_line_text(t, depth), width.max(1));
    let icon_end = display_prefix_byte_index(text.as_str(), task_status_prefix(t, depth).width());
    let mut spans = vec![Span::styled(
        text[..icon_end].to_string(),
        Style::default().fg(status_color(t.status, theme)),
    )];
    let subject_end = display_prefix_byte_index(text.as_str(), task_subject_prefix(t, depth).width());
    if subject_end > icon_end {
        spans.push(Span::styled(
            text[icon_end..subject_end].to_string(),
            task_subject_style(t, theme),
        ));
    }
    if subject_end < text.len() {
        spans.push(Span::styled(
            text[subject_end..].to_string(),
            theme.style_for(ThemeRole::StatusDim),
        ));
    }
    Line::from(spans)
}

fn task_line_text(t: &TodoTask, depth: usize) -> String {
    let mut parts = vec![task_status_prefix(t, depth), format!("{}.{}", t.id, inline(&t.subject))];
    if t.status == TodoStatus::InProgress {
        if let Some(active_form) = t.active_form.as_deref().filter(|value| !value.is_empty()) {
            parts.push(format!("— {}", inline(active_form)));
        }
    }
    if let Some(parent_id) = t.parent_id {
        parts.push(format!("parent:#{parent_id}"));
    }
    if !t.blocked_by.is_empty() {
        parts.push(format!(
            "blocked:{}",
            t.blocked_by
                .iter()
                .map(|id| format!("#{id}"))
                .collect::<Vec<_>>()
                .join(",")
        ));
    }
    parts.join(" ")
}

fn task_tree_prefix(depth: usize) -> String {
    if depth == 0 {
        "    ".to_string()
    } else {
        format!("    {}↳ ", "  ".repeat(depth))
    }
}

fn task_status_prefix(t: &TodoTask, depth: usize) -> String {
    format!("{}{}", task_tree_prefix(depth), t.status.icon())
}

fn task_subject_prefix(t: &TodoTask, depth: usize) -> String {
    format!("{} {}.{}", task_status_prefix(t, depth), t.id, inline(&t.subject))
}

fn task_subject_style(t: &TodoTask, theme: &Theme) -> Style {
    let mut style = t
        .thinking
        .as_deref()
        .map(|level| thinking_color(level, theme))
        .map(|color| Style::default().fg(color))
        .unwrap_or_else(|| theme.style_for(ThemeRole::AssistantText));
    if t.status == TodoStatus::Completed {
        style = style.add_modifier(Modifier::CROSSED_OUT);
    }
    style
}

fn thinking_color(level: &str, theme: &Theme) -> Color {
    match level {
        "low" => theme.status_dim,
        "medium" => theme.tool_running,
        "high" | "xhigh" => theme.diag_warn,
        _ => theme.status_dim,
    }
}

fn widget_action(args: &Value) -> Option<&str> {
    args.get(WIDGET_KEY)
        .and_then(|widget| widget.get("action"))
        .and_then(Value::as_str)
}

fn widget_next_id(args: &Value) -> Option<i64> {
    args.get(WIDGET_KEY)
        .and_then(|widget| widget.get("nextId"))
        .and_then(Value::as_i64)
}

fn visible_task_rows(tasks: &[TodoTask]) -> Vec<(TodoTask, usize)> {
    let tasks: Vec<TodoTask> = tasks
        .iter()
        .filter(|task| task.status != TodoStatus::Deleted)
        .cloned()
        .collect();
    let tasks_by_id: HashMap<i64, TodoTask> = tasks.iter().cloned().map(|task| (task.id, task)).collect();
    let mut children_by_parent: HashMap<i64, Vec<TodoTask>> = HashMap::new();
    let mut roots = Vec::new();
    for task in &tasks {
        if let Some(parent_id) = task.parent_id.filter(|parent_id| *parent_id != task.id) {
            if tasks_by_id.contains_key(&parent_id) {
                children_by_parent.entry(parent_id).or_default().push(task.clone());
                continue;
            }
        }
        roots.push(task.clone());
    }

    let mut rows = Vec::new();
    let mut emitted = std::collections::HashSet::new();
    fn emit_task(
        task: TodoTask,
        depth: usize,
        rows: &mut Vec<(TodoTask, usize)>,
        emitted: &mut std::collections::HashSet<i64>,
        children_by_parent: &HashMap<i64, Vec<TodoTask>>,
    ) {
        if !emitted.insert(task.id) {
            return;
        }
        rows.push((task.clone(), depth));
        if let Some(children) = children_by_parent.get(&task.id) {
            for child in children {
                emit_task(child.clone(), depth + 1, rows, emitted, children_by_parent);
            }
        }
    }

    for task in roots {
        emit_task(task, 0, &mut rows, &mut emitted, &children_by_parent);
    }
    for task in tasks {
        emit_task(task, 0, &mut rows, &mut emitted, &children_by_parent);
    }
    rows
}

fn tool_icon(status: ToolStatus, theme: &Theme) -> (&'static str, Color) {
    match status {
        ToolStatus::Pending => ("○", theme.tool_pending),
        ToolStatus::Running => ("◑", theme.tool_running),
        ToolStatus::Completed => ("●", theme.tool_completed),
        ToolStatus::Failed => ("✖", theme.tool_failed),
    }
}
fn status_color(status: TodoStatus, theme: &Theme) -> Color {
    match status {
        TodoStatus::Pending => theme.status_dim,
        TodoStatus::InProgress => theme.tool_running,
        TodoStatus::Deferred => theme.diag_warn,
        TodoStatus::Completed => theme.tool_completed,
        TodoStatus::Deleted => theme.tool_failed,
    }
}

fn normalized_value(v: &Value) -> Value {
    if let Value::String(s) = v {
        serde_json::from_str(s.trim()).unwrap_or(Value::Null)
    } else {
        v.clone()
    }
}
fn str_any<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|k| v.get(*k)?.as_str())
        .filter(|s| !s.trim().is_empty())
}
fn bool_any(v: &Value, keys: &[&str]) -> bool {
    keys.iter()
        .find_map(|k| v.get(*k)?.as_bool())
        .unwrap_or(false)
}
fn i64_any(v: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter().find_map(|k| v.get(*k)?.as_i64())
}
fn i64_array_any(v: &Value, keys: &[&str]) -> Option<Vec<i64>> {
    keys.iter().find_map(|k| {
        v.get(*k)?
            .as_array()
            .map(|xs| xs.iter().filter_map(Value::as_i64).collect())
    })
}
fn parse_hash_id(s: &str) -> Option<(i64, &str)> {
    let after = &s[s.find('#')? + 1..];
    let len = after
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .map(char::len_utf8)
        .sum::<usize>();
    if len == 0 {
        return None;
    }
    Some((after[..len].parse().ok()?, after[len..].trim()))
}
fn first_id(s: &str) -> Option<i64> {
    scan_ids(s).into_iter().next()
}
fn scan_ids(mut s: &str) -> Vec<i64> {
    let mut ids = Vec::new();
    while let Some(pos) = s.find('#') {
        s = &s[pos + 1..];
        let len = s
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .map(char::len_utf8)
            .sum::<usize>();
        if len > 0 {
            if let Ok(id) = s[..len].parse() {
                ids.push(id);
            }
            s = &s[len..];
        }
    }
    ids
}
fn item_count(args: &Value) -> Option<usize> {
    if let Some(a) = args.as_array() {
        return Some(a.len());
    }
    ["items", "todos", "todoList", "todo_list", "tasks"]
        .iter()
        .find_map(|k| args.get(*k)?.as_array().map(Vec::len))
}
fn plural(n: usize, word: &str) -> String {
    if n == 1 {
        word.into()
    } else {
        format!("{word}s")
    }
}
fn token(s: &str) -> String {
    s.trim()
        .chars()
        .filter(|c| *c != '-' && *c != ' ')
        .flat_map(char::to_lowercase)
        .collect()
}
fn inline(s: &str) -> String {
    s.replace('\r', "").replace('\n', " ").replace('\x1b', "␛")
}
fn truncate(s: &str, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    if UnicodeWidthStr::width(s) <= width {
        return s.into();
    }
    if width == 1 {
        return "…".into();
    }
    let mut out = String::new();
    let mut used = 0;
    for ch in s.chars() {
        let w = UnicodeWidthChar::width(ch).unwrap_or(0);
        if used + w > width - 1 {
            break;
        }
        out.push(ch);
        used += w;
    }
    out.push('…');
    out
}

fn display_prefix_byte_index(s: &str, width: usize) -> usize {
    if width == 0 {
        return 0;
    }
    let mut used = 0;
    for (idx, ch) in s.char_indices() {
        let ch_width = UnicodeWidthChar::width(ch).unwrap_or(0);
        if used + ch_width > width {
            return idx;
        }
        used += ch_width;
        if used == width {
            return idx + ch.len_utf8();
        }
    }
    s.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn text(line: &Line<'_>) -> String {
        line.spans.iter().map(|s| s.content.as_ref()).collect()
    }
    fn task(id: i64, subject: &str, status: TodoStatus, blocked_by: Vec<i64>) -> TodoTask {
        TodoTask {
            id,
            subject: subject.into(),
            description: String::new(),
            status,
            active_form: None,
            owner: None,
            parent_id: None,
            blocked_by,
            thinking: None,
        }
    }

    #[test]
    fn parse_create_args() {
        let p = parse_todo_args(
            &json!({"action":"create","subject":"Write tests","description":"cover parser","blockedBy":[2]}),
        );
        assert_eq!(p.action, Some(TodoAction::Create));
        assert_eq!(p.primary.subject.as_deref(), Some("Write tests"));
        assert_eq!(p.primary.description.as_deref(), Some("cover parser"));
        assert_eq!(p.primary.blocked_by, Some(vec![2]));
    }

    #[test]
    fn parse_update_status() {
        let p = parse_todo_args(&json!({"action":"update","id":7,"status":"in_progress"}));
        assert_eq!(p.action, Some(TodoAction::Update));
        assert_eq!(p.primary.id, Some(7));
        assert_eq!(p.primary.status, Some(TodoStatus::InProgress));
    }

    #[test]
    fn parse_batch_create() {
        let p = parse_todo_args(
            &json!({"action":"batch_create","items":[{"subject":"A"},{"subject":"B","thinking":"high"}]}),
        );
        assert_eq!(p.items.len(), 2);
        assert_eq!(p.items[1].subject.as_deref(), Some("B"));
        assert_eq!(p.items[1].thinking.as_deref(), Some("high"));
    }

    #[test]
    fn parse_list_response() {
        let tasks = parse_human_task_lines(
            "[pending] #1 First\n[in_progress] #2 Second (working) ↳ #1 ⛓ #3,#4",
        );
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].subject, "First");
        assert_eq!(tasks[1].parent_id, Some(1));
        assert_eq!(tasks[1].blocked_by, vec![3, 4]);
    }

    #[test]
    fn render_task_list_lines() {
        let mut args = json!({"action":"list"});
        write_widget_tasks(
            &mut args,
            Some(TodoAction::List),
            &[task(
                1,
                "A very long subject that will truncate",
                TodoStatus::Pending,
                vec![],
            )],
            Some(2),
        );
        let lines = render_todo_tool_call_with_theme(
            "todo",
            &args,
            ToolStatus::Running,
            24,
            &Theme::default(),
        );
        assert_eq!(lines.len(), 2);
        let row = text(&lines[1]);
        assert!(row.starts_with("    □ 1.A very"), "got {row:?}");
        assert!(UnicodeWidthStr::width(row.as_str()) <= 24);
    }

    #[test]
    fn todo_header_keeps_suffix_muted() {
        let theme = Theme::default();
        let lines = render_todo_tool_call_with_theme(
            "todo",
            &json!({"action":"update", "__pix_todo_widget": {"action": "update"}}),
            ToolStatus::Running,
            80,
            &theme,
        );
        assert_eq!(text(&lines[0]), "  ◑ todo action=update");
        assert_eq!(lines[0].spans[1].style.fg, Some(theme.tool_running));
        assert_eq!(lines[0].spans[2].style.fg, Some(theme.status_dim));
    }

    #[test]
    fn status_icon_mapping() {
        assert_eq!(TodoStatus::Pending.icon(), "□");
        assert_eq!(TodoStatus::Deferred.icon(), "○");
        assert_eq!(TodoStatus::InProgress.icon(), "▶");
        assert_eq!(TodoStatus::Completed.icon(), "✓");
        assert_eq!(TodoStatus::Deleted.icon(), "✖");
    }

    #[test]
    fn blocked_by_preservation() {
        let mut state = TodoState::default();
        state.set_tasks(vec![task(1, "Keep blockers", TodoStatus::Pending, vec![9])]);
        let mut args = json!({"action":"update","id":1,"status":"completed"});
        assert!(state.update_from_tool_result(
            "todo",
            &mut args,
            "Updated #1 (pending → completed)",
            true
        ));
        assert_eq!(state.tasks[0].status, TodoStatus::Completed);
        assert_eq!(state.tasks[0].blocked_by, vec![9]);
    }

    #[test]
    fn malformed_args_fallback() {
        let p = parse_todo_args(&json!("{not-json"));
        assert_eq!(p.action, None);
        assert!(p.items.is_empty());
        assert!(!should_render_inline_task_list(&json!("{not-json")));
    }

    #[test]
    fn json_envelope_updates_state() {
        let mut state = TodoState::default();
        let mut args = json!({"action":"list"});
        let result = json!({"details":{"action":"list","tasks":[{"id":3,"subject":"From details","status":"deferred"}],"nextId":4}}).to_string();
        assert!(state.update_from_tool_result("todo", &mut args, &result, true));
        assert_eq!(state.tasks[0].id, 3);
        assert_eq!(state.tasks[0].status, TodoStatus::Deferred);
        assert!(should_render_inline_task_list(&args));
    }
}
