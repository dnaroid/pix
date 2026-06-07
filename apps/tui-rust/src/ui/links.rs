//! OSC 8 hyperlink helpers for file paths rendered in the conversation.

use std::path::{Component, Path, PathBuf};

use ratatui::text::Line;
use unicode_width::UnicodeWidthStr;

pub const CLICK_TARGET_PREFIX: &str = "\x1b]8;;";
pub const CLICK_TARGET_SUFFIX: &str = "\x1b\\";

const KNOWN_EXTENSIONS: &[&str] = &[".rs", ".ts", ".tsx", ".js", ".json", ".toml", ".md", ".py"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkSpan {
    pub url: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkClickTarget {
    pub line_idx: usize,
    pub col_start: usize,
    pub col_end: usize,
    pub url: String,
}

#[derive(Debug, Clone)]
struct LinkRange {
    start: usize,
    end: usize,
    span: LinkSpan,
}

/// Extract file-looking path spans from `text`.
pub fn extract_file_paths(text: &str, workspace_root: Option<&Path>) -> Vec<LinkSpan> {
    extract_file_path_ranges(text, workspace_root)
        .into_iter()
        .map(|range| range.span)
        .collect()
}

/// Wrap `text` in an OSC 8 hyperlink envelope.
pub fn envelope_osc8(url: &str, text: &str) -> String {
    format!("{CLICK_TARGET_PREFIX}{url}{CLICK_TARGET_SUFFIX}{text}{CLICK_TARGET_PREFIX}{CLICK_TARGET_SUFFIX}")
}

/// Apply OSC 8 envelopes to all non-overlapping occurrences of `spans`.
pub fn apply_osc8_to_spans(text: &str, spans: &[LinkSpan]) -> String {
    if text.is_empty() || spans.is_empty() {
        return text.to_string();
    }

    let mut candidates: Vec<LinkRange> = Vec::new();
    for span in spans.iter().filter(|span| !span.text.is_empty()) {
        for (start, _) in text.match_indices(&span.text) {
            candidates.push(LinkRange {
                start,
                end: start + span.text.len(),
                span: span.clone(),
            });
        }
    }
    let ranges = dedupe_ranges(candidates);
    if ranges.is_empty() {
        return text.to_string();
    }

    let mut out = String::with_capacity(text.len() + ranges.len() * 32);
    let mut cursor = 0usize;
    for range in ranges {
        if range.start < cursor || range.end > text.len() {
            continue;
        }
        out.push_str(&text[cursor..range.start]);
        out.push_str(&envelope_osc8(
            &range.span.url,
            &text[range.start..range.end],
        ));
        cursor = range.end;
    }
    out.push_str(&text[cursor..]);
    out
}

/// Build click targets for already-rendered lines.
pub fn index_click_targets(
    lines: &[Line<'static>],
    workspace_root: Option<&Path>,
) -> Vec<LinkClickTarget> {
    let mut targets = Vec::new();
    for (line_idx, line) in lines.iter().enumerate() {
        let raw = line
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect::<String>();
        let (visible, mut osc_targets) = osc8_targets_for_line(line_idx, &raw);
        targets.append(&mut osc_targets);

        for range in extract_file_path_ranges(&visible, workspace_root) {
            let col_start = UnicodeWidthStr::width(&visible[..range.start]);
            let col_end = col_start + UnicodeWidthStr::width(range.span.text.as_str());
            if col_end > col_start
                && !targets.iter().any(|target| {
                    target.line_idx == line_idx
                        && ranges_overlap(col_start, col_end, target.col_start, target.col_end)
                })
            {
                targets.push(LinkClickTarget {
                    line_idx,
                    col_start,
                    col_end,
                    url: range.span.url,
                });
            }
        }
    }
    targets
}

fn extract_file_path_ranges(text: &str, workspace_root: Option<&Path>) -> Vec<LinkRange> {
    let mut candidates = Vec::new();
    let mut token_start: Option<usize> = None;

    for (idx, ch) in text.char_indices() {
        if is_token_delimiter(ch) {
            if let Some(start) = token_start.take() {
                push_token_candidate(text, start, idx, workspace_root, &mut candidates);
            }
        } else if token_start.is_none() {
            token_start = Some(idx);
        }
    }
    if let Some(start) = token_start {
        push_token_candidate(text, start, text.len(), workspace_root, &mut candidates);
    }

    dedupe_ranges(candidates)
}

fn push_token_candidate(
    text: &str,
    start: usize,
    end: usize,
    workspace_root: Option<&Path>,
    candidates: &mut Vec<LinkRange>,
) {
    let token = &text[start..end];
    let leading = token
        .char_indices()
        .take_while(|(_, ch)| is_leading_punctuation(*ch))
        .map(|(idx, ch)| idx + ch.len_utf8())
        .last()
        .unwrap_or(0);
    let trailing = token
        .char_indices()
        .rev()
        .take_while(|(_, ch)| is_trailing_punctuation(*ch))
        .map(|(idx, _)| idx)
        .last()
        .unwrap_or(token.len());
    if leading >= trailing {
        return;
    }

    let candidate_start = start + leading;
    let candidate_end = start + trailing;
    let candidate = &text[candidate_start..candidate_end];
    if !looks_like_file_path(candidate) {
        return;
    }
    let Some(url) = file_url(candidate, workspace_root) else {
        return;
    };
    candidates.push(LinkRange {
        start: candidate_start,
        end: candidate_end,
        span: LinkSpan {
            url,
            text: candidate.to_string(),
        },
    });
}

fn looks_like_file_path(text: &str) -> bool {
    if text.len() <= 1 || text.starts_with("http://") || text.starts_with("https://") {
        return false;
    }
    let path_part = strip_line_suffix(text).0;
    if path_part.starts_with('/') {
        return path_part.len() > 1;
    }
    path_part.contains('/') && has_known_extension(path_part)
}

fn has_known_extension(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    KNOWN_EXTENSIONS.iter().any(|ext| lower.ends_with(ext))
}

fn strip_line_suffix(text: &str) -> (&str, Option<&str>) {
    if let Some((path, suffix)) = text.rsplit_once(':') {
        let mut parts = suffix.splitn(2, '+');
        let line = parts.next().unwrap_or_default();
        let limit = parts.next();
        let valid_limit = match limit {
            None => true,
            Some(value) => !value.is_empty() && value.chars().all(|ch| ch.is_ascii_digit()),
        };
        if !line.is_empty() && line.chars().all(|ch| ch.is_ascii_digit()) && valid_limit {
            return (path, Some(suffix));
        }
    }
    (text, None)
}

fn file_url(text: &str, workspace_root: Option<&Path>) -> Option<String> {
    let (path_text, _) = strip_line_suffix(text);
    let path = Path::new(path_text);
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        let base = workspace_root
            .map(Path::to_path_buf)
            .or_else(|| std::env::current_dir().ok())?;
        base.join(path)
    };
    Some(format!("file://{}", normalize_path(&absolute).display()))
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn dedupe_ranges(mut ranges: Vec<LinkRange>) -> Vec<LinkRange> {
    ranges.sort_by(|a, b| {
        let len_a = a.end.saturating_sub(a.start);
        let len_b = b.end.saturating_sub(b.start);
        len_b.cmp(&len_a).then_with(|| a.start.cmp(&b.start))
    });
    let mut selected: Vec<LinkRange> = Vec::new();
    'outer: for range in ranges {
        for existing in &selected {
            if ranges_overlap(range.start, range.end, existing.start, existing.end) {
                continue 'outer;
            }
        }
        selected.push(range);
    }
    selected.sort_by_key(|range| range.start);
    selected
}

fn ranges_overlap(a_start: usize, a_end: usize, b_start: usize, b_end: usize) -> bool {
    a_start < b_end && b_start < a_end
}

fn is_token_delimiter(ch: char) -> bool {
    ch.is_whitespace() || matches!(ch, '"' | '\'' | '`' | '<' | '>' | '|' | '\0')
}

fn is_leading_punctuation(ch: char) -> bool {
    matches!(ch, '(' | '[' | '{')
}

fn is_trailing_punctuation(ch: char) -> bool {
    matches!(ch, '.' | ',' | ';' | '!' | '?' | ')' | ']' | '}')
}

fn osc8_targets_for_line(line_idx: usize, raw: &str) -> (String, Vec<LinkClickTarget>) {
    let mut visible = String::new();
    let mut targets = Vec::new();
    let mut rest = raw;

    while let Some(prefix_pos) = rest.find(CLICK_TARGET_PREFIX) {
        visible.push_str(&rest[..prefix_pos]);
        rest = &rest[prefix_pos + CLICK_TARGET_PREFIX.len()..];
        let Some(url_end) = rest.find(CLICK_TARGET_SUFFIX) else {
            visible.push_str(CLICK_TARGET_PREFIX);
            visible.push_str(rest);
            return (visible, targets);
        };
        let url = &rest[..url_end];
        rest = &rest[url_end + CLICK_TARGET_SUFFIX.len()..];
        let close = format!("{CLICK_TARGET_PREFIX}{CLICK_TARGET_SUFFIX}");
        let Some(text_end) = rest.find(&close) else {
            visible.push_str(rest);
            return (visible, targets);
        };
        let linked_text = &rest[..text_end];
        let col_start = UnicodeWidthStr::width(visible.as_str());
        visible.push_str(linked_text);
        let col_end = UnicodeWidthStr::width(visible.as_str());
        if col_end > col_start && !url.is_empty() {
            targets.push(LinkClickTarget {
                line_idx,
                col_start,
                col_end,
                url: url.to_string(),
            });
        }
        rest = &rest[text_end + close.len()..];
    }
    visible.push_str(rest);
    (visible, targets)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::text::{Line, Span};

    #[test]
    fn extract_absolute_path() {
        let spans = extract_file_paths("open /tmp/demo/file.txt now", None);
        assert_eq!(spans[0].text, "/tmp/demo/file.txt");
        assert_eq!(spans[0].url, "file:///tmp/demo/file.txt");
    }

    #[test]
    fn extract_relative_path_with_known_extension() {
        let root = Path::new("/workspace");
        let spans = extract_file_paths("see src/ui/main.rs", Some(root));
        assert_eq!(spans[0].text, "src/ui/main.rs");
        assert_eq!(spans[0].url, "file:///workspace/src/ui/main.rs");
    }

    #[test]
    fn extract_line_suffix() {
        let spans = extract_file_paths("at src/foo.rs:42", Some(Path::new("/w")));
        assert_eq!(spans[0].text, "src/foo.rs:42");
        assert_eq!(spans[0].url, "file:///w/src/foo.rs");
    }

    #[test]
    fn extract_overlapping_spans_prefers_longest() {
        let spans = extract_file_paths("src/foo.rs:42", Some(Path::new("/w")));
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].text, "src/foo.rs:42");
    }

    #[test]
    fn extract_avoids_plain_text_false_positives() {
        assert!(extract_file_paths("hello world and foo/bar without extension", None).is_empty());
    }

    #[test]
    fn envelope_format_is_correct() {
        assert_eq!(
            envelope_osc8("file:///tmp/a.rs", "a.rs"),
            "\x1b]8;;file:///tmp/a.rs\x1b\\a.rs\x1b]8;;\x1b\\"
        );
    }

    #[test]
    fn apply_single_span_positions() {
        let span = LinkSpan {
            url: "file:///a".into(),
            text: "a.rs".into(),
        };
        assert!(apply_osc8_to_spans("a.rs end", std::slice::from_ref(&span))
            .starts_with(CLICK_TARGET_PREFIX));
        assert!(
            apply_osc8_to_spans("see a.rs end", std::slice::from_ref(&span))
                .contains("see \x1b]8;;file:///a")
        );
        assert!(apply_osc8_to_spans("see a.rs", &[span]).ends_with(CLICK_TARGET_SUFFIX));
    }

    #[test]
    fn apply_multiple_spans_and_unicode_prefix() {
        let spans = vec![
            LinkSpan {
                url: "file:///w/a.rs".into(),
                text: "src/a.rs".into(),
            },
            LinkSpan {
                url: "file:///w/b.ts".into(),
                text: "src/b.ts".into(),
            },
        ];
        let out = apply_osc8_to_spans("λ src/a.rs and src/b.ts", &spans);
        assert_eq!(out.matches(CLICK_TARGET_PREFIX).count(), 4);
        assert!(out.contains("λ "));
    }

    #[test]
    fn index_click_targets_empty_lines() {
        assert!(index_click_targets(&[Line::raw("")], None).is_empty());
    }

    #[test]
    fn index_click_targets_one_link_per_line() {
        let line = Line::from(Span::raw(envelope_osc8("file:///tmp/a.rs", "a.rs")));
        let targets = index_click_targets(&[line], None);
        assert_eq!(
            targets,
            vec![LinkClickTarget {
                line_idx: 0,
                col_start: 0,
                col_end: 4,
                url: "file:///tmp/a.rs".into()
            }]
        );
    }

    #[test]
    fn index_click_targets_unicode_columns() {
        let line = Line::raw("λ src/a.rs");
        let targets = index_click_targets(&[line], Some(Path::new("/w")));
        assert_eq!(targets[0].col_start, 2);
        assert_eq!(targets[0].col_end, 10);
    }

    #[test]
    fn index_click_targets_multiline_span_marks_start_line_only() {
        let lines = vec![
            Line::from(vec![Span::raw(envelope_osc8("file:///tmp/a.rs", "a.rs"))]),
            Line::raw("continued text"),
        ];
        let targets = index_click_targets(&lines, None);
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].line_idx, 0);
    }
}
