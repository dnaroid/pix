//! In-memory session search for the Rust TUI.

use ratatui::style::Modifier;
use ratatui::text::{Line, Span};

use crate::ui::app::{App, Block};
use crate::ui::theme::{Theme, ThemeRole};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchHit {
    pub block_index: usize,
    pub snippet: String,
    pub line_in_block: usize,
    pub score: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SearchStatus {
    Idle,
    Searching,
    Done(usize),
    Error(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionSearchState {
    pub query: String,
    pub results: Vec<SearchHit>,
    pub cursor: usize,
    pub status: SearchStatus,
}

impl Default for SessionSearchState {
    fn default() -> Self {
        Self {
            query: String::new(),
            results: Vec::new(),
            cursor: 0,
            status: SearchStatus::Idle,
        }
    }
}

impl SessionSearchState {
    pub fn open(&mut self, query: impl Into<String>, blocks: &[Block]) {
        self.query = query.into();
        self.cursor = 0;
        self.search_blocks(blocks);
    }

    pub fn clear(&mut self) {
        self.query.clear();
        self.results.clear();
        self.cursor = 0;
        self.status = SearchStatus::Idle;
    }

    pub fn search_messages(&mut self, app: &App) {
        self.search_blocks(&app.blocks);
    }

    pub fn search_blocks(&mut self, blocks: &[Block]) {
        self.status = SearchStatus::Searching;
        self.results.clear();

        let query = self.query.trim();
        if query.is_empty() {
            self.cursor = 0;
            self.status = SearchStatus::Done(0);
            return;
        }

        let needle = query.to_ascii_lowercase();
        let mut hits = Vec::new();
        for (block_index, block) in blocks.iter().enumerate() {
            let Some(searchable) = searchable_text(block) else {
                continue;
            };

            for (line_in_block, line) in searchable.lines().enumerate() {
                let haystack = line.to_ascii_lowercase();
                let Some(match_start) = haystack.find(&needle) else {
                    continue;
                };
                let match_end = match_start + needle.len();
                let exact = is_exact_word_match(&haystack, match_start, match_end);
                let occurrences = count_ascii_matches(&haystack, &needle);
                hits.push(SearchHit {
                    block_index,
                    snippet: make_snippet(line, match_start, match_end),
                    line_in_block,
                    score: score_hit(block_index, exact, occurrences),
                });
            }
        }

        hits.sort_by(|a, b| {
            b.score
                .cmp(&a.score)
                .then_with(|| b.block_index.cmp(&a.block_index))
                .then_with(|| a.line_in_block.cmp(&b.line_in_block))
        });

        self.results = hits;
        if self.results.is_empty() {
            self.cursor = 0;
        } else {
            self.cursor = self.cursor.min(self.results.len() - 1);
        }
        self.status = SearchStatus::Done(self.results.len());
    }

    pub fn set_query(&mut self, query: impl Into<String>, blocks: &[Block]) {
        self.query = query.into();
        self.cursor = 0;
        self.search_blocks(blocks);
    }

    pub fn push_query_char(&mut self, c: char, blocks: &[Block]) {
        self.query.push(c);
        self.cursor = 0;
        self.search_blocks(blocks);
    }

    pub fn pop_query_char(&mut self, blocks: &[Block]) -> bool {
        let changed = self.query.pop().is_some();
        if changed {
            self.cursor = 0;
            self.search_blocks(blocks);
        }
        changed
    }

    pub fn move_cursor_up(&mut self) -> bool {
        let old = self.cursor;
        self.cursor = self.cursor.saturating_sub(1);
        old != self.cursor
    }

    pub fn move_cursor_down(&mut self) -> bool {
        if self.results.is_empty() {
            return false;
        }
        let old = self.cursor;
        self.cursor = self.cursor.saturating_add(1).min(self.results.len() - 1);
        old != self.cursor
    }

    pub fn page_up(&mut self, page_size: usize) -> bool {
        let old = self.cursor;
        self.cursor = self.cursor.saturating_sub(page_size.max(1));
        old != self.cursor
    }

    pub fn page_down(&mut self, page_size: usize) -> bool {
        if self.results.is_empty() {
            return false;
        }
        let old = self.cursor;
        self.cursor = self
            .cursor
            .saturating_add(page_size.max(1))
            .min(self.results.len() - 1);
        old != self.cursor
    }

    pub fn move_home(&mut self) -> bool {
        let old = self.cursor;
        self.cursor = 0;
        old != self.cursor
    }

    pub fn move_end(&mut self) -> bool {
        if self.results.is_empty() {
            return false;
        }
        let old = self.cursor;
        self.cursor = self.results.len() - 1;
        old != self.cursor
    }

    pub fn selected_hit(&self) -> Option<&SearchHit> {
        self.results.get(self.cursor)
    }

    pub fn visible_start(&self, capacity: usize) -> usize {
        if capacity == 0 || self.results.len() <= capacity {
            return 0;
        }
        if self.cursor >= capacity {
            self.cursor + 1 - capacity
        } else {
            0
        }
    }
}

pub fn popup_lines(
    state: &SessionSearchState,
    theme: &Theme,
    max_rows: usize,
) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    lines.push(Line::from(vec![
        Span::styled("search: ", theme.style_for(ThemeRole::StatusDim)),
        Span::styled(
            if state.query.is_empty() {
                "type to search this session".to_string()
            } else {
                state.query.clone()
            },
            theme.style_for(ThemeRole::CodeInline),
        ),
    ]));
    lines.push(Line::from(status_span(state, theme)));

    if max_rows <= 2 {
        return lines.into_iter().take(max_rows).collect();
    }

    lines.push(Line::from(""));
    let capacity = max_rows.saturating_sub(3).max(1);
    if state.results.is_empty() {
        lines.push(Line::from(Span::styled(
            "  No matches yet",
            theme
                .style_for(ThemeRole::StatusDim)
                .add_modifier(Modifier::DIM),
        )));
        return lines.into_iter().take(max_rows).collect();
    }

    let start = state.visible_start(capacity);
    for (idx, hit) in state.results.iter().enumerate().skip(start).take(capacity) {
        let focused = idx == state.cursor;
        let arrow = if focused { "› " } else { "  " };
        let mut spans = vec![
            Span::styled(
                arrow.to_string(),
                theme
                    .style_for(ThemeRole::StatusDim)
                    .add_modifier(Modifier::DIM),
            ),
            Span::styled(
                format!("#{} L{}  ", hit.block_index, hit.line_in_block + 1),
                theme.style_for(ThemeRole::SessionAccent),
            ),
        ];
        spans.extend(snippet_spans(&hit.snippet, theme, focused));
        lines.push(Line::from(spans));
    }

    lines.into_iter().take(max_rows).collect()
}

fn status_span(state: &SessionSearchState, theme: &Theme) -> Span<'static> {
    let text = match &state.status {
        SearchStatus::Idle => "Type to search · Enter jumps · Esc closes".to_string(),
        SearchStatus::Searching => "searching this session…".to_string(),
        SearchStatus::Done(0) if state.query.trim().is_empty() => {
            "Type to search · Enter jumps · Esc closes".to_string()
        }
        SearchStatus::Done(0) => "0 results · Edit the query and try again".to_string(),
        SearchStatus::Done(n) => format!(
            "{} result{} · Enter jumps to selection",
            n,
            if *n == 1 { "" } else { "s" }
        ),
        SearchStatus::Error(message) => format!("error: {message}"),
    };
    Span::styled(text, theme.style_for(ThemeRole::StatusDim))
}

fn snippet_spans(snippet: &str, theme: &Theme, focused: bool) -> Vec<Span<'static>> {
    let normal = if focused {
        theme
            .style_for(ThemeRole::AssistantText)
            .add_modifier(Modifier::BOLD)
    } else {
        theme.style_for(ThemeRole::AssistantText)
    };
    let highlight = theme
        .style_for(ThemeRole::ModelAccent)
        .add_modifier(Modifier::BOLD);

    let mut spans = Vec::new();
    let mut rest = snippet;
    loop {
        let Some(open) = rest.find('{') else {
            if !rest.is_empty() {
                spans.push(Span::styled(rest.to_string(), normal));
            }
            break;
        };
        if open > 0 {
            spans.push(Span::styled(rest[..open].to_string(), normal));
        }
        let after_open = &rest[open + 1..];
        let Some(close) = after_open.find('}') else {
            spans.push(Span::styled(rest[open..].to_string(), normal));
            break;
        };
        spans.push(Span::styled(after_open[..close].to_string(), highlight));
        rest = &after_open[close + 1..];
    }
    spans
}

fn searchable_text(block: &Block) -> Option<String> {
    match block {
        Block::User { text } | Block::Assistant { text, .. } => Some(text.clone()),
        Block::ToolCall { name, args, .. } => Some(format!("{} {}", name, compact_json(args))),
        Block::ToolResult { summary, .. } => Some(summary.clone()),
        Block::RawEvent { .. } | Block::Diag { .. } => None,
    }
}

fn compact_json(value: &serde_json::Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| value.to_string())
}

fn score_hit(block_index: usize, exact_word: bool, occurrences: usize) -> usize {
    let exact_bonus = if exact_word { 100_000 } else { 0 };
    exact_bonus + block_index.saturating_mul(100) + occurrences.min(99)
}

fn count_ascii_matches(haystack: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    let mut count = 0;
    let mut start = 0;
    while let Some(pos) = haystack[start..].find(needle) {
        count += 1;
        start += pos + needle.len();
        if start >= haystack.len() {
            break;
        }
    }
    count
}

fn is_exact_word_match(haystack: &str, start: usize, end: usize) -> bool {
    let before = if start == 0 {
        None
    } else {
        haystack.as_bytes().get(start - 1).copied()
    };
    let after = haystack.as_bytes().get(end).copied();
    !before.is_some_and(is_word_byte) && !after.is_some_and(is_word_byte)
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn make_snippet(line: &str, start: usize, end: usize) -> String {
    const CONTEXT: usize = 32;
    let prefix_start = prev_char_boundary(line, start.saturating_sub(CONTEXT));
    let suffix_end = next_char_boundary(line, end.saturating_add(CONTEXT).min(line.len()));
    let prefix = &line[prefix_start..start];
    let matched = &line[start..end];
    let suffix = &line[end..suffix_end];

    let mut out = String::new();
    if prefix_start > 0 {
        out.push('…');
    }
    out.push_str(prefix.trim_start());
    out.push('{');
    out.push_str(matched);
    out.push('}');
    out.push_str(suffix.trim_end());
    if suffix_end < line.len() {
        out.push('…');
    }
    out
}

fn prev_char_boundary(s: &str, mut idx: usize) -> usize {
    idx = idx.min(s.len());
    while idx > 0 && !s.is_char_boundary(idx) {
        idx -= 1;
    }
    idx
}

fn next_char_boundary(s: &str, mut idx: usize) -> usize {
    idx = idx.min(s.len());
    while idx < s.len() && !s.is_char_boundary(idx) {
        idx += 1;
    }
    idx
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::app::{App, ToolStatus};
    use crate::ui::popup::PopupKind;
    use serde_json::json;

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

    fn app_with_blocks() -> App {
        let mut app = App::new("/tmp".to_string());
        app.blocks.push(Block::User {
            text: "Hello from the user".to_string(),
        });
        app.blocks.push(Block::Assistant {
            text: "The assistant mentions Rust and ratatui".to_string(),
            done: true,
            provider: None,
            model: None,
        });
        app.blocks.push(Block::ToolCall {
            call_id: "1".to_string(),
            name: "read".to_string(),
            args: json!({"path": "src/main.rs"}),
            status: ToolStatus::Completed,
        });
        app.blocks.push(Block::ToolResult {
            call_id: "1".to_string(),
            summary: "Read returned RUST code".to_string(),
            ok: true,
        });
        app
    }

    #[test]
    fn search_transitions_to_done() {
        let app = app_with_blocks();
        let mut state = SessionSearchState {
            query: "rust".to_string(),
            ..SessionSearchState::default()
        };
        state.search_messages(&app);
        assert_eq!(state.status, SearchStatus::Done(2));
        assert_eq!(state.results.len(), 2);
    }

    #[test]
    fn basic_search_is_case_insensitive() {
        let app = app_with_blocks();
        let mut state = SessionSearchState::default();
        state.set_query("RuSt", &app.blocks);
        assert_eq!(state.results.len(), 2);
        assert!(state.results.iter().any(|hit| hit.block_index == 1));
        assert!(state.results.iter().any(|hit| hit.block_index == 3));
    }

    #[test]
    fn snippet_wraps_match_with_braces() {
        let snippet = make_snippet("before searchable after", 7, 17);
        assert_eq!(snippet, "before {searchable} after");
    }

    #[test]
    fn scoring_prefers_exact_word_over_substring() {
        let blocks = vec![
            Block::User {
                text: "prefix rustacean".to_string(),
            },
            Block::User {
                text: "older rust".to_string(),
            },
        ];
        let mut state = SessionSearchState::default();
        state.set_query("rust", &blocks);
        assert_eq!(state.results[0].block_index, 1);
        assert!(state.results[0].score > state.results[1].score);
    }

    #[test]
    fn scoring_prefers_more_recent_for_same_match_kind() {
        let blocks = vec![
            Block::User {
                text: "rust".to_string(),
            },
            Block::Assistant {
                text: "rust".to_string(),
                done: true,
                provider: None,
                model: None,
            },
        ];
        let mut state = SessionSearchState::default();
        state.set_query("rust", &blocks);
        assert_eq!(state.results[0].block_index, 1);
    }

    #[test]
    fn empty_query_clears_results() {
        let app = app_with_blocks();
        let mut state = SessionSearchState::default();
        state.set_query("rust", &app.blocks);
        assert!(!state.results.is_empty());
        state.set_query("   ", &app.blocks);
        assert!(state.results.is_empty());
        assert_eq!(state.status, SearchStatus::Done(0));
    }

    #[test]
    fn no_results_reports_done_zero() {
        let app = app_with_blocks();
        let mut state = SessionSearchState::default();
        state.set_query("not-present", &app.blocks);
        assert!(state.results.is_empty());
        assert_eq!(state.status, SearchStatus::Done(0));
    }

    #[test]
    fn popup_lifecycle_open_and_clear() {
        let mut app = app_with_blocks();
        app.open_session_search("rust".to_string());
        assert_eq!(
            app.current_popup_kind(),
            Some(&PopupKind::Search {
                query: "rust".to_string()
            })
        );
        assert_eq!(app.session_search.status, SearchStatus::Done(2));

        app.close_popup();
        app.session_search.clear();
        assert!(app.current_popup_kind().is_none());
        assert_eq!(app.session_search.status, SearchStatus::Idle);
    }

    #[test]
    fn move_home_and_end_follow_result_bounds() {
        let app = app_with_blocks();
        let mut state = SessionSearchState::default();
        state.set_query("rust", &app.blocks);

        assert!(state.move_end());
        assert_eq!(state.cursor, state.results.len() - 1);
        assert!(state.move_home());
        assert_eq!(state.cursor, 0);
    }

    #[test]
    fn popup_lines_show_search_placeholder_when_empty() {
        let state = SessionSearchState::default();
        let text = text_of(&popup_lines(&state, &Theme::default(), 4));

        assert!(text.contains("type to search this session"));
        assert!(text.contains("type to search"));
    }
}
