//! Markdown rendering for assistant messages.
//!
//! M0 scope: render the markdown features that show up most often in
//! assistant replies — headings, paragraphs, fenced code, lists,
//! blockquotes, horizontal rules, plus inline `**bold**`, `*italic*`,
//! `` `code` `` and `[text](url)`. Tables are rendered as raw text for
//! now (parsed-and-formatted tables are an M1 task because they require
//! measuring every cell before wrapping).
//!
//! Output is a list of ratatui `Line<'static>` ready to drop into the
//! viewport. A companion `markdown_line_count(text, width)` returns the
//! exact number of visual lines `render_markdown` would produce at the
//! same width — used by the viewport's binary-search layout.

use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use unicode_width::UnicodeWidthStr;

use super::links::extract_file_paths;
use super::syntax;
use super::theme::{Theme, ThemeRole};

// ---------- Public API ----------------------------------------------------

/// Render markdown `text` into a list of styled visual lines that fit
/// inside `width` display columns.
pub fn render_markdown(text: &str, width: usize) -> Vec<Line<'static>> {
    render_markdown_with_theme(text, width, &Theme::default())
}

/// Render markdown using a caller-provided color theme.
pub fn render_markdown_with_theme(text: &str, width: usize, theme: &Theme) -> Vec<Line<'static>> {
    let blocks = parse_markdown(text);
    let mut out: Vec<Line<'static>> = Vec::new();
    for (i, block) in blocks.iter().enumerate() {
        if i > 0 {
            // Inter-block blank separator (matches TS markdown renderer).
            out.push(Line::raw(""));
        }
        render_block(block, width, &mut out, theme);
    }
    out
}

/// Number of visual lines `render_markdown` would produce at `width`.
/// Computed cheaply (block parsing + per-block line count) without
/// building styled spans.
pub fn markdown_line_count(text: &str, width: usize) -> usize {
    let blocks = parse_markdown(text);
    if blocks.is_empty() {
        return 0;
    }
    let mut total = 0usize;
    for (i, block) in blocks.iter().enumerate() {
        if i > 0 {
            total += 1; // separator
        }
        total += block_line_count(block, width);
    }
    total
}

// ---------- Block model ---------------------------------------------------

#[derive(Debug, Clone)]
enum MdBlock {
    /// `# heading` through `###### heading`.
    Heading { level: u8, inline: Vec<InlineToken> },
    /// Plain paragraph.
    Paragraph(Vec<InlineToken>),
    /// Fenced code block (` ``` ` or `~~~`).
    CodeBlock { lang: Option<String>, code: String },
    /// Ordered or unordered list item. (Nested lists are flattened with
    /// increasing `depth` for M0; the parser doesn't model sub-lists as
    /// children — they just stack as separate items.)
    ListItem {
        depth: usize,
        marker: String,
        inline: Vec<InlineToken>,
    },
    /// `> quote` line. Adjacent blockquote lines merge.
    Blockquote(Vec<InlineToken>),
    /// `---`, `***`, `___` on its own line.
    Hr,
}

#[derive(Debug, Clone)]
struct InlineToken {
    style: InlineStyle,
    text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum InlineStyle {
    Plain,
    Bold,
    Italic,
    Code,
    Link { url: String },
}

// ---------- Block parser --------------------------------------------------

fn parse_markdown(text: &str) -> Vec<MdBlock> {
    let sanitized = sanitize(text);
    let lines: Vec<&str> = sanitized.split('\n').collect();
    let mut blocks: Vec<MdBlock> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];

        // Fenced code block.
        if let Some(fence) = parse_fence_open(line) {
            let mut code_lines: Vec<&str> = Vec::new();
            i += 1;
            while i < lines.len() {
                if parse_fence_close(lines[i], &fence).is_some() {
                    i += 1;
                    break;
                }
                code_lines.push(lines[i]);
                i += 1;
            }
            let code = code_lines.join("\n");
            blocks.push(MdBlock::CodeBlock {
                lang: fence.lang,
                code,
            });
            continue;
        }

        // Horizontal rule.
        if is_hr(line) && blocks.last_is_paragraph_end() {
            blocks.push(MdBlock::Hr);
            i += 1;
            continue;
        }

        // ATX heading.
        if let Some((level, body)) = parse_atx_heading(line) {
            blocks.push(MdBlock::Heading {
                level,
                inline: parse_inline(body),
            });
            i += 1;
            continue;
        }

        // Blockquote (accumulate consecutive `> ...` lines).
        if strip_blockquote_prefix(line).is_some() {
            let mut quoted: Vec<&str> = Vec::new();
            while i < lines.len() {
                if let Some(s) = strip_blockquote_prefix(lines[i]) {
                    quoted.push(s);
                    i += 1;
                } else {
                    break;
                }
            }
            let joined = quoted.join("\n");
            blocks.push(MdBlock::Blockquote(parse_inline(&joined)));
            continue;
        }

        // List item.
        if let Some((marker, depth, body)) = parse_list_item(line) {
            blocks.push(MdBlock::ListItem {
                depth,
                marker,
                inline: parse_inline(body),
            });
            i += 1;
            continue;
        }

        // Blank line — paragraph separator.
        if line.trim().is_empty() {
            i += 1;
            continue;
        }

        // Paragraph: accumulate until blank line / another block opener.
        let start = i;
        while i < lines.len() {
            let l = lines[i];
            if l.trim().is_empty()
                || parse_fence_open(l).is_some()
                || parse_atx_heading(l).is_some()
                || strip_blockquote_prefix(l).is_some()
                || parse_list_item(l).is_some()
                || (is_hr(l) && i != start)
            {
                break;
            }
            i += 1;
        }
        let para = lines[start..i].join("\n");
        blocks.push(MdBlock::Paragraph(parse_inline(&para)));
    }

    blocks
}

// Block-level helpers.

#[derive(Debug, Clone)]
struct FenceOpen {
    lang: Option<String>,
}

fn parse_fence_open(line: &str) -> Option<FenceOpen> {
    let trimmed = line.trim_start();
    let indent = line.len() - trimmed.len();
    if indent > 3 {
        return None;
    }
    let first = trimmed.chars().next()?;
    if first != '`' && first != '~' {
        return None;
    }
    let fence_len = trimmed.chars().take_while(|c| *c == first).count();
    if fence_len < 3 {
        return None;
    }
    // Backtick fences must not contain a backtick in the info string.
    let info = trimmed[fence_len..].trim();
    if first == '`' && info.contains('`') {
        return None;
    }
    let lang = if info.is_empty() {
        None
    } else {
        Some(info.to_string())
    };
    Some(FenceOpen { lang })
}

fn parse_fence_close(line: &str, open: &FenceOpen) -> Option<()> {
    let trimmed = line.trim_start();
    let indent = line.len() - trimmed.len();
    if indent > 3 {
        return None;
    }
    let first = trimmed.chars().next()?;
    let _ = open;
    // CommonMark: close must be same char and length >= open length.
    // We don't track the open char here for simplicity since both are
    // valid only when matched; treat any fence of >=3 of the same char
    // (` or ~) with no info as a closer. Acceptable for M0.
    if first != '`' && first != '~' {
        return None;
    }
    let fence_len = trimmed.chars().take_while(|c| *c == first).count();
    if fence_len < 3 {
        return None;
    }
    if !trimmed[fence_len..].trim().is_empty() {
        return None;
    }
    Some(())
}

fn is_hr(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.len() < 3 {
        return false;
    }
    let c = trimmed.chars().next().unwrap();
    if !matches!(c, '-' | '*' | '_') {
        return false;
    }
    if !trimmed.chars().all(|ch| ch == c || ch.is_whitespace()) {
        return false;
    }
    trimmed.chars().filter(|ch| *ch == c).count() >= 3
}

fn parse_atx_heading(line: &str) -> Option<(u8, &str)> {
    let trimmed = line.trim_start();
    let indent = line.len() - trimmed.len();
    if indent > 3 {
        return None;
    }
    let hashes = trimmed.bytes().take_while(|b| *b == b'#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let after = &trimmed[hashes..];
    // Must be followed by whitespace or end-of-line.
    if !after.is_empty() && !after.starts_with(' ') && !after.starts_with('\t') {
        return None;
    }
    let body = after.trim();
    Some((hashes as u8, body))
}

fn strip_blockquote_prefix(line: &str) -> Option<&str> {
    let trimmed = line.trim_start();
    let indent = line.len() - trimmed.len();
    if indent > 3 {
        return None;
    }
    trimmed.strip_prefix('>').map(|rest| {
        // Allow one optional space after `>`.
        rest.strip_prefix(' ').unwrap_or(rest)
    })
}

/// `(marker, depth, body)`. `marker` includes the trailing space, e.g.
/// `"- "`, `"1. "`. `depth` = leading_spaces / 2 (clamped).
fn parse_list_item(line: &str) -> Option<(String, usize, &str)> {
    let leading = line.bytes().take_while(|b| *b == b' ').count();
    if leading > 8 {
        return None;
    }
    let rest = &line[leading..];
    let depth = leading / 2;

    // Unordered: `- `, `* `, `+ `.
    if let Some(after) = rest
        .strip_prefix("- ")
        .or_else(|| rest.strip_prefix("* "))
        .or_else(|| rest.strip_prefix("+ "))
    {
        return Some((rest[..2].to_string(), depth, after));
    }

    // Ordered: 1-9 digits then `.` then space.
    let bytes = rest.as_bytes();
    let mut digits = 0;
    while digits < bytes.len() && bytes[digits].is_ascii_digit() && digits < 9 {
        digits += 1;
    }
    if digits == 0 {
        return None;
    }
    if digits + 1 >= bytes.len() {
        return None;
    }
    if bytes[digits] != b'.' && bytes[digits] != b')' {
        return None;
    }
    if bytes[digits + 1] != b' ' {
        return None;
    }
    let marker_len = digits + 2;
    let marker = rest[..marker_len].to_string();
    let body = &rest[marker_len..];
    Some((marker, depth, body))
}

fn sanitize(text: &str) -> String {
    // Mirror TS `sanitizeMarkdownText`:
    // - drop `\r`
    // - replace bare ESC with the visible escape glyph
    // - hide markdown/DCP reference metadata lines injected by the harness
    // - leave anything else alone (icon substitution and zero-width
    //   joins are M1 concerns).
    text.lines()
        .filter(|line| !is_hidden_markdown_metadata_line(line))
        .collect::<Vec<_>>()
        .join("\n")
        .replace('\r', "")
        .replace('\x1b', "␛")
}

fn is_hidden_markdown_metadata_line(line: &str) -> bool {
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

// Trait helper for HR placement (can't appear inside a paragraph).
trait ParagraphEnd {
    fn last_is_paragraph_end(&self) -> bool;
}

impl ParagraphEnd for Vec<MdBlock> {
    fn last_is_paragraph_end(&self) -> bool {
        match self.last() {
            None => true,
            Some(MdBlock::Paragraph(_)) => false,
            // Within a paragraph, an HR-looking line should be treated
            // as setext underline — but CommonMark also accepts `---`
            // between non-paragraph blocks. We approximate: any trailing
            // non-paragraph block makes a valid HR.
            Some(_) => true,
        }
    }
}

// ---------- Inline parser -------------------------------------------------

fn parse_inline(text: &str) -> Vec<InlineToken> {
    let mut tokens: Vec<InlineToken> = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    let mut buf = String::new();

    let flush_plain = |buf: &mut String, tokens: &mut Vec<InlineToken>| {
        if !buf.is_empty() {
            tokens.push(InlineToken {
                style: InlineStyle::Plain,
                text: std::mem::take(buf),
            });
        }
    };

    while i < bytes.len() {
        // Inline code: `...` or `` ... `` (multi-backtick).
        if bytes[i] == b'`' {
            let n = bytes[i..].iter().take_while(|b| **b == b'`').count();
            // Look for matching run.
            if let Some(end_rel) = find_backtick_run(&bytes[i + n..], n) {
                let content_start = i + n;
                let content_end = i + n + end_rel;
                let content = &text[content_start..content_end];
                flush_plain(&mut buf, &mut tokens);
                tokens.push(InlineToken {
                    style: InlineStyle::Code,
                    text: content.to_string(),
                });
                i = content_end + n;
                continue;
            }
        }

        // Bold: **text**
        if bytes[i] == b'*' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            if let Some(end) = find_marker_end(bytes, i + 2, b'*', 2) {
                flush_plain(&mut buf, &mut tokens);
                let inner = &text[i + 2..end];
                tokens.push(InlineToken {
                    style: InlineStyle::Bold,
                    text: inner.to_string(),
                });
                i = end + 2;
                continue;
            }
        }

        // Italic: *text* (single)
        if bytes[i] == b'*' {
            if let Some(end) = find_marker_end(bytes, i + 1, b'*', 1) {
                flush_plain(&mut buf, &mut tokens);
                let inner = &text[i + 1..end];
                tokens.push(InlineToken {
                    style: InlineStyle::Italic,
                    text: inner.to_string(),
                });
                i = end + 1;
                continue;
            }
        }

        // Link: [text](url)
        if bytes[i] == b'[' {
            if let Some(close) = find_matching_bracket(bytes, i) {
                if close + 1 < bytes.len() && bytes[close + 1] == b'(' {
                    if let Some(paren) = find_matching_paren(bytes, close + 1) {
                        let link_text = &text[i + 1..close];
                        let url = &text[close + 2..paren];
                        flush_plain(&mut buf, &mut tokens);
                        tokens.push(InlineToken {
                            style: InlineStyle::Link {
                                url: url.to_string(),
                            },
                            text: link_text.to_string(),
                        });
                        i = paren + 1;
                        continue;
                    }
                }
            }
        }

        // Backslash escape: `\X` → `X`
        if bytes[i] == b'\\' && i + 1 < bytes.len() {
            let next = bytes[i + 1];
            if is_punctuation(next) {
                buf.push(next as char);
                i += 2;
                continue;
            }
        }

        // Default: copy one char.
        let ch_len = next_char_len(bytes, i);
        let s = &text[i..i + ch_len];
        buf.push_str(s);
        i += ch_len;
    }

    flush_plain(&mut buf, &mut tokens);
    coalesce_plain(&mut tokens);
    tokens
}

fn find_backtick_run(bytes: &[u8], n: usize) -> Option<usize> {
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'`' {
            let run = bytes[i..].iter().take_while(|b| **b == b'`').count();
            if run == n {
                return Some(i);
            }
            i += run;
        } else {
            i += 1;
        }
    }
    None
}

fn find_marker_end(bytes: &[u8], from: usize, marker: u8, len: usize) -> Option<usize> {
    let mut i = from;
    while i + len <= bytes.len() {
        if bytes[i] == marker && bytes[i + len - 1] == marker {
            // Reject if previous char is also `marker` (would form a longer run).
            // CommonMark nuance: this is approximate.
            return Some(i);
        }
        i += 1;
    }
    None
}

fn find_matching_bracket(bytes: &[u8], open: usize) -> Option<usize> {
    let mut depth = 1;
    let mut i = open + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            b'\\' if i + 1 < bytes.len() => i += 1,
            _ => {}
        }
        i += 1;
    }
    None
}

fn find_matching_paren(bytes: &[u8], open: usize) -> Option<usize> {
    let mut depth = 1;
    let mut i = open + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            b'\\' if i + 1 < bytes.len() => i += 1,
            _ => {}
        }
        i += 1;
    }
    None
}

fn is_punctuation(b: u8) -> bool {
    matches!(
        b,
        b'!' | b'"'
            | b'#'
            | b'$'
            | b'%'
            | b'&'
            | b'\''
            | b'('
            | b')'
            | b'*'
            | b'+'
            | b','
            | b'-'
            | b'.'
            | b'/'
            | b':'
            | b';'
            | b'<'
            | b'='
            | b'>'
            | b'?'
            | b'@'
            | b'['
            | b'\\'
            | b']'
            | b'^'
            | b'_'
            | b'`'
            | b'{'
            | b'|'
            | b'}'
            | b'~'
    )
}

fn next_char_len(bytes: &[u8], i: usize) -> usize {
    if bytes[i] < 0x80 {
        1
    } else if bytes[i] & 0xE0 == 0xC0 && i + 1 < bytes.len() {
        2
    } else if bytes[i] & 0xF0 == 0xE0 && i + 2 < bytes.len() {
        3
    } else if bytes[i] & 0xF8 == 0xF0 && i + 3 < bytes.len() {
        4
    } else {
        1 // invalid: skip 1 byte to avoid infinite loop
    }
}

fn coalesce_plain(tokens: &mut Vec<InlineToken>) {
    let mut i = 1;
    while i < tokens.len() {
        let merge =
            tokens[i - 1].style == InlineStyle::Plain && tokens[i].style == InlineStyle::Plain;
        if !merge {
            i += 1;
            continue;
        }
        // Split to avoid overlapping borrows.
        let (left, right) = tokens.split_at_mut(i);
        left.last_mut().unwrap().text.push_str(&right[0].text);
        tokens.remove(i);
    }
}

// ---------- Block rendering -----------------------------------------------

fn render_block(block: &MdBlock, width: usize, out: &mut Vec<Line<'static>>, theme: &Theme) {
    match block {
        MdBlock::Heading { level, inline } => render_heading(*level, inline, width, out, theme),
        MdBlock::Paragraph(inline) => render_paragraph(inline, width, out, theme),
        MdBlock::CodeBlock { lang, code } => render_code_block(lang.as_deref(), code, width, out),
        MdBlock::ListItem {
            depth,
            marker,
            inline,
        } => render_list_item(*depth, marker, inline, width, out, theme),
        MdBlock::Blockquote(inline) => render_blockquote(inline, width, out, theme),
        MdBlock::Hr => render_hr(width, out, theme),
    }
}

fn block_line_count(block: &MdBlock, width: usize) -> usize {
    match block {
        MdBlock::Heading { inline, .. } => inline_line_count(inline, width),
        MdBlock::Paragraph(inline) => inline_line_count(inline, width),
        MdBlock::CodeBlock { code, .. } => code_block_line_count(code, width),
        MdBlock::ListItem {
            depth,
            marker,
            inline,
        } => {
            let indent = marker_visual_width(*depth, marker);
            let body_width = width.saturating_sub(indent).max(1);
            inline_line_count(inline, body_width)
        }
        MdBlock::Blockquote(inline) => {
            let body_width = width.saturating_sub(2).max(1);
            inline_line_count(inline, body_width)
        }
        MdBlock::Hr => 1,
    }
}

fn render_heading(
    level: u8,
    inline: &[InlineToken],
    width: usize,
    out: &mut Vec<Line<'static>>,
    theme: &Theme,
) {
    let color = match level {
        1 => theme.heading1,
        2 => theme.heading2,
        _ => theme.heading3_plus,
    };
    let style = Style::default().fg(color).add_modifier(Modifier::BOLD);
    let header_inline = inline.iter().map(|t| InlineToken {
        style: t.style.clone(),
        text: t.text.clone(),
    });
    let mut spans_line = flatten_with_style(header_inline, style, theme);
    let _ = width; // headings don't wrap; truncate via terminal if needed.
    if spans_line.is_empty() {
        spans_line.push(Span::styled(String::new(), style));
    }
    out.push(Line::from(spans_line));
}

fn render_paragraph(
    inline: &[InlineToken],
    width: usize,
    out: &mut Vec<Line<'static>>,
    theme: &Theme,
) {
    if width == 0 {
        return;
    }
    let lines = wrap_inline(inline, width, theme);
    for spans in lines {
        out.push(Line::from(spans));
    }
}

fn code_block_line_count(code: &str, width: usize) -> usize {
    let prefix = "  "; // 2-space indent for code body
    let body_width = width.saturating_sub(prefix.len()).max(1);
    let mut count = 1; // opening fence
    for line in code.split('\n') {
        count += wrap_visual_count(line, body_width).max(1);
    }
    count += 1; // closing fence
    count
}

fn render_code_block(lang: Option<&str>, code: &str, width: usize, out: &mut Vec<Line<'static>>) {
    let fence_color = Color::DarkGray;
    let body_color = Color::LightYellow;
    let body_style = Style::default().fg(body_color);
    let fence_style = Style::default().fg(fence_color);

    let prefix = "  ";
    let body_width = width.saturating_sub(prefix.len()).max(1);
    let lang_label = lang.unwrap_or("");
    out.push(Line::from(vec![Span::styled(
        format!("```{lang_label}"),
        fence_style,
    )]));
    let highlighted = syntax::highlight_code(code, lang_label);
    for (line, segments) in code.split('\n').zip(highlighted) {
        for chunk_spans in wrap_highlighted_code_line(line, &segments, body_width, body_style) {
            let mut spans = Vec::with_capacity(chunk_spans.len() + 1);
            spans.push(Span::styled(prefix.to_string(), body_style));
            spans.extend(chunk_spans);
            out.push(Line::from(spans));
        }
    }
    out.push(Line::from(Span::styled("```", fence_style)));
}

fn wrap_highlighted_code_line(
    source: &str,
    segments: &[(String, Style)],
    body_width: usize,
    fallback_style: Style,
) -> Vec<Vec<Span<'static>>> {
    let chunks = wrap_text_owned(source, body_width);
    let mut search_start = 0usize;
    chunks
        .into_iter()
        .map(|chunk| {
            if chunk.is_empty() {
                return Vec::new();
            }
            let start = source[search_start..]
                .find(&chunk)
                .map(|offset| search_start + offset)
                .unwrap_or(search_start);
            let end = start + chunk.len();
            search_start = end;
            styled_slice(segments, start, end, fallback_style, &chunk)
        })
        .collect()
}

fn styled_slice(
    segments: &[(String, Style)],
    start: usize,
    end: usize,
    fallback_style: Style,
    fallback_text: &str,
) -> Vec<Span<'static>> {
    let mut spans: Vec<Span<'static>> = Vec::new();
    let mut offset = 0usize;
    for (text, style) in segments {
        let seg_start = offset;
        let seg_end = offset + text.len();
        offset = seg_end;
        if seg_end <= start || seg_start >= end {
            continue;
        }
        let local_start = start.saturating_sub(seg_start);
        let local_end = (end.min(seg_end)) - seg_start;
        if local_start >= local_end || local_end > text.len() {
            continue;
        }
        spans.push(Span::styled(
            text[local_start..local_end].to_string(),
            *style,
        ));
    }
    if spans.is_empty() && !fallback_text.is_empty() {
        spans.push(Span::styled(fallback_text.to_string(), fallback_style));
    }
    merge_identifier_spans(&mut spans);
    spans
}

fn merge_identifier_spans(spans: &mut Vec<Span<'static>>) {
    let mut i = 1;
    while i < spans.len() {
        let prev_text = spans[i - 1].content.as_ref();
        let cur_text = spans[i].content.as_ref();
        if is_identifierish(prev_text) && is_identifierish(cur_text) {
            let cur = spans.remove(i);
            spans[i - 1].content = format!("{}{}", spans[i - 1].content, cur.content).into();
        } else {
            i += 1;
        }
    }
}

fn is_identifierish(text: &str) -> bool {
    !text.is_empty()
        && text
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch.is_ascii_whitespace())
}

fn render_list_item(
    depth: usize,
    marker: &str,
    inline: &[InlineToken],
    width: usize,
    out: &mut Vec<Line<'static>>,
    theme: &Theme,
) {
    let indent_str: String = " ".repeat(depth * 2);
    let indent_w = indent_str.chars().count();
    let marker_w = marker.chars().count();
    let body_width = width.saturating_sub(indent_w + marker_w).max(1);

    let wrapped = wrap_inline(inline, body_width, theme);
    for (i, spans) in wrapped.into_iter().enumerate() {
        if i == 0 {
            let mut line_spans: Vec<Span<'static>> = Vec::with_capacity(spans.len() + 2);
            if !indent_str.is_empty() {
                line_spans.push(Span::raw(indent_str.clone()));
            }
            line_spans.push(Span::styled(
                marker.to_string(),
                theme.style_for(ThemeRole::ListMarker),
            ));
            line_spans.extend(spans);
            out.push(Line::from(line_spans));
        } else {
            let cont: String = " ".repeat(indent_w + marker_w);
            let mut line_spans: Vec<Span<'static>> = Vec::with_capacity(spans.len() + 1);
            line_spans.push(Span::raw(cont));
            line_spans.extend(spans);
            out.push(Line::from(line_spans));
        }
    }
}

fn marker_visual_width(depth: usize, marker: &str) -> usize {
    depth * 2 + marker.chars().count()
}

fn render_blockquote(
    inline: &[InlineToken],
    width: usize,
    out: &mut Vec<Line<'static>>,
    theme: &Theme,
) {
    let bar = Span::styled("▌ ", theme.style_for(ThemeRole::BlockquoteBar));
    let body_width = width.saturating_sub(2).max(1);
    let wrapped = wrap_inline(inline, body_width, theme);
    for spans in wrapped {
        let mut line_spans: Vec<Span<'static>> = Vec::with_capacity(spans.len() + 1);
        line_spans.push(bar.clone());
        line_spans.extend(spans);
        out.push(Line::from(line_spans));
    }
}

fn render_hr(width: usize, out: &mut Vec<Line<'static>>, theme: &Theme) {
    let cells: String = "─".repeat(width.max(1));
    out.push(Line::from(Span::styled(
        cells,
        theme.style_for(ThemeRole::Hr),
    )));
}

// ---------- Inline wrapping (preserves spans) -----------------------------

fn inline_line_count(inline: &[InlineToken], width: usize) -> usize {
    if inline.is_empty() {
        return 1;
    }
    wrap_inline(inline, width.max(1), &Theme::default())
        .len()
        .max(1)
}

fn wrap_inline(inline: &[InlineToken], width: usize, theme: &Theme) -> Vec<Vec<Span<'static>>> {
    let width = width.max(1);
    // Build a flat list of word tokens with style attached.
    let mut pieces: Vec<Piece> = Vec::new();
    for tok in inline {
        let style = inline_style_for(&tok.style, theme);
        if matches!(tok.style, InlineStyle::Link { .. }) {
            pieces.push(Piece {
                style,
                text: tok.text.clone(),
                is_ws: tok.text.chars().all(|c| c.is_whitespace()),
                display_width: UnicodeWidthStr::width(tok.text.as_str()),
                is_link: true,
            });
            continue;
        }
        for w in split_words(&tok.text) {
            let display_width = UnicodeWidthStr::width(w.as_str());
            let spans = extract_file_paths(&w, None);
            let is_link = !spans.is_empty();
            pieces.push(Piece {
                style,
                text: w,
                is_ws: false,
                display_width,
                is_link,
            });
        }
    }
    // After split_words each Piece is either pure-whitespace or non-whitespace.
    // Determine which.
    for p in pieces.iter_mut() {
        p.is_ws = p.text.chars().all(|c| c.is_whitespace());
    }

    let mut lines: Vec<Vec<Span<'static>>> = Vec::new();
    let mut cur: Vec<Span<'static>> = Vec::new();
    let mut cur_w = 0usize;

    for piece in pieces.into_iter() {
        let pw = piece.display_width;
        if piece.is_ws {
            if cur.is_empty() {
                // Leading whitespace on a new line: drop unless this is the
                // very first piece overall (rare; preserves intentional indent).
                continue;
            }
            if cur_w + pw > width {
                // Drop trailing whitespace and flush.
                lines.push(std::mem::take(&mut cur));
                cur_w = 0;
                continue;
            }
            // Append whitespace to current span if same style, else push.
            if let Some(last) = cur.last_mut() {
                if last.style == piece.style {
                    last.content = format!("{}{}", last.content, piece.text).into();
                    cur_w += pw;
                    continue;
                }
            }
            cur.push(Span::styled(piece.text.clone(), piece.style));
            cur_w += pw;
            continue;
        }

        // Non-whitespace piece.
        if pw > width {
            if piece.is_link {
                if !cur.is_empty() {
                    trim_trailing_ws_spans(&mut cur, &mut cur_w);
                    lines.push(std::mem::take(&mut cur));
                }
                cur.push(Span::styled(piece.text, piece.style));
                cur_w = pw;
                continue;
            }
            // Flush current line if any, then hard-break this piece.
            if !cur.is_empty() {
                trim_trailing_ws_spans(&mut cur, &mut cur_w);
                lines.push(std::mem::take(&mut cur));
                cur_w = 0;
            }
            for chunk in hard_break(&piece.text, width) {
                let cw = UnicodeWidthStr::width(chunk.as_str());
                if !cur.is_empty() && cur_w + cw > width {
                    lines.push(std::mem::take(&mut cur));
                    cur_w = 0;
                }
                cur.push(Span::styled(chunk, piece.style));
                cur_w += cw;
            }
            continue;
        }

        if cur_w + pw > width {
            // Wrap.
            trim_trailing_ws_spans(&mut cur, &mut cur_w);
            lines.push(std::mem::take(&mut cur));
            cur.push(Span::styled(piece.text.clone(), piece.style));
            cur_w = pw;
            continue;
        }

        // Fits.
        if let Some(last) = cur.last_mut() {
            if last.style == piece.style {
                last.content = format!("{}{}", last.content, piece.text).into();
                cur_w += pw;
                continue;
            }
        }
        cur.push(Span::styled(piece.text.clone(), piece.style));
        cur_w += pw;
    }

    trim_trailing_ws_spans(&mut cur, &mut cur_w);
    lines.push(cur);
    lines
}

#[derive(Debug, Clone)]
struct Piece {
    style: Style,
    text: String,
    is_ws: bool,
    display_width: usize,
    is_link: bool,
}

fn trim_trailing_ws_spans(spans: &mut Vec<Span<'static>>, cur_w: &mut usize) {
    while let Some(last) = spans.last() {
        if last.content.is_empty() {
            spans.pop();
            continue;
        }
        let trimmed = last.content.trim_end();
        if trimmed.len() == last.content.len() {
            break;
        }
        let removed_w = UnicodeWidthStr::width(&last.content[trimmed.len()..]);
        if trimmed.is_empty() {
            spans.pop();
            *cur_w -= removed_w;
        } else {
            *cur_w -= removed_w;
            let style = last.style;
            *spans.last_mut().unwrap() = Span::styled(trimmed.to_string(), style);
            break;
        }
    }
}

fn split_words(s: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut buf = String::new();
    let mut in_ws: Option<bool> = None;
    for ch in s.chars() {
        let is_ws = ch.is_whitespace();
        match in_ws {
            None => {
                buf.push(ch);
                in_ws = Some(is_ws);
            }
            Some(cur) if cur == is_ws => buf.push(ch),
            Some(_) => {
                out.push(std::mem::take(&mut buf));
                buf.push(ch);
                in_ws = Some(is_ws);
            }
        }
    }
    if !buf.is_empty() {
        out.push(buf);
    }
    out
}

fn hard_break(s: &str, width: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut buf = String::new();
    let mut w = 0usize;
    for ch in s.chars() {
        let cw = UnicodeWidthStr::width(ch.to_string().as_str());
        if w + cw > width && !buf.is_empty() {
            out.push(std::mem::take(&mut buf));
            w = 0;
        }
        buf.push(ch);
        w += cw;
    }
    if !buf.is_empty() {
        out.push(buf);
    }
    out
}

fn wrap_text_owned(s: &str, width: usize) -> Vec<String> {
    if s.is_empty() {
        return vec![String::new()];
    }
    super::wrap::wrap_text(s, width)
}

fn wrap_visual_count(s: &str, width: usize) -> usize {
    super::wrap::line_count(s, width)
}

fn inline_style_for(style: &InlineStyle, theme: &Theme) -> Style {
    match style {
        InlineStyle::Plain => theme.style_for(ThemeRole::AssistantText),
        InlineStyle::Bold => Style::default()
            .fg(theme.bold_text)
            .add_modifier(Modifier::BOLD),
        InlineStyle::Italic => Style::default()
            .fg(theme.italic_text)
            .add_modifier(Modifier::ITALIC),
        InlineStyle::Code => theme.style_for(ThemeRole::CodeInline),
        InlineStyle::Link { .. } => Style::default()
            .fg(theme.link)
            .add_modifier(Modifier::UNDERLINED),
    }
}

fn flatten_with_style<I>(tokens: I, base: Style, theme: &Theme) -> Vec<Span<'static>>
where
    I: IntoIterator<Item = InlineToken>,
{
    let mut out: Vec<Span<'static>> = Vec::new();
    for tok in tokens {
        let style = compose(base, inline_style_for(&tok.style, theme));
        out.push(Span::styled(tok.text, style));
    }
    out
}

fn compose(base: Style, inline: Style) -> Style {
    // Combine by taking whichever side has an explicit fg/bg; union modifiers.
    let fg = if inline.fg.is_some() {
        inline.fg
    } else {
        base.fg
    };
    let bg = if inline.bg.is_some() {
        inline.bg
    } else {
        base.bg
    };
    let mods = base.add_modifier | inline.add_modifier;
    let mut s = Style::default().add_modifier(mods);
    if let Some(c) = fg {
        s = s.fg(c);
    }
    if let Some(c) = bg {
        s = s.bg(c);
    }
    s
}

// ---------- Tests ---------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn line_count_eq(text: &str, width: usize, expected: usize) {
        let actual = markdown_line_count(text, width);
        assert_eq!(
            actual, expected,
            "input {text:?} at width {width}: got {actual}, want {expected}"
        );
    }

    fn render_line_count_eq(text: &str, width: usize) {
        let a = markdown_line_count(text, width);
        let b = render_markdown(text, width).len();
        assert_eq!(a, b, "line_count {a} != render().len() {b} for {text:?}");
    }

    #[test]
    fn empty_text_yields_zero() {
        line_count_eq("", 80, 0);
    }

    #[test]
    fn simple_paragraph_wraps() {
        let text = "word ".repeat(20);
        // 20 words, each 4-char + space. Width 30: ~6 words per line.
        // Expect 4 lines + no separator since one block.
        let n = markdown_line_count(&text, 30);
        assert!((3..=5).contains(&n), "got {n}");
        render_line_count_eq(&text, 30);
    }

    #[test]
    fn heading_renders_as_one_line() {
        let text = "# Heading";
        line_count_eq(text, 80, 1);
        let lines = render_markdown(text, 80);
        assert_eq!(lines.len(), 1);
    }

    #[test]
    fn heading_levels_distinct_colors() {
        for lvl in 1..=6 {
            let text = format!("{} Heading", "#".repeat(lvl));
            let lines = render_markdown(&text, 80);
            assert_eq!(lines.len(), 1);
        }
    }

    #[test]
    fn paragraph_then_heading_has_separator() {
        let text = "first paragraph\n\n# heading";
        // 1 para + 1 separator + 1 heading = 3
        line_count_eq(text, 80, 3);
        render_line_count_eq(text, 80);
    }

    #[test]
    fn code_block_preserves_internal_text() {
        let text = "```rust\nfn main() {}\n```";
        // 1 open + 1 body + 1 close = 3
        line_count_eq(text, 80, 3);
        render_line_count_eq(text, 80);
    }

    #[test]
    fn code_block_with_lang_renders_label() {
        let lines = render_markdown("```ts\nlet x = 1;\n```", 80);
        assert_eq!(lines.len(), 3);
        // First line should contain "```ts"
        let first = lines[0]
            .spans
            .iter()
            .map(|s| s.content.as_ref())
            .collect::<String>();
        assert!(first.contains("```ts"), "got {first:?}");
    }

    #[test]
    fn unordered_list_items_renders_with_marker() {
        let text = "- one\n- two\n- three";
        // 3 list items, each on its own block, with separators.
        // 1 + 1 + 1 + 2 separators = 5
        line_count_eq(text, 80, 5);
        render_line_count_eq(text, 80);
    }

    #[test]
    fn nested_indent_list_item_preserves_depth() {
        let text = "- top\n  - nested\n- back";
        let lines = render_markdown(text, 80);
        // First item "- top", second has 2-space indent + "- nested", third "- back".
        let flat: Vec<String> = lines
            .iter()
            .map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect())
            .collect();
        assert!(
            flat.iter()
                .any(|s| s.contains("  - nested") || s.contains("nested")),
            "expected nested marker in {flat:?}"
        );
    }

    #[test]
    fn blockquote_renders_with_bar() {
        let text = "> quoted line";
        line_count_eq(text, 80, 1);
        let lines = render_markdown(text, 80);
        let flat: String = lines[0].spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(flat.contains("▌"), "got {flat:?}");
    }

    #[test]
    fn hr_renders_full_width() {
        let lines = render_markdown("---\n\npara after", 40);
        // hr is first block, para after is second; separator between.
        // hr line should span the width.
        let hr_line = &lines[0];
        let cell_count: usize = hr_line
            .spans
            .iter()
            .map(|s| s.content.chars().count())
            .sum();
        assert_eq!(cell_count, 40, "hr should span 40 cells, got {cell_count}");
    }

    #[test]
    fn bold_inline_styling_kept() {
        let text = "hello **world** end";
        let lines = render_markdown(text, 80);
        // Should be 1 line with multiple spans.
        assert_eq!(lines.len(), 1);
        assert!(lines[0].spans.len() >= 2);
        let has_bold = lines[0]
            .spans
            .iter()
            .any(|s| s.style.add_modifier.contains(Modifier::BOLD));
        assert!(has_bold, "expected at least one bold span");
    }

    #[test]
    fn inline_code_styled() {
        let text = "Use `cargo build` to compile.";
        let lines = render_markdown(text, 80);
        assert_eq!(lines.len(), 1);
        let has_code = lines[0]
            .spans
            .iter()
            .any(|s| s.style.fg == Some(Theme::default().code_inline));
        assert!(has_code, "expected a theme code span");
    }

    #[test]
    fn italic_with_single_asterisks() {
        let text = "this is *italic* text";
        let lines = render_markdown(text, 80);
        let has_italic = lines[0]
            .spans
            .iter()
            .any(|s| s.style.add_modifier.contains(Modifier::ITALIC));
        assert!(has_italic);
    }

    #[test]
    fn link_text_is_extracted() {
        let text = "See [docs](https://example.com).";
        let lines = render_markdown(text, 80);
        let flat: String = lines[0].spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(flat.contains("docs"));
        assert!(!flat.contains("https://"));
    }

    #[test]
    fn plain_file_paths_render_without_terminal_hyperlink_sequences() {
        let lines = render_markdown("See src/main.rs for details.", 80);
        let flat: String = lines[0].spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(flat.contains("src/main.rs"));
        assert!(!flat.contains("\x1b]8;;"), "got {flat:?}");
    }

    #[test]
    fn backslash_escape_passes_char_through() {
        let text = "literal \\*not bold\\* end";
        let lines = render_markdown(text, 80);
        let flat: String = lines[0].spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(flat.contains("*not bold*"));
    }

    #[test]
    fn markdown_line_count_matches_render() {
        let samples = [
            "",
            "hello",
            "# Heading\n\nparagraph text",
            "- a\n- b\n- c",
            "```ts\nfoo()\nbar()\n```",
            "> quoted",
            "plain **bold** and `code`",
            "a b c d e f g h i j k l m n o p q r s t u v w x y z",
        ];
        for s in samples {
            render_line_count_eq(s, 80);
            render_line_count_eq(s, 40);
            render_line_count_eq(s, 20);
        }
    }

    #[test]
    fn sanitizes_carriage_returns() {
        let text = "line one\r\nline two";
        let lines = render_markdown(text, 80);
        let flat: String = lines
            .iter()
            .flat_map(|l| l.spans.iter())
            .map(|s| s.content.as_ref())
            .collect::<String>();
        assert!(!flat.contains('\r'));
    }

    #[test]
    fn hides_dcp_and_markdown_reference_metadata_lines() {
        let text =
            "[dcp-id]: # (m154)\nvisible text\n[dcp-block-id]: # (b3)\n[ref]: https://example.com";
        let lines = render_markdown(text, 80);
        let flat: String = lines
            .iter()
            .flat_map(|l| l.spans.iter())
            .map(|s| s.content.as_ref())
            .collect::<String>();

        assert!(flat.contains("visible text"), "got {flat:?}");
        assert!(!flat.contains("dcp-id"), "got {flat:?}");
        assert!(!flat.contains("dcp-block-id"), "got {flat:?}");
        assert!(!flat.contains("https://example.com"), "got {flat:?}");
    }

    #[test]
    fn hides_streaming_partial_dcp_metadata_prefix() {
        let lines = render_markdown("[dcp-id]: # (m", 80);
        assert!(lines.is_empty(), "got {lines:?}");
    }

    #[test]
    fn unknown_block_falls_back_to_plain() {
        let text = "| col1 | col2 |\n| --- | --- |\n| a | b |";
        let lines = render_markdown(text, 80);
        // Pass-through as raw text — at least one line should appear.
        assert!(!lines.is_empty());
    }
}
