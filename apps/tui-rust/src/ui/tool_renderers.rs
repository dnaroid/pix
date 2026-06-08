//! Specialized renderers for tool call/result blocks.
//!
//! The viewport owns the outer conversation layout, while this module keeps
//! per-tool summaries concise and consistent with the TypeScript pix UI.

use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use serde_json::Value;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::config::{PixConfig, ToolRendererConfig, ToolRendererRule};
use crate::ui::app::ToolStatus;
use crate::ui::links::{extract_file_paths, LinkSpan};
use crate::ui::theme::{Theme, ThemeRole};

use super::{markdown, wrap};

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
    Line::from(Span::styled(
        path.to_string(),
        theme.style_for(ThemeRole::Link),
    ))
}

pub fn render_tool_call_with_theme(
    name: &str,
    args: &Value,
    status: crate::ui::app::ToolStatus,
    width: usize,
    theme: &Theme,
) -> Vec<Line<'static>> {
    render_tool_entry_with_theme(name, args, status, None, None, width, theme)
}

pub fn render_tool_call_with_config(
    name: &str,
    args: &Value,
    status: crate::ui::app::ToolStatus,
    width: usize,
    theme: &Theme,
    config: &PixConfig,
) -> Vec<Line<'static>> {
    render_tool_entry_with_config(name, args, status, None, None, width, theme, config)
}

/// Render a full pix-style tool block: header/args plus the captured result
/// preview once the tool finishes. This mirrors TS pix's `renderToolBlock`
/// behavior closely enough for the Rust TUI: tool output stays attached to the
/// call, previews obey the same default head/tail line counts, and truncated
/// previews are marked with `▶`.
pub fn render_tool_entry_with_theme(
    name: &str,
    args: &Value,
    status: crate::ui::app::ToolStatus,
    result_summary: Option<&str>,
    result_ok: Option<bool>,
    width: usize,
    theme: &Theme,
) -> Vec<Line<'static>> {
    render_tool_entry_with_config(
        name,
        args,
        status,
        result_summary,
        result_ok,
        width,
        theme,
        &PixConfig::default(),
    )
}

pub fn render_tool_entry_with_config(
    name: &str,
    args: &Value,
    status: crate::ui::app::ToolStatus,
    result_summary: Option<&str>,
    result_ok: Option<bool>,
    width: usize,
    theme: &Theme,
    config: &PixConfig,
) -> Vec<Line<'static>> {
    render_tool_entry_with_config_and_expansion(
        name,
        args,
        status,
        result_summary,
        result_ok,
        false,
        width,
        theme,
        config,
    )
}

pub fn render_tool_entry_with_config_and_expansion(
    name: &str,
    args: &Value,
    status: crate::ui::app::ToolStatus,
    result_summary: Option<&str>,
    result_ok: Option<bool>,
    expanded: bool,
    width: usize,
    theme: &Theme,
    config: &PixConfig,
) -> Vec<Line<'static>> {
    let width = width.max(1);
    let rule = resolve_tool_rule(name, &config.tool_renderer);
    if rule.hidden.unwrap_or(false) {
        return Vec::new();
    }
    if crate::ui::todo_view::is_todo_tool_name(name)
        && crate::ui::todo_view::should_render_inline_task_list(args)
        && result_ok.unwrap_or(true)
    {
        let mut lines = crate::ui::todo_view::render_todo_tool_call_with_theme(
            name, args, status, width, theme,
        );
        if !expanded {
            lines.truncate(1);
        }
        return lines;
    }
    let icons = AppIcons::from_config(config);
    let (status_icon, status_color) =
        status_icon_and_color(name, status, result_summary, result_ok, theme, icons);
    let title_color = rule
        .color
        .as_deref()
        .map(|color_ref| theme.resolve_color_ref(color_ref))
        .unwrap_or(theme.status_dim);
    let display = tool_display(name, args);
    let title = tool_header_title(name, &display.title);
    let mut out = Vec::with_capacity(1 + MAX_DETAIL_LINES);

    out.push(header_line(
        status_icon,
        status_color,
        title_color,
        &title,
        width,
        theme,
    ));
    if let Some(details) = display.details.filter(|text| !text.trim().is_empty()) {
        out.extend(detail_lines(&details, width, MAX_DETAIL_LINES, theme));
    }
    if let Some(summary) = result_summary.filter(|text| !text.trim().is_empty()) {
        if expanded {
            out.extend(result_body_lines(
                summary,
                result_ok.unwrap_or(true),
                width,
                theme,
            ));
        } else {
            out.extend(result_preview_lines(
                name,
                summary,
                result_ok.unwrap_or(true),
                width,
                theme,
                &rule,
            ));
        }
    }
    out
}

/// Cheap visual-line count for `render_tool_entry_with_config_and_expansion`.
///
/// The viewport calls this for every block while rebuilding its prefix-sum
/// layout. Keep it allocation-light: do not construct `ratatui::Line`s or scan
/// full collapsed previews just to discover they cap at `previewLines`.
pub fn tool_entry_line_count_with_config_and_expansion(
    name: &str,
    args: &Value,
    _status: crate::ui::app::ToolStatus,
    result_summary: Option<&str>,
    _result_ok: Option<bool>,
    expanded: bool,
    width: usize,
    config: &PixConfig,
) -> usize {
    let width = width.max(1);
    let rule = resolve_tool_rule(name, &config.tool_renderer);
    if rule.hidden.unwrap_or(false) {
        return 0;
    }
    if crate::ui::todo_view::is_todo_tool_name(name)
        && crate::ui::todo_view::should_render_inline_task_list(args)
        && _result_ok.unwrap_or(true)
    {
        if !expanded {
            return 1;
        }
        let tasks = args
            .get(crate::ui::todo_view::WIDGET_KEY)
            .and_then(|widget| widget.get("tasks"))
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        return 1 + tasks.max(1);
    }

    let display = tool_display(name, args);
    let mut count = 1; // header
    if let Some(details) = display.details.filter(|text| !text.trim().is_empty()) {
        count += detail_line_count(&details, width, MAX_DETAIL_LINES);
    }
    if let Some(summary) = result_summary.filter(|text| !text.trim().is_empty()) {
        count += if expanded {
            result_body_line_count(summary, width)
        } else {
            result_preview_line_count(summary, width, &rule)
        };
    }
    count
}

pub(crate) fn tool_default_expanded(name: &str, config: &PixConfig) -> bool {
    resolve_tool_rule(name, &config.tool_renderer)
        .default_expanded
        .unwrap_or(false)
}

/// Render a reasoning/thinking entry with the same header treatment as normal
/// tool calls. Collapsed entries stay on one line; expanded entries render the
/// markdown body below the header so click-to-expand matches pix.
pub fn render_thinking_entry_with_config(
    text: &str,
    done: bool,
    expanded: bool,
    width: usize,
    theme: &Theme,
    config: &PixConfig,
) -> Vec<Line<'static>> {
    let icons = AppIcons::from_config(config);
    let (icon, icon_color) = if done {
        (icons.check_circle, theme.tool_completed)
    } else {
        (icons.timer_sand, theme.status_dim)
    };
    let mut lines = vec![header_line(
        icon,
        icon_color,
        theme.resolve_color_ref("accent"),
        "thinking",
        width.max(1),
        theme,
    )];
    if expanded {
        lines.extend(render_thinking_body_lines(text, width, theme));
    }
    lines
}

pub fn thinking_entry_line_count(text: &str, width: usize, expanded: bool, config: &PixConfig) -> usize {
    render_thinking_entry_with_config(text, true, expanded, width, &Theme::default(), config).len()
}

fn render_thinking_body_lines(text: &str, width: usize, theme: &Theme) -> Vec<Line<'static>> {
    let body_width = width.saturating_sub(2).max(1);
    markdown::render_markdown_with_theme(text, body_width, theme)
        .into_iter()
        .flat_map(split_embedded_newlines)
        .map(indent_line)
        .collect()
}

fn indent_line(line: Line<'static>) -> Line<'static> {
    let mut spans = Vec::with_capacity(line.spans.len() + 1);
    spans.push(Span::raw("  "));
    spans.extend(line.spans);
    Line::from(spans)
}

fn split_embedded_newlines(line: Line<'static>) -> Vec<Line<'static>> {
    let mut out = Vec::new();
    let mut current = Vec::new();

    for span in line.spans {
        let style = span.style;
        let mut parts = span.content.split('\n').peekable();
        while let Some(part) = parts.next() {
            if !part.is_empty() {
                current.push(Span::styled(part.to_string(), style));
            }
            if parts.peek().is_some() {
                out.push(Line::from(std::mem::take(&mut current)));
            }
        }
    }

    out.push(Line::from(current));
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
    let title = format!("{}{}", path.unwrap_or(name), range);
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
        title: command,
        // TS pix keeps shell metadata out of the header area: the visible shell
        // header is exactly one row (`<icon> shell <command>`), and output lives
        // in the preview/expanded body.
        details: None,
    }
}

fn edit_display(name: &str, args: &Value) -> ToolDisplay {
    let path = get_str_any(args, &["file_path", "filePath", "path", "file"]);
    ToolDisplay {
        title: path.unwrap_or(name).to_string(),
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
        title: path.unwrap_or(name).to_string(),
        details,
    }
}

fn apply_patch_display(name: &str, args: &Value) -> ToolDisplay {
    let path = get_str_any(args, &["file_path", "filePath", "path", "file"])
        .map(str::to_string)
        .or_else(|| patch_path(args));
    let title = match path {
        Some(path) if !path.is_empty() => path,
        // TS renderApplyPatchTool uses `patch` as the header args when it
        // cannot extract a path, so the visible header is
        // `<icon> apply_patch patch` rather than just `<icon> apply_patch`.
        _ => "patch".to_string(),
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
        Some(path) if !path.is_empty() => format!("{pattern} in {path}"),
        _ => pattern.to_string(),
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
        title: pattern.to_string(),
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
    let mut title = pattern.to_string();
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
    let mut parts = Vec::new();
    if let Some(topic) = value_summary_any(args, &["topic"]) {
        parts.push(topic);
    }
    if let Some(target) = value_summary_any(args, &["paths", "path", "target", "targets", "files"]) {
        parts.push(target);
    }
    let target = if parts.is_empty() {
        name.to_string()
    } else {
        parts.join(" · ")
    };
    ToolDisplay {
        title: target,
        details: None,
    }
}

fn question_display(name: &str, args: &Value) -> ToolDisplay {
    let title = question_header(args).unwrap_or_else(|| {
        let question = get_str_any(args, &["question", "prompt", "label", "text", "title"])
            .map(str::to_string)
            .unwrap_or_else(|| name.to_string());
        match choice_count(args) {
            Some(count) => format!("{question} ({count} {})", plural(count, "choice")),
            None => question,
        }
    });
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

fn question_header(args: &Value) -> Option<String> {
    let questions = args.get("questions")?.as_array()?;
    let labels = questions
        .iter()
        .filter_map(|question| get_str_any(question, &["label", "id"]))
        .take(4)
        .collect::<Vec<_>>();
    let count = questions.len();
    let count_text = format!("{count} {}", plural(count, "question"));
    if labels.is_empty() {
        return Some(count_text);
    }
    let shown = labels
        .iter()
        .take(3)
        .copied()
        .collect::<Vec<_>>()
        .join(", ");
    let suffix = if labels.len() > 3 { ", …" } else { "" };
    Some(format!("{count_text} · {shown}{suffix}"))
}

fn repo_display(name: &str, args: &Value) -> ToolDisplay {
    let action = repo_action(name);
    let target = repo_target(args);
    let title = match target {
        Some(target) if !target.is_empty() => format!("{action} {target}"),
        _ => action.to_string(),
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
        title: skill,
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
        title: query.to_string(),
        details: compact_fields(args, &["query", "q", "search"]),
    }
}

fn web_fetch_display(name: &str, args: &Value) -> ToolDisplay {
    let url = get_str_any(args, &["url", "uri", "href"]).unwrap_or(name);
    ToolDisplay {
        title: url.to_string(),
        details: compact_fields(args, &["url", "uri", "href"]),
    }
}

fn default_display(name: &str, args: &Value) -> ToolDisplay {
    ToolDisplay {
        // Match TS defaultToolRender: the generic block keeps the raw tool name
        // as the label and renders parsed arguments as inline header args.
        title: format_args_inline(args).unwrap_or_else(|| name.to_string()),
        details: None,
    }
}

fn tool_header_title(name: &str, title: &str) -> String {
    let title = title.trim();
    if title.is_empty() {
        return name.to_string();
    }
    let normalized_title = normalized_tool_name(title);
    let normalized_name = normalized_tool_name(name);
    if normalized_title == normalized_name || normalized_title.starts_with(&normalized_name) {
        title.to_string()
    } else {
        format!("{name} {title}")
    }
}

fn header_line(
    icon: &str,
    icon_color: Color,
    title_color: Color,
    title: &str,
    width: usize,
    theme: &Theme,
) -> Line<'static> {
    let prefix = format!("{icon} ");
    let prefix_width = UnicodeWidthStr::width(prefix.as_str());
    if width <= prefix_width {
        return Line::from(Span::styled(
            truncate_display(&prefix, width),
            Style::default().fg(icon_color),
        ));
    }

    let title = truncate_display(&sanitize_inline(title), width - prefix_width);
    let mut spans = vec![Span::styled(prefix, Style::default().fg(icon_color))];
    let (label, args) = split_header_label_args(&title);
    spans.extend(spans_with_links(
        label,
        Style::default().fg(title_color),
        theme.style_for(ThemeRole::Link),
    ));
    if let Some(args) = args {
        spans.push(Span::raw(" ".to_string()));
        spans.extend(spans_with_links(
            args,
            theme.style_for(ThemeRole::StatusDim),
            theme.style_for(ThemeRole::Link),
        ));
    }
    Line::from(spans)
}

fn split_header_label_args(title: &str) -> (&str, Option<&str>) {
    let trimmed = title.trim();
    match trimmed.find(char::is_whitespace) {
        Some(idx) => {
            let (label, rest) = trimmed.split_at(idx);
            let args = rest.trim_start();
            if args.is_empty() {
                (label, None)
            } else {
                (label, Some(args))
            }
        }
        None => (trimmed, None),
    }
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

fn detail_line_count(text: &str, width: usize, max_lines: usize) -> usize {
    let prefix = "    ";
    let body_width = width.saturating_sub(UnicodeWidthStr::width(prefix)).max(1);
    wrap::line_count(&sanitize_inline(text), body_width).min(max_lines)
}

fn result_preview_lines(
    _name: &str,
    text: &str,
    ok: bool,
    width: usize,
    theme: &Theme,
    rule: &ToolRendererRule,
) -> Vec<Line<'static>> {
    let preview_lines = rule.preview_lines.unwrap_or(0) as usize;
    if rule.hidden.unwrap_or(false) || preview_lines == 0 {
        return Vec::new();
    }

    let body_width = width.saturating_sub(2).max(1);
    let color = if ok {
        theme.style_for(ThemeRole::StatusDim)
    } else {
        theme.style_for(ThemeRole::DiagError)
    };
    let body_lines: Vec<String> = sanitize_tool_body(text)
        .split('\n')
        .flat_map(|line| wrap::wrap_text(line, body_width))
        .map(|line| format!("  {line}"))
        .collect();
    if body_lines.is_empty() {
        return Vec::new();
    }

    let tail = matches!(rule.direction, Some(crate::config::PreviewDirection::Tail));
    let total = body_lines.len();
    let mut selected: Vec<String> = if tail && total > preview_lines {
        body_lines[total - preview_lines..].to_vec()
    } else {
        body_lines.into_iter().take(preview_lines).collect()
    };
    if total > preview_lines && !selected.is_empty() {
        let marker_idx = if tail { 0 } else { selected.len() - 1 };
        selected[marker_idx] = mark_truncated_preview_line(&selected[marker_idx]);
    }

    selected
        .into_iter()
        .map(|line| {
            let spans = result_preview_spans(&line, color, theme);
            Line::from(spans)
        })
        .collect()
}

fn result_preview_line_count(text: &str, width: usize, rule: &ToolRendererRule) -> usize {
    let preview_lines = rule.preview_lines.unwrap_or(0) as usize;
    if rule.hidden.unwrap_or(false) || preview_lines == 0 {
        return 0;
    }

    let body_width = width.saturating_sub(2).max(1);
    // Rendering later selects at most `previewLines` wrapped body rows (head or
    // tail). For layout height we only need the capped count, so stop as soon
    // as the cap is reached instead of wrapping/scanning huge tool outputs.
    let mut count = 0usize;
    for line in sanitize_tool_body(text).split('\n') {
        count += wrap::line_count(line, body_width);
        if count >= preview_lines {
            return preview_lines;
        }
    }
    count.min(preview_lines)
}

fn result_body_lines(text: &str, ok: bool, width: usize, theme: &Theme) -> Vec<Line<'static>> {
    let body_width = width.saturating_sub(2).max(1);
    let color = if ok {
        theme.style_for(ThemeRole::StatusDim)
    } else {
        theme.style_for(ThemeRole::DiagError)
    };
    sanitize_tool_body(text)
        .split('\n')
        .flat_map(|line| wrap::wrap_text(line, body_width))
        .map(|line| Line::from(result_preview_spans(&format!("  {line}"), color, theme)))
        .collect()
}

fn result_body_line_count(text: &str, width: usize) -> usize {
    let body_width = width.saturating_sub(2).max(1);
    wrap::line_count(&sanitize_tool_body(text), body_width)
}

fn mark_truncated_preview_line(line: &str) -> String {
    if let Some(rest) = line.strip_prefix("  ") {
        format!("▶ {rest}")
    } else {
        format!("▶ {line}")
    }
}

fn result_preview_spans(line: &str, color: Style, theme: &Theme) -> Vec<Span<'static>> {
    let link_style = theme.style_for(ThemeRole::Link);
    let Some(rest) = line.strip_prefix('▶') else {
        return spans_with_links(line, color, link_style);
    };

    let mut spans = vec![Span::styled(
        "▶".to_string(),
        theme.style_for(ThemeRole::StatusDim),
    )];
    spans.extend(spans_with_links(rest, color, link_style));
    spans
}

fn spans_with_links(text: &str, base_style: Style, link_style: Style) -> Vec<Span<'static>> {
    let link_spans = extract_file_paths(text, None);
    if link_spans.is_empty() {
        return vec![Span::styled(text.to_string(), base_style)];
    }

    let mut out = Vec::new();
    let mut cursor = 0usize;
    for LinkSpan {
        url: _,
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
        out.push(Span::styled(link_text, link_style));
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

#[derive(Debug, Clone, Copy)]
struct AppIcons {
    alert: &'static str,
    circle_outline: &'static str,
    close_circle: &'static str,
    check_circle: &'static str,
    timer_sand: &'static str,
}

impl AppIcons {
    fn from_config(config: &PixConfig) -> Self {
        let normalized = config
            .icon_theme
            .name
            .trim()
            .to_ascii_lowercase()
            .replace([' ', '_', '-'], "");
        if matches!(normalized.as_str(), "fallback" | "plain" | "ascii") {
            Self::fallback()
        } else {
            Self::nerd_font()
        }
    }

    fn nerd_font() -> Self {
        Self {
            alert: "\u{f0026}",
            circle_outline: "\u{f0766}",
            close_circle: "\u{f0159}",
            check_circle: "\u{f05e0}",
            timer_sand: "\u{f051f}",
        }
    }

    fn fallback() -> Self {
        Self {
            alert: "!",
            circle_outline: "○",
            close_circle: "×",
            check_circle: "✓",
            timer_sand: "⏳",
        }
    }
}

fn status_icon_and_color(
    name: &str,
    status: ToolStatus,
    result_summary: Option<&str>,
    result_ok: Option<bool>,
    theme: &Theme,
    icons: AppIcons,
) -> (&'static str, Color) {
    match status {
        ToolStatus::Pending => (icons.circle_outline, theme.status_dim),
        ToolStatus::Running => (icons.timer_sand, theme.status_dim),
        ToolStatus::Completed => {
            if result_ok == Some(false) {
                return (icons.close_circle, theme.tool_failed);
            }
            if let Some(severity) = lsp_diagnostic_severity_after_mutation(name, result_summary) {
                return (
                    icons.alert,
                    if severity == DiagnosticSeverity::Error {
                        theme.tool_failed
                    } else {
                        theme.diag_warn
                    },
                );
            }
            (icons.check_circle, theme.tool_completed)
        }
        ToolStatus::Failed => (icons.close_circle, theme.tool_failed),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DiagnosticSeverity {
    Warning,
    Error,
}

fn lsp_diagnostic_severity_after_mutation(
    name: &str,
    output: Option<&str>,
) -> Option<DiagnosticSeverity> {
    if !is_mutation_tool(name) {
        return None;
    }
    let output = output?;
    if !output.to_ascii_lowercase().contains("lsp diagnostics") {
        return None;
    }
    if output.to_ascii_lowercase().contains("error") {
        Some(DiagnosticSeverity::Error)
    } else if output.to_ascii_lowercase().contains("warning") {
        Some(DiagnosticSeverity::Warning)
    } else {
        None
    }
}

fn is_mutation_tool(name: &str) -> bool {
    matches!(
        normalized_tool_name(name).as_str(),
        "applypatch" | "apply_patch" | "edit" | "write" | "ast_apply" | "astapply"
    )
}

fn resolve_tool_rule<'a>(name: &str, config: &'a ToolRendererConfig) -> ToolRendererRule {
    if let Some(rule) = config.tools.get(name) {
        return merged_tool_rule(rule, &config.default);
    }

    let normalized = normalized_tool_name(name);
    if let Some(rule) = config
        .tools
        .iter()
        .find_map(|(key, rule)| tool_rule_key_matches(key, &normalized).then_some(rule))
    {
        return merged_tool_rule(rule, &config.default);
    }

    config.default.clone()
}

fn tool_rule_key_matches(key: &str, normalized_name: &str) -> bool {
    let normalized_key = normalized_tool_name(key.trim_end_matches('*'));
    if key.ends_with('*') {
        normalized_name.starts_with(&normalized_key)
    } else {
        normalized_name == normalized_key
    }
}

fn merged_tool_rule(rule: &ToolRendererRule, default: &ToolRendererRule) -> ToolRendererRule {
    ToolRendererRule {
        preview_lines: rule.preview_lines.or(default.preview_lines),
        direction: rule.direction.or(default.direction),
        color: rule.color.clone().or_else(|| default.color.clone()),
        default_expanded: rule.default_expanded.or(default.default_expanded),
        compact_hidden: rule.compact_hidden.or(default.compact_hidden),
        hidden: rule.hidden.or(default.hidden),
    }
}

fn normalized_tool_name(name: &str) -> String {
    // TS `normalizeToolName` first drops namespace/path prefixes such as
    // `functions.read`, `mcp:tool`, or `/nested/tool`. The Rust renderer then
    // additionally removes separators for case-insensitive alias matching.
    let last_part = name
        .split(['.', ':', '/'])
        .filter(|part| !part.is_empty())
        .last()
        .unwrap_or(name)
        .trim();
    last_part
        .chars()
        .filter(|c| *c != '-' && *c != '_' && *c != ' ')
        .flat_map(char::to_lowercase)
        .collect()
}

fn format_args_inline(args: &Value) -> Option<String> {
    match args {
        Value::Null => None,
        Value::Object(obj) => {
            let parts = obj
                .iter()
                .filter_map(|(key, value)| {
                    format_inline_value(value).map(|value| format!("{key}: {value}"))
                })
                .collect::<Vec<_>>();
            (!parts.is_empty()).then(|| parts.join(" · "))
        }
        other => format_inline_value(other),
    }
}

fn format_inline_value(value: &Value) -> Option<String> {
    match value {
        Value::Null => Some("null".to_string()),
        Value::Bool(value) => Some(value.to_string()),
        Value::Number(value) => Some(value.to_string()),
        Value::String(value) => Some(value.replace('\n', " ").trim().to_string()),
        Value::Array(values) => {
            let mut parts = values
                .iter()
                .take(3)
                .filter_map(format_inline_value)
                .collect::<Vec<_>>();
            if values.len() > parts.len() {
                parts.push(format!("+{}", values.len() - parts.len()));
            }
            Some(format!("[{}]", parts.join(", ")))
        }
        Value::Object(obj) => {
            if obj.is_empty() {
                Some("{}".to_string())
            } else {
                Some(format!("{{{} keys}}", obj.len()))
            }
        }
    }
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
    strip_hidden_metadata_lines(text)
        .replace('\r', "")
        .replace('\n', " ")
        .replace('\x1b', "␛")
}

fn sanitize_tool_body(text: &str) -> String {
    strip_hidden_metadata_lines(text)
        .replace('\r', "")
        .replace('\x1b', "␛")
}

fn strip_hidden_metadata_lines(text: &str) -> String {
    let filtered: Vec<&str> = text
        .lines()
        .filter(|line| !is_hidden_metadata_line(line))
        .collect();
    crate::ui::wrap::collapse_blank_runs(&filtered.join("\n"))
}

fn is_hidden_metadata_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    let indent = line.len().saturating_sub(trimmed.len());
    if indent > 3 {
        return false;
    }
    is_markdown_reference_definition(trimmed) || is_streaming_dcp_metadata_prefix(trimmed)
}

fn is_markdown_reference_definition(line: &str) -> bool {
    let Some(rest) = line.strip_prefix('[') else {
        return false;
    };
    let Some(close) = rest.find("]:") else {
        return false;
    };
    let after = rest[close + 2..].trim_start_matches([' ', '\t']);
    !after.is_empty() && !after.chars().next().is_some_and(char::is_whitespace)
}

fn is_streaming_dcp_metadata_prefix(line: &str) -> bool {
    is_dcp_reference_prefix(line, "[dcp-id]: # (m")
        || is_dcp_reference_prefix(line, "[dcp-block-id]: # (b")
}

fn is_dcp_reference_prefix(line: &str, marker_prefix: &str) -> bool {
    marker_prefix.starts_with(line)
        || line
            .strip_prefix(marker_prefix)
            .is_some_and(|suffix| suffix.chars().all(|ch| ch.is_ascii_digit()))
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
    use ratatui::style::Modifier;
    use serde_json::json;

    fn first_text(name: &str, args: Value) -> String {
        line_text(&render_tool_call(name, &args, ToolStatus::Running, 80)[0])
    }

    fn nerd_running_prefix() -> String {
        format!("{} ", AppIcons::nerd_font().timer_sand)
    }

    fn nerd_completed_prefix() -> String {
        format!("{} ", AppIcons::nerd_font().check_circle)
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
        assert!(
            text.starts_with(&format!("{}Read src/lib.rs", nerd_running_prefix())),
            "got {text:?}"
        );
    }

    #[test]
    fn namespaced_read_matches_pix_normalized_tool_name() {
        let text = first_text(
            "functions.read",
            json!({"path": "src/lib.rs", "offset": 2, "limit": 5}),
        );
        assert!(
            text.starts_with(&format!(
                "{}functions.read src/lib.rs:2+5",
                nerd_running_prefix()
            )),
            "got {text:?}"
        );
    }

    #[test]
    fn bash_branch_renders_command_prefix() {
        let text = first_text("Bash", json!({"command": "cargo   test"}));
        assert!(
            text.starts_with(&format!("{}Bash cargo test", nerd_running_prefix())),
            "got {text:?}"
        );
    }

    #[test]
    fn shell_header_styles_label_color_and_args_muted_on_one_line() {
        let theme = Theme::default();
        let lines = render_tool_call_with_config(
            "shell",
            &json!({"command": "npm   run check", "cwd": "/repo"}),
            ToolStatus::Completed,
            80,
            &theme,
            &PixConfig::default(),
        );
        assert_eq!(
            lines.len(),
            1,
            "shell header should not emit args detail rows"
        );
        assert_eq!(
            line_text(&lines[0]),
            format!("{}shell npm run check", nerd_completed_prefix())
        );
        assert_eq!(
            lines[0].spans[1].style.fg,
            Some(theme.resolve_color_ref("warning"))
        );
        assert_eq!(lines[0].spans[3].style.fg, Some(theme.status_dim));
        assert!(!lines[0].spans[0]
            .style
            .add_modifier
            .contains(Modifier::BOLD));
        assert!(!lines[0].spans[1]
            .style
            .add_modifier
            .contains(Modifier::BOLD));
    }

    #[test]
    fn edit_branch_renders_file_prefix() {
        let text = first_text("Edit", json!({"file_path": "src/main.rs"}));
        assert!(
            text.starts_with(&format!("{}Edit src/main.rs", nerd_running_prefix())),
            "got {text:?}"
        );
    }

    #[test]
    fn write_branch_renders_file_prefix() {
        let text = first_text("Write", json!({"file_path": "out.txt", "content": "hello"}));
        assert!(
            text.starts_with(&format!("{}Write out.txt", nerd_running_prefix())),
            "got {text:?}"
        );
    }

    #[test]
    fn apply_patch_branch_renders_file_prefix() {
        let text = first_text("ApplyPatch", json!({"file_path": "src/lib.rs"}));
        assert!(
            text.starts_with(&format!("{}ApplyPatch src/lib.rs", nerd_running_prefix())),
            "got {text:?}"
        );
    }

    #[test]
    fn update_todo_list_branch_counts_items() {
        let text = first_text(
            "UpdateTodoList",
            json!({"items": [{"text": "a"}, {"text": "b"}]}),
        );
        assert!(text.starts_with(&nerd_running_prefix()), "got {text:?}");
        assert!(text.contains("2 items"), "got {text:?}");
    }

    #[test]
    fn todo_tool_is_hidden_by_default_even_with_inline_widget_tasks() {
        let args = json!({
            "action": "list",
            "__pix_todo_widget": [{"id": 1, "subject": "hidden"}],
        });
        let lines = render_tool_entry_with_config_and_expansion(
            "todo",
            &args,
            ToolStatus::Completed,
            Some("listed"),
            Some(true),
            false,
            80,
            &Theme::default(),
            &PixConfig::default(),
        );

        assert!(lines.is_empty(), "todo should honor hidden config");
        assert_eq!(
            tool_entry_line_count_with_config_and_expansion(
                "todo",
                &args,
                ToolStatus::Completed,
                Some("listed"),
                Some(true),
                false,
                80,
                &PixConfig::default(),
            ),
            0
        );
    }

    #[test]
    fn grep_branch_renders_pattern_and_path() {
        let text = first_text("Grep", json!({"pattern": "TODO", "path": "src"}));
        assert!(
            text.starts_with(&format!("{}Grep TODO in src", nerd_running_prefix())),
            "got {text:?}"
        );
    }

    #[test]
    fn grep_uses_default_zero_preview_lines_like_pix_config() {
        let lines = render_tool_entry_with_theme(
            "grep",
            &json!({"pattern": "TODO", "path": "src"}),
            ToolStatus::Completed,
            Some("src/a.rs:1:TODO\nsrc/b.rs:2:TODO"),
            Some(true),
            80,
            &Theme::default(),
        );
        let texts: Vec<String> = lines.iter().map(line_text).collect();

        assert_eq!(
            texts.len(),
            1,
            "grep should not render a result preview by default"
        );
        assert!(texts[0].contains("grep TODO in src"), "got {texts:?}");
    }

    #[test]
    fn glob_branch_renders_pattern() {
        let text = first_text("Glob", json!({"pattern": "**/*.rs"}));
        assert!(
            text.starts_with(&format!("{}Glob **/*.rs", nerd_running_prefix())),
            "got {text:?}"
        );
    }

    #[test]
    fn ast_grep_branch_renders_pattern_paths_lang_and_detail() {
        let lines = rendered_texts(
            "ast_grep",
            json!({"pattern": "console.log($X)", "paths": ["src", "tests"], "lang": "ts", "strictness": "relaxed"}),
        );
        assert!(
            lines[0].starts_with(&format!(
                "{}ast_grep console.log($X) in src, tests [ts]",
                nerd_running_prefix()
            )),
            "got {:?}",
            lines[0]
        );
        assert!(lines[1].contains("strictness=\"relaxed\""), "got {lines:?}");
    }

    #[test]
    fn ast_grep_aliases_match() {
        let dashed = first_text("ast-grep", json!({"pattern": "foo", "path": "src"}));
        let short = first_text("sg", json!({"pattern": "bar", "language": "rust"}));
        assert!(
            dashed.starts_with(&format!("{}ast-grep foo in src", nerd_running_prefix())),
            "got {dashed:?}"
        );
        assert!(
            short.starts_with(&format!("{}sg bar [rust]", nerd_running_prefix())),
            "got {short:?}"
        );
    }

    #[test]
    fn compress_branch_renders_target_paths_and_detail() {
        let lines = render_tool_call(
            "compress",
            &json!({"paths": ["src/main.ts", "src/ui.ts"], "budget": 4096}),
            ToolStatus::Running,
            120,
        );
        let lines: Vec<String> = lines.iter().map(line_text).collect();
        assert!(
            lines[0].starts_with(&format!(
                "{}compress src/main.ts, src/ui.ts",
                nerd_running_prefix()
            )),
            "got {:?}",
            lines[0]
        );
        assert_eq!(lines.len(), 1, "got {lines:?}");
    }

    #[test]
    fn question_branch_renders_question_choice_count_and_detail() {
        let lines = rendered_texts(
            "question",
            json!({"question": "Pick a mode", "choices": ["fast", "safe", "custom"], "required": true}),
        );
        assert!(
            lines[0].starts_with(&format!(
                "{}question Pick a mode (3 choices)",
                nerd_running_prefix()
            )),
            "got {:?}",
            lines[0]
        );
        assert!(lines[1].contains("required=true"), "got {lines:?}");
    }

    #[test]
    fn question_array_header_matches_pix_count_and_labels() {
        let text = first_text(
            "question",
            json!({"questions": [
                {"id": "scope", "label": "Scope", "prompt": "What?"},
                {"id": "priority", "prompt": "Priority?"}
            ]}),
        );
        assert!(
            text.starts_with(&format!(
                "{}question 2 questions · Scope, priority",
                nerd_running_prefix()
            )),
            "got {text:?}"
        );
    }

    #[test]
    fn repo_branch_renders_action_target_symbol_and_detail() {
        let lines = rendered_texts(
            "repo_search",
            json!({"target": "src", "symbol": "ToolDisplay", "limit": 5}),
        );
        assert!(
            lines[0].starts_with(&format!(
                "{}repo_search search src · ToolDisplay",
                nerd_running_prefix()
            )),
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
            lines[0].starts_with(&format!(
                "{}repo-architecture architecture apps/tui-rust",
                nerd_running_prefix()
            )),
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
        assert!(
            lines[0].starts_with(&format!("{}skill rust", nerd_running_prefix())),
            "got {:?}",
            lines[0]
        );
        assert!(lines[1].contains("mode=\"read\""), "got {lines:?}");
    }

    #[test]
    fn subagents_branch_renders_action_task_count_and_detail() {
        let lines = rendered_texts(
            "subagents",
            json!({"action": "start", "tasks": [{"prompt": "a"}, {"prompt": "b"}], "concurrency": 2}),
        );
        assert!(
            lines[0].starts_with(&nerd_running_prefix()) && lines[0].contains("start · 2 tasks"),
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
            lines[0].starts_with(&format!(
                "{}web_search rust ratatui widgets",
                nerd_running_prefix()
            )),
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
            lines[0].starts_with(&format!(
                "{}web_fetch https://example.com/docs",
                nerd_running_prefix()
            )),
            "got {:?}",
            lines[0]
        );
        assert!(lines[1].contains("timeout=30"), "got {lines:?}");
    }

    #[test]
    fn default_fallback_renders_name_and_args() {
        let lines = render_tool_call("UnknownTool", &json!({"x": 1}), ToolStatus::Running, 80);
        assert_eq!(
            lines.len(),
            1,
            "TS defaultToolRender puts args in the header"
        );
        assert!(
            line_text(&lines[0]).contains("UnknownTool x: 1"),
            "got {:?}",
            line_text(&lines[0])
        );
    }

    #[test]
    fn apply_patch_without_path_uses_patch_header_arg() {
        let text = first_text("apply_patch", json!({}));
        assert!(
            text.starts_with(&format!("{}apply_patch patch", nerd_running_prefix())),
            "got {text:?}"
        );
    }

    #[test]
    fn status_icon_switches() {
        let args = json!({"file_path": "a"});
        let statuses = [
            (ToolStatus::Pending, AppIcons::nerd_font().circle_outline),
            (ToolStatus::Running, AppIcons::nerd_font().timer_sand),
            (ToolStatus::Completed, AppIcons::nerd_font().check_circle),
            (ToolStatus::Failed, AppIcons::nerd_font().close_circle),
        ];
        for (status, icon) in statuses {
            let text = line_text(&render_tool_call("Read", &args, status, 80)[0]);
            assert!(text.starts_with(&format!("{icon} ")), "got {text:?}");
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

    #[test]
    fn configured_tool_entry_line_count_matches_render_length() {
        let mut config = PixConfig::default();
        config.tool_renderer.default.preview_lines = Some(3);
        let args = json!({"command": "printf '%s\\n' one two three four", "cwd": "/tmp"});
        let summary = "one\ntwo\nthree\nfour\nfive\nsix";

        let collapsed = render_tool_entry_with_config_and_expansion(
            "bash",
            &args,
            ToolStatus::Completed,
            Some(summary),
            Some(true),
            false,
            32,
            &Theme::default(),
            &config,
        );
        assert_eq!(
            tool_entry_line_count_with_config_and_expansion(
                "bash",
                &args,
                ToolStatus::Completed,
                Some(summary),
                Some(true),
                false,
                32,
                &config,
            ),
            collapsed.len()
        );

        let expanded = render_tool_entry_with_config_and_expansion(
            "bash",
            &args,
            ToolStatus::Completed,
            Some(summary),
            Some(true),
            true,
            32,
            &Theme::default(),
            &config,
        );
        assert_eq!(
            tool_entry_line_count_with_config_and_expansion(
                "bash",
                &args,
                ToolStatus::Completed,
                Some(summary),
                Some(true),
                true,
                32,
                &config,
            ),
            expanded.len()
        );
    }

    #[test]
    fn tool_entry_renders_pix_style_result_preview() {
        let lines = render_tool_entry_with_theme(
            "bash",
            &json!({"command": "printf lines"}),
            ToolStatus::Completed,
            Some("one\ntwo\nthree\nfour\nfive\nsix\nseven"),
            Some(true),
            80,
            &Theme::default(),
        );
        let texts: Vec<String> = lines.iter().map(line_text).collect();

        assert!(
            texts[0].starts_with(&format!("{}bash printf lines", nerd_completed_prefix())),
            "got {texts:?}"
        );
        assert!(
            texts.iter().any(|line| line.starts_with("▶ two")),
            "got {texts:?}"
        );
        assert!(texts.iter().any(|line| line == "  seven"), "got {texts:?}");
        assert!(!texts.iter().any(|line| line == "  one"), "got {texts:?}");
    }

    #[test]
    fn fallback_icon_theme_matches_pix_fallback_status_icons() {
        let mut config = PixConfig::default();
        config.icon_theme.name = "fallback".to_string();
        let args = json!({"file_path": "a"});

        let statuses = [
            (ToolStatus::Pending, "○"),
            (ToolStatus::Running, "⏳"),
            (ToolStatus::Completed, "✓"),
            (ToolStatus::Failed, "×"),
        ];

        for (status, icon) in statuses {
            let line =
                render_tool_call_with_config("read", &args, status, 80, &Theme::default(), &config);
            let text = line_text(&line[0]);
            assert!(text.starts_with(&format!("{icon} ")), "got {text:?}");
        }
    }

    #[test]
    fn configured_tool_rule_color_styles_title_separately_from_status_icon() {
        let theme = Theme::default();
        let mut config = PixConfig::default();
        config.tool_renderer.tools.insert(
            "bash".to_string(),
            ToolRendererRule {
                color: Some("toolSearch".to_string()),
                ..ToolRendererRule::default()
            },
        );

        let line = render_tool_call_with_config(
            "bash",
            &json!({"command": "cargo test"}),
            ToolStatus::Completed,
            80,
            &theme,
            &config,
        )
        .remove(0);

        assert_eq!(line.spans[0].style.fg, Some(theme.tool_completed));
        assert!(!line.spans[0].style.add_modifier.contains(Modifier::BOLD));
        assert_eq!(
            line.spans[1].style.fg,
            Some(theme.resolve_color_ref("toolSearch"))
        );
        assert!(!line.spans[1].style.add_modifier.contains(Modifier::BOLD));
        assert_eq!(
            line_text(&line),
            format!("{}bash cargo test", nerd_completed_prefix())
        );
        assert_eq!(line.spans[3].style.fg, Some(theme.status_dim));
    }

    #[test]
    fn read_expanded_renders_tool_output_body() {
        let lines = render_tool_entry_with_config_and_expansion(
            "read",
            &json!({"path": "src/lib.rs"}),
            ToolStatus::Completed,
            Some("line one\nline two"),
            Some(true),
            true,
            80,
            &Theme::default(),
            &PixConfig::default(),
        );
        let texts: Vec<String> = lines.iter().map(line_text).collect();

        assert_eq!(
            texts[0],
            format!("{}read src/lib.rs", nerd_completed_prefix())
        );
        assert!(
            texts.iter().any(|line| line == "  line one"),
            "got {texts:?}"
        );
        assert!(
            texts.iter().any(|line| line == "  line two"),
            "got {texts:?}"
        );
    }

    #[test]
    fn mutation_lsp_diagnostics_use_alert_icon_and_severity_color() {
        let theme = Theme::default();
        let warning = render_tool_entry_with_config(
            "apply_patch",
            &json!({}),
            ToolStatus::Completed,
            Some("LSP diagnostics: 1 warning"),
            Some(true),
            80,
            &theme,
            &PixConfig::default(),
        );
        let error = render_tool_entry_with_config(
            "apply_patch",
            &json!({}),
            ToolStatus::Completed,
            Some("LSP diagnostics: 1 error"),
            Some(true),
            80,
            &theme,
            &PixConfig::default(),
        );

        assert!(line_text(&warning[0]).starts_with(&format!("{} ", AppIcons::nerd_font().alert)));
        assert_eq!(warning[0].spans[0].style.fg, Some(theme.diag_warn));
        assert!(line_text(&error[0]).starts_with(&format!("{} ", AppIcons::nerd_font().alert)));
        assert_eq!(error[0].spans[0].style.fg, Some(theme.tool_failed));
    }

    #[test]
    fn tool_header_has_no_outer_indent_and_truncated_preview_marker_matches_pix() {
        let lines = render_tool_entry_with_theme(
            "bash",
            &json!({"command": "cargo test"}),
            ToolStatus::Completed,
            Some("one\ntwo\nthree\nfour\nfive\nsix\nseven"),
            Some(false),
            80,
            &Theme::default(),
        );
        let texts: Vec<String> = lines.iter().map(line_text).collect();

        assert!(!texts[0].starts_with(' '), "got {texts:?}");
        assert!(texts[0].contains("bash cargo test"), "got {texts:?}");
        assert!(texts.iter().any(|line| line == "▶ two"), "got {texts:?}");
        assert!(texts.iter().any(|line| line == "  seven"), "got {texts:?}");
        assert!(
            !texts.iter().any(|line| line.starts_with("  ▶")),
            "got {texts:?}"
        );
    }

    #[test]
    fn tool_result_preview_hides_dcp_metadata_markers() {
        let lines = render_tool_entry_with_theme(
            "bash",
            &json!({"command": "echo ok"}),
            ToolStatus::Completed,
            Some("[dcp-id]: # (m154)\nreal output\n[dcp-block-id]: # (b3)"),
            Some(true),
            80,
            &Theme::default(),
        );
        let texts: Vec<String> = lines.iter().map(line_text).collect();

        assert!(
            texts.iter().any(|line| line == "  real output"),
            "got {texts:?}"
        );
        assert!(
            !texts.iter().any(|line| line.contains("dcp-id")),
            "got {texts:?}"
        );
        assert!(
            !texts.iter().any(|line| line.contains("dcp-block-id")),
            "got {texts:?}"
        );
    }

    #[test]
    fn tool_result_preview_collapses_blank_lines_left_by_hidden_metadata() {
        // A metadata marker sitting between real output lines must not leave
        // an extra blank row in the rendered preview.
        let lines = render_tool_entry_with_theme(
            "bash",
            &json!({"command": "echo ok"}),
            ToolStatus::Completed,
            Some("first\n[dcp-id]: # (m9)\nsecond\n[dcp-block-id]: # (b2)\nthird"),
            Some(true),
            80,
            &Theme::default(),
        );
        let texts: Vec<String> = lines.iter().map(line_text).collect();
        let body: Vec<&String> = texts.iter().filter(|line| line.starts_with("  ")).collect();

        assert_eq!(
            body.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
            vec!["  first", "  second", "  third"],
            "got {texts:?}"
        );
    }

    #[test]
    fn tool_result_preview_trims_trailing_blank_lines_so_gap_does_not_double() {
        // Tool output that ends with newlines must not produce a trailing
        // blank row that would visually stack on top of the inter-block
        // gap and create two consecutive blank rows.
        let lines = render_tool_entry_with_theme(
            "bash",
            &json!({"command": "echo ok"}),
            ToolStatus::Completed,
            Some("first\nsecond\n\n"),
            Some(true),
            80,
            &Theme::default(),
        );
        let texts: Vec<String> = lines.iter().map(line_text).collect();
        let body: Vec<&String> = texts.iter().filter(|line| line.starts_with("  ")).collect();

        assert_eq!(
            body.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
            vec!["  first", "  second"],
            "trailing blank rows should be trimmed; got {texts:?}"
        );
    }

    #[test]
    fn thinking_entry_uses_tool_header_layout() {
        let theme = Theme::default();
        let line = render_thinking_entry_with_config(
            "private notes",
            true,
            false,
            80,
            &theme,
            &PixConfig::default(),
        )
        .remove(0);
        let text = line_text(&line);

        assert!(text.starts_with(&nerd_completed_prefix()), "got {text:?}");
        assert_eq!(text, format!("{}thinking", nerd_completed_prefix()));
        assert!(!text.starts_with(' '), "got {text:?}");
        assert_eq!(
            line.spans[1].style.fg,
            Some(theme.resolve_color_ref("accent"))
        );
    }

    #[test]
    fn expanded_thinking_entry_renders_indented_body_lines() {
        let theme = Theme::default();
        let lines = render_thinking_entry_with_config(
            "step one\n\nstep two",
            true,
            true,
            80,
            &theme,
            &PixConfig::default(),
        );
        let texts: Vec<String> = lines.iter().map(line_text).collect();

        assert_eq!(texts[0], format!("{}thinking", nerd_completed_prefix()));
        assert!(texts[1].starts_with("  step one"), "got {texts:?}");
        assert!(texts.iter().any(|line| line.starts_with("  step two")), "got {texts:?}");
    }
}
