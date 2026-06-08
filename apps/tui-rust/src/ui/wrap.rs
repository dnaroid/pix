//! Greedy word/char soft-wrap for terminal output.
//!
//! The TS renderer does greedy word-wrap with a Unicode-aware width function
//! (see `src/app/rendering/render-text.ts`). We mirror that here using
//! `unicode-width` for measuring and a tiny hand-rolled word segmenter.
//!
//! On the Rust side this is only used by the viewport to compute the visual
//! line count and to produce wrapped text for rendering. The wrap is greedy
//! (pack as many words as fit on the current line, never break a word
//! unless it is longer than `width`).

use unicode_width::UnicodeWidthStr;

/// Wrap `text` to fit inside `width` display cells.
///
/// - Existing newlines always start a new line.
/// - Within a paragraph, words are separated by ASCII whitespace. Words
///   longer than `width` are broken at character boundaries.
/// - Empty paragraphs yield one empty line.
/// - `width == 0` is treated as `width == 1` to avoid infinite loops.
pub fn wrap_text(text: &str, width: usize) -> Vec<String> {
    let cap = if width == 0 { 1 } else { width };
    let mut out = Vec::new();
    for paragraph in text.split('\n') {
        if paragraph.is_empty() {
            out.push(String::new());
            continue;
        }
        wrap_paragraph(paragraph, cap, &mut out);
    }
    if out.is_empty() {
        out.push(String::new());
    }
    out
}

fn wrap_paragraph(input: &str, width: usize, out: &mut Vec<String>) {
    let mut line = String::new();
    let mut line_w = 0usize;

    let mut rest = input;
    while !rest.is_empty() {
        let (run, after) = take_word_run(rest);
        let run_w = UnicodeWidthStr::width(run);

        if line_w + run_w <= width {
            line.push_str(run);
            line_w += run_w;
        } else if line_w == 0 {
            // The run alone doesn't fit on a fresh line: hard-break it.
            let mut taken = 0usize;
            let mut buf = String::new();
            for ch in run.chars() {
                let cw = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
                if taken + cw > width && !buf.is_empty() {
                    // Trim trailing whitespace on the emitted piece — it's
                    // just padding that would otherwise leak into the next
                    // line's leading position.
                    while buf.ends_with(' ') {
                        buf.pop();
                    }
                    if !buf.is_empty() {
                        out.push(std::mem::take(&mut buf));
                    }
                    taken = 0;
                }
                buf.push(ch);
                taken += cw;
            }
            if !buf.is_empty() {
                let trimmed = buf.trim_end();
                if !trimmed.is_empty() {
                    line.push_str(trimmed);
                    line_w = UnicodeWidthStr::width(trimmed);
                }
            }
        } else {
            // Strip trailing whitespace from the line before emitting so
            // the next word starts cleanly at column 0 on the new line.
            while line.ends_with(' ') {
                line.pop();
            }
            out.push(std::mem::take(&mut line));
            let trimmed = run.trim_start();
            line.push_str(trimmed);
            line_w = UnicodeWidthStr::width(trimmed);
        }
        rest = after;
    }

    while line.ends_with(' ') {
        line.pop();
    }
    out.push(line);
}

/// Take one "word + following whitespace" run from the input. Returns the
/// run and the remaining slice.
fn take_word_run(s: &str) -> (&str, &str) {
    // Walk forward while accumulating non-whitespace chars, then while
    // accumulating whitespace chars. We use char_indices so the slice
    // boundaries land on UTF-8 boundaries.
    let bytes = s.as_bytes();
    if bytes.is_empty() {
        return ("", "");
    }
    let mut i = 0usize;
    // Non-whitespace
    for (idx, ch) in s.char_indices() {
        if ch.is_whitespace() {
            break;
        }
        i = idx + ch.len_utf8();
    }
    // Whitespace
    for (idx, ch) in s[i..].char_indices() {
        if !ch.is_whitespace() {
            i += idx;
            break;
        }
        // last char of string
        if idx + ch.len_utf8() + i == s.len() {
            i = s.len();
            break;
        }
    }
    // If we exhausted the trailing-whitespace loop without a break, advance
    // to end of string.
    if i < s.len() && s[i..].chars().all(|c| c.is_whitespace()) {
        i = s.len();
    }
    s.split_at(i)
}

/// Collapse runs of consecutive blank lines into a single blank line and
/// strip leading/trailing blank lines.
///
/// Used by sanitizers that hide metadata lines (DCP markers, markdown
/// reference definitions): removing those lines leaves the surrounding
/// newlines behind, which would otherwise render as extra empty rows.
/// Trimming leading/trailing blanks prevents the resulting blank row from
/// combining with the inter-block gap into two consecutive blank rows.
pub fn collapse_blank_runs(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut prev_blank = false;
    let mut last_non_blank_end = 0usize;
    for line in text.split('\n') {
        let is_blank = line.trim().is_empty();
        if is_blank && prev_blank {
            continue;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(line);
        if !is_blank {
            last_non_blank_end = out.len();
        }
        prev_blank = is_blank;
    }
    out.truncate(last_non_blank_end);
    out
}

/// Visual-line count for `text` at the given width. Equivalent to
/// `wrap_text(text, width).len()` but without allocating the strings.
pub fn line_count(text: &str, width: usize) -> usize {
    let cap = if width == 0 { 1 } else { width };
    let mut total = 0usize;
    for paragraph in text.split('\n') {
        if paragraph.is_empty() {
            total += 1;
            continue;
        }
        total += count_paragraph(paragraph, cap);
    }
    if total == 0 {
        1
    } else {
        total
    }
}

fn count_paragraph(input: &str, width: usize) -> usize {
    let mut lines = 1usize;
    let mut line_w = 0usize;
    let mut rest = input;
    while !rest.is_empty() {
        let (run, after) = take_word_run(rest);
        let run_w = UnicodeWidthStr::width(run);
        if line_w + run_w <= width {
            line_w += run_w;
        } else if line_w == 0 {
            // Hard-break; count emitted pieces, ignoring trailing whitespace.
            let mut taken = 0usize;
            let mut piece_chars = 0usize;
            for ch in run.chars() {
                let cw = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
                if taken + cw > width && piece_chars > 0 {
                    lines += 1;
                    taken = 0;
                    piece_chars = 0;
                }
                if !ch.is_whitespace() {
                    piece_chars += 1;
                }
                taken += cw;
            }
            line_w = 0; // trim_end semantics: leftover whitespace discarded
        } else {
            lines += 1;
            let trimmed = run.trim_start();
            line_w = UnicodeWidthStr::width(trimmed);
        }
        rest = after;
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_yields_single_blank_line() {
        let lines = wrap_text("", 10);
        assert_eq!(lines, vec![""]);
        assert_eq!(line_count("", 10), 1);
    }

    #[test]
    fn preserves_existing_newlines() {
        let lines = wrap_text("a\nb\nc", 10);
        assert_eq!(lines, vec!["a", "b", "c"]);
    }

    #[test]
    fn fits_on_one_line() {
        let lines = wrap_text("hello world", 80);
        assert_eq!(lines, vec!["hello world"]);
    }

    #[test]
    fn wraps_on_word_boundary() {
        let lines = wrap_text("alpha beta gamma delta", 11);
        // "alpha beta" (10) fits, "gamma" doesn't, "gamma delta" (11) fits.
        assert_eq!(lines, vec!["alpha beta", "gamma delta"]);
    }

    #[test]
    fn breaks_words_longer_than_width() {
        let lines = wrap_text("abcdefghij", 4);
        assert_eq!(lines, vec!["abcd", "efgh", "ij"]);
    }

    #[test]
    fn zero_width_treated_as_one() {
        let lines = wrap_text("ab", 0);
        assert_eq!(lines, vec!["a", "b"]);
    }

    #[test]
    fn preserves_internal_spacing_on_one_line() {
        // When text fits on a single line, inter-word spaces are kept
        // verbatim (including doubled spaces).
        let lines = wrap_text("foo  bar", 80);
        assert_eq!(lines, vec!["foo  bar"]);
    }

    #[test]
    fn trailing_whitespace_stripped_at_wrap_boundary() {
        // When we wrap mid-text, no trailing space leaks onto the next
        // line. This is the standard word-wrap convention.
        // width 11: "alpha beta " (11) fits, "gamma" doesn't.
        let lines = wrap_text("alpha beta gamma delta", 11);
        assert_eq!(lines, vec!["alpha beta", "gamma delta"]);
    }

    #[test]
    fn collapse_blank_runs_collapses_consecutive_blanks() {
        assert_eq!(collapse_blank_runs("a\n\n\nb"), "a\n\nb");
        assert_eq!(collapse_blank_runs("a\n\n\n\nb"), "a\n\nb");
    }

    #[test]
    fn collapse_blank_runs_preserves_single_blank() {
        assert_eq!(collapse_blank_runs("a\n\nb"), "a\n\nb");
    }

    #[test]
    fn collapse_blank_runs_strips_leading_and_trailing_blanks() {
        assert_eq!(collapse_blank_runs("\n\na\n\n"), "a");
        assert_eq!(collapse_blank_runs("\na\n"), "a");
        assert_eq!(collapse_blank_runs("\n\n"), "");
        assert_eq!(collapse_blank_runs(""), "");
    }

    #[test]
    fn line_count_matches_wrap_text() {
        for (input, w) in [
            ("", 10),
            ("hello", 80),
            ("alpha beta gamma delta", 11),
            ("abcdefghij", 4),
            ("foo\nbar\n\nbaz", 10),
            ("rocket 🚀🚀🚀 go", 6),
        ] {
            assert_eq!(
                line_count(input, w),
                wrap_text(input, w).len(),
                "input={:?} w={}",
                input,
                w
            );
        }
    }
}
