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

use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

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
    /// Total visual lines across all blocks (including inter-block gaps).
    total: usize,
    /// `offsets[i]` = sum of line counts for blocks `[0, i)` including gaps.
    /// Length is `blocks.len() + 1`. Last entry equals `total`.
    offsets: Vec<usize>,
    /// Visual line count for each block, including its trailing gap.
    line_counts: Vec<usize>,
    /// Rendered lines per block index, lazily filled.
    rendered: HashMap<usize, RenderedBlock>,
}

#[derive(Debug, Clone)]
struct RenderedBlock {
    /// Version derived from the source block's mutation counter
    /// (`App::block_version`); mismatch forces a re-render.
    version: u64,
    theme: Theme,
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
        self.ensure_layout(blocks, width).total
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
        if count == 0 {
            return Vec::new();
        }
        let total = self.ensure_layout(blocks, width).total;

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
            self.ensure_block_rendered(blocks, width, block_idx, theme);

            let rendered = self
                .layouts
                .get(&width)
                .expect("layout just built")
                .rendered
                .get(&block_idx)
                .expect("rendered just ensured")
                .clone();

            let local_start = start.saturating_sub(block_start);
            let local_end = end.saturating_sub(block_start).min(rendered.lines.len());
            for line in rendered
                .lines
                .into_iter()
                .skip(local_start)
                .take(local_end - local_start)
            {
                out.push(line);
            }
            block_idx += 1;
        }

        out
    }

    fn ensure_layout(&mut self, blocks: &[Block], width: ViewportWidth) -> &mut Layout {
        let needs_rebuild = self
            .layouts
            .get(&width)
            .map(|l| l.line_counts.len() != blocks.len())
            .unwrap_or(true);
        if needs_rebuild {
            self.build_layout(blocks, width);
        }
        self.layouts.get_mut(&width).expect("layout just built")
    }

    fn build_layout(&mut self, blocks: &[Block], width: ViewportWidth) {
        let content_width = content_width_for(width);
        let mut offsets = Vec::with_capacity(blocks.len() + 1);
        let mut line_counts = Vec::with_capacity(blocks.len());
        let mut total = 0usize;
        offsets.push(0);
        for (idx, block) in blocks.iter().enumerate() {
            let count = block_line_count(block, content_width)
                + if has_trailing_gap(idx, blocks.len()) {
                    1
                } else {
                    0
                };
            line_counts.push(count);
            total += count;
            offsets.push(total);
        }
        let layout = Layout {
            total,
            offsets,
            line_counts,
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
    ) {
        let version = block_version(blocks, idx);
        let needs_render = match self.layouts.get(&width).and_then(|l| l.rendered.get(&idx)) {
            Some(r) => r.version != version || r.theme != *theme,
            None => true,
        };
        if !needs_render {
            return;
        }
        let content_width = content_width_for(width);
        let block = match blocks.get(idx).cloned() {
            Some(b) => b,
            None => return,
        };
        let gap = has_trailing_gap(idx, blocks.len());
        let lines = render_block(&block, idx, content_width, gap, theme);
        let layout = self
            .layouts
            .get_mut(&width)
            .expect("layout must exist before rendering block");
        layout.rendered.insert(
            idx,
            RenderedBlock {
                version,
                theme: *theme,
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
    // Conversation widget has a 1-cell border on each side. We also reserve
    // a 2-cell left gutter for the icon column (tool statuses, raw marker).
    width.0.saturating_sub(4).max(1)
}

/// Should block N be followed by a blank separator row? Mirrors
/// `ConversationViewport.gapAfterEntry` with `superCompactTools = false`.
fn has_trailing_gap(idx: usize, total_blocks: usize) -> bool {
    idx + 1 < total_blocks
}

fn block_line_count(block: &Block, width: usize) -> usize {
    match block {
        Block::User { text } => {
            // Header line ("you: <text>") wraps to `width`.
            // We overestimate by 1 to account for the "you: " prefix.
            let prefix = 5;
            wrap::line_count(text, width.saturating_sub(prefix).max(1)).max(1)
        }
        Block::Assistant { text, .. } => {
            if text.is_empty() {
                1
            } else {
                markdown::markdown_line_count(text, width).max(1)
            }
        }
        Block::ToolCall { name, args, .. } => {
            tool_renderers::tool_call_line_count(name, args, width)
        }
        Block::ToolResult {
            call_id,
            summary,
            ok,
        } => tool_renderers::render_tool_result(call_id, summary, *ok, width)
            .len()
            .max(1),
        Block::RawEvent { line, .. } => wrap::line_count(line, width).max(1),
        Block::Diag { text, .. } => wrap::line_count(text, width).max(1),
    }
}

fn render_block(
    block: &Block,
    idx: usize,
    width: usize,
    gap: bool,
    theme: &Theme,
) -> Vec<VisualLine> {
    let mut out: Vec<VisualLine> = Vec::new();
    append_block_lines(block, idx, width, &mut out, theme);
    if gap {
        out.push(VisualLine {
            line: Line::raw(""),
            source_idx: None,
        });
    }
    out
}

fn append_block_lines(
    block: &Block,
    idx: usize,
    width: usize,
    out: &mut Vec<VisualLine>,
    theme: &Theme,
) {
    match block {
        Block::User { text } => {
            let body_width = width.saturating_sub(5).max(1);
            let lines = wrap::wrap_text(text, body_width);
            for (i, line) in lines.into_iter().enumerate() {
                let mut spans = Vec::with_capacity(3);
                if i == 0 {
                    spans.push(Span::styled(
                        "you",
                        Style::default()
                            .fg(theme.list_marker)
                            .add_modifier(Modifier::BOLD),
                    ));
                    spans.push(Span::raw(": "));
                } else {
                    spans.push(Span::raw("     "));
                }
                spans.push(Span::styled(line, theme.style_for(ThemeRole::UserText)));
                out.push(VisualLine {
                    line: Line::from(spans),
                    source_idx: Some(idx),
                });
            }
        }
        Block::Assistant {
            text,
            done,
            provider,
            model,
        } => {
            let header = vec![
                Span::styled(
                    "assistant",
                    Style::default()
                        .fg(theme.tool_completed)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::raw(": "),
                Span::styled(
                    format!(
                        "({}{}) ",
                        provider.clone().unwrap_or_default(),
                        model.clone().map(|m| format!("/{m}")).unwrap_or_default(),
                    ),
                    theme.style_for(ThemeRole::StatusDim),
                ),
                Span::styled(
                    if *done { "" } else { "…" },
                    theme.style_for(ThemeRole::ToolRunning),
                ),
            ];
            if text.is_empty() {
                out.push(VisualLine {
                    line: Line::from(header),
                    source_idx: Some(idx),
                });
                return;
            }
            let md_lines = markdown::render_markdown_with_theme(text, width, theme);
            if md_lines.is_empty() {
                out.push(VisualLine {
                    line: Line::from(header),
                    source_idx: Some(idx),
                });
                return;
            }
            // First visual line carries the assistant header.
            let mut iter = md_lines.into_iter();
            let first = iter.next().unwrap();
            let mut spans = header.clone();
            // Note: ratatui Line.spans must have content whose first span
            // may be empty; we just append the existing spans.
            spans.extend(first.spans);
            out.push(VisualLine {
                line: Line::from(spans),
                source_idx: Some(idx),
            });
            for line in iter {
                out.push(VisualLine {
                    line,
                    source_idx: Some(idx),
                });
            }
        }
        Block::ToolCall {
            name, args, status, ..
        } => {
            for line in
                tool_renderers::render_tool_call_with_theme(name, args, *status, width, theme)
            {
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
            for line in wrap::wrap_text(text, width) {
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

    fn blocks_of(blocks: Vec<Block>) -> Vec<Block> {
        blocks
    }

    fn theme() -> Theme {
        Theme::default()
    }

    #[test]
    fn empty_conversation_has_zero_lines() {
        let blocks = blocks_of(vec![]);
        let mut v = Viewport::new();
        assert_eq!(v.line_count(&blocks, ViewportWidth(80)), 0);
    }

    #[test]
    fn user_block_counts_prefix() {
        let blocks = blocks_of(vec![Block::User { text: "abc".into() }]);
        let mut v = Viewport::new();
        // Width 80: content_width=76, prefix=5, body=71. "abc" fits.
        assert_eq!(v.line_count(&blocks, ViewportWidth(80)), 1);
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
        // First visual line carries the "assistant" header.
        let first: String = lines[0]
            .line
            .spans
            .iter()
            .map(|s| s.content.as_ref())
            .collect();
        assert!(first.contains("assistant"), "got {first:?}");
        // And contains the heading body.
        assert!(first.contains("Heading"), "got {first:?}");
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
