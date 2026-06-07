//! Built-in color themes for the Rust TUI.
#![allow(dead_code)]

use ratatui::style::{Color, Style};

#[rustfmt::skip]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Theme {
    pub user_text: Color, pub assistant_text: Color,
    pub tool_pending: Color, pub tool_running: Color, pub tool_completed: Color, pub tool_failed: Color,
    pub status_bg: Color, pub status_dim: Color, pub model_accent: Color, pub session_accent: Color,
    pub heading1: Color, pub heading2: Color, pub heading3_plus: Color,
    pub code_inline: Color, pub code_fence_border: Color,
    pub list_marker: Color, pub blockquote_bar: Color, pub hr: Color, pub link: Color,
    pub bold_text: Color, pub italic_text: Color,
    pub diag_info: Color, pub diag_warn: Color, pub diag_error: Color,
    pub input_border: Color, pub input_border_busy: Color, pub cursor: Color,
}

#[rustfmt::skip]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThemeRole {
    UserText, AssistantText, ToolPending, ToolRunning, ToolCompleted, ToolFailed,
    StatusBg, StatusDim, ModelAccent, SessionAccent, Heading1, Heading2, Heading3Plus,
    CodeInline, CodeFenceBorder, ListMarker, BlockquoteBar, Hr, Link, BoldText, ItalicText,
    DiagInfo, DiagWarn, DiagError, InputBorder, InputBorderBusy, Cursor,
}

pub type ThemeLoadError = String;

impl Default for Theme {
    fn default() -> Self {
        Self::default_theme()
    }
}

impl Theme {
    pub fn by_name(name: &str) -> Theme {
        match normalize_name(name).as_str() {
            "" | "default" => Self::default_theme(),
            "dark" => Self::dark(),
            "light" => Self::light(),
            "monokai" => Self::monokai(),
            _ => Self::default_theme(),
        }
    }

    pub fn from_json_str(input: &str) -> Result<Theme, ThemeLoadError> {
        let value: serde_json::Value =
            serde_json::from_str(input).map_err(|err| format!("parse theme JSON: {err}"))?;
        let object = value
            .as_object()
            .ok_or_else(|| "theme JSON must be an object".to_string())?;
        let mut theme = object
            .get("extends")
            .or_else(|| object.get("base"))
            .and_then(serde_json::Value::as_str)
            .map(Self::by_name)
            .unwrap_or_default();
        for (key, value) in object {
            if matches!(key.as_str(), "name" | "extends" | "base") {
                continue;
            }
            let raw = value
                .as_str()
                .ok_or_else(|| format!("theme color `{key}` must be a string"))?;
            let color = parse_color(raw)
                .ok_or_else(|| format!("theme color `{key}` has invalid value `{raw}`"))?;
            theme.set_color(key, color)?;
        }
        Ok(theme)
    }

    pub fn style_for(&self, role: ThemeRole) -> Style {
        match role {
            ThemeRole::StatusBg => Style::default().bg(self.color_for(role)),
            _ => Style::default().fg(self.color_for(role)),
        }
    }

    #[rustfmt::skip]
    pub fn color_for(&self, role: ThemeRole) -> Color {
        match role {
            ThemeRole::UserText => self.user_text, ThemeRole::AssistantText => self.assistant_text,
            ThemeRole::ToolPending => self.tool_pending, ThemeRole::ToolRunning => self.tool_running,
            ThemeRole::ToolCompleted => self.tool_completed, ThemeRole::ToolFailed => self.tool_failed,
            ThemeRole::StatusBg => self.status_bg, ThemeRole::StatusDim => self.status_dim,
            ThemeRole::ModelAccent => self.model_accent, ThemeRole::SessionAccent => self.session_accent,
            ThemeRole::Heading1 => self.heading1, ThemeRole::Heading2 => self.heading2,
            ThemeRole::Heading3Plus => self.heading3_plus, ThemeRole::CodeInline => self.code_inline,
            ThemeRole::CodeFenceBorder => self.code_fence_border, ThemeRole::ListMarker => self.list_marker,
            ThemeRole::BlockquoteBar => self.blockquote_bar, ThemeRole::Hr => self.hr, ThemeRole::Link => self.link,
            ThemeRole::BoldText => self.bold_text, ThemeRole::ItalicText => self.italic_text,
            ThemeRole::DiagInfo => self.diag_info, ThemeRole::DiagWarn => self.diag_warn, ThemeRole::DiagError => self.diag_error,
            ThemeRole::InputBorder => self.input_border, ThemeRole::InputBorderBusy => self.input_border_busy, ThemeRole::Cursor => self.cursor,
        }
    }

    #[rustfmt::skip]
    fn default_theme() -> Self {
        Self {
            user_text: Color::White, assistant_text: Color::White,
            tool_pending: Color::DarkGray, tool_running: Color::Yellow, tool_completed: Color::Green, tool_failed: Color::Red,
            status_bg: Color::Black, status_dim: Color::DarkGray, model_accent: Color::Yellow, session_accent: Color::Magenta,
            heading1: Color::Cyan, heading2: Color::LightCyan, heading3_plus: Color::Yellow,
            code_inline: Color::LightYellow, code_fence_border: Color::DarkGray,
            list_marker: Color::Cyan, blockquote_bar: Color::Magenta, hr: Color::DarkGray, link: Color::Cyan,
            bold_text: Color::White, italic_text: Color::White,
            diag_info: Color::Cyan, diag_warn: Color::Yellow, diag_error: Color::Red,
            input_border: Color::DarkGray, input_border_busy: Color::Yellow, cursor: Color::White,
        }
    }

    fn dark() -> Self {
        Self {
            status_bg: Color::Rgb(8, 12, 18),
            status_dim: Color::Gray,
            model_accent: Color::LightYellow,
            session_accent: Color::LightMagenta,
            heading3_plus: Color::LightYellow,
            input_border: Color::Rgb(78, 86, 105),
            ..Self::default_theme()
        }
    }

    fn light() -> Self {
        let mut t = Self::default_theme();
        t.user_text = Color::Black;
        t.assistant_text = Color::Black;
        t.bold_text = Color::Black;
        t.italic_text = Color::Black;
        t.tool_pending = Color::Gray;
        t.tool_running = Color::Rgb(160, 96, 0);
        t.tool_completed = Color::Rgb(0, 120, 72);
        t.tool_failed = Color::Rgb(184, 32, 32);
        t.status_bg = Color::White;
        t.status_dim = Color::Gray;
        t.model_accent = Color::Rgb(120, 80, 0);
        t.session_accent = Color::Rgb(128, 48, 128);
        t.heading1 = Color::Blue;
        t.heading3_plus = Color::Rgb(128, 96, 0);
        t.code_inline = Color::Rgb(128, 80, 0);
        t.link = Color::Blue;
        t.list_marker = Color::Blue;
        t.input_border = Color::Gray;
        t.input_border_busy = Color::Rgb(160, 96, 0);
        t.cursor = Color::Black;
        t
    }

    fn monokai() -> Self {
        let mut t = Self::default_theme();
        t.user_text = Color::Rgb(248, 248, 242);
        t.assistant_text = t.user_text;
        t.bold_text = t.user_text;
        t.italic_text = t.user_text;
        t.tool_pending = Color::Rgb(117, 113, 94);
        t.tool_running = Color::Rgb(230, 219, 116);
        t.tool_completed = Color::Rgb(166, 226, 46);
        t.tool_failed = Color::Rgb(249, 38, 114);
        t.status_bg = Color::Rgb(39, 40, 34);
        t.status_dim = t.tool_pending;
        t.model_accent = t.tool_running;
        t.session_accent = Color::Rgb(174, 129, 255);
        t.heading1 = Color::Rgb(102, 217, 239);
        t.heading2 = t.tool_completed;
        t.heading3_plus = Color::Rgb(253, 151, 31);
        t.code_inline = t.tool_running;
        t.code_fence_border = t.tool_pending;
        t.list_marker = t.heading1;
        t.blockquote_bar = t.session_accent;
        t.hr = t.tool_pending;
        t.link = t.heading1;
        t.diag_info = t.heading1;
        t.diag_warn = t.tool_running;
        t.diag_error = t.tool_failed;
        t.input_border = t.tool_pending;
        t.input_border_busy = t.heading3_plus;
        t.cursor = t.user_text;
        t
    }

    fn set_color(&mut self, key: &str, color: Color) -> Result<(), ThemeLoadError> {
        match normalize_key(key).as_str() {
            "usertext" => self.user_text = color,
            "assistanttext" => self.assistant_text = color,
            "toolpending" => self.tool_pending = color,
            "toolrunning" => self.tool_running = color,
            "toolcompleted" => self.tool_completed = color,
            "toolfailed" => self.tool_failed = color,
            "statusbg" => self.status_bg = color,
            "statusdim" => self.status_dim = color,
            "modelaccent" => self.model_accent = color,
            "sessionaccent" => self.session_accent = color,
            "heading1" => self.heading1 = color,
            "heading2" => self.heading2 = color,
            "heading3plus" | "heading3" => self.heading3_plus = color,
            "codeinline" => self.code_inline = color,
            "codefenceborder" => self.code_fence_border = color,
            "listmarker" => self.list_marker = color,
            "blockquotebar" => self.blockquote_bar = color,
            "hr" => self.hr = color,
            "link" => self.link = color,
            "boldtext" => self.bold_text = color,
            "italictext" => self.italic_text = color,
            "diaginfo" => self.diag_info = color,
            "diagwarn" => self.diag_warn = color,
            "diagerror" => self.diag_error = color,
            "inputborder" => self.input_border = color,
            "inputborderbusy" => self.input_border_busy = color,
            "cursor" => self.cursor = color,
            _ => return Err(format!("unknown theme color `{key}`")),
        }
        Ok(())
    }
}

fn normalize_name(name: &str) -> String {
    name.trim().to_ascii_lowercase().replace([' ', '_'], "-")
}

fn normalize_key(key: &str) -> String {
    key.chars()
        .filter(|c| *c != '_' && *c != '-' && !c.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}

fn parse_color(value: &str) -> Option<Color> {
    let normalized = normalize_key(value);
    match normalized.as_str() {
        "black" => Some(Color::Black),
        "red" => Some(Color::Red),
        "green" => Some(Color::Green),
        "yellow" => Some(Color::Yellow),
        "blue" => Some(Color::Blue),
        "magenta" => Some(Color::Magenta),
        "cyan" => Some(Color::Cyan),
        "gray" | "grey" => Some(Color::Gray),
        "darkgray" | "darkgrey" => Some(Color::DarkGray),
        "lightred" => Some(Color::LightRed),
        "lightgreen" => Some(Color::LightGreen),
        "lightyellow" => Some(Color::LightYellow),
        "lightblue" => Some(Color::LightBlue),
        "lightmagenta" => Some(Color::LightMagenta),
        "lightcyan" => Some(Color::LightCyan),
        "white" => Some(Color::White),
        _ => parse_hex_color(value),
    }
}

fn parse_hex_color(value: &str) -> Option<Color> {
    let hex = value.trim().strip_prefix('#')?;
    if hex.len() != 6 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
    let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
    let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
    Some(Color::Rgb(r, g, b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[rustfmt::skip]
    fn default_theme_matches_current_colors() {
        let theme = Theme::by_name("default");
        let actual = [theme.user_text, theme.assistant_text, theme.tool_pending, theme.tool_running, theme.tool_completed, theme.tool_failed, theme.status_bg, theme.heading1, theme.code_inline, theme.input_border_busy];
        let expected = [Color::White, Color::White, Color::DarkGray, Color::Yellow, Color::Green, Color::Red, Color::Black, Color::Cyan, Color::LightYellow, Color::Yellow];
        assert_eq!(actual, expected);
    }

    #[test]
    fn by_name_is_case_insensitive_and_falls_back() {
        assert_eq!(Theme::by_name(" MONOKAI "), Theme::monokai());
        assert_eq!(Theme::by_name("unknown-theme"), Theme::default());
    }

    #[test]
    fn built_in_themes_are_distinct() {
        assert_ne!(
            Theme::by_name("default").status_bg,
            Theme::by_name("dark").status_bg
        );
        assert_ne!(
            Theme::by_name("light").user_text,
            Theme::by_name("dark").user_text
        );
        assert_ne!(
            Theme::by_name("monokai").tool_failed,
            Theme::by_name("default").tool_failed
        );
    }

    #[test]
    fn style_for_sets_fg_or_bg() {
        let theme = Theme::default();
        assert_eq!(
            theme.style_for(ThemeRole::ToolRunning).fg,
            Some(Color::Yellow)
        );
        assert_eq!(theme.style_for(ThemeRole::StatusBg).bg, Some(Color::Black));
    }

    #[test]
    fn custom_theme_loads_from_json_snippet() {
        let theme = Theme::from_json_str(
            r##"{
                "extends": "default",
                "user_text": "lightGreen",
                "tool_failed": "#ff0066",
                "heading3_plus": "blue"
            }"##,
        )
        .expect("custom theme should parse");
        assert_eq!(theme.user_text, Color::LightGreen);
        assert_eq!(theme.tool_failed, Color::Rgb(255, 0, 102));
        assert_eq!(theme.heading3_plus, Color::Blue);
        assert_eq!(theme.assistant_text, Color::White);
    }

    #[test]
    fn custom_theme_rejects_unknown_fields_and_colors() {
        assert!(Theme::from_json_str(r#"{ "nope": "red" }"#).is_err());
        assert!(Theme::from_json_str(r#"{ "user_text": "not-a-color" }"#).is_err());
    }

    #[test]
    fn color_parser_accepts_common_spellings() {
        assert_eq!(parse_color("dark-gray"), Some(Color::DarkGray));
        assert_eq!(parse_color("Light Cyan"), Some(Color::LightCyan));
        assert_eq!(parse_color("#001122"), Some(Color::Rgb(0, 17, 34)));
    }
}
