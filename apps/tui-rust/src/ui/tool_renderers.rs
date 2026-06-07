//! Specialized renderers for tool call/result blocks.
//!
//! The viewport owns the outer conversation layout, while this module keeps
//! per-tool summaries concise and consistent with the TypeScript pix UI.

use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use serde_json::Value;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::ui::app::ToolStatus;
use crate::ui::links::{envelope_osc8, extract_file_paths, LinkSpan};
use crate::ui::theme::{Theme, ThemeRole};

use super::wrap;

const MAX_DETAIL_LINES: usize = 3;

/// Render a tool call as a compact, styled block.
pub fn render_tool_call(
    name: &str,
    args: &Value,
    status: crate::ui::app::ToolStatus,
    width: usize,
) -> Vec<Line<'static>> {
    render_tool_call_with_theme(name, args, status, width, &Theme::default())
}

/// Render a path-like value as a standalone clickable OSC 8 link line.
pub fn render_path_with_link(path: &str) -> Line<'static> {
    let theme = Theme::default();
    let spans = extract_file_paths(path, None);
    let text = spans
        .first()
        .map(|span| envelope_osc8(&span.url, path))
        .unwrap_or_else(|| path.to_string());
    Line::from(Span::styled(text, theme.style_for(ThemeRole::Link)))
}

pub fn render_tool_call_with_theme(
    name: &str,
    args: &Value,
    status: crate::ui::app::ToolStatus,
    width: usize,
    theme: &Theme,
) -> Vec<Line<'static>> {
    let width = width.max(1);
    if crate::ui::todo_view::is_todo_tool_name(name)
        && crate::ui::todo_view::should_render_inline_task_list(args)
    {
        return crate::ui::todo_view::render_todo_tool_call_with_theme(
            name, args, status, width, theme,
        );
    }
    let (status_icon, status_color) = status_icon_and_color(status, theme);
    let display = tool_display(name, args);
    let mut out = Vec::with_capacity(1 + MAX_DETAIL_LINES);

    out.push(header_line(
        status_icon,
        status_color,
        &display.title,
        width,
        theme,
    ));
    if let Some(details) = display.details.filter(|text| !text.trim().is_empty()) {
        out.extend(detail_lines(&details, width, MAX_DETAIL_LINES, theme));
    }
    out
}

/// Number of visual lines `render_tool_call` emits for the same args/width.
pub fn tool_call_line_count(name: &str, args: &Value, width: usize) -> usize {
    render_tool_call(name, args, ToolStatus::Pending, width).len()
}

/// Render a tool result summary paired with a call.
pub fn render_tool_result(
    call_id: &str,
    summary: &str,
    ok: bool,
    width: usize,
) -> Vec<Line<'static>> {
    render_tool_result_with_theme(call_id, summary, ok, width, &Theme::default())
}

pub fn render_tool_result_with_theme(
    call_id: &str,
    summary: &str,
    ok: bool,
    width: usize,
    theme: &Theme,
) -> Vec<Line<'static>> {
    let width = width.max(1);
    let (result_icon, color) = if ok {
        ("✓", theme.tool_completed)
    } else {
        ("✖", theme.tool_failed)
    };
    let text = if summary.trim().is_empty() {
        if call_id.is_empty() {
            "(result)".to_string()
        } else {
            format!("call {call_id}")
        }
    } else {
        sanitize_inline(summary)
    };
    let first_prefix = format!("    ↳ {result_icon} ");
    let cont_prefix = "      ";
    wrapped_prefixed_lines(
        &text,
        width,
        &first_prefix,
        cont_prefix,
        Style::default().fg(color),
        theme,
    )
}

#[derive(Debug)]
struct ToolDisplay {
    title: String,
    details: Option<String>,
}

fn tool_display(name: &str, args: &Value) -> ToolDisplay {
    match normalized_tool_name(name).as_str() {
        "read" => read_display(name, args),
        "edit" => edit_display(name, args),
        "write" => write_display(name, args),
        "applypatch" | "apply_patch" => apply_patch_display(name, args),
        "bash" | "shell" | "shellcommand" | "shell_command" => bash_display(name, args),
        "updatetodolist" | "update_todo_list" | "todo" => update_todo_list_display(name, args),
        "grep" => grep_display(name, args),
        "glob" => glob_display(name, args),
        "ast_grep" | "astgrep" | "sg" => ast_grep_display(name, args),
        "compress" => compress_display(name, args),
        "question" => question_display(name, args),
        "repo_search" | "reposearch" | "repo_explain" | "repoexplain" | "repo_deps"
        | "repodeps" | "repo_architecture" | "repoarchitecture" | "repo_structure"
        | "repostructure" | "repo_ast" | "repoast" => repo_display(name, args),
        "skill" => skill_display(name, args),
        "subagents"
        | "async_subagents"
        | "async_subagents_spawn"
        | "async_subagents_status"
        | "async_subagents_wait"
        | "async_subagents_result"
        | "async_subagents_stop"
        | "async_subagents_cleanup" => subagents_display(name, args),
        "web_search" | "websearch" => web_search_display(name, args),
        "web_fetch" | "webfetch" => web_fetch_display(name, args),
        _ => default_display(name, args),
    }
}

fn read_display(name: &str, args: &Value) -> ToolDisplay {
    let path = get_str_any(args, &["file_path", "filePath", "path", "file", "target"]);
    let range = read_range(args);
    let title = format!("📖 {}{}", path.unwrap_or(name), range);
    ToolDisplay {
        title,
        details: compact_fields(
            args,
            &[
                "file_path",
                "filePath",
                "path",
                "file",
                "target",
                "offset",
                "limit",
            ],
        ),
    }
}

fn bash_display(name: &str, args: &Value) -> ToolDisplay {
    let command = get_str_any(args, &["command", "cmd", "script"])
        .map(compact_command)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| name.to_string());
    ToolDisplay {
        title: format!("$ {command}"),
        details: compact_fields(args, &["command", "cmd", "script"]),
    }
}

fn edit_display(name: &str, args: &Value) -> ToolDisplay {
    let path = get_str_any(args, &["file_path", "filePath", "path", "file"]);
    ToolDisplay {
        title: format!("✎ {}", path.unwrap_or(name)),
        details: compact_fields(args, &["file_path", "filePath", "path", "file"]),
    }
}

fn write_display(name: &str, args: &Value) -> ToolDisplay {
    let path = get_str_any(args, &["file_path", "filePath", "path", "file"]);
    let mut details = compact_fields(args, &["file_path", "filePath", "path", "file", "content"]);
    if let Some(content) = get_str_any(args, &["content"]) {
        let bytes = content.len();
        details = Some(match details {
            Some(existing) => format!("content={bytes} bytes {existing}"),
            None => format!("content={bytes} bytes"),
        });
    }
    ToolDisplay {
        title: format!("✍ {}", path.unwrap_or(name)),
        details,
    }
}

fn apply_patch_display(name: &str, args: &Value) -> ToolDisplay {
    let path = get_str_any(args, &["file_path", "filePath", "path", "file"])
        .map(str::to_string)
        .or_else(|| patch_path(args));
    let title = match path {
        Some(path) if !path.is_empty() => format!("⚡ apply-patch {path}"),
        _ => "⚡ apply-patch".to_string(),
    };
    let mut details = compact_fields(
        args,
        &["file_path", "filePath", "path", "file", "patch", "input"],
    );
    if let Some(patch) = get_str_any(args, &["patch", "input"]) {
        if let Some(summary) = patch_summary(patch) {
            details = Some(match details {
                Some(existing) => format!("{summary} {existing}"),
                None => summary,
            });
        }
    }
    ToolDisplay {
        title: if title.is_empty() {
            name.to_string()
        } else {
            title
        },
        details,
    }
}

fn update_todo_list_display(_name: &str, args: &Value) -> ToolDisplay {
    let (title, details) = crate::ui::todo_view::tool_display_for_todo(_name, args);
    ToolDisplay { title, details }
}

fn grep_display(name: &str, args: &Value) -> ToolDisplay {
    let pattern = get_str_any(args, &["pattern", "query", "regex"]).unwrap_or(name);
    let path = get_str_any(args, &["path", "file_path", "filePath", "dir", "include"]);
    let title = match path {
        Some(path) if !path.is_empty() => format!("🔍 {pattern} in {path}"),
        _ => format!("🔍 {pattern}"),
    };
    ToolDisplay {
        title,
        details: compact_fields(
            args,
            &[
                "pattern",
                "query",
                "regex",
                "path",
                "file_path",
                "filePath",
                "dir",
                "include",
            ],
        ),
    }
}

fn glob_display(name: &str, args: &Value) -> ToolDisplay {
    let pattern = get_str_any(args, &["pattern", "glob"]).unwrap_or(name);
    ToolDisplay {
        title: format!("📂 {pattern}"),
        details: compact_fields(args, &["pattern", "glob"]),
    }
}

fn ast_grep_display(name: &str, args: &Value) -> ToolDisplay {
    let pattern = get_str_any(args, &["pattern", "target", "command", "query"]).unwrap_or(name);
    let paths = value_summary_any(
        args,
        &[
            "paths",
            "path",
            "file_path",
            "filePath",
            "dir",
            "include",
            "includes",
        ],
    );
    let lang = get_str_any(args, &["lang", "language"]);
    let mut title = format!("🔍 {pattern}");
    if let Some(paths) = paths.filter(|s| !s.is_empty()) {
        title.push_str(&format!(" in {paths}"));
    }
    if let Some(lang) = lang.filter(|s| !s.is_empty()) {
        title.push_str(&format!(" [{lang}]"));
    }
    ToolDisplay {
        title,
        details: compact_fields(
            args,
            &[
                "pattern",
                "target",
                "command",
                "query",
                "paths",
                "path",
                "file_path",
                "filePath",
                "dir",
                "include",
                "includes",
                "lang",
                "language",
            ],
        ),
    }
}

fn compress_display(name: &str, args: &Value) -> ToolDisplay {
    let target = value_summary_any(
        args,
        &["paths", "path", "target", "targets", "files", "topic"],
    )
    .unwrap_or_else(|| name.to_string());
    ToolDisplay {
        title: format!("📦 {target}"),
        details: compact_fields(
            args,
            &["paths", "path", "target", "targets", "files", "topic"],
        ),
    }
}

fn question_display(name: &str, args: &Value) -> ToolDisplay {
    let question = get_str_any(args, &["question", "prompt", "label", "text", "title"])
        .map(str::to_string)
        .or_else(|| first_question_text(args))
        .unwrap_or_else(|| name.to_string());
    let title = match choice_count(args) {
        Some(count) => format!("❓ {question} ({count} {})", plural(count, "choice")),
        None => format!("❓ {question}"),
    };
    ToolDisplay {
        title,
        details: compact_fields(
            args,
            &[
                "question",
                "prompt",
                "label",
                "text",
                "title",
                "choices",
                "options",
                "questions",
            ],
        ),
    }
}

fn repo_display(name: &str, args: &Value) -> ToolDisplay {
    let action = repo_action(name);
    let target = repo_target(args);
    let title = match target {
        Some(target) if !target.is_empty() => format!("🏛️ {action} {target}"),
        _ => format!("🏛️ {action}"),
    };
    ToolDisplay {
        title,
        details: compact_fields(
            args,
            &[
                "target", "symbol", "path", "query", "name", "args", "maxLines", "maxBytes",
            ],
        ),
    }
}

fn skill_display(name: &str, args: &Value) -> ToolDisplay {
    let skill = get_str_any(args, &["skill", "skill_name", "skillName", "name"])
        .map(str::to_string)
        .or_else(|| {
            get_str_any(args, &["path", "file_path", "filePath", "target"])
                .map(skill_name_from_path)
        })
        .unwrap_or_else(|| name.to_string());
    ToolDisplay {
        title: format!("🎯 {skill}"),
        details: compact_fields(
            args,
            &[
                "skill",
                "skill_name",
                "skillName",
                "name",
                "path",
                "file_path",
                "filePath",
                "target",
            ],
        ),
    }
}

fn subagents_display(name: &str, args: &Value) -> ToolDisplay {
    let (title, details) = crate::ui::subagents_view::tool_display_for_subagents(name, args);
    ToolDisplay { title, details }
}

fn web_search_display(name: &str, args: &Value) -> ToolDisplay {
    let query = get_str_any(args, &["query", "q", "search"]).unwrap_or(name);
    ToolDisplay {
        title: format!("🌐 {query}"),
        details: compact_fields(args, &["query", "q", "search"]),
    }
}

fn web_fetch_display(name: &str, args: &Value) -> ToolDisplay {
    let url = get_str_any(args, &["url", "uri", "href"]).unwrap_or(name);
    ToolDisplay {
        title: format!("🌐 {url}"),
        details: compact_fields(args, &["url", "uri", "href"]),
    }
}

fn default_display(name: &str, args: &Value) -> ToolDisplay {
    let details = if args.is_null() {
        None
    } else {
        Some(serde_json::to_string(args).unwrap_or_else(|_| format!("{args}")))
    };
    ToolDisplay {
        title: name.to_string(),
        details,
    }
}

fn header_line(
    icon: &str,
    color: Color,
    title: &str,
    width: usize,
    theme: &Theme,
) -> Line<'static> {
    let prefix = format!("  {icon} ");
    let prefix_width = UnicodeWidthStr::width(prefix.as_str());
    if width <= prefix_width {
        return Line::from(Span::styled(
            truncate_display(&prefix, width),
            Style::default().fg(color),
        ));
    }

    let title = truncate_display(&sanitize_inline(title), width - prefix_width);
    let title_spans = spans_with_links(
        &title,
        Style::default().fg(color).add_modifier(Modifier::BOLD),
        theme
            .style_for(ThemeRole::Link)
            .add_modifier(Modifier::BOLD),
    );
    let mut spans = vec![Span::styled(
        prefix,
        Style::default().fg(color).add_modifier(Modifier::BOLD),
    )];
    spans.extend(title_spans);
    Line::from(spans)
}

fn detail_lines(text: &str, width: usize, max_lines: usize, theme: &Theme) -> Vec<Line<'static>> {
    let prefix = "    ";
    let body_width = width.saturating_sub(UnicodeWidthStr::width(prefix)).max(1);
    let mut chunks = wrap::wrap_text(&sanitize_inline(text), body_width);
    if chunks.len() > max_lines {
        chunks.truncate(max_lines);
        if let Some(last) = chunks.last_mut() {
            *last = with_ellipsis(last, body_width);
        }
    }
    chunks
        .into_iter()
        .map(|chunk| {
            let detail_spans = spans_with_links(
                &chunk,
                Style::default().fg(Color::DarkGray),
                theme.style_for(ThemeRole::Link),
            );
            let mut spans = vec![Span::raw(prefix.to_string())];
            spans.extend(detail_spans);
            Line::from(spans)
        })
        .collect()
}

fn spans_with_links(text: &str, base_style: Style, link_style: Style) -> Vec<Span<'static>> {
    let link_spans = extract_file_paths(text, None);
    if link_spans.is_empty() {
        return vec![Span::styled(text.to_string(), base_style)];
    }

    let mut out = Vec::new();
    let mut cursor = 0usize;
    for LinkSpan {
        url,
        text: link_text,
    } in link_spans
    {
        let Some(rel_start) = text[cursor..].find(&link_text) else {
            continue;
        };
        let start = cursor + rel_start;
        let end = start + link_text.len();
        if start > cursor {
            out.push(Span::styled(text[cursor..start].to_string(), base_style));
        }
        out.push(Span::styled(envelope_osc8(&url, &link_text), link_style));
        cursor = end;
    }
    if cursor < text.len() {
        out.push(Span::styled(text[cursor..].to_string(), base_style));
    }
    if out.is_empty() {
        out.push(Span::styled(text.to_string(), base_style));
    }
    out
}

fn wrapped_prefixed_lines(
    text: &str,
    width: usize,
    first_prefix: &str,
    cont_prefix: &str,
    style: Style,
    theme: &Theme,
) -> Vec<Line<'static>> {
    let first_body_width = width
        .saturating_sub(UnicodeWidthStr::width(first_prefix))
        .max(1);
    let cont_body_width = width
        .saturating_sub(UnicodeWidthStr::width(cont_prefix))
        .max(1);
    let mut out = Vec::new();
    let first_chunks = wrap::wrap_text(text, first_body_width);

    for (idx, chunk) in first_chunks.into_iter().enumerate() {
        let prefix = if idx == 0 { first_prefix } else { cont_prefix };
        let mut spans = vec![Span::styled(prefix.to_string(), style)];
        spans.extend(spans_with_links(
            &chunk,
            Style::default().fg(Color::DarkGray),
            theme.style_for(ThemeRole::Link),
        ));
        out.push(Line::from(spans));
    }

    // Re-wrap continuation overflow against the continuation prefix width.
    // This only matters when the first prefix is narrower than continuation;
    // common terminal widths make the first pass sufficient.
    if UnicodeWidthStr::width(first_prefix) >= UnicodeWidthStr::width(cont_prefix) {
        return out;
    }

    let mut repaired = Vec::new();
    for (idx, line) in out.into_iter().enumerate() {
        if idx == 0 {
            repaired.push(line);
            continue;
        }
        let text = line_text(&line).trim_start().to_string();
        for chunk in wrap::wrap_text(&text, cont_body_width) {
            let mut spans = vec![Span::styled(cont_prefix.to_string(), style)];
            spans.extend(spans_with_links(
                &chunk,
                Style::default().fg(Color::DarkGray),
                theme.style_for(ThemeRole::Link),
            ));
            repaired.push(Line::from(spans));
        }
    }
    repaired
}

fn status_icon_and_color(status: ToolStatus, theme: &Theme) -> (&'static str, Color) {
    match status {
        ToolStatus::Pending => ("○", theme.tool_pending),
        ToolStatus::Running => ("◑", theme.tool_running),
        ToolStatus::Completed => ("●", theme.tool_completed),
        ToolStatus::Failed => ("✖", theme.tool_failed),
    }
}

fn normalized_tool_name(name: &str) -> String {
    name.chars()
        .filter(|c| *c != '-' && *c != ' ')
        .flat_map(char::to_lowercase)
        .collect()
}

fn get_str_any<'a>(args: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| args.get(*key)?.as_str())
        .filter(|s| !s.is_empty())
}

fn read_range(args: &Value) -> String {
    let offset = args.get("offset").and_then(Value::as_i64);
    let limit = args.get("limit").and_then(Value::as_i64);
    match (offset, limit) {
        (Some(offset), Some(limit)) => format!(":{offset}+{limit}"),
        (Some(offset), None) => format!(":{offset}"),
        _ => String::new(),
    }
}

fn compact_fields(args: &Value, skip: &[&str]) -> Option<String> {
    let obj = args.as_object()?;
    let parts: Vec<String> = obj
        .iter()
        .filter(|(key, _)| !skip.iter().any(|skip_key| skip_key == key))
        .filter_map(|(key, value)| value_preview(value).map(|preview| format!("{key}={preview}")))
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" "))
    }
}

fn value_preview(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::Bool(v) => Some(v.to_string()),
        Value::Number(v) => Some(v.to_string()),
        Value::String(v) => Some(quote_preview(v, 72)),
        Value::Array(v) => Some(format!("[{} items]", v.len())),
        Value::Object(v) => Some(format!("{{{} keys}}", v.len())),
    }
}

fn quote_preview(text: &str, width: usize) -> String {
    format!("\"{}\"", truncate_display(&sanitize_inline(text), width))
}

fn compact_command(command: &str) -> String {
    command.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn patch_path(args: &Value) -> Option<String> {
    let patch = get_str_any(args, &["patch", "input"])?;
    for line in patch.lines() {
        let trimmed = line.trim();
        for prefix in ["*** Update File:", "*** Add File:", "*** Delete File:"] {
            if let Some(path) = trimmed.strip_prefix(prefix) {
                return Some(path.trim().to_string());
            }
        }
        if let Some(path) = trimmed.strip_prefix("+++") {
            return Some(path.trim().trim_start_matches("b/").to_string());
        }
    }
    None
}

fn patch_summary(patch: &str) -> Option<String> {
    if patch.trim().is_empty() {
        return None;
    }
    let added = patch
        .lines()
        .filter(|line| line.starts_with('+') && !line.starts_with("+++"))
        .count();
    let removed = patch
        .lines()
        .filter(|line| line.starts_with('-') && !line.starts_with("---"))
        .count();
    if added == 0 && removed == 0 {
        Some("patch".to_string())
    } else {
        Some(format!("patch +{added} -{removed}"))
    }
}

fn value_summary_any(args: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value_summary(args.get(*key)?))
        .filter(|s| !s.is_empty())
}

fn value_summary(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(sanitize_inline(value.trim())),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        Value::Array(values) => {
            let mut parts: Vec<String> = values
                .iter()
                .filter_map(value_summary)
                .filter(|part| !part.is_empty())
                .take(3)
                .collect();
            if parts.is_empty() {
                return None;
            }
            if values.len() > parts.len() {
                parts.push(format!("+{}", values.len() - parts.len()));
            }
            Some(parts.join(", "))
        }
        _ => None,
    }
}

fn first_question_text(args: &Value) -> Option<String> {
    let first = args.get("questions")?.as_array()?.first()?;
    get_str_any(
        first,
        &["question", "prompt", "label", "id", "text", "title"],
    )
    .map(str::to_string)
}

fn choice_count(args: &Value) -> Option<usize> {
    if let Some(count) = args.get("choices").and_then(Value::as_array).map(Vec::len) {
        return Some(count);
    }
    if let Some(count) = args.get("options").and_then(Value::as_array).map(Vec::len) {
        return Some(count);
    }
    let questions = args.get("questions")?.as_array()?;
    let total = questions
        .iter()
        .filter_map(|question| {
            question
                .get("choices")
                .and_then(Value::as_array)
                .map(Vec::len)
        })
        .sum();
    Some(total)
}

fn repo_action(name: &str) -> String {
    let normalized = name
        .rsplit(['.', ':', '/'])
        .next()
        .unwrap_or(name)
        .replace('-', "_");
    normalized
        .strip_prefix("repo_")
        .unwrap_or(normalized.as_str())
        .to_string()
}

fn repo_target(args: &Value) -> Option<String> {
    let target = get_str_any(args, &["target"]);
    let symbol = get_str_any(args, &["symbol"]);
    match (target, symbol) {
        (Some(target), Some(symbol)) if target != symbol => Some(format!("{target} · {symbol}")),
        (Some(target), _) => Some(target.to_string()),
        (_, Some(symbol)) => Some(symbol.to_string()),
        _ => value_summary_any(args, &["path", "query", "name"]),
    }
}

fn skill_name_from_path(path: &str) -> String {
    let trimmed = path.trim().trim_end_matches(['/', '\\']);
    let mut parts = trimmed
        .split(['/', '\\'])
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if parts
        .last()
        .is_some_and(|file| file.eq_ignore_ascii_case("SKILL.md"))
    {
        parts.pop();
    }
    parts.last().copied().unwrap_or("skill").to_string()
}

fn plural(count: usize, word: &str) -> String {
    if count == 1 {
        word.to_string()
    } else {
        format!("{word}s")
    }
}

fn sanitize_inline(text: &str) -> String {
    text.replace('\r', "")
        .replace('\n', " ")
        .replace('\x1b', "␛")
}

fn truncate_display(text: &str, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    if UnicodeWidthStr::width(text) <= width {
        return text.to_string();
    }
    if width == 1 {
        return "…".to_string();
    }

    let mut out = String::new();
    let mut used = 0usize;
    let limit = width - 1;
    for ch in text.chars() {
        let cw = UnicodeWidthChar::width(ch).unwrap_or(0);
        if used + cw > limit {
            break;
        }
        out.push(ch);
        used += cw;
    }
    out.push('…');
    out
}

fn with_ellipsis(text: &str, width: usize) -> String {
    let marker = "…";
    if width <= 1 {
        return marker.to_string();
    }
    let base = truncate_display(text, width.saturating_sub(1));
    format!("{base}{marker}")
}

fn line_text(line: &Line<'_>) -> String {
    let raw = line
        .spans
        .iter()
        .map(|span| span.content.as_ref())
        .collect::<String>();
    strip_osc8(&raw)
}

fn strip_osc8(raw: &str) -> String {
    let mut out = String::new();
    let mut rest = raw;
    let close = "\x1b]8;;\x1b\\";
    while let Some(prefix_pos) = rest.find("\x1b]8;;") {
        out.push_str(&rest[..prefix_pos]);
        rest = &rest[prefix_pos + "\x1b]8;;".len()..];
        let Some(url_end) = rest.find("\x1b\\") else {
            out.push_str(rest);
            return out;
        };
        rest = &rest[url_end + "\x1b\\".len()..];
        let Some(text_end) = rest.find(close) else {
            out.push_str(rest);
            return out;
        };
        out.push_str(&rest[..text_end]);
        rest = &rest[text_end + close.len()..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn first_text(name: &str, args: Value) -> String {
        line_text(&render_tool_call(name, &args, ToolStatus::Running, 80)[0])
    }

    fn rendered_texts(name: &str, args: Value) -> Vec<String> {
        let lines = render_tool_call(name, &args, ToolStatus::Running, 120);
        assert_eq!(tool_call_line_count(name, &args, 120), lines.len());
        assert_eq!(2, lines.len(), "expected header + one detail line");
        lines.iter().map(line_text).collect()
    }

    #[test]
    fn read_branch_renders_file_prefix() {
        let text = first_text("Read", json!({"file_path": "src/lib.rs"}));
        assert!(text.starts_with("  ◑ 📖 src/lib.rs"), "got {text:?}");
    }

    #[test]
    fn bash_branch_renders_command_prefix() {
        let text = first_text("Bash", json!({"command": "cargo   test"}));
        assert!(text.starts_with("  ◑ $ cargo test"), "got {text:?}");
    }

    #[test]
    fn edit_branch_renders_file_prefix() {
        let text = first_text("Edit", json!({"file_path": "src/main.rs"}));
        assert!(text.starts_with("  ◑ ✎ src/main.rs"), "got {text:?}");
    }

    #[test]
    fn write_branch_renders_file_prefix() {
        let text = first_text("Write", json!({"file_path": "out.txt", "content": "hello"}));
        assert!(text.starts_with("  ◑ ✍ out.txt"), "got {text:?}");
    }

    #[test]
    fn apply_patch_branch_renders_file_prefix() {
        let text = first_text("ApplyPatch", json!({"file_path": "src/lib.rs"}));
        assert!(
            text.starts_with("  ◑ ⚡ apply-patch src/lib.rs"),
            "got {text:?}"
        );
    }

    #[test]
    fn update_todo_list_branch_counts_items() {
        let text = first_text(
            "UpdateTodoList",
            json!({"items": [{"text": "a"}, {"text": "b"}]}),
        );
        assert!(text.starts_with("  ◑ 📋 2 items"), "got {text:?}");
    }

    #[test]
    fn grep_branch_renders_pattern_and_path() {
        let text = first_text("Grep", json!({"pattern": "TODO", "path": "src"}));
        assert!(text.starts_with("  ◑ 🔍 TODO in src"), "got {text:?}");
    }

    #[test]
    fn glob_branch_renders_pattern() {
        let text = first_text("Glob", json!({"pattern": "**/*.rs"}));
        assert!(text.starts_with("  ◑ 📂 **/*.rs"), "got {text:?}");
    }

    #[test]
    fn ast_grep_branch_renders_pattern_paths_lang_and_detail() {
        let lines = rendered_texts(
            "ast_grep",
            json!({"pattern": "console.log($X)", "paths": ["src", "tests"], "lang": "ts", "strictness": "relaxed"}),
        );
        assert!(
            lines[0].starts_with("  ◑ 🔍 console.log($X) in src, tests [ts]"),
            "got {:?}",
            lines[0]
        );
        assert!(lines[1].contains("strictness=\"relaxed\""), "got {lines:?}");
    }

    #[test]
    fn ast_grep_aliases_match() {
        let dashed = first_text("ast-grep", json!({"pattern": "foo", "path": "src"}));
        let short = first_text("sg", json!({"pattern": "bar", "language": "rust"}));
        assert!(dashed.starts_with("  ◑ 🔍 foo in src"), "got {dashed:?}");
        assert!(short.starts_with("  ◑ 🔍 bar [rust]"), "got {short:?}");
    }

    #[test]
    fn compress_branch_renders_target_paths_and_detail() {
        let lines = rendered_texts(
            "compress",
            json!({"paths": ["src/main.ts", "src/ui.ts"], "budget": 4096}),
        );
        assert!(
            lines[0].starts_with("  ◑ 📦 src/main.ts, src/ui.ts"),
            "got {:?}",
            lines[0]
        );
        assert!(lines[1].contains("budget=4096"), "got {lines:?}");
    }

    #[test]
    fn question_branch_renders_question_choice_count_and_detail() {
        let lines = rendered_texts(
            "question",
            json!({"question": "Pick a mode", "choices": ["fast", "safe", "custom"], "required": true}),
        );
        assert!(
            lines[0].starts_with("  ◑ ❓ Pick a mode (3 choices)"),
            "got {:?}",
            lines[0]
        );
        assert!(lines[1].contains("required=true"), "got {lines:?}");
    }

    #[test]
    fn repo_branch_renders_action_target_symbol_and_detail() {
        let lines = rendered_texts(
            "repo_search",
            json!({"target": "src", "symbol": "ToolDisplay", "limit": 5}),
        );
        assert!(
            lines[0].starts_with("  ◑ 🏛️ search src · ToolDisplay"),
            "got {:?}",
            lines[0]
        );
        assert!(lines[1].contains("limit=5"), "got {lines:?}");
    }

    #[test]
    fn repo_dash_alias_renders_architecture_path() {
        let lines = rendered_texts(
            "repo-architecture",
            json!({"path": "apps/tui-rust", "depth": 2}),
        );
        assert!(
            lines[0].starts_with("  ◑ 🏛️ architecture apps/tui-rust"),
            "got {:?}",
            lines[0]
        );
        assert!(lines[1].contains("depth=2"), "got {lines:?}");
    }

    #[test]
    fn skill_branch_renders_skill_name_and_detail() {
        let lines = rendered_texts(
            "skill",
            json!({"path": "/tmp/skills/rust/SKILL.md", "mode": "read"}),
        );
        assert!(lines[0].starts_with("  ◑ 🎯 rust"), "got {:?}", lines[0]);
        assert!(lines[1].contains("mode=\"read\""), "got {lines:?}");
    }

    #[test]
    fn subagents_branch_renders_action_task_count_and_detail() {
        let lines = rendered_texts(
            "subagents",
            json!({"action": "start", "tasks": [{"prompt": "a"}, {"prompt": "b"}], "concurrency": 2}),
        );
        assert!(
            lines[0].starts_with("  ◑ 👥 start · 2 tasks"),
            "got {:?}",
            lines[0]
        );
        assert!(lines[1].contains("concurrency=2"), "got {lines:?}");
    }

    #[test]
    fn web_search_branch_renders_query_and_detail() {
        let lines = rendered_texts(
            "web_search",
            json!({"query": "rust ratatui widgets", "max_results": 3}),
        );
        assert!(
            lines[0].starts_with("  ◑ 🌐 rust ratatui widgets"),
            "got {:?}",
            lines[0]
        );
        assert!(lines[1].contains("max_results=3"), "got {lines:?}");
    }

    #[test]
    fn web_fetch_branch_renders_url_and_detail() {
        let lines = rendered_texts(
            "web_fetch",
            json!({"url": "https://example.com/docs", "timeout": 30}),
        );
        assert!(
            lines[0].starts_with("  ◑ 🌐 https://example.com/docs"),
            "got {:?}",
            lines[0]
        );
        assert!(lines[1].contains("timeout=30"), "got {lines:?}");
    }

    #[test]
    fn default_fallback_renders_name_and_args() {
        let lines = render_tool_call("UnknownTool", &json!({"x": 1}), ToolStatus::Running, 80);
        assert!(line_text(&lines[0]).contains("UnknownTool"));
        assert!(line_text(&lines[1]).contains("\"x\":1"));
    }

    #[test]
    fn status_icon_switches() {
        let args = json!({"file_path": "a"});
        let statuses = [
            (ToolStatus::Pending, "○"),
            (ToolStatus::Running, "◑"),
            (ToolStatus::Completed, "●"),
            (ToolStatus::Failed, "✖"),
        ];
        for (status, icon) in statuses {
            let text = line_text(&render_tool_call("Read", &args, status, 80)[0]);
            assert!(text.starts_with(&format!("  {icon} ")), "got {text:?}");
        }
    }

    #[test]
    fn tool_result_renders_ok_and_failed() {
        let ok = line_text(&render_tool_result("call-1", "read 3 lines", true, 80)[0]);
        let failed = line_text(&render_tool_result("call-1", "permission denied", false, 80)[0]);
        assert!(ok.starts_with("    ↳ ✓ read 3 lines"), "got {ok:?}");
        assert!(
            failed.starts_with("    ↳ ✖ permission denied"),
            "got {failed:?}"
        );
    }

    #[test]
    fn line_count_matches_render_length() {
        let args = json!({"command": "echo hello", "cwd": "/tmp"});
        assert_eq!(
            tool_call_line_count("Bash", &args, 80),
            render_tool_call("Bash", &args, ToolStatus::Completed, 80).len()
        );

        let wrapped =
            json!({"x": "a very long value that should wrap when the terminal width is narrow"});
        assert_eq!(
            tool_call_line_count("Unknown", &wrapped, 24),
            render_tool_call("Unknown", &wrapped, ToolStatus::Failed, 24).len()
        );
    }
}
