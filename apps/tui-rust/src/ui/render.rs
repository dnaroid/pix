//! ratatui rendering for the conversation UI.
//!
//! Layout (top to bottom):
//! - Session tabs (2 rows): tab buttons + bottom connector line.
//! - Conversation (fills remaining space minus input). Lines come from
//!   `Viewport::slice`, which uses the per-width layout cache so a resize
//!   does not tear down work for the previous width.
//! - Input box (multi-line aware). Height grows with the editor's
//!   rendered line count, capped at half the screen (and at least 3 rows).
//! - Status line (1 row): mirrors pix's bottom status text.
//!
//! The renderer takes an `&mut App` so it can:
//! - Pull `&app.blocks` for the viewport,
//! - Mutably drive `app.viewport`, `app.scroll`, and `app.input` (each
//!   renders only the visible window),
//! - Stash the resulting `line_count` / `body_height` on the app so the
//!   input handler can translate PageUp/PageDown without re-measuring.

use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block as RBlock, Borders, Clear, List, ListItem, Paragraph};
use ratatui::Frame;
use std::path::Path;

use super::app::App;
use super::autocomplete::render_suggestions;
use super::input_editor::RenderedInput;
use super::theme::ThemeRole;
use super::viewport::ViewportWidth;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

const COMPACT_PROGRESS_BAR_WIDTH: usize = 5;
const COMPACT_PROGRESS_BAR_EMPTY: char = ' ';
const COMPACT_PROGRESS_BAR_PARTIALS: [char; 7] = ['▏', '▎', '▍', '▌', '▋', '▊', '▉'];

/// Visual prefixes used by the input editor. The first row gets
/// `first_prefix`; subsequent rows of the same prompt get
/// `cont_prefix`. Kept centralised so render_input and the editor's
/// `render()` agree, and exposed for the mouse resolver so it can map
/// a click column back to a visual position with the same offset.
pub const INPUT_FIRST_PREFIX: &str = "";
pub const INPUT_CONT_PREFIX: &str = "";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct StatusTargets {
    pub model: Option<(usize, usize)>,
    pub thinking: Option<(usize, usize)>,
}

pub fn render(f: &mut Frame, app: &mut App) {
    app.refresh_theme_cache();
    let size = f.area();

    // Pre-render the input editor so we know how tall the input area
    // needs to be. The inner width is total - 2 borders.
    let inner_width = size.width.saturating_sub(2) as usize;
    let max_input_rows = ((size.height as usize) / 2).clamp(3, 10);
    let rendered_input = app.input.render(
        inner_width,
        max_input_rows,
        INPUT_FIRST_PREFIX,
        INPUT_CONT_PREFIX,
    );
    let input_content_rows = rendered_input.visual_lines.len().max(1).min(max_input_rows);
    let input_total_height = (input_content_rows + 2) as u16; // +2 borders

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(2),                  // session tabs
            Constraint::Min(3),                     // conversation
            Constraint::Length(input_total_height), // input
            Constraint::Length(1),                  // status
        ])
        .split(size);

    render_session_tabs(f, app, chunks[0]);
    render_conversation(f, app, chunks[1]);
    render_toasts(f, app, chunks[1]);
    render_input(f, app, chunks[2], rendered_input);
    render_status(f, app, chunks[3]);
    render_autocomplete_popup(f, app, size, chunks[2]);
    render_popup(f, app, size);
}

fn render_autocomplete_popup(f: &mut Frame, app: &App, screen: Rect, input_area: Rect) {
    if !app.autocomplete.is_active() || screen.width == 0 || screen.height == 0 {
        return;
    }

    let body_rows = app.autocomplete.suggestions.len().clamp(1, 8) as u16;
    let height = body_rows.saturating_add(2).min(screen.height);
    if height == 0 || input_area.y == 0 {
        return;
    }

    let width = input_area.width.max(40).min(screen.width);
    let max_x = screen.x + screen.width.saturating_sub(width);
    let x = input_area.x.min(max_x);
    let y = input_area.y.saturating_sub(height).max(screen.y);
    let rect = Rect::new(
        x,
        y,
        width,
        height.min(input_area.y.saturating_sub(screen.y)),
    );
    if rect.width == 0 || rect.height < 3 {
        return;
    }

    let block = RBlock::default()
        .borders(Borders::ALL)
        .border_style(app.theme_cache.style_for(ThemeRole::InputBorder))
        .title(Span::styled(
            " Suggestions ",
            app.theme_cache
                .style_for(ThemeRole::Heading2)
                .add_modifier(Modifier::BOLD),
        ));
    let inner = block.inner(rect);
    let inner_rows = inner.height.max(1) as usize;
    let max_rows = if app.autocomplete.suggestions.len() > inner_rows {
        inner_rows.saturating_sub(1).max(1)
    } else {
        inner_rows
    };
    let lines = render_suggestions(&app.autocomplete, max_rows, &app.theme_cache);

    f.render_widget(Clear, rect);
    f.render_widget(Paragraph::new(lines).block(block), rect);
}

fn render_popup(f: &mut Frame, app: &App, size: Rect) {
    if let Some(popup_kind) = app.current_popup_kind().cloned() {
        let rect = super::popup::compute_popup_rect(size, &popup_kind);
        super::popup::render_popup_frame(f, app, rect);
    }
}

fn render_status(f: &mut Frame, app: &App, area: Rect) {
    let line = Line::from(build_status_spans(app, area.width as usize));
    let para = Paragraph::new(line);
    f.render_widget(para, area);
}

fn render_session_tabs(f: &mut Frame, app: &App, area: Rect) {
    if area.width == 0 || area.height == 0 {
        return;
    }

    let layout = crate::ui::tabs_state::tabs_layout(
        &app.tabs,
        &app.theme_cache,
        area.width as usize,
        app.session_file.as_deref(),
        app.session_id.as_deref(),
        app.session_name.as_deref(),
        app.loading_runtime_key.as_deref(),
        app.pending_new_tab.then_some("new"),
    );
    let lines = if area.height > 1 {
        vec![layout.top, layout.bottom]
    } else {
        vec![layout.top]
    };
    let para = Paragraph::new(lines).style(Style::default().bg(app.theme_cache.status_bg));
    f.render_widget(para, area);
}

pub(crate) fn build_status_spans(app: &App, width: usize) -> Vec<Span<'static>> {
    let model = status_model_label(app);
    let cwd = Path::new(&app.cwd)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(app.cwd.as_str());
    let thinking = app
        .thinking_level
        .clone()
        .unwrap_or_else(|| "—".to_string());
    let token_pct = match (app.last_token_count, app.context_limit) {
        (Some(tokens), Some(limit)) if limit > 0 => {
            let pct = rounded_context_percent(tokens, limit);
            format!("{pct:>2}%")
        }
        _ => "?%".to_string(),
    };
    let context_percent = match (app.last_token_count, app.context_limit) {
        (Some(tokens), Some(limit)) if limit > 0 => Some(rounded_context_percent(tokens, limit)),
        _ => None,
    };
    let context_bar = context_percent.map(format_compact_progress_bar);
    let base_status = format!("{model} 💡 {thinking} {token_pct}");
    let include_context_bar = context_bar
        .as_ref()
        .is_some_and(|bar| status_display_width(&base_status, Some(bar), cwd) <= width);
    let dot = "●";
    let dot_color = if app.is_streaming {
        app.theme_cache.diag_warn
    } else {
        app.theme_cache.status_dim
    };
    let context_style = Style::default()
        .fg(context_percent.map_or(app.theme_cache.status_dim, |pct| {
            context_usage_color(app, pct)
        }));

    let mut spans = vec![
        Span::styled(dot, Style::default().fg(dot_color)),
        Span::raw(" "),
        Span::styled(model, Style::default().fg(model_label_color(app))),
        Span::raw(" "),
        Span::styled(
            format!("💡 {thinking}"),
            thinking_level_style(app, &thinking),
        ),
        Span::raw(" "),
        Span::styled(token_pct, context_style),
    ];

    if include_context_bar {
        if let Some(bar) = context_bar {
            spans.push(Span::raw(" "));
            spans.push(Span::styled(
                bar,
                context_style.bg(app.theme_cache.status_dim),
            ));
        }
    }

    spans.push(Span::raw(" "));
    spans.push(Span::styled(
        compact(cwd, 24),
        app.theme_cache.style_for(ThemeRole::SessionAccent),
    ));

    if app.voice.status_widget_active() {
        spans.push(Span::raw("  "));
        spans.push(Span::styled(
            app.voice.status_widget_text(),
            app.theme_cache.style_for(ThemeRole::StatusDim),
        ));
    }

    spans
}

pub fn status_targets(app: &App, width: usize) -> StatusTargets {
    let spans = build_status_spans(app, width);
    let mut column = 0usize;
    let mut targets = StatusTargets::default();
    for (idx, span) in spans.iter().enumerate() {
        let span_width = UnicodeWidthStr::width(span.content.as_ref());
        if idx == 2 {
            targets.model = Some((column, column + span_width));
        } else if idx == 4 {
            targets.thinking = Some((column, column + span_width));
        }
        column += span_width;
    }
    targets
}

fn status_model_label(app: &App) -> String {
    match (&app.provider, &app.model) {
        (Some(provider), Some(model)) => compact(&format!("{provider}/{model}"), 40),
        (None, Some(model)) => compact(model, 40),
        _ => "no model".to_string(),
    }
}

fn rounded_context_percent(tokens: u64, limit: u64) -> u64 {
    ((tokens.saturating_mul(100) + (limit / 2)) / limit).min(100)
}

fn status_display_width(status: &str, context_bar: Option<&str>, workspace: &str) -> usize {
    let details = if let Some(bar) = context_bar {
        format!("● {status} {bar} {workspace}")
    } else {
        format!("● {status} {workspace}")
    };
    UnicodeWidthStr::width(details.as_str())
}

fn context_usage_color(app: &App, percent: u64) -> Color {
    if percent <= 30 {
        app.theme_cache.tool_completed
    } else if percent <= 50 {
        app.theme_cache.diag_warn
    } else {
        app.theme_cache.diag_error
    }
}

fn thinking_level_style(app: &App, level: &str) -> Style {
    let color = thinking_level_color(app, level);
    Style::default().fg(color)
}

pub(crate) fn thinking_level_color(app: &App, level: &str) -> Color {
    let base_colors = [
        app.theme_cache.status_dim,
        app.theme_cache.tool_completed,
        app.theme_cache.model_accent,
        app.theme_cache.diag_warn,
        app.theme_cache.diag_error,
        app.theme_cache.resolve_color_ref("thinkingXHigh"),
    ];
    let available = if app.available_thinking_levels.is_empty() {
        ["off", "minimal", "low", "medium", "high", "xhigh"]
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>()
    } else {
        app.available_thinking_levels.clone()
    };
    let fallback = ["off", "minimal", "low", "medium", "high", "xhigh"];
    let index = available
        .iter()
        .position(|candidate| candidate == level)
        .or_else(|| fallback.iter().position(|candidate| candidate == &level))
        .unwrap_or(2)
        .min(base_colors.len() - 1);
    base_colors[index]
}

pub(crate) fn model_ref_color(app: &App, model_ref: &str, provider: Option<&str>) -> Color {
    configured_model_color(app, model_ref)
        .unwrap_or_else(|| provider_model_color(app, provider.unwrap_or(model_ref)))
}

fn model_label_color(app: &App) -> Color {
    match (&app.provider, &app.model) {
        (Some(provider), Some(model)) => model_ref_color(app, &format!("{provider}/{model}"), Some(provider)),
        (_, Some(model)) => model_ref_color(app, model, None),
        _ => app.theme_cache.model_accent,
    }
}

fn configured_model_color(app: &App, model_ref: &str) -> Option<Color> {
    let normalized_ref = model_ref.trim().to_ascii_lowercase();
    if normalized_ref.is_empty() {
        return None;
    }

    let mut best: Option<(&str, usize)> = None;
    for (pattern, color) in &app.config.model_colors.rules {
        let normalized_pattern = pattern.trim().to_ascii_lowercase();
        if normalized_pattern.is_empty() || !glob_matches(&normalized_pattern, &normalized_ref) {
            continue;
        }
        let specificity = normalized_pattern.replace('*', "").len();
        if best.is_none_or(|(_, current)| specificity > current) {
            best = Some((color.as_str(), specificity));
        }
    }

    best.map(|(color, _)| app.theme_cache.resolve_color_ref(color))
}

fn provider_model_color(app: &App, provider: &str) -> Color {
    let palette = [
        app.theme_cache.session_accent,
        app.theme_cache.diag_info,
        app.theme_cache.resolve_color_ref("toolSearch"),
        app.theme_cache.resolve_color_ref("toolMutation"),
        app.theme_cache.tool_completed,
        app.theme_cache.diag_warn,
    ];
    let hash = hash_string(&provider.trim().to_ascii_lowercase()) as usize;
    palette[hash % palette.len()]
}

fn hash_string(value: &str) -> u32 {
    let mut hash = 1_779_033_703u32 ^ value.len() as u32;
    for byte in value.bytes() {
        hash = (hash ^ byte as u32).wrapping_mul(3_432_918_353);
        hash = hash.rotate_left(13);
    }
    hash = (hash ^ (hash >> 16)).wrapping_mul(2_246_822_507);
    hash = (hash ^ (hash >> 13)).wrapping_mul(3_266_489_909);
    hash ^ (hash >> 16)
}

fn glob_matches(pattern: &str, text: &str) -> bool {
    let pattern = pattern.as_bytes();
    let text = text.as_bytes();
    let (mut p, mut t, mut star, mut matched) = (0usize, 0usize, None, 0usize);
    while t < text.len() {
        if p < pattern.len() && pattern[p] == text[t] {
            p += 1;
            t += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            matched = t;
            p += 1;
        } else if let Some(star_idx) = star {
            p = star_idx + 1;
            matched += 1;
            t = matched;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
}

fn format_compact_progress_bar(percent: u64) -> String {
    (0..COMPACT_PROGRESS_BAR_WIDTH)
        .map(|index| progress_bar_cell(percent, index, COMPACT_PROGRESS_BAR_WIDTH))
        .collect()
}

fn progress_bar_cell(percent: u64, index: usize, width: usize) -> char {
    let fill = progress_bar_cell_fill(percent, index, width);
    if fill >= 1.0 {
        return '█';
    }
    if fill <= 0.0 {
        return COMPACT_PROGRESS_BAR_EMPTY;
    }
    let partial_index = ((fill * COMPACT_PROGRESS_BAR_PARTIALS.len() as f64).ceil() as usize)
        .saturating_sub(1)
        .min(COMPACT_PROGRESS_BAR_PARTIALS.len() - 1);
    COMPACT_PROGRESS_BAR_PARTIALS[partial_index]
}

fn progress_bar_cell_fill(percent: u64, index: usize, width: usize) -> f64 {
    let cell_size = 100.0 / width.max(1) as f64;
    (((percent.min(100) as f64) - index as f64 * cell_size) / cell_size).clamp(0.0, 1.0)
}

fn compact(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let mut out: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() && max_chars > 0 {
        out.pop();
        out.push('…');
    }
    out
}

fn render_conversation(f: &mut Frame, app: &mut App, area: Rect) {
    let inner_width_cells = area.width as usize;
    let body_height = area.height as usize;
    let viewport_width = ViewportWidth(inner_width_cells);

    // Measure total lines and compute the visible slice via ScrollView.
    let total = app
        .viewport
        .line_count_with_config(&app.blocks, viewport_width, &app.config);
    let metrics = app.scroll.metrics(total, body_height);

    let theme = app.theme_cache;
    let visible = app.viewport.slice_with_config(
        &app.blocks,
        viewport_width,
        metrics.start,
        body_height,
        &theme,
        &app.config,
    );

    let visible_lines: Vec<Line<'static>> = visible.iter().map(|vl| vl.line.clone()).collect();
    app.link_click_targets =
        super::links::index_click_targets(&visible_lines, Some(Path::new(&app.cwd)));

    // Cache for the input handler.
    app.record_metrics(total, body_height);

    let items: Vec<ListItem<'static>> = visible
        .into_iter()
        .map(|vl| ListItem::new(normalize_and_fill_line(vl.line, inner_width_cells)))
        .collect();
    f.render_widget(Clear, area);
    f.render_widget(List::new(items), area);

    if app.is_runtime_loading(app.session_file.as_deref()) && total == 0 {
        render_loading_overlay(f, app, area);
    }
}

fn render_loading_overlay(f: &mut Frame, app: &App, area: Rect) {
    if area.width == 0 || area.height == 0 {
        return;
    }

    let row = Rect::new(area.x, area.y + area.height / 2, area.width, 1);
    let loading = Paragraph::new(Line::from(Span::styled(
        "Loading…",
        app.theme_cache.style_for(ThemeRole::StatusDim),
    )))
    .alignment(Alignment::Center);
    f.render_widget(loading, row);
}

fn normalize_and_fill_line(line: Line<'static>, width: usize) -> Line<'static> {
    let width = width.max(1);
    let mut spans = Vec::with_capacity(line.spans.len().saturating_add(1));
    let mut used = 0usize;

    for span in line.spans {
        if used >= width {
            break;
        }
        let mut text = String::new();
        for ch in span.content.chars() {
            let replacements: Vec<char> = match ch {
                '\t' => vec![' ', ' ', ' ', ' '],
                '\r' | '\n' => Vec::new(),
                c if c.is_control() => vec![' '],
                c => vec![c],
            };
            for replacement in replacements {
                let char_width = UnicodeWidthChar::width(replacement).unwrap_or(0);
                if used + char_width > width {
                    break;
                }
                text.push(replacement);
                used += char_width;
            }
            if used >= width {
                break;
            }
        }
        if !text.is_empty() {
            spans.push(Span::styled(text, span.style));
        }
    }

    if used < width {
        spans.push(Span::raw(" ".repeat(width - used)));
    }

    Line::from(spans)
}

fn render_toasts(f: &mut Frame, app: &App, conversation_area: Rect) {
    if app.toasts.is_empty() || conversation_area.width <= 4 || conversation_area.height <= 2 {
        return;
    }

    let max_width = 60.min(conversation_area.width.saturating_sub(4));
    if max_width == 0 {
        return;
    }
    let lines: Vec<Line<'static>> = app
        .toasts
        .iter_active()
        .take(3)
        .map(|toast| {
            let prefix = format!("{} {} ", toast.kind_label.icon(), toast.level.label());
            let max_message = max_width.saturating_sub(prefix.len() as u16).max(1) as usize;
            let message = compact(&toast.message, max_message);
            Line::from(Span::styled(
                format!("{prefix}{message}"),
                Style::default()
                    .fg(toast_fg(&app.theme_cache, toast.level))
                    .bg(toast_bg(&app.theme_cache, toast.level)),
            ))
        })
        .collect();

    let height = (lines.len() as u16).min(3).min(conversation_area.height);
    if height == 0 {
        return;
    }
    let width = max_width.min(conversation_area.width);
    let area = Rect::new(
        conversation_area
            .right()
            .saturating_sub(width)
            .saturating_sub(1)
            .max(conversation_area.x),
        conversation_area.y.saturating_add(1),
        width,
        height,
    );

    f.render_widget(Clear, area);
    f.render_widget(Paragraph::new(lines), area);
}

fn toast_fg(theme: &super::theme::Theme, level: super::toast::ToastLevel) -> Color {
    match level {
        super::toast::ToastLevel::Info => theme.diag_info,
        super::toast::ToastLevel::Warn => theme.diag_warn,
        super::toast::ToastLevel::Error => theme.diag_error,
    }
}

fn toast_bg(theme: &super::theme::Theme, level: super::toast::ToastLevel) -> Color {
    match level {
        super::toast::ToastLevel::Info => theme.status_bg,
        super::toast::ToastLevel::Warn => theme.status_bg,
        super::toast::ToastLevel::Error => theme.status_bg,
    }
}

fn render_input(f: &mut Frame, app: &mut App, area: Rect, rendered: RenderedInput) {
    let lines = build_input_lines(app, &rendered, area.width as usize, area.height as usize);
    f.render_widget(Paragraph::new(lines), area);

    // Place the cursor.
    if rendered.cursor_visible {
        let cursor_row_in_view = rendered
            .cursor_visual_row
            .saturating_sub(rendered.scroll_offset);
        let x = area.x + 1 + (rendered.cursor_screen_col as u16).saturating_sub(1);
        let y = area.y + 1 + cursor_row_in_view as u16;
        // Clamp to area (cursor_screen_col is 1-based; subtracting prefix
        // already happened inside the editor).
        let x = x.min(area.x + area.width.saturating_sub(1));
        let y = y.min(area.y + area.height.saturating_sub(1));
        f.set_cursor_position((x, y));
    }
}

fn build_input_lines(app: &App, rendered: &RenderedInput, area_width: usize, area_height: usize) -> Vec<Line<'static>> {
    let body_width = area_width.saturating_sub(2);
    let body_height = area_height.saturating_sub(2);
    let start = rendered.scroll_offset;
    let end = (start + body_height).min(rendered.visual_lines.len());
    let visible_visual = &rendered.visual_lines[start..end];
    let ghost_chunks = ghost_suffix_chunks(app, rendered, body_width, body_height, start, visible_visual);
    let scrollbar = input_scrollbar(rendered.visual_lines.len(), body_height, rendered.scroll_offset);

    let mut body_lines = Vec::with_capacity(body_height);
    for row_idx in 0..body_height {
        let text = visible_visual
            .get(row_idx)
            .map(|line| line.text.as_str())
            .unwrap_or("");
        let ghost = ghost_chunks.get(row_idx).map(String::as_str);
        let right_border = scrollbar_border_span(app, scrollbar.as_ref(), row_idx);

        let line = if row_idx == 0 && app.input.is_empty() && !app.input.has_attachments() {
            placeholder_input_line(app, body_width, right_border, ghost)
        } else {
            styled_input_line(app, text, body_width, ghost, right_border)
        };
        body_lines.push(line);
    }

    let mut lines = Vec::with_capacity(area_height.max(2));
    lines.push(input_border_line(app, area_width, true));
    lines.extend(body_lines);
    lines.push(input_border_line(app, area_width, false));
    lines
}

fn placeholder_input_line(
    app: &App,
    content_width: usize,
    right_border: Span<'static>,
    ghost_suffix: Option<&str>,
) -> Line<'static> {
    frame_spans(
        app,
        vec![Span::styled(
            "Type a prompt — / commands, Ctrl+H help, Ctrl+T sessions".to_string(),
            app.theme_cache.style_for(ThemeRole::StatusDim),
        )],
        content_width,
        ghost_suffix,
        right_border,
    )
}

fn styled_input_line(
    app: &App,
    text: &str,
    content_width: usize,
    ghost_suffix: Option<&str>,
    right_border: Span<'static>,
) -> Line<'static> {
    let ranges = app.input.attachment_tag_ranges_for_line(text);
    if ranges.is_empty() {
        return frame_spans(
            app,
            vec![Span::raw(text.to_string())],
            content_width,
            ghost_suffix,
            right_border,
        );
    }
    let mut spans = Vec::new();
    let mut pos = 0usize;
    for (start, end) in ranges {
        if start > pos {
            spans.push(Span::raw(text[pos..start].to_string()));
        }
        let tag_text = &text[start..end];
        spans.push(Span::styled(
            tag_text.to_string(),
            attachment_tag_style(app, tag_text),
        ));
        pos = end;
    }
    if pos < text.len() {
        spans.push(Span::raw(text[pos..].to_string()));
    }
    frame_spans(app, spans, content_width, ghost_suffix, right_border)
}

fn frame_spans(
    app: &App,
    mut spans: Vec<Span<'static>>,
    content_width: usize,
    ghost_suffix: Option<&str>,
    right_border: Span<'static>,
) -> Line<'static> {
    let border_style = input_border_style(app);
    let mut used_width = spans_width(&spans).min(content_width);
    if let Some(suffix) = ghost_suffix.filter(|suffix| !suffix.is_empty()) {
        let avail = content_width.saturating_sub(used_width);
        let ghost = take_width_chunk(suffix, avail);
        if !ghost.is_empty() {
            used_width += UnicodeWidthStr::width(ghost.as_str()).min(avail);
            spans.push(Span::styled(
                ghost,
                app.theme_cache.style_for(ThemeRole::StatusDim),
            ));
        }
    }
    if used_width < content_width {
        spans.push(Span::raw(" ".repeat(content_width - used_width)));
    }

    let mut framed = Vec::with_capacity(spans.len() + 2);
    framed.push(Span::styled("│", border_style));
    framed.extend(spans);
    framed.push(right_border);
    Line::from(framed)
}

fn ghost_suffix_chunks(
    app: &App,
    rendered: &RenderedInput,
    content_width: usize,
    body_height: usize,
    start: usize,
    visible_visual: &[super::input_editor::InputVisualLine],
) -> Vec<String> {
    let Some(mut suffix) = selected_autocomplete_suffix(app) else {
        return Vec::new();
    };
    if suffix.is_empty() || body_height == 0 {
        return Vec::new();
    }

    let Some(cursor_row_in_view) = rendered.cursor_visual_row.checked_sub(start) else {
        return Vec::new();
    };
    if cursor_row_in_view >= body_height {
        return Vec::new();
    }

    let mut chunks = vec![String::new(); body_height];
    for row_idx in cursor_row_in_view..body_height {
        if suffix.is_empty() {
            break;
        }
        let used_width = if row_idx == cursor_row_in_view {
            visible_visual
                .get(row_idx)
                .map(|line| UnicodeWidthStr::width(line.text.as_str()).min(content_width))
                .unwrap_or(0)
        } else {
            0
        };
        let avail = content_width.saturating_sub(used_width);
        if avail == 0 {
            continue;
        }
        let chunk = take_width_chunk(&suffix, avail);
        if chunk.is_empty() {
            break;
        }
        let chunk_len = chunk.len();
        chunks[row_idx] = chunk;
        suffix.drain(..chunk_len);
    }
    chunks
}

fn selected_autocomplete_suffix(app: &App) -> Option<String> {
    let trigger = app.autocomplete.trigger.as_ref()?;
    let suggestion = app.autocomplete.selected_suggestion()?;
    let text = app.input.text();
    let cursor = app.input.cursor();
    if cursor != text.len() || trigger.replace_end != cursor || trigger.replace_start > cursor {
        return None;
    }
    let typed = &text[trigger.replace_start..cursor];
    suggestion
        .replace_text
        .strip_prefix(typed)
        .filter(|suffix| !suffix.is_empty())
        .map(ToOwned::to_owned)
}

fn take_width_chunk(text: &str, width: usize) -> String {
    if text.is_empty() || width == 0 {
        return String::new();
    }
    let mut end = 0usize;
    let mut used = 0usize;
    for (idx, ch) in text.char_indices() {
        let ch_width = UnicodeWidthChar::width(ch).unwrap_or(0);
        if used + ch_width > width {
            break;
        }
        used += ch_width;
        end = idx + ch.len_utf8();
    }
    text[..end].to_string()
}

#[derive(Debug, Clone, Copy)]
struct InputScrollbar {
    top: usize,
    height: usize,
}

fn input_scrollbar(total_rows: usize, body_height: usize, scroll_offset: usize) -> Option<InputScrollbar> {
    if body_height == 0 || total_rows <= body_height {
        return None;
    }
    let thumb_height = ((body_height * body_height) / total_rows).max(1).min(body_height);
    let max_top = body_height.saturating_sub(thumb_height);
    let max_scroll = total_rows.saturating_sub(body_height).max(1);
    let top = ((scroll_offset * max_top) / max_scroll).min(max_top);
    Some(InputScrollbar {
        top,
        height: thumb_height,
    })
}

fn scrollbar_border_span(
    app: &App,
    scrollbar: Option<&InputScrollbar>,
    row_idx: usize,
) -> Span<'static> {
    let border_style = input_border_style(app);
    if let Some(scrollbar) = scrollbar {
        let is_thumb = row_idx >= scrollbar.top && row_idx < scrollbar.top + scrollbar.height;
        if is_thumb {
            return Span::styled(
                " ",
                border_style.bg(app.theme_cache.color_for(ThemeRole::InputBorder)),
            );
        }
    }
    Span::styled("│", border_style)
}

fn input_border_line(app: &App, width: usize, top: bool) -> Line<'static> {
    if width == 0 {
        return Line::default();
    }

    let border_style = input_border_style(app);
    if width == 1 {
        return Line::from(Span::styled(if top { "╭" } else { "╰" }, border_style));
    }

    let left = if top { "╭" } else { "╰" };
    let right = if top { "╮" } else { "╯" };
    Line::from(vec![
        Span::styled(left, border_style),
        Span::styled("─".repeat(width.saturating_sub(2)), border_style),
        Span::styled(right, border_style),
    ])
}

fn input_border_style(app: &App) -> Style {
    if app.is_streaming {
        app.theme_cache.style_for(ThemeRole::InputBorderBusy)
    } else {
        app.theme_cache.style_for(ThemeRole::InputBorder)
    }
}

fn spans_width(spans: &[Span<'_>]) -> usize {
    spans
        .iter()
        .map(|span| UnicodeWidthStr::width(span.content.as_ref()))
        .sum()
}

fn attachment_tag_style(app: &App, tag_text: &str) -> Style {
    let color = if tag_text.starts_with("[Image") {
        app.theme_cache.model_accent
    } else if tag_text.starts_with("[File") {
        app.theme_cache.heading3_plus
    } else {
        app.theme_cache.link
    };

    Style::default()
        .fg(color)
        .add_modifier(Modifier::BOLD | Modifier::UNDERLINED)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::buffer::Buffer;
    use ratatui::widgets::Widget;

    fn render_status_text(app: &App, width: u16) -> String {
        let area = Rect::new(0, 0, width, 1);
        let mut buffer = Buffer::empty(area);
        Paragraph::new(Line::from(build_status_spans(app, width as usize)))
            .render(area, &mut buffer);
        buffer
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>()
    }

    #[test]
    fn status_renders_all_segments() {
        let mut app = App::new("/tmp/example-workspace".to_string());
        app.provider = Some("anthropic".to_string());
        app.model = Some("claude-sonnet".to_string());
        app.config.default_model.thinking = Some(crate::config::ThinkingLevel::Medium);
        app.thinking_level = Some("medium".to_string());
        app.session_id = Some("abcdef1234567890".to_string());
        app.last_token_count = Some(2_500);
        app.context_limit = Some(10_000);
        app.tool_use_count = 3;
        app.message_count = Some(12);
        app.is_streaming = true;
        app.bridge_status = "ready".to_string();

        let text = render_status_text(&app, 200);

        assert!(text.contains("●"));
        assert!(text.contains("example-workspace"));
        assert!(text.contains("anthropic/claude-sonnet"));
        assert!(text.contains("medium"));
        assert!(text.contains("25%"));
        assert!(text.contains("█▎"));
        assert!(!text.contains("ready"));
        assert!(!text.contains("abcdef12"));
        assert!(!text.contains("12 msg · 3 tools"));
    }

    #[test]
    fn status_handles_missing_fields() {
        let mut app = App::new("".to_string());
        app.provider = None;
        app.model = None;
        app.thinking_level = Some("off".to_string());
        app.session_id = None;
        app.last_token_count = None;
        app.context_limit = None;
        app.tool_use_count = 0;

        let text = render_status_text(&app, 200);

        assert!(text.contains("●"));
        assert!(text.contains("no model"));
        assert!(text.contains("💡"));
        assert!(text.contains("?%"));
        assert!(!text.contains("(no session)"));
    }

    #[test]
    fn status_omits_context_bar_when_too_narrow() {
        let mut app = App::new("/tmp/example-workspace".to_string());
        app.provider = Some("anthropic".to_string());
        app.model = Some("claude-sonnet".to_string());
        app.config.default_model.thinking = Some(crate::config::ThinkingLevel::High);
        app.thinking_level = Some("high".to_string());
        app.last_token_count = Some(5_000);
        app.context_limit = Some(10_000);

        let text = build_status_spans(&app, 32)
            .into_iter()
            .map(|span| span.content.into_owned())
            .collect::<String>();

        assert!(text.contains("50%"));
        assert!(!text.contains("██"));
    }

    #[test]
    fn placeholder_line_mentions_commands_and_help() {
        let app = App::new("/tmp".to_string());
        let text = placeholder_input_line(
            &app,
            48,
            Span::styled("│", input_border_style(&app)),
            None,
        )
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect::<String>();

        assert!(text.contains("Type a prompt"));
        assert!(text.contains("/ commands"));
        assert!(text.contains("Ctrl+H"));
        assert!(text.contains("Ctrl+T"));
    }

    #[test]
    fn status_targets_cover_model_and_thinking_segments() {
        let mut app = App::new("/tmp/example-workspace".to_string());
        app.provider = Some("anthropic".to_string());
        app.model = Some("claude-sonnet".to_string());
        app.thinking_level = Some("medium".to_string());

        let text = build_status_spans(&app, 120)
            .into_iter()
            .map(|span| span.content.into_owned())
            .collect::<String>();
        let targets = status_targets(&app, 120);

        let (model_start, model_end) = targets.model.expect("model target");
        let (thinking_start, thinking_end) = targets.thinking.expect("thinking target");
        let model_text = text
            .chars()
            .skip(model_start)
            .take(model_end.saturating_sub(model_start))
            .collect::<String>();
        let thinking_text = text
            .chars()
            .skip(thinking_start)
            .take(thinking_end.saturating_sub(thinking_start))
            .collect::<String>();
        assert_eq!(model_text, "anthropic/claude-sonnet");
        assert_eq!(thinking_text.trim_end(), "💡 medium");
    }

    #[test]
    fn input_lines_match_pix_style_frame() {
        let mut app = App::new("/tmp".to_string());
        app.input.set_text("hello");
        let rendered = RenderedInput {
            visual_lines: vec![super::super::input_editor::InputVisualLine {
                text: "hello".to_string(),
                wrapped: false,
                start_offset: 0,
                end_offset: 5,
            }],
            cursor_visual_row: 0,
            cursor_screen_col: 6,
            scroll_offset: 0,
            cursor_visible: true,
        };

        let text = build_input_lines(&app, &rendered, 12, 3)
            .into_iter()
            .map(|line| line.spans.into_iter().map(|span| span.content.into_owned()).collect::<String>())
            .collect::<Vec<_>>();

        assert_eq!(text, vec!["╭──────────╮", "│hello     │", "╰──────────╯"]);
    }

    #[test]
    fn input_lines_show_inline_autocomplete_suffix() {
        let mut app = App::new("/tmp".to_string());
        app.input.set_text("/he");
        app.refresh_autocomplete(None);
        let rendered = RenderedInput {
            visual_lines: vec![super::super::input_editor::InputVisualLine {
                text: "/he".to_string(),
                wrapped: false,
                start_offset: 0,
                end_offset: 3,
            }],
            cursor_visual_row: 0,
            cursor_screen_col: 4,
            scroll_offset: 0,
            cursor_visible: true,
        };

        let text = build_input_lines(&app, &rendered, 12, 3)
            .into_iter()
            .map(|line| line.spans.into_iter().map(|span| span.content.into_owned()).collect::<String>())
            .collect::<Vec<_>>();

        assert_eq!(text, vec!["╭──────────╮", "│/help     │", "╰──────────╯"]);
    }

    #[test]
    fn input_lines_show_scrollbar_thumb_when_editor_overflows() {
        let mut app = App::new("/tmp".to_string());
        app.input.set_text("seed");
        let lines = build_input_lines(
            &app,
            &RenderedInput {
                visual_lines: (0..5)
                    .map(|i| super::super::input_editor::InputVisualLine {
                        text: format!("l{i}"),
                        wrapped: i > 0,
                        start_offset: i * 2,
                        end_offset: i * 2 + 2,
                    })
                    .collect(),
                cursor_visual_row: 4,
                cursor_screen_col: 3,
                scroll_offset: 2,
                cursor_visible: true,
            },
            8,
            5,
        )
        .into_iter()
        .map(|line| line.spans.into_iter().map(|span| span.content.into_owned()).collect::<String>())
        .collect::<Vec<_>>();

        assert_eq!(lines, vec!["╭──────╮", "│l2    │", "│l3    │", "│l4     ", "╰──────╯"]);
    }

    #[test]
    fn conversation_line_fill_pads_short_rows() {
        let line = normalize_and_fill_line(Line::from(Span::raw("abc")), 8);
        let text = line
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect::<String>();

        assert_eq!(text, "abc     ");
    }

    #[test]
    fn conversation_line_fill_expands_tabs_and_drops_controls() {
        let line = normalize_and_fill_line(Line::from(Span::raw("a\tb\rc\x1bd")), 12);
        let text = line
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect::<String>();

        assert_eq!(text, "a    bc d   ");
    }

    #[test]
    fn conversation_line_fill_clips_to_display_width() {
        let line = normalize_and_fill_line(Line::from(Span::raw("abcdef")), 4);
        let text = line
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect::<String>();

        assert_eq!(text, "abcd");
    }

    #[test]
    fn loading_overlay_centers_label_on_middle_row() {
        let text = centered_overlay_text(20, "Loading…");

        assert_eq!(text.chars().count(), 20);
        assert!(text.contains("Loading…"));
        assert_eq!(text.trim(), "Loading…");
    }

    fn centered_overlay_text(width: usize, text: &str) -> String {
        let left = width.saturating_sub(text.chars().count()) / 2;
        format!("{}{}", " ".repeat(left), text).chars().take(width).collect::<String>().chars().chain(std::iter::repeat(' ')).take(width).collect()
    }
}
