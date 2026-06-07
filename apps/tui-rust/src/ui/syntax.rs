//! Syntax highlighting for fenced Markdown code blocks.
//!
//! This module is deliberately small and UI-facing: it hides syntect's
//! lifetime-heavy API and returns owned ratatui styles/spans that the Markdown
//! renderer can wrap and draw without keeping highlighter state around.

use once_cell::sync::Lazy;
use ratatui::style::{Color, Modifier, Style};
use syntect::easy::HighlightLines;
use syntect::highlighting::{Color as SynColor, FontStyle, Style as SynStyle, Theme, ThemeSet};
use syntect::parsing::{SyntaxReference, SyntaxSet};

/// One visual source line split into text segments that share the same style.
pub type HighlightedLine = Vec<(String, Style)>;

static SYNTAX_SET: Lazy<SyntaxSet> = Lazy::new(SyntaxSet::load_defaults_newlines);
static THEME_SET: Lazy<ThemeSet> = Lazy::new(ThemeSet::load_defaults);

/// Highlight `text` as `lang`, returning one entry per source line.
///
/// Unknown/empty languages intentionally fall back to a monochrome style. The
/// returned shape mirrors `text.split('\n')`: empty input therefore yields one
/// empty line, which keeps fenced code block line counts stable.
pub fn highlight_code(text: &str, lang: &str) -> Vec<HighlightedLine> {
    let Some(syntax) = find_syntax(lang) else {
        return plain_lines(text);
    };
    let Some(theme) = selected_theme() else {
        return plain_lines(text);
    };

    let mut highlighter = HighlightLines::new(syntax, theme);
    let mut lines = Vec::new();

    for source_line in text.split('\n') {
        let ranges = match highlighter.highlight_line(source_line, &SYNTAX_SET) {
            Ok(ranges) => ranges,
            Err(_) => return plain_lines(text),
        };
        let mut highlighted = ranges_to_line(ranges);
        if highlighted.is_empty() {
            highlighted.push((String::new(), plain_style()));
        }
        lines.push(highlighted);
    }

    if lines.is_empty() {
        vec![vec![(String::new(), plain_style())]]
    } else {
        lines
    }
}

fn ranges_to_line(ranges: Vec<(SynStyle, &str)>) -> HighlightedLine {
    let mut out: HighlightedLine = Vec::new();
    for (syn_style, text) in ranges {
        if text.is_empty() {
            continue;
        }
        let style = style_from_syntect(syn_style);
        if let Some((last_text, last_style)) = out.last_mut() {
            if *last_style == style {
                last_text.push_str(text);
                continue;
            }
        }
        out.push((text.to_string(), style));
    }
    out
}

fn selected_theme() -> Option<&'static Theme> {
    THEME_SET
        .themes
        .get("base16-ocean.dark")
        .or_else(|| THEME_SET.themes.get("Solarized (dark)"))
        .or_else(|| THEME_SET.themes.get("InspiredGitHub"))
        .or_else(|| THEME_SET.themes.values().next())
}

fn find_syntax(lang: &str) -> Option<&'static SyntaxReference> {
    let normalized = normalize_lang(lang)?;
    let mapped = map_lang_alias(&normalized);

    SYNTAX_SET
        .find_syntax_by_token(mapped)
        .or_else(|| SYNTAX_SET.find_syntax_by_extension(mapped))
        .or_else(|| SYNTAX_SET.find_syntax_by_name(mapped))
}

fn normalize_lang(lang: &str) -> Option<String> {
    let first = lang
        .split(|c: char| c.is_whitespace() || c == ',' || c == ';')
        .find(|part| !part.trim().is_empty())?
        .trim()
        .trim_matches(|c| matches!(c, '{' | '}' | '[' | ']' | '(' | ')' | '"' | '\''))
        .trim_start_matches('.')
        .to_ascii_lowercase();

    if first.is_empty() {
        None
    } else {
        Some(first)
    }
}

fn map_lang_alias(lang: &str) -> &str {
    match lang {
        "rs" | "rust" => "rs",
        "ts" | "typescript" => "ts",
        "tsx" | "typescriptreact" => "tsx",
        "js" | "javascript" | "mjs" | "cjs" => "js",
        "jsx" | "javascriptreact" => "jsx",
        "py" | "python" | "python3" => "py",
        "json" | "jsonc" => "json",
        "bash" | "sh" | "shell" | "zsh" | "ksh" | "fish" | "console" | "terminal" => "sh",
        "toml" => "toml",
        "yaml" | "yml" => "yaml",
        "html" | "htm" => "html",
        "css" | "scss" | "sass" | "less" => lang,
        "md" | "markdown" | "mdown" => "md",
        other => other,
    }
}

fn style_from_syntect(style: SynStyle) -> Style {
    let mut out = Style::default().fg(color_from_syntect(style.foreground));

    if style.font_style.contains(FontStyle::BOLD) {
        out = out.add_modifier(Modifier::BOLD);
    }
    if style.font_style.contains(FontStyle::ITALIC) {
        out = out.add_modifier(Modifier::ITALIC);
    }
    if style.font_style.contains(FontStyle::UNDERLINE) {
        out = out.add_modifier(Modifier::UNDERLINED);
    }

    out
}

fn color_from_syntect(color: SynColor) -> Color {
    Color::Rgb(color.r, color.g, color.b)
}

fn plain_lines(text: &str) -> Vec<HighlightedLine> {
    let mut lines: Vec<HighlightedLine> = text
        .split('\n')
        .map(|line| vec![(line.to_string(), plain_style())])
        .collect();
    if lines.is_empty() {
        lines.push(vec![(String::new(), plain_style())]);
    }
    lines
}

fn plain_style() -> Style {
    Style::default().fg(Color::LightYellow)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flattened(lines: &[HighlightedLine]) -> Vec<String> {
        lines
            .iter()
            .map(|line| line.iter().map(|(text, _)| text.as_str()).collect())
            .collect()
    }

    fn distinct_styles(line: &HighlightedLine) -> usize {
        let mut styles: Vec<Style> = Vec::new();
        for (_, style) in line {
            if !styles.contains(style) {
                styles.push(*style);
            }
        }
        styles.len()
    }

    #[test]
    fn rust_snippet_returns_non_empty_lines_with_multiple_styles() {
        let lines = highlight_code("fn main() {\n    let x = 42;\n}", "rust");

        assert_eq!(lines.len(), 3);
        assert!(lines.iter().all(|line| !line.is_empty()));
        assert!(
            lines.iter().any(|line| distinct_styles(line) > 1),
            "expected at least one Rust line to contain multiple styles: {lines:?}"
        );
        assert_eq!(flattened(&lines)[0], "fn main() {");
    }

    #[test]
    fn unknown_language_falls_back_to_plain_monochrome() {
        let lines = highlight_code("alpha\nbeta", "definitely-not-a-language");

        assert_eq!(flattened(&lines), vec!["alpha", "beta"]);
        assert_eq!(lines.len(), 2);
        for line in lines {
            assert_eq!(line.len(), 1);
            assert_eq!(line[0].1, plain_style());
        }
    }

    #[test]
    fn empty_input_yields_one_empty_plain_line() {
        let lines = highlight_code("", "rust");

        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0], vec![(String::new(), plain_style())]);
    }

    #[test]
    fn multi_line_code_preserves_line_boundaries() {
        let source = "const value = 1;\nconsole.log(value);\n";
        let lines = highlight_code(source, "typescript");

        assert_eq!(lines.len(), 3);
        assert_eq!(
            flattened(&lines),
            vec!["const value = 1;", "console.log(value);", ""]
        );
    }

    #[test]
    fn json_highlighting_preserves_text_and_uses_multiple_styles() {
        let lines = highlight_code("{\"name\": true, \"count\": 3}", "json");

        assert_eq!(flattened(&lines), vec!["{\"name\": true, \"count\": 3}"]);
        assert!(
            distinct_styles(&lines[0]) > 1,
            "expected JSON to have multiple styles: {:?}",
            lines[0]
        );
    }

    #[test]
    fn common_language_aliases_are_supported() {
        for lang in [
            "rs", "ts", "js", "py", "json", "bash", "toml", "yaml", "html", "css", "md",
        ] {
            let lines = highlight_code("let x = 1", lang);
            assert_eq!(lines.len(), 1, "lang {lang}");
            assert_eq!(flattened(&lines), vec!["let x = 1"], "lang {lang}");
        }
    }
}
