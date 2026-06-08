//! Conversation viewport — layout cache + line slicing.
//!
//! This is the Rust counterpart of
//! `src/app/rendering/conversation-viewport.ts`. We deliberately ship a
//! simpler version for the M0 milestone:
//!
//! - One layout per width, fully recomputed when blocks change. No
//!   incremental dirty tracking (TS does this to support 10k+ line
//!   histories without re-walking the whole list each render). The
//!   complexity is deferred to the M3 perf audit.
//! - No "deferred user messages" / "queued SDK messages" / "dynamic
//!   conversation block" concepts. Those live in TS for live streaming
//!   state; we already capture the streaming state on `App::blocks`
//!   directly (see `Block::Assistant { done, ... }`).
//! - Block IDs are array indices, not strings. Stable enough while blocks
//!   are append-only; once we add edit/compact we will assign stable
//!   `BlockId`s.
//!
//! What we keep:
//!
//! - Binary search on the prefix-sum `offsets[]` to find the block that
//!   owns a given visual line offset.
//! - `slice(start, count)` returns only the visible lines, without
//!   walking the whole list.
//! - Per-width caching so resize doesn't tear down work for the previous
//!   width — we keep both layouts around and rebuild only on demand.
//! - "Estimated" vs "measured" line counts: for M0 we always measure
//!   (the cost is small), but the field is kept so future code can skip
//!   rendering off-screen entries.

use std::collections::HashMap;

use ratatui::style::Style;
use ratatui::text::{Line, Span};
use unicode_width::UnicodeWidthStr;

use crate::config::PixConfig;

use super::app::{block_version, Block, DiagKind};
use super::theme::{Theme, ThemeRole};
use super::{markdown, tool_renderers, wrap};

/// A single visual line ready for ratatui rendering.
#[derive(Debug, Clone)]
pub struct VisualLine {
    /// Pre-built ratatui `Line`. Ownership makes slicing cheap.
    pub line: Line<'static>,
    /// Index into `App::blocks` (source block). `None` for synthetic lines
    /// like inter-block gap rows.
    pub source_idx: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ViewportWidth(pub usize);

#[derive(Debug, Default)]
pub struct Viewport {
    layouts: HashMap<ViewportWidth, Layout>,
}

#[derive(Debug)]
struct Layout {
    config: PixConfig,
    /// Total visual lines across all blocks (including inter-block gaps).
    total: usize,
    /// `offsets[i]` = sum of line counts for blocks `[0, i)` including gaps.
    /// Length is `blocks.len() + 1`. Last entry equals `total`.
    offsets: Vec<usize>,
    /// Visual line count for each block, including its trailing gap.
    line_counts: Vec<usize>,
    /// Per-block visual line count WITHOUT the trailing gap. Cached so the
    /// renderer can decide whether to emit a gap row without re-walking
    /// later blocks (see `has_trailing_gap`).
    visible_counts: Vec<usize>,
    /// Rendered lines per block index, lazily filled.
    rendered: HashMap<usize, RenderedBlock>,
}

#[derive(Debug, Clone)]
struct RenderedBlock {
    /// Version derived from the source block's mutation counter
    /// (`App::block_version`); mismatch forces a re-render.
    version: u64,
    theme: Theme,
    config: PixConfig,
    lines: Vec<VisualLine>,
}

impl Viewport {
    pub fn new() -> Self {
        Self::default()
    }

    /// Drop all caches. Call when the app resets / switches sessions.
    pub fn invalidate(&mut self) {
        self.layouts.clear();
    }

    /// Drop the cached layout for one width (force re-measure).
    pub fn invalidate_width(&mut self, width: ViewportWidth) {
        self.layouts.remove(&width);
    }

    /// Total visual line count for `blocks` at the given width
    /// (including inter-block gap rows).
    pub fn line_count(&mut self, blocks: &[Block], width: ViewportWidth) -> usize {
        self.line_count_with_config(blocks, width, &PixConfig::default())
    }

    pub fn line_count_with_config(
        &mut self,
        blocks: &[Block],
        width: ViewportWidth,
        config: &PixConfig,
    ) -> usize {
        self.ensure_layout(blocks, width, config).total
    }

    /// Return the source block index for an absolute visual line offset.
    pub fn hit_test(
        &self,
        blocks: &[Block],
        width: ViewportWidth,
        visual_line_offset: usize,
    ) -> Option<usize> {
        let layout = self.layouts.get(&width)?;
        if visual_line_offset >= layout.total {
            return None;
        }
        let candidate = find_block_for_offset(&layout.offsets, visual_line_offset)?;
        (candidate < blocks.len()).then_some(candidate)
    }

    /// Return up to `count` visible lines starting from visual line offset
    /// `start`. Mirrors `ConversationViewport.slice(width, start, count)`.
    pub fn slice(
        &mut self,
        blocks: &[Block],
        width: ViewportWidth,
        start: usize,
        count: usize,
        theme: &Theme,
    ) -> Vec<VisualLine> {
        self.slice_with_config(blocks, width, start, count, theme, &PixConfig::default())
    }

    pub fn slice_with_config(
        &mut self,
        blocks: &[Block],
        width: ViewportWidth,
        start: usize,
        count: usize,
        theme: &Theme,
        config: &PixConfig,
    ) -> Vec<VisualLine> {
        if count == 0 {
            return Vec::new();
        }
        let total = self.ensure_layout(blocks, width, config).total;

        if start >= total {
            return Vec::new();
        }
        let want = count.min(total - start);
        let mut out: Vec<VisualLine> = Vec::with_capacity(want);
        let end = start + want;

        // Re-borrow layout after the ensure call returned (it returned a
        // borrow we no longer need). Find the first block that owns `start`.
        let block_idx = {
            let layout = self.layouts.get(&width).expect("layout just built");
            find_block_for_offset(&layout.offsets, start)
        };
        let block_idx = match block_idx {
            Some(idx) => idx,
            None => return out,
        };

        let mut block_idx = block_idx;
        while block_idx < blocks.len() && out.len() < want {
            let (block_start, block_end) = {
                let layout = self.layouts.get(&width).expect("layout just built");
                (layout.offsets[block_idx], layout.offsets[block_idx + 1])
            };
            if block_end <= start {
                block_idx += 1;
                continue;
            }
            if block_start >= end {
                break;
            }
            // Ensure this block's lines are rendered.
            self.ensure_block_rendered(blocks, width, block_idx, theme, config);

            let local_start = start.saturating_sub(block_start);
            let layout = self.layouts.get(&width).expect("layout just built");
            let rendered = layout
                .rendered
                .get(&block_idx)
                .expect("rendered just ensured");
            let local_end = end.saturating_sub(block_start).min(rendered.lines.len());
            if local_start < local_end {
                out.extend(rendered.lines[local_start..local_end].iter().cloned());
            }
            block_idx += 1;
        }

        out
    }

    fn ensure_layout(
        &mut self,
        blocks: &[Block],
        width: ViewportWidth,
        config: &PixConfig,
    ) -> &mut Layout {
        let needs_rebuild = self
            .layouts
            .get(&width)
            .map(|l| l.line_counts.len() != blocks.len() || l.config != *config)
            .unwrap_or(true);
        if needs_rebuild {
            self.build_layout(blocks, width, config);
        }
        self.layouts.get_mut(&width).expect("layout just built")
    }

    fn build_layout(&mut self, blocks: &[Block], width: ViewportWidth, config: &PixConfig) {
        let content_width = content_width_for(width);
        let visible_counts: Vec<usize> = blocks
            .iter()
            .map(|block| block_line_count(block, content_width, config))
            .collect();
        let mut offsets = Vec::with_capacity(blocks.len() + 1);
        let mut line_counts = Vec::with_capacity(blocks.len());
        let mut total = 0usize;
        offsets.push(0);
        for (idx, visible_count) in visible_counts.iter().copied().enumerate() {
            let count = visible_count
                + if has_trailing_gap(idx, &visible_counts) {
                    1
                } else {
                    0
                };
            line_counts.push(count);
            total += count;
            offsets.push(total);
        }
        let layout = Layout {
            config: config.clone(),
            total,
            offsets,
            line_counts,
            visible_counts,
            rendered: HashMap::new(),
        };
        self.layouts.insert(width, layout);
    }

    fn ensure_block_rendered(
        &mut self,
        blocks: &[Block],
        width: ViewportWidth,
        idx: usize,
        theme: &Theme,
        config: &PixConfig,
    ) {
        let version = block_version(blocks, idx);
        let needs_render = match self.layouts.get(&width).and_then(|l| l.rendered.get(&idx)) {
            Some(r) => r.version != version || r.theme != *theme || r.config != *config,
            None => true,
        };
        if !needs_render {
            return;
        }
        let content_width = content_width_for(width);
        let block = match blocks.get(idx) {
            Some(b) => b,
            None => return,
        };
        let gap = {
            let layout = self
                .layouts
                .get(&width)
                .expect("layout must exist before rendering block");
            has_trailing_gap(idx, &layout.visible_counts)
        };
        let lines = render_block(block, idx, content_width, gap, theme, config);
        let layout = self
            .layouts
            .get_mut(&width)
            .expect("layout must exist before rendering block");
        layout.rendered.insert(
            idx,
            RenderedBlock {
                version,
                theme: *theme,
                config: config.clone(),
                lines,
            },
        );
    }
}

fn find_block_for_offset(offsets: &[usize], target: usize) -> Option<usize> {
    // offsets.len() == blocks.len() + 1; we want the largest i such that
    // offsets[i] <= target and offsets[i+1] > target.
    if offsets.len() < 2 {
        return None;
    }
    let mut lo = 0usize;
    let mut hi = offsets.len() - 2;
    let mut result = None;
    while lo <= hi {
        let mid = (lo + hi) / 2;
        let next = offsets.get(mid + 1).copied().unwrap_or(usize::MAX);
        if next <= target {
            lo = mid + 1;
        } else {
            result = Some(mid);
            if mid == 0 {
                break;
            }
            hi = mid - 1;
        }
    }
    result
}

fn content_width_for(width: ViewportWidth) -> usize {
    // Conversation is borderless; blocks own their own local padding.
    width.0.max(1)
}

/// Should block N be followed by a blank separator row? Mirrors
/// `ConversationViewport.gapAfterEntry` with `superCompactTools = false`.
fn has_trailing_gap(idx: usize, visible_counts: &[usize]) -> bool {
    visible_counts.get(idx).copied().unwrap_or(0) > 0
        && visible_counts
            .get(idx + 1..)
            .is_some_and(|rest| rest.iter().any(|count| *count > 0))
}

fn block_line_count(block: &Block, width: usize, config: &PixConfig) -> usize {
    match block {
        Block::User { text } => {
            // Mirror opencode `UserMessage` `<Show when={text()}>`: an
            // empty user bubble would render as a single padded blank row
            // that combines with the inter-block gap into two consecutive
            // blank lines. Hide it instead.
            let collapsed = wrap::collapse_blank_runs(text);
            if collapsed.trim().is_empty() {
                return 0;
            }
            // Render pads each row with " ... " (2 cells). The header width
            // is intentionally conservative so the count overestimates by
            // at most one row rather than underestimating.
            let prefix = 5;
            wrap::line_count(&collapsed, width.saturating_sub(prefix).max(1)).max(1)
        }
        Block::Assistant { text, done, .. } => {
            // Mirror opencode `TextPart` `<Show when={props.part.text.trim()}>`:
            // a finalised assistant turn whose text is empty (or sanitises
            // to empty after stripping hidden metadata) renders as a single
            // blank VisualLine, which combines with the inter-block gap
            // into two consecutive blank rows. The empty assistant block is
            // a common artefact of the live stream — `handle_assistant_start`
            // pushes it eagerly and `handle_assistant_end` finalises it even
            // when no text deltas arrived (e.g. a tool-only turn).
            //
            // While streaming (`!done`) we still emit 1 line so the `…`
            // placeholder stays visible.
            let empty_count = if *done { 0 } else { 1 };
            if text.trim().is_empty() {
                return empty_count;
            }
            let count = markdown::markdown_line_count(text, width);
            if count == 0 {
                return empty_count;
            }
            count
        }
        Block::Thinking { .. } => 1,
        Block::ToolCall {
            name,
            args,
            status,
            result_summary,
            result_ok,
            expanded,
            ..
        } => tool_renderers::tool_entry_line_count_with_config_and_expansion(
            name,
            args,
            *status,
            result_summary.as_deref(),
            *result_ok,
            *expanded,
            width,
            config,
        ),
        Block::ToolResult {
            call_id,
            summary,
            ok,
        } => tool_renderers::render_tool_result(call_id, summary, *ok, width)
            .len()
            .max(1),
        Block::RawEvent { line, .. } => {
            let collapsed = wrap::collapse_blank_runs(line);
            wrap::line_count(&collapsed, width).max(1)
        }
        Block::Diag { text, .. } => {
            let collapsed = wrap::collapse_blank_runs(text);
            wrap::line_count(&collapsed, width).max(1)
        }
    }
}

fn render_block(
    block: &Block,
    idx: usize,
    width: usize,
    gap: bool,
    theme: &Theme,
    config: &PixConfig,
) -> Vec<VisualLine> {
    let mut out: Vec<VisualLine> = Vec::new();
    append_block_lines(block, idx, width, &mut out, theme, config);
    if gap {
        out.push(VisualLine {
            line: Line::raw(""),
            source_idx: None,
        });
    }
    out
}

/// Append the single-cell `…` placeholder used while an assistant turn is
/// streaming but has produced no visible text yet.
fn push_streaming_placeholder(out: &mut Vec<VisualLine>, idx: usize, theme: &Theme) {
    out.push(VisualLine {
        line: Line::from(Span::styled("…", theme.style_for(ThemeRole::ToolRunning))),
        source_idx: Some(idx),
    });
}

fn append_block_lines(
    block: &Block,
    idx: usize,
    width: usize,
    out: &mut Vec<VisualLine>,
    theme: &Theme,
    config: &PixConfig,
) {
    match block {
        Block::User { text } => {
            let collapsed = wrap::collapse_blank_runs(text);
            if collapsed.trim().is_empty() {
                return;
            }
            let body_width = width.saturating_sub(2).max(1);
            let lines = wrap::wrap_text(&collapsed, body_width);
            for line in lines {
                let used = UnicodeWidthStr::width(line.as_str()).min(body_width);
                let padding = " ".repeat(body_width.saturating_sub(used));
                let style = theme
                    .style_for(ThemeRole::UserText)
                    .bg(theme.user_message_background);
                out.push(VisualLine {
                    line: Line::from(Span::styled(format!(" {line}{padding} "), style)),
                    source_idx: Some(idx),
                });
            }
        }
        Block::Assistant {
            text,
            done,
            provider: _,
            model: _,
        } => {
            // See `block_line_count` for the rationale: a finalised empty
            // assistant block must render as zero lines so it cannot stack
            // a blank row on top of the inter-block gap. While streaming we
            // keep the `…` placeholder.
            if text.trim().is_empty() {
                if !done {
                    push_streaming_placeholder(out, idx, theme);
                }
                return;
            }
            let md_lines = markdown::render_markdown_with_theme(text, width, theme);
            if md_lines.is_empty() {
                if !done {
                    push_streaming_placeholder(out, idx, theme);
                }
                return;
            }
            for line in md_lines {
                out.push(VisualLine {
                    line,
                    source_idx: Some(idx),
                });
            }
        }
        Block::Thinking { done, .. } => {
            for line in
                tool_renderers::render_thinking_entry_with_config(*done, width, theme, config)
            {
                out.push(VisualLine {
                    line,
                    source_idx: Some(idx),
                });
            }
        }
        Block::ToolCall {
            name,
            args,
            status,
            result_summary,
            result_ok,
            expanded,
            ..
        } => {
            for line in tool_renderers::render_tool_entry_with_config_and_expansion(
                name,
                args,
                *status,
                result_summary.as_deref(),
                *result_ok,
                *expanded,
                width,
                theme,
                config,
            ) {
                out.push(VisualLine {
                    line,
                    source_idx: Some(idx),
                });
            }
        }
        Block::ToolResult {
            call_id,
            summary,
            ok,
        } => {
            for line in
                tool_renderers::render_tool_result_with_theme(call_id, summary, *ok, width, theme)
            {
                out.push(VisualLine {
                    line,
                    source_idx: Some(idx),
                });
            }
        }
        Block::RawEvent { type_, line } => {
            out.push(VisualLine {
                line: Line::from(vec![
                    Span::styled("  raw ", theme.style_for(ThemeRole::StatusDim)),
                    Span::styled(type_.clone(), theme.style_for(ThemeRole::SessionAccent)),
                    Span::raw(" "),
                    Span::styled(line.clone(), theme.style_for(ThemeRole::StatusDim)),
                ]),
                source_idx: Some(idx),
            });
        }
        Block::Diag { kind, text } => {
            let (icon, color) = match kind {
                DiagKind::Stderr => ("!", theme.diag_warn),
                DiagKind::BridgeError => ("✖", theme.diag_error),
                DiagKind::Info => ("i", theme.diag_info),
            };
            let collapsed = wrap::collapse_blank_runs(text);
            for line in wrap::wrap_text(&collapsed, width) {
                out.push(VisualLine {
                    line: Line::from(vec![
                        Span::styled(format!("  {icon} "), Style::default().fg(color)),
                        Span::styled(line, Style::default().fg(color)),
                    ]),
                    source_idx: Some(idx),
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    use crate::ui::app::ToolStatus;

    fn blocks_of(blocks: Vec<Block>) -> Vec<Block> {
        blocks
    }

    fn theme() -> Theme {
        Theme::default()
    }

    fn line_text(line: &VisualLine) -> String {
        line.line
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect()
    }

    #[test]
    fn empty_conversation_has_zero_lines() {
        let blocks = blocks_of(vec![]);
        let mut v = Viewport::new();
        assert_eq!(v.line_count(&blocks, ViewportWidth(80)), 0);
    }

    #[test]
    fn user_block_counts_padded_bubble() {
        let blocks = blocks_of(vec![Block::User { text: "abc".into() }]);
        let mut v = Viewport::new();
        // Width 80: borderless content_width=80, padded user bubble body=78.
        assert_eq!(v.line_count(&blocks, ViewportWidth(80)), 1);
    }

    #[test]
    fn user_block_renders_without_author_prefix() {
        let blocks = blocks_of(vec![Block::User {
            text: "hello".into(),
        }]);
        let mut v = Viewport::new();
        let lines = v.slice(&blocks, ViewportWidth(24), 0, 1, &theme());
        let text: String = lines[0]
            .line
            .spans
            .iter()
            .map(|s| s.content.as_ref())
            .collect();
        assert!(text.starts_with(' '), "expected left padding, got {text:?}");
        assert!(text.contains("hello"), "got {text:?}");
        assert!(!text.contains("you:"), "got {text:?}");
    }

    #[test]
    fn long_text_wraps() {
        let text = "word ".repeat(40);
        let blocks = blocks_of(vec![Block::Assistant {
            text: text.clone(),
            done: true,
            provider: None,
            model: None,
        }]);
        let mut v = Viewport::new();
        let total = v.line_count(&blocks, ViewportWidth(40));
        // content_width = 36. Each "word " (5 cells): 7 fit per line.
        // 40 words / 7 = 5 full lines + 5 words on the 6th.
        assert!((5..=7).contains(&total), "got {total}");
    }

    #[test]
    fn trailing_gap_between_blocks() {
        let blocks = blocks_of(vec![
            Block::User { text: "a".into() },
            Block::User { text: "b".into() },
        ]);
        let mut v = Viewport::new();
        // 1 line + 1 gap + 1 line = 3.
        assert_eq!(v.line_count(&blocks, ViewportWidth(80)), 3);
    }

    #[test]
    fn consecutive_tool_blocks_have_at_most_one_blank_gap() {
        let blocks = blocks_of(vec![
            Block::ToolCall {
                call_id: "call-1".into(),
                name: "shell".into(),
                args: json!({"command": "echo one"}),
                status: ToolStatus::Completed,
                result_summary: None,
                result_ok: Some(true),
                expanded: false,
            },
            Block::ToolCall {
                call_id: "call-2".into(),
                name: "shell".into(),
                args: json!({"command": "echo two"}),
                status: ToolStatus::Completed,
                result_summary: None,
                result_ok: Some(true),
                expanded: false,
            },
        ]);
        let mut v = Viewport::new();
        let total = v.line_count(&blocks, ViewportWidth(80));
        let lines = v.slice(&blocks, ViewportWidth(80), 0, total, &theme());
        let texts: Vec<String> = lines.iter().map(line_text).collect();

        assert_eq!(texts.len(), 3, "got {texts:?}");
        assert_eq!(
            texts.iter().filter(|line| line.is_empty()).count(),
            1,
            "got {texts:?}"
        );
        assert!(texts[0].contains("shell echo one"), "got {texts:?}");
        assert!(texts[2].contains("shell echo two"), "got {texts:?}");
    }

    #[test]
    fn hidden_tool_between_tools_does_not_add_extra_blank_gap() {
        let blocks = blocks_of(vec![
            Block::ToolCall {
                call_id: "call-1".into(),
                name: "shell".into(),
                args: json!({"command": "echo one"}),
                status: ToolStatus::Completed,
                result_summary: None,
                result_ok: Some(true),
                expanded: false,
            },
            Block::ToolCall {
                call_id: "todo-1".into(),
                name: "todo".into(),
                args: json!({"action": "create", "subject": "hidden"}),
                status: ToolStatus::Completed,
                result_summary: None,
                result_ok: Some(true),
                expanded: false,
            },
            Block::ToolCall {
                call_id: "call-2".into(),
                name: "shell".into(),
                args: json!({"command": "echo two"}),
                status: ToolStatus::Completed,
                result_summary: None,
                result_ok: Some(true),
                expanded: false,
            },
        ]);
        let mut v = Viewport::new();
        let total = v.line_count(&blocks, ViewportWidth(80));
        let lines = v.slice(&blocks, ViewportWidth(80), 0, total, &theme());
        let texts: Vec<String> = lines.iter().map(line_text).collect();

        assert_eq!(texts.len(), 3, "got {texts:?}");
        assert_eq!(
            texts.iter().filter(|line| line.is_empty()).count(),
            1,
            "got {texts:?}"
        );
        assert!(
            !texts.iter().any(|line| line.contains("todo")),
            "got {texts:?}"
        );
    }

    #[test]
    fn empty_assistant_done_block_is_hidden() {
        // Mirror opencode `TextPart` `<Show when={props.part.text.trim()}>`:
        // an assistant turn that produced no text (e.g. a tool-only turn)
        // must contribute zero visual lines so its blank placeholder does
        // not stack on top of the inter-block gap.
        let blocks = blocks_of(vec![Block::Assistant {
            text: String::new(),
            done: true,
            provider: None,
            model: None,
        }]);
        let mut v = Viewport::new();
        assert_eq!(v.line_count(&blocks, ViewportWidth(80)), 0);
    }

    #[test]
    fn whitespace_only_assistant_done_block_is_hidden() {
        let blocks = blocks_of(vec![Block::Assistant {
            text: "   \n\n  \n".into(),
            done: true,
            provider: None,
            model: None,
        }]);
        let mut v = Viewport::new();
        assert_eq!(v.line_count(&blocks, ViewportWidth(80)), 0);
    }

    #[test]
    fn empty_assistant_streaming_block_shows_placeholder() {
        // While streaming we keep the `…` placeholder so the user can see
        // that an assistant turn is in progress even before any text
        // deltas have arrived.
        let blocks = blocks_of(vec![Block::Assistant {
            text: String::new(),
            done: false,
            provider: None,
            model: None,
        }]);
        let mut v = Viewport::new();
        let total = v.line_count(&blocks, ViewportWidth(80));
        assert_eq!(total, 1, "streaming placeholder must occupy 1 line");
        let lines = v.slice(&blocks, ViewportWidth(80), 0, total, &theme());
        let text = line_text(&lines[0]);
        assert!(text.contains('…'), "got {text:?}");
    }

    #[test]
    fn empty_assistant_between_tools_does_not_double_blank_gap() {
        // Regression: a tool-only assistant turn leaves an empty
        // `Block::Assistant { text: "", done: true }` between two tool
        // calls. Before the fix that empty block rendered one blank row,
        // which combined with the inter-block gap produced two consecutive
        // blank rows.
        let blocks = blocks_of(vec![
            Block::ToolCall {
                call_id: "call-1".into(),
                name: "shell".into(),
                args: json!({"command": "echo one"}),
                status: ToolStatus::Completed,
                result_summary: None,
                result_ok: Some(true),
                expanded: false,
            },
            Block::Assistant {
                text: String::new(),
                done: true,
                provider: None,
                model: None,
            },
            Block::ToolCall {
                call_id: "call-2".into(),
                name: "shell".into(),
                args: json!({"command": "echo two"}),
                status: ToolStatus::Completed,
                result_summary: None,
                result_ok: Some(true),
                expanded: false,
            },
        ]);
        let mut v = Viewport::new();
        let total = v.line_count(&blocks, ViewportWidth(80));
        let lines = v.slice(&blocks, ViewportWidth(80), 0, total, &theme());
        let texts: Vec<String> = lines.iter().map(line_text).collect();

        assert_eq!(texts.len(), 3, "got {texts:?}");
        assert_eq!(
            texts.iter().filter(|line| line.is_empty()).count(),
            1,
            "expected exactly one blank gap row, got {texts:?}"
        );
        assert!(
            !texts.iter().any(|line| line.contains('…')),
            "empty finalised assistant must not leak the streaming placeholder, got {texts:?}"
        );
    }

    #[test]
    fn empty_user_block_is_hidden() {
        // Mirror opencode `UserMessage` `<Show when={text()}>`.
        let blocks = blocks_of(vec![
            Block::User {
                text: String::new(),
            },
            Block::User {
                text: "hello".into(),
            },
        ]);
        let mut v = Viewport::new();
        let total = v.line_count(&blocks, ViewportWidth(80));
        let lines = v.slice(&blocks, ViewportWidth(80), 0, total, &theme());
        let texts: Vec<String> = lines.iter().map(line_text).collect();
        assert_eq!(texts.len(), 1, "got {texts:?}");
        assert!(texts[0].contains("hello"), "got {texts:?}");
    }

    #[test]
    fn slice_returns_only_visible_range() {
        let blocks = blocks_of(vec![
            Block::User {
                text: "first".into(),
            },
            Block::User {
                text: "second".into(),
            },
            Block::User {
                text: "third".into(),
            },
        ]);
        let mut v = Viewport::new();
        // Layout: "first"(1) + gap(1) + "second"(1) + gap(1) + "third"(1) = 5
        let lines = v.slice(&blocks, ViewportWidth(80), 1, 2, &theme());
        assert_eq!(lines.len(), 2);
        // line 1 is the gap (empty), line 2 is "second".
        assert_eq!(lines[0].source_idx, None);
        assert_eq!(lines[1].source_idx, Some(1));
    }

    #[test]
    fn slice_start_beyond_total_returns_empty() {
        let blocks = blocks_of(vec![Block::User { text: "x".into() }]);
        let mut v = Viewport::new();
        let lines = v.slice(&blocks, ViewportWidth(80), 100, 5, &theme());
        assert!(lines.is_empty());
    }

    #[test]
    fn invalidate_clears_cache() {
        let blocks = blocks_of(vec![Block::User { text: "x".into() }]);
        let mut v = Viewport::new();
        v.line_count(&blocks, ViewportWidth(80));
        assert_eq!(v.layouts.len(), 1);
        v.invalidate();
        assert!(v.layouts.is_empty());
    }

    #[test]
    fn different_widths_cache_separately() {
        let blocks = blocks_of(vec![Block::User {
            text: "alpha beta gamma".into(),
        }]);
        let mut v = Viewport::new();
        let _ = v.line_count(&blocks, ViewportWidth(80));
        let _ = v.line_count(&blocks, ViewportWidth(40));
        assert_eq!(v.layouts.len(), 2);
    }

    #[test]
    fn hit_test_existing_block_returns_source_index() {
        let blocks = blocks_of(vec![Block::User { text: "x".into() }]);
        let mut v = Viewport::new();
        let width = ViewportWidth(80);
        v.line_count(&blocks, width);

        assert_eq!(v.hit_test(&blocks, width, 0), Some(0));
    }

    #[test]
    fn hit_test_offset_out_of_bounds_returns_none() {
        let blocks = blocks_of(vec![Block::User { text: "x".into() }]);
        let mut v = Viewport::new();
        let width = ViewportWidth(80);
        v.line_count(&blocks, width);

        assert_eq!(v.hit_test(&blocks, width, 1), None);
    }

    #[test]
    fn hit_test_multi_block_offsets_return_matching_indices() {
        let blocks = blocks_of(vec![
            Block::User { text: "a".into() },
            Block::User { text: "b".into() },
            Block::User { text: "c".into() },
        ]);
        let mut v = Viewport::new();
        let width = ViewportWidth(80);
        v.line_count(&blocks, width);

        assert_eq!(v.hit_test(&blocks, width, 0), Some(0));
        assert_eq!(v.hit_test(&blocks, width, 2), Some(1));
        assert_eq!(v.hit_test(&blocks, width, 4), Some(2));
    }

    #[test]
    fn assistant_uses_markdown_renderer() {
        // A heading + paragraph at width 80 should produce >= 2 visual
        // lines (heading + paragraph + blank separator).
        let blocks = blocks_of(vec![Block::Assistant {
            text: "# Heading\n\nFollow-up paragraph text.".into(),
            done: true,
            provider: Some("anthropic".into()),
            model: Some("claude".into()),
        }]);
        let mut v = Viewport::new();
        let total = v.line_count(&blocks, ViewportWidth(80));
        assert!(
            total >= 3,
            "expected at least 3 visual lines for heading + sep + paragraph, got {total}"
        );

        let lines = v.slice(&blocks, ViewportWidth(80), 0, total, &theme());
        // Assistant text is rendered directly, without the legacy author header.
        let first: String = lines[0]
            .line
            .spans
            .iter()
            .map(|s| s.content.as_ref())
            .collect();
        assert!(!first.contains("assistant"), "got {first:?}");
        assert!(first.contains("Heading"), "got {first:?}");
    }

    #[test]
    fn assistant_hides_dcp_metadata_markers() {
        let blocks = blocks_of(vec![Block::Assistant {
            text: "[dcp-id]: # (m154)\nvisible\n[dcp-block-id]: # (b3)".into(),
            done: true,
            provider: None,
            model: None,
        }]);
        let mut v = Viewport::new();
        let lines = v.slice(&blocks, ViewportWidth(80), 0, 5, &theme());
        let flat: String = lines
            .iter()
            .flat_map(|line| line.line.spans.iter())
            .map(|span| span.content.as_ref())
            .collect();

        assert!(flat.contains("visible"), "got {flat:?}");
        assert!(!flat.contains("dcp-id"), "got {flat:?}");
        assert!(!flat.contains("dcp-block-id"), "got {flat:?}");
    }

    #[test]
    fn thinking_uses_tool_header_layout() {
        let blocks = blocks_of(vec![Block::Thinking {
            text: "private notes".into(),
            done: true,
        }]);
        let mut v = Viewport::new();
        let lines = v.slice(&blocks, ViewportWidth(80), 0, 1, &theme());
        let text: String = lines[0]
            .line
            .spans
            .iter()
            .map(|s| s.content.as_ref())
            .collect();

        assert!(text.contains("thinking"), "got {text:?}");
        assert!(!text.starts_with(' '), "got {text:?}");
    }

    #[test]
    fn assistant_code_block_indents_and_wraps() {
        let blocks = blocks_of(vec![Block::Assistant {
            text: "Look:\n```rust\nfn main() {}\n```".into(),
            done: true,
            provider: None,
            model: None,
        }]);
        let mut v = Viewport::new();
        let total = v.line_count(&blocks, ViewportWidth(80));
        // 1 ("Look:" paragraph) + 1 separator + 1 (```rust) + 1 (fn main) + 1 (```) = 5
        assert!(total >= 5, "got {total}");
        let lines = v.slice(&blocks, ViewportWidth(80), 0, total, &theme());
        // Some line must contain "fn main".
        let any_main = lines
            .iter()
            .any(|vl| vl.line.spans.iter().any(|s| s.content.contains("fn main")));
        assert!(any_main, "expected a line containing `fn main`");
    }
}
