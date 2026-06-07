use ratatui::layout::Rect;
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use super::app::App;

const LEFT_WIDTH: usize = 25;
const RIGHT_WIDTH: usize = 15;
const MIN_CENTER_WIDTH: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContextBar {
    pub used: u64,
    pub limit: u64,
    pub tool_count: u32,
    pub streaming: bool,
}

impl ContextBar {
    pub fn from_app(app: &App) -> Self {
        Self {
            used: app.last_token_count.unwrap_or(0),
            limit: app.context_limit.unwrap_or(0),
            tool_count: app.tool_use_count,
            streaming: app.is_streaming,
        }
    }

    pub fn render(&self, frame: &mut Frame, area: Rect) {
        if area.height == 0 || area.width == 0 {
            return;
        }

        let line = Line::from(self.spans_for_test(area.width as usize));
        frame.render_widget(Paragraph::new(line), area);
    }

    pub fn spans_for_test(&self, width: usize) -> Vec<Span<'static>> {
        if width == 0 {
            return Vec::new();
        }

        let percent = self.percent();
        let color = progress_color(percent);

        if width < LEFT_WIDTH + MIN_CENTER_WIDTH + RIGHT_WIDTH {
            return vec![Span::styled(
                fit_to_width(&self.left_label(), width),
                Style::default().fg(Color::White),
            )];
        }

        let center_width = width.saturating_sub(LEFT_WIDTH + RIGHT_WIDTH);
        let right_label = self.right_label();

        let mut spans = Vec::with_capacity(9);
        spans.push(Span::styled(
            fit_to_width(&self.left_label(), LEFT_WIDTH),
            Style::default().fg(Color::White),
        ));
        spans.extend(progress_spans(percent, color, center_width));
        spans.push(Span::styled(
            fit_to_width(&right_label, RIGHT_WIDTH),
            Style::default().fg(Color::Cyan),
        ));
        spans
    }

    fn percent(&self) -> u64 {
        if self.limit == 0 {
            return 0;
        }

        ((self.used.saturating_mul(100) + (self.limit / 2)) / self.limit).min(100)
    }

    fn left_label(&self) -> String {
        let limit = if self.limit == 0 {
            "—".to_string()
        } else {
            format_tokens(self.limit)
        };
        format!("{} / {limit} tokens", format_tokens(self.used))
    }

    fn right_label(&self) -> String {
        if self.streaming {
            format!("🛠 {} ●", self.tool_count)
        } else {
            format!("🛠 {}", self.tool_count)
        }
    }
}

fn progress_spans(percent: u64, color: Color, width: usize) -> Vec<Span<'static>> {
    if width == 0 {
        return Vec::new();
    }

    let percent_label = format!(" {percent}%");
    let fixed_width = 2 + UnicodeWidthStr::width(percent_label.as_str()); // [] + percent
    if width <= fixed_width {
        return vec![Span::styled(
            fit_to_width(&format!("{percent}%"), width),
            Style::default().fg(color),
        )];
    }

    let bar_width = width - fixed_width;
    let (filled, partial, empty) = bar_cells(percent, bar_width);
    let used_width = fixed_width + bar_width;
    let padding = width.saturating_sub(used_width);

    let mut spans = Vec::with_capacity(6);
    spans.push(Span::styled("[", Style::default().fg(Color::DarkGray)));
    if filled > 0 {
        spans.push(Span::styled("█".repeat(filled), Style::default().fg(color)));
    }
    if partial {
        spans.push(Span::styled("▓", Style::default().fg(color)));
    }
    if empty > 0 {
        spans.push(Span::styled(
            "░".repeat(empty),
            Style::default().fg(Color::DarkGray),
        ));
    }
    spans.push(Span::styled(
        format!("]{percent_label}"),
        Style::default().fg(color),
    ));
    if padding > 0 {
        spans.push(Span::raw(" ".repeat(padding)));
    }
    spans
}

fn bar_cells(percent: u64, width: usize) -> (usize, bool, usize) {
    if width == 0 {
        return (0, false, 0);
    }

    let total_units = (percent.min(100) as usize) * width;
    let filled = (total_units / 100).min(width);
    let partial = filled < width && !total_units.is_multiple_of(100);
    let empty = width.saturating_sub(filled + usize::from(partial));
    (filled, partial, empty)
}

fn progress_color(percent: u64) -> Color {
    match percent {
        95.. => Color::Red,
        80.. => Color::Yellow,
        _ => Color::Green,
    }
}

fn format_tokens(value: u64) -> String {
    if value < 1_000 {
        value.to_string()
    } else if value < 1_000_000 {
        format_scaled(value, 1_000, "k")
    } else {
        format_scaled(value, 1_000_000, "m")
    }
}

fn format_scaled(value: u64, scale: u64, suffix: &str) -> String {
    let tenths = (value.saturating_mul(10) + (scale / 2)) / scale;
    if tenths.is_multiple_of(10) {
        format!("{}{}", tenths / 10, suffix)
    } else {
        format!("{}.{}{}", tenths / 10, tenths % 10, suffix)
    }
}

fn fit_to_width(text: &str, width: usize) -> String {
    if width == 0 {
        return String::new();
    }

    let text_width = UnicodeWidthStr::width(text);
    if text_width == width {
        return text.to_string();
    }
    if text_width < width {
        return format!("{text}{}", " ".repeat(width - text_width));
    }
    if width == 1 {
        return "…".to_string();
    }

    let target = width - 1;
    let mut out = String::new();
    let mut used = 0;
    for ch in text.chars() {
        let ch_width = UnicodeWidthChar::width(ch).unwrap_or(0);
        if used + ch_width > target {
            break;
        }
        out.push(ch);
        used += ch_width;
    }
    out.push('…');
    out.push_str(&" ".repeat(width.saturating_sub(used + 1)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bar(used: u64, limit: u64) -> ContextBar {
        ContextBar {
            used,
            limit,
            tool_count: 0,
            streaming: false,
        }
    }

    fn text(spans: &[Span<'static>]) -> String {
        spans.iter().map(|span| span.content.as_ref()).collect()
    }

    fn filled_color(spans: &[Span<'static>]) -> Option<Color> {
        spans
            .iter()
            .find(|span| span.content.contains('█') || span.content.contains('▓'))
            .and_then(|span| span.style.fg)
    }

    #[test]
    fn from_app_without_limit_renders_zero_percent() {
        let app = App::new("/tmp/work".to_string());
        let bar = ContextBar::from_app(&app);

        let spans = bar.spans_for_test(80);
        let line = text(&spans);

        assert_eq!(bar.used, 0);
        assert_eq!(bar.limit, 0);
        assert!(line.contains("0 / — tokens"));
        assert!(line.contains("0%"));
    }

    #[test]
    fn renders_fifty_percent_green() {
        let spans = bar(100_000, 200_000).spans_for_test(80);
        let line = text(&spans);
        assert!(line.contains("100k / 200k tokens"));
        assert!(line.contains("50%"));
        assert_eq!(filled_color(&spans), Some(Color::Green));
    }

    #[test]
    fn renders_eighty_percent_yellow() {
        let spans = bar(160_000, 200_000).spans_for_test(80);
        assert!(text(&spans).contains("80%"));
        assert_eq!(filled_color(&spans), Some(Color::Yellow));
    }

    #[test]
    fn renders_ninety_five_percent_red() {
        let spans = bar(190_000, 200_000).spans_for_test(80);
        assert!(text(&spans).contains("95%"));
        assert_eq!(filled_color(&spans), Some(Color::Red));
    }

    #[test]
    fn renders_tool_count_icon() {
        let bar = ContextBar {
            used: 12_300,
            limit: 200_000,
            tool_count: 12,
            streaming: false,
        };

        let line = text(&bar.spans_for_test(80));
        assert!(line.contains("12.3k / 200k tokens"));
        assert!(line.contains("🛠 12"));
    }

    #[test]
    fn renders_streaming_dot_when_active() {
        let bar = ContextBar {
            used: 1,
            limit: 10,
            tool_count: 2,
            streaming: true,
        };

        let line = text(&bar.spans_for_test(80));
        assert!(line.contains("🛠 2 ●"));
    }
}
