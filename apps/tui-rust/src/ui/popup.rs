//! Popup overlay framework for pix-tui.

use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::Color;
use ratatui::style::Modifier;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};
use ratatui::Frame;
use serde_json::{json, Value};

use crate::runtime;
use crate::ui::app::App;
use crate::ui::model_picker::{self, MODEL_PICKER_POPUP_HEIGHT};
use crate::ui::slash::{filter_catalog, slash_commands_catalog};
use crate::ui::theme::{Theme, ThemeRole};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PopupKind {
    Help,
    ModelPicker,
    ThinkingPicker,
    SessionPicker,
    SlashMenu { query: String },
    Search { query: String },
}

#[derive(Debug, Clone, PartialEq)]
pub struct ActivePopup {
    pub kind: PopupKind,
    pub focus: usize,
    pub items: Vec<PopupItem>,
    pub scroll: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PopupItem {
    pub label: String,
    pub hint: Option<String>,
    pub data: Value,
    pub color: Option<Color>,
}

impl ActivePopup {
    pub fn new(kind: PopupKind) -> Self {
        let items = default_items_for_kind(&kind);
        Self {
            kind,
            focus: 0,
            items,
            scroll: 0,
        }
    }
}

impl PopupItem {
    pub fn new(label: impl Into<String>, hint: Option<impl Into<String>>, data: Value) -> Self {
        Self {
            label: label.into(),
            hint: hint.map(Into::into),
            data,
            color: None,
        }
    }
}

pub fn compute_popup_rect(screen: Rect, kind: &PopupKind) -> Rect {
    let (target_width, target_height) = match kind {
        PopupKind::Help => (80, 24),
        PopupKind::ModelPicker => (76, MODEL_PICKER_POPUP_HEIGHT),
        PopupKind::ThinkingPicker => (48, 10),
        PopupKind::SessionPicker => (96, 18),
        PopupKind::SlashMenu { .. } => (60, 8),
        PopupKind::Search { .. } => ((screen.width * 60 / 100), (screen.height * 60 / 100)),
    };

    let width = screen.width.min(target_width);
    let height = screen.height.min(target_height);
    let x = screen.x + screen.width.saturating_sub(width) / 2;
    let y = screen.y + screen.height.saturating_sub(height) / 2;
    Rect::new(x, y, width, height)
}

pub fn render_popup_frame(f: &mut Frame, app: &App, rect: Rect) {
    if rect.width == 0 || rect.height == 0 {
        return;
    }

    let Some(active) = app.active_popup.as_ref() else {
        return;
    };

    let theme = &app.theme_cache;
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.style_for(ThemeRole::InputBorder))
        .title(Span::styled(
            popup_title(&active.kind),
            theme
                .style_for(ThemeRole::Heading2)
                .add_modifier(Modifier::BOLD),
        ));

    f.render_widget(Clear, rect);
    let inner = block.inner(rect);
    f.render_widget(Paragraph::new("").block(block), rect);

    if inner.width == 0 || inner.height == 0 {
        return;
    }

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(0), Constraint::Length(1)])
        .split(inner);

    let body_lines = match &active.kind {
        PopupKind::ModelPicker => {
            model_picker::popup_lines(&app.model_picker, theme, chunks[0].height as usize)
        }
        PopupKind::SessionPicker => crate::ui::session_list::popup_lines(
            &app.session_list,
            theme,
            app.session_file.as_deref(),
            app.session_name.as_deref(),
            chunks[0].height as usize,
        ),
        PopupKind::Search { .. } => crate::ui::session_search::popup_lines(
            &app.session_search,
            theme,
            chunks[0].height as usize,
        ),
        _ => popup_body_lines(active, theme),
    };
    let body = Paragraph::new(body_lines).style(theme.style_for(ThemeRole::AssistantText));
    f.render_widget(body, chunks[0]);

    let hint = popup_hint_line(active, theme);
    f.render_widget(Paragraph::new(hint), chunks[1]);
}

fn popup_hint_line(active: &ActivePopup, theme: &Theme) -> Line<'static> {
    match active.kind {
        PopupKind::Help => hint_line(theme, &[("Esc", "Close")]),
        PopupKind::ModelPicker => hint_line(
            theme,
            &[
                ("↑↓", "Move"),
                ("PgUp/PgDn", "Page"),
                ("Home/End", "Jump"),
                ("Type", "Filter"),
                ("Enter", "Select"),
                ("Esc", "Close"),
            ],
        ),
        PopupKind::ThinkingPicker => hint_line(
            theme,
            &[
                ("↑↓", "Move"),
                ("PgUp/PgDn", "Page"),
                ("Home/End", "Jump"),
                ("Enter", "Select"),
                ("Esc", "Close"),
            ],
        ),
        PopupKind::SessionPicker => hint_line(
            theme,
            &[
                ("↑↓", "Move"),
                ("PgUp/PgDn", "Page"),
                ("Home/End", "Jump"),
                ("Type", "Filter"),
                ("Enter", "Switch"),
                ("Ctrl+R", "Refresh"),
                ("Ctrl+N", "New"),
                ("Esc", "Close"),
            ],
        ),
        PopupKind::Search { .. } => hint_line(
            theme,
            &[
                ("Type", "Search"),
                ("↑↓", "Move"),
                ("PgUp/PgDn", "Page"),
                ("Home/End", "Jump"),
                ("Enter", "Go"),
                ("Esc", "Close"),
            ],
        ),
        PopupKind::SlashMenu { .. } => hint_line(
            theme,
            &[("↑↓", "Move"), ("Enter", "Insert"), ("Esc", "Close")],
        ),
    }
}

fn hint_line(theme: &Theme, items: &[(&str, &str)]) -> Line<'static> {
    let mut spans = Vec::with_capacity(items.len().saturating_mul(2));
    for (idx, (key, action)) in items.iter().enumerate() {
        if idx > 0 {
            spans.push(Span::styled("  ", theme.style_for(ThemeRole::StatusDim)));
        }
        spans.push(Span::styled(
            (*key).to_string(),
            theme.style_for(ThemeRole::ModelAccent),
        ));
        spans.push(Span::styled(
            format!(" {action}"),
            theme.style_for(ThemeRole::StatusDim),
        ));
    }
    Line::from(spans)
}

pub fn popup_body_lines(active: &ActivePopup, theme: &Theme) -> Vec<Line<'static>> {
    match &active.kind {
        PopupKind::Help => help_lines(theme),
        PopupKind::ModelPicker => item_lines(active, theme),
        PopupKind::ThinkingPicker => item_lines(active, theme),
        PopupKind::SessionPicker => Vec::new(),
        PopupKind::Search { query } => vec![Line::from(vec![
            Span::styled("search: ", theme.style_for(ThemeRole::StatusDim)),
            Span::styled(query.clone(), theme.style_for(ThemeRole::CodeInline)),
        ])],
        PopupKind::SlashMenu { query } => {
            let mut lines = vec![Line::from(vec![
                Span::styled("filter: ", theme.style_for(ThemeRole::StatusDim)),
                Span::styled(query.clone(), theme.style_for(ThemeRole::CodeInline)),
            ])];
            lines.extend(item_lines(active, theme));
            lines
        }
    }
}

fn help_lines(theme: &Theme) -> Vec<Line<'static>> {
    let bindings = [
        ("Enter / Alt+Enter", "send · insert newline"),
        ("Tab / Shift+Tab", "cycle autocomplete"),
        ("/", "browse slash commands"),
        ("Ctrl+H / Ctrl+F", "help · search this session"),
        ("Ctrl+T / /model", "open sessions · open models"),
        (
            "Ctrl+V / Ctrl+Shift+V",
            "paste text or image · attach @path",
        ),
        ("Ctrl+M", "toggle voice input"),
        ("Ctrl+Y / Ctrl+L", "copy last reply · jump to latest"),
        ("Ctrl+Z / Ctrl+R / Ctrl+N", "undo · compact · new session"),
        ("Ctrl+\\ / Ctrl+C", "previous workspace · quit"),
        ("Esc / PageUp/Down", "stop reply or close · scroll"),
    ];
    let crash_dir = runtime::default_crash_report_dir();

    let mut lines = vec![Line::from(Span::styled(
        "Quick start",
        theme
            .style_for(ThemeRole::Heading3Plus)
            .add_modifier(Modifier::BOLD),
    ))];
    lines.extend(bindings.into_iter().map(|(key, description)| {
        Line::from(vec![
            Span::styled(
                format!("  {key:<12}"),
                theme.style_for(ThemeRole::ModelAccent),
            ),
            Span::styled(
                description.to_string(),
                theme.style_for(ThemeRole::AssistantText),
            ),
        ])
    }));
    lines.push(Line::from(Span::styled(
        "Slash commands",
        theme
            .style_for(ThemeRole::Heading3Plus)
            .add_modifier(Modifier::BOLD),
    )));
    lines.push(Line::from(Span::styled(
        "Type / in the input to browse commands and autocomplete.",
        theme.style_for(ThemeRole::StatusDim),
    )));
    for row in slash_commands_catalog()
        .iter()
        .map(|info| info.usage)
        .collect::<Vec<_>>()
        .chunks(4)
    {
        lines.push(Line::from(Span::styled(
            row.join("  "),
            theme.style_for(ThemeRole::CodeInline),
        )));
    }
    lines.push(Line::from(Span::styled(
        "Voice input is optional and downloads a Vosk model on first use.",
        theme.style_for(ThemeRole::StatusDim),
    )));
    lines.push(Line::from(Span::styled(
        "Troubleshooting",
        theme
            .style_for(ThemeRole::Heading3Plus)
            .add_modifier(Modifier::BOLD),
    )));
    lines.push(Line::from(vec![
        Span::styled(
            "  pix-tui --diagnostics",
            theme.style_for(ThemeRole::CodeInline),
        ),
        Span::styled(
            "  inspect sidecar/config/runtime setup",
            theme.style_for(ThemeRole::StatusDim),
        ),
    ]));
    lines.push(Line::from(vec![
        Span::styled("  crash reports: ", theme.style_for(ThemeRole::StatusDim)),
        Span::styled(
            crash_dir.display().to_string(),
            theme.style_for(ThemeRole::CodeInline),
        ),
    ]));
    lines
}

fn item_lines(active: &ActivePopup, theme: &Theme) -> Vec<Line<'static>> {
    if active.items.is_empty() {
        return vec![Line::from(Span::styled(
            "  No items",
            theme
                .style_for(ThemeRole::StatusDim)
                .add_modifier(Modifier::DIM),
        ))];
    }

    active
        .items
        .iter()
        .enumerate()
        .skip(active.scroll)
        .map(|(idx, item)| {
            let focused = idx == active.focus;
            let arrow = if focused { "› " } else { "  " };
            let arrow_style = theme
                .style_for(ThemeRole::StatusDim)
                .add_modifier(Modifier::DIM);
            let label_style = {
                let mut style = item
                    .color
                    .map(|color| theme.style_for(ThemeRole::AssistantText).fg(color))
                    .unwrap_or_else(|| theme.style_for(ThemeRole::AssistantText));
                if focused {
                    style = style.add_modifier(Modifier::BOLD);
                }
                style
            };

            let mut spans = vec![
                Span::styled(arrow.to_string(), arrow_style),
                Span::styled(item.label.clone(), label_style),
            ];
            if let Some(hint) = &item.hint {
                spans.push(Span::raw("  "));
                spans.push(Span::styled(
                    hint.clone(),
                    theme.style_for(ThemeRole::StatusDim),
                ));
            }
            Line::from(spans)
        })
        .collect()
}

fn default_items_for_kind(kind: &PopupKind) -> Vec<PopupItem> {
    match kind {
        PopupKind::Help => Vec::new(),
        PopupKind::ModelPicker => Vec::new(),
        PopupKind::ThinkingPicker => Vec::new(),
        PopupKind::SessionPicker => Vec::new(),
        PopupKind::SlashMenu { query } => slash_items(query),
        PopupKind::Search { .. } => Vec::new(),
    }
}

fn slash_items(query: &str) -> Vec<PopupItem> {
    filter_catalog(query)
        .into_iter()
        .map(|info| {
            PopupItem::new(
                info.usage,
                Some(info.hint),
                json!({"command": format!("/{}", info.name)}),
            )
        })
        .collect()
}

fn popup_title(kind: &PopupKind) -> &'static str {
    match kind {
        PopupKind::Help => " Help ",
        PopupKind::ModelPicker => " Model Picker ",
        PopupKind::ThinkingPicker => " Thinking Level ",
        PopupKind::SessionPicker => " Session Picker ",
        PopupKind::SlashMenu { .. } => " Slash Commands ",
        PopupKind::Search { .. } => " Search This Session ",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn compute_popup_rect_centers_help() {
        let rect = compute_popup_rect(Rect::new(0, 0, 120, 40), &PopupKind::Help);
        assert_eq!(rect, Rect::new(20, 8, 80, 24));
    }

    #[test]
    fn compute_popup_rect_clamps_to_small_screen() {
        let rect = compute_popup_rect(Rect::new(5, 3, 40, 6), &PopupKind::ModelPicker);
        assert_eq!(rect, Rect::new(5, 3, 40, 6));
    }

    #[test]
    fn popup_body_lines_help_lists_keybindings_and_slash_reference() {
        let active = ActivePopup::new(PopupKind::Help);
        let text = text_of(&popup_body_lines(&active, &Theme::default()));
        assert!(text.contains("Enter"));
        assert!(text.contains("Ctrl+M"));
        assert!(text.contains("Ctrl+H"));
        assert!(text.contains("Ctrl+F"));
        assert!(text.contains("Ctrl+T"));
        assert!(text.contains("Ctrl+Shift+V"));
        assert!(text.contains("Ctrl+Z"));
        assert!(text.contains("Ctrl+C"));
        assert!(text.contains("/search <query>"));
        assert!(text.contains("/model [provider/model]"));
        assert!(text.contains("Voice input is optional"));
        assert!(text.contains("pix-tui --diagnostics"));
    }

    #[test]
    fn help_popup_body_fits_default_help_window() {
        let active = ActivePopup::new(PopupKind::Help);
        let body = popup_body_lines(&active, &Theme::default());

        assert!(body.len() <= 21, "help body should fit without clipping");
    }

    #[test]
    fn popup_hint_line_matches_search_controls() {
        let line = popup_hint_line(
            &ActivePopup::new(PopupKind::Search {
                query: String::new(),
            }),
            &Theme::default(),
        );
        let text = text_of(&[line]);

        assert!(text.contains("Type Search"));
        assert!(text.contains("Home/End Jump"));
        assert!(text.contains("Enter Go"));
    }

    #[test]
    fn popup_body_lines_model_picker_marks_focus() {
        let mut active = ActivePopup::new(PopupKind::ModelPicker);
        active.items = vec![
            PopupItem::new("GPT 5.5", Some("openai-codex/gpt-5.5"), json!({})),
            PopupItem::new("Claude Sonnet", Some("anthropic/claude-sonnet"), json!({})),
        ];
        active.focus = 1;
        let text = text_of(&popup_body_lines(&active, &Theme::default()));
        assert!(text.contains("GPT 5.5"));
        assert!(text.contains("› Claude Sonnet"));
    }

    #[test]
    fn popup_body_lines_session_picker_lists_session_actions() {
        let active = ActivePopup::new(PopupKind::SessionPicker);
        let lines = popup_body_lines(&active, &Theme::default());
        assert!(lines.is_empty());
    }

    #[test]
    fn popup_body_lines_slash_menu_filters_by_query() {
        let active = ActivePopup::new(PopupKind::SlashMenu {
            query: "mod".to_string(),
        });
        let text = text_of(&popup_body_lines(&active, &Theme::default()));
        assert!(text.contains("filter: mod"));
        assert!(text.contains("/model [provider/model]"));
        assert!(!text.contains("/quit"));
    }

    #[test]
    fn active_popup_new_starts_at_top() {
        let active = ActivePopup::new(PopupKind::SlashMenu {
            query: String::new(),
        });
        assert_eq!(active.focus, 0);
        assert_eq!(active.scroll, 0);
        assert!(!active.items.is_empty());
    }

    #[test]
    fn app_open_popup_close_popup_roundtrip() {
        let mut app = App::new("/tmp".to_string());
        assert!(app.current_popup_kind().is_none());

        app.open_popup(PopupKind::Help);
        assert_eq!(app.current_popup_kind(), Some(&PopupKind::Help));
        assert!(app
            .active_popup
            .as_ref()
            .is_some_and(|popup| popup.items.is_empty()));

        app.close_popup();
        assert!(app.current_popup_kind().is_none());
    }
}
