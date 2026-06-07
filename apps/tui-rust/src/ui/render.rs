//! ratatui rendering for the conversation UI.
//!
//! Layout (top to bottom):
//! - Status line (1 row): model / session id / streaming flag.
//! - Conversation (fills remaining space minus input). Lines come from
//!   `Viewport::slice`, which uses the per-width layout cache so a resize
//!   does not tear down work for the previous width.
//! - Input box (multi-line aware). Height grows with the editor's
//!   rendered line count, capped at half the screen (and at least 3 rows).
//!
//! The renderer takes an `&mut App` so it can:
//! - Pull `&app.blocks` for the viewport,
//! - Mutably drive `app.viewport`, `app.scroll`, and `app.input` (each
//!   renders only the visible window),
//! - Stash the resulting `line_count` / `body_height` on the app so the
//!   input handler can translate PageUp/PageDown without re-measuring.

use ratatui::layout::{Constraint, Direction, Layout, Rect};
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
use super::ContextBar;

/// Visual prefixes used by the input editor. The first row gets
/// `first_prefix`; subsequent rows of the same prompt get
/// `cont_prefix`. Kept centralised so render_input and the editor's
/// `render()` agree, and exposed for the mouse resolver so it can map
/// a click column back to a visual position with the same offset.
pub const INPUT_FIRST_PREFIX: &str = "❯ ";
pub const INPUT_CONT_PREFIX: &str = "  ";

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
            Constraint::Length(1),                  // status
            Constraint::Length(1),                  // context bar
            Constraint::Length(1),                  // sessions
            Constraint::Min(3),                     // conversation
            Constraint::Length(input_total_height), // input
        ])
        .split(size);

    render_status(f, app, chunks[0]);
    ContextBar::from_app(app).render(f, chunks[1]);
    render_session_tabs(f, app, chunks[2]);
    render_conversation(f, app, chunks[3]);
    render_toasts(f, app, chunks[3]);
    render_input(f, app, chunks[4], rendered_input);
    render_autocomplete_popup(f, app, size, chunks[4]);
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
    let line = Line::from(build_status_spans(app));
    let para = Paragraph::new(line).style(
        Style::default()
            .bg(app.theme_cache.status_bg)
            .add_modifier(Modifier::REVERSED),
    );
    f.render_widget(para, area);
}

fn render_session_tabs(f: &mut Frame, app: &App, area: Rect) {
    if area.width == 0 || area.height == 0 {
        return;
    }

    let line = crate::ui::tabs_state::tabs_line(
        &app.tabs,
        &app.theme_cache,
        area.width as usize,
        app.session_file.as_deref(),
        app.session_id.as_deref(),
        app.session_name.as_deref(),
    );
    let para = Paragraph::new(line).style(Style::default().bg(app.theme_cache.status_bg));
    f.render_widget(para, area);
}

pub(crate) fn build_status_spans(app: &App) -> Vec<Span<'static>> {
    let model = match (&app.provider, &app.model) {
        (Some(provider), Some(model)) => compact(&format!("{provider}/{model}"), 32),
        (None, Some(model)) => compact(model, 32),
        _ => "—".to_string(),
    };
    let cwd = Path::new(&app.cwd)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(app.cwd.as_str());
    let cwd = compact(cwd, 20);
    let session = app
        .session_name
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .map(|name| compact(name, 18))
        .or_else(|| {
            app.session_id
                .as_deref()
                .map(|id| id.chars().take(8).collect::<String>())
        })
        .unwrap_or_else(|| "(no session)".to_string());
    let thinking = app
        .config
        .default_model
        .thinking
        .map(|value| value.as_str().to_string())
        .unwrap_or_else(|| "—".to_string());
    let token_pct = match (app.last_token_count, app.context_limit) {
        (Some(tokens), Some(limit)) if limit > 0 => {
            format!(
                "{}%",
                ((tokens.saturating_mul(100) + (limit / 2)) / limit).min(100)
            )
        }
        _ => "—%".to_string(),
    };
    let dot = if app.is_streaming { "●" } else { "○" };
    let dot_color = if app.is_streaming {
        app.theme_cache.tool_completed
    } else {
        app.theme_cache.status_dim
    };
    let bridge_status = compact(&app.bridge_status, 18);
    let dim = app.theme_cache.style_for(ThemeRole::StatusDim);

    let mut spans = vec![
        Span::styled(dot, Style::default().fg(dot_color)),
        Span::raw(" "),
        Span::styled(bridge_status, dim),
        Span::raw("  "),
        Span::styled(cwd, app.theme_cache.style_for(ThemeRole::AssistantText)),
        Span::raw("  "),
        Span::styled(model, app.theme_cache.style_for(ThemeRole::ModelAccent)),
        Span::raw(" "),
        Span::styled(
            format!("💡 {thinking}"),
            app.theme_cache.style_for(ThemeRole::Heading3Plus),
        ),
        Span::raw(" "),
        Span::styled(token_pct, app.theme_cache.style_for(ThemeRole::ModelAccent)),
        Span::raw("  "),
        Span::styled(session, app.theme_cache.style_for(ThemeRole::SessionAccent)),
    ];

    if app.message_count.is_some() || app.tool_use_count > 0 {
        spans.push(Span::raw("  "));
        spans.push(Span::styled(
            format!(
                "{} msg · {} tool{}",
                app.message_count.unwrap_or(0),
                app.tool_use_count,
                if app.tool_use_count == 1 { "" } else { "s" }
            ),
            dim,
        ));
    }

    if app.voice.status_widget_active() {
        spans.push(Span::raw("  "));
        spans.push(Span::styled(
            app.voice.status_widget_text(),
            app.theme_cache.style_for(ThemeRole::StatusDim),
        ));
    }

    spans
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
    let inner_width_cells = area.width.saturating_sub(2) as usize; // borders
    let body_height = area.height.saturating_sub(2) as usize; // borders
    let viewport_width = ViewportWidth(inner_width_cells);

    // Measure total lines and compute the visible slice via ScrollView.
    let total = app.viewport.line_count(&app.blocks, viewport_width);
    let metrics = app.scroll.metrics(total, body_height);

    let theme = app.theme_cache;
    let visible = app.viewport.slice(
        &app.blocks,
        viewport_width,
        metrics.start,
        body_height,
        &theme,
    );

    let visible_lines: Vec<Line<'static>> = visible.iter().map(|vl| vl.line.clone()).collect();
    app.link_click_targets =
        super::links::index_click_targets(&visible_lines, Some(Path::new(&app.cwd)));

    // Cache for the input handler.
    app.record_metrics(total, body_height);

    let title = format!(" Conversation ({} lines) ", total);
    let list_block = RBlock::default()
        .borders(Borders::ALL)
        .border_style(app.theme_cache.style_for(ThemeRole::StatusDim))
        .title(Span::styled(
            title,
            app.theme_cache.style_for(ThemeRole::StatusDim),
        ));

    let items: Vec<ListItem<'static>> = visible
        .into_iter()
        .map(|vl| ListItem::new(vl.line))
        .collect();
    let list = List::new(items).block(list_block);
    f.render_widget(list, area);
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
    let title = build_input_title(app);
    let border = if app.is_streaming {
        app.theme_cache.style_for(ThemeRole::InputBorderBusy)
    } else {
        app.theme_cache.style_for(ThemeRole::InputBorder)
    };
    let input_block = RBlock::default()
        .borders(Borders::ALL)
        .border_style(border)
        .title(Span::styled(
            title,
            app.theme_cache.style_for(ThemeRole::StatusDim),
        ));

    // Build the paragraph text by joining the visible visual rows with
    // newlines. We slice by `scroll_offset..scroll_offset+area.height-2`
    // so the editor's auto-scroll is respected.
    let body_height = area.height.saturating_sub(2) as usize;
    let start = rendered.scroll_offset;
    let end = (start + body_height).min(rendered.visual_lines.len());
    let mut lines: Vec<Line<'static>> = rendered.visual_lines[start..end]
        .iter()
        .map(|v| styled_input_line(app, &v.text))
        .collect();
    if app.input.is_empty() && !app.input.has_attachments() && !lines.is_empty() {
        lines[0] = placeholder_input_line(app);
    }
    let para = Paragraph::new(lines).block(input_block);
    f.render_widget(para, area);

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

fn placeholder_input_line(app: &App) -> Line<'static> {
    Line::from(vec![
        Span::raw(INPUT_FIRST_PREFIX.to_string()),
        Span::styled(
            "Type a prompt — / commands, Ctrl+H help, Ctrl+T sessions",
            app.theme_cache.style_for(ThemeRole::StatusDim),
        ),
    ])
}

fn styled_input_line(app: &App, text: &str) -> Line<'static> {
    let ranges = app.input.attachment_tag_ranges_for_line(text);
    if ranges.is_empty() {
        return Line::from(Span::raw(text.to_string()));
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
    Line::from(spans)
}

fn build_input_title(app: &App) -> String {
    let mut title = if app.is_streaming {
        " Input (busy · Esc stops reply · Ctrl+H help".to_string()
    } else {
        " Input (Enter sends · / commands · Tab completes · Ctrl+V paste/image · @path attach"
            .to_string()
    };

    title.push_str(" · ");
    title.push_str(&app.voice.input_hint_text());

    if let Some(partial) = app
        .voice_partial_text
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        title.push_str(" · 🎙 ");
        title.push_str(&compact(partial, 28));
    }

    if let Some(summary) = app.input.attachment_summary() {
        title.push_str(" · ");
        title.push_str(&summary);
        title.push_str(" · Del removes tag");
    }

    title.push_str(") ");
    title
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
        Paragraph::new(Line::from(build_status_spans(app))).render(area, &mut buffer);
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
        app.session_id = Some("abcdef1234567890".to_string());
        app.last_token_count = Some(2_500);
        app.context_limit = Some(10_000);
        app.tool_use_count = 3;
        app.message_count = Some(12);
        app.is_streaming = true;
        app.bridge_status = "ready".to_string();

        let text = render_status_text(&app, 200);

        assert!(text.contains("●"));
        assert!(text.contains("ready"));
        assert!(text.contains("example-workspace"));
        assert!(text.contains("anthropic/claude-sonnet"));
        assert!(text.contains("medium"));
        assert!(text.contains("25%"));
        assert!(text.contains("abcdef12"));
        assert!(text.contains("12 msg · 3 tools"));
    }

    #[test]
    fn status_handles_missing_fields() {
        let mut app = App::new("".to_string());
        app.provider = None;
        app.model = None;
        app.session_id = None;
        app.last_token_count = None;
        app.context_limit = None;
        app.tool_use_count = 0;

        let text = render_status_text(&app, 200);

        assert!(text.contains("○"));
        assert!(text.contains("—"));
        assert!(text.contains("(no session)"));
        assert!(text.contains("—"));
        assert!(text.contains("—%"));
    }

    #[test]
    fn placeholder_line_mentions_commands_and_help() {
        let app = App::new("/tmp".to_string());
        let text = placeholder_input_line(&app)
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
    fn input_title_mentions_attachment_summary() {
        let mut app = App::new("/tmp".to_string());
        app.input.attach_image("abc", "image/png");
        app.input.attach_pasted_text("one\ntwo");

        let title = build_input_title(&app);

        assert!(title.contains("1 image · 1 paste"));
        assert!(title.contains("Del removes tag"));
    }

    #[test]
    fn input_title_keeps_attach_and_voice_hints_without_attachments() {
        let app = App::new("/tmp".to_string());
        let title = build_input_title(&app);

        assert!(title.contains("/ commands"));
        assert!(title.contains("Ctrl+V paste/image"));
        assert!(title.contains("@path attach"));
        assert!(title.contains("Ctrl+M"));
        assert!(!title.contains("Del removes tag"));
    }

    #[test]
    fn input_title_shows_partial_voice_preview() {
        let mut app = App::new("/tmp".to_string());
        app.voice_partial_text = Some("drafting the next sentence".to_string());

        let title = build_input_title(&app);

        assert!(title.contains("🎙 drafting the next sentence"));
    }
}
