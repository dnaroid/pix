//! Built-in color themes for the Rust TUI.
#![allow(dead_code)]

use ratatui::style::{Color, Style};

#[rustfmt::skip]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Theme {
    pub user_text: Color, pub assistant_text: Color,
    pub user_message_background: Color,
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
    UserText, AssistantText, UserMessageBackground, ToolPending, ToolRunning, ToolCompleted, ToolFailed,
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
            ThemeRole::StatusBg | ThemeRole::UserMessageBackground => {
                Style::default().bg(self.color_for(role))
            }
            _ => Style::default().fg(self.color_for(role)),
        }
    }

    pub fn resolve_color_ref(&self, color_ref: &str) -> Color {
        let trimmed = color_ref.trim();
        if let Some(color) = parse_color(trimmed) {
            return color;
        }

        match normalize_key(trimmed).as_str() {
            "muted" => Color::Rgb(125, 133, 144),
            "statusforeground" | "statusdim" => self.status_dim,
            "accent" => self.session_accent,
            "success" => self.tool_completed,
            "warning" => self.diag_warn,
            "info" => self.diag_info,
            "error" => self.tool_failed,
            "toolmutation" => {
                self.pix_palette_color(Color::Rgb(212, 122, 162), Color::Rgb(163, 58, 104))
            }
            "toolsearch" => {
                self.pix_palette_color(Color::Rgb(168, 137, 214), Color::Rgb(109, 82, 165))
            }
            "tooltitle" => {
                self.pix_palette_color(Color::Rgb(154, 167, 180), Color::Rgb(82, 96, 112))
            }
            "modelopenai" => {
                self.pix_palette_color(Color::Rgb(200, 180, 90), Color::Rgb(117, 103, 31))
            }
            "foreground" | "assistantforeground" => self.assistant_text,
            "userforeground" | "usertext" => self.user_text,
            "link" => self.link,
            _ => self.status_dim,
        }
    }

    fn pix_palette_color(&self, dark: Color, light: Color) -> Color {
        if self.status_bg == Color::Rgb(248, 250, 252) {
            light
        } else {
            dark
        }
    }

    #[rustfmt::skip]
    pub fn color_for(&self, role: ThemeRole) -> Color {
        match role {
            ThemeRole::UserText => self.user_text, ThemeRole::AssistantText => self.assistant_text,
            ThemeRole::UserMessageBackground => self.user_message_background,
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
            user_text: Color::Rgb(214, 222, 235), assistant_text: Color::Rgb(201, 209, 217), user_message_background: Color::Rgb(30, 30, 30),
            tool_pending: Color::Rgb(125, 133, 144), tool_running: Color::Rgb(212, 154, 74), tool_completed: Color::Rgb(124, 169, 130), tool_failed: Color::Rgb(201, 106, 103),
            status_bg: Color::Rgb(9, 13, 19), status_dim: Color::Rgb(125, 133, 144), model_accent: Color::Rgb(200, 180, 90), session_accent: Color::Rgb(122, 162, 214),
            heading1: Color::Rgb(127, 179, 200), heading2: Color::Rgb(122, 162, 214), heading3_plus: Color::Rgb(212, 154, 74),
            code_inline: Color::Rgb(212, 154, 74), code_fence_border: Color::Rgb(48, 54, 61),
            list_marker: Color::Rgb(127, 179, 200), blockquote_bar: Color::Rgb(122, 162, 214), hr: Color::Rgb(48, 54, 61), link: Color::Rgb(127, 179, 200),
            bold_text: Color::Rgb(214, 222, 235), italic_text: Color::Rgb(214, 222, 235),
            diag_info: Color::Rgb(127, 179, 200), diag_warn: Color::Rgb(212, 154, 74), diag_error: Color::Rgb(201, 106, 103),
            input_border: Color::Rgb(48, 54, 61), input_border_busy: Color::Rgb(212, 154, 74), cursor: Color::Rgb(240, 246, 252),
        }
    }

    fn dark() -> Self {
        Self::default_theme()
    }

    fn light() -> Self {
        let mut t = Self::default_theme();
        t.user_text = Color::Rgb(31, 41, 55);
        t.assistant_text = Color::Rgb(31, 41, 55);
        t.user_message_background = Color::White;
        t.bold_text = t.user_text;
        t.italic_text = t.user_text;
        t.tool_pending = Color::Rgb(100, 116, 139);
        t.tool_running = Color::Rgb(154, 99, 29);
        t.tool_completed = Color::Rgb(71, 121, 76);
        t.tool_failed = Color::Rgb(164, 73, 73);
        t.status_bg = Color::Rgb(248, 250, 252);
        t.status_dim = Color::Rgb(100, 116, 139);
        t.model_accent = Color::Rgb(117, 103, 31);
        t.session_accent = Color::Rgb(49, 95, 159);
        t.heading1 = Color::Rgb(36, 107, 142);
        t.heading2 = Color::Rgb(49, 95, 159);
        t.heading3_plus = Color::Rgb(154, 99, 29);
        t.code_inline = Color::Rgb(154, 99, 29);
        t.link = Color::Rgb(36, 107, 142);
        t.list_marker = Color::Rgb(36, 107, 142);
        t.diag_info = Color::Rgb(36, 107, 142);
        t.diag_warn = Color::Rgb(154, 99, 29);
        t.diag_error = Color::Rgb(164, 73, 73);
        t.input_border = Color::Rgb(51, 65, 85);
        t.input_border_busy = Color::Rgb(154, 99, 29);
        t.cursor = Color::Rgb(15, 23, 42);
        t
    }

    fn monokai() -> Self {
        let mut t = Self::default_theme();
        t.user_text = Color::Rgb(248, 248, 242);
        t.assistant_text = t.user_text;
        t.user_message_background = Color::Rgb(39, 40, 34);
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
            "usermessagebackground" | "usermessagebg" => self.user_message_background = color,
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
        let expected = [Color::Rgb(214, 222, 235), Color::Rgb(201, 209, 217), Color::Rgb(125, 133, 144), Color::Rgb(212, 154, 74), Color::Rgb(124, 169, 130), Color::Rgb(201, 106, 103), Color::Rgb(9, 13, 19), Color::Rgb(127, 179, 200), Color::Rgb(212, 154, 74), Color::Rgb(212, 154, 74)];
        assert_eq!(actual, expected);
    }

    #[test]
    fn default_theme_resolves_pix_tool_palette() {
        let theme = Theme::by_name("default");
        assert_eq!(
            theme.resolve_color_ref("toolTitle"),
            Color::Rgb(154, 167, 180)
        );
        assert_eq!(
            theme.resolve_color_ref("toolMutation"),
            Color::Rgb(212, 122, 162)
        );
        assert_eq!(
            theme.resolve_color_ref("toolSearch"),
            Color::Rgb(168, 137, 214)
        );
        assert_eq!(theme.resolve_color_ref("warning"), Color::Rgb(212, 154, 74));
        assert_eq!(theme.resolve_color_ref("accent"), Color::Rgb(122, 162, 214));
        assert_eq!(theme.resolve_color_ref("muted"), Color::Rgb(125, 133, 144));
    }

    #[test]
    fn light_theme_resolves_pix_tool_palette() {
        let theme = Theme::by_name("light");
        assert_eq!(
            theme.resolve_color_ref("toolTitle"),
            Color::Rgb(82, 96, 112)
        );
        assert_eq!(
            theme.resolve_color_ref("toolMutation"),
            Color::Rgb(163, 58, 104)
        );
        assert_eq!(
            theme.resolve_color_ref("toolSearch"),
            Color::Rgb(109, 82, 165)
        );
        assert_eq!(theme.resolve_color_ref("warning"), Color::Rgb(154, 99, 29));
        assert_eq!(theme.resolve_color_ref("accent"), Color::Rgb(49, 95, 159));
    }

    #[test]
    fn by_name_is_case_insensitive_and_falls_back() {
        assert_eq!(Theme::by_name(" MONOKAI "), Theme::monokai());
        assert_eq!(Theme::by_name("unknown-theme"), Theme::default());
    }

    #[test]
    fn built_in_themes_are_distinct() {
        assert_eq!(Theme::by_name("default"), Theme::by_name("dark"));
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
            Some(Color::Rgb(212, 154, 74))
        );
        assert_eq!(
            theme.style_for(ThemeRole::StatusBg).bg,
            Some(Color::Rgb(9, 13, 19))
        );
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
        assert_eq!(theme.assistant_text, Color::Rgb(201, 209, 217));
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
