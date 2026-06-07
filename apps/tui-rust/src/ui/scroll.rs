//! Scroll state for the conversation viewport.
//!
//! Mirrors `src/app/screen/scroll-controller.ts`, stripped of:
//!
//! - History-window pagination (`loadOlderSessionHistory`,
//!   `olderHistoryThresholdLines`). Will be wired in M0 #2
//!   (session persistence) and M2 #26 (resume loader).
//! - Tab-panel subtraction in body-height math. We have a single tab in
//!   M0; the host already subtracts the status and input rows before
//!   calling us.
//! - Text search / jump-to-entry. That lands in M2 #25.
//!
//! What we keep:
//!
//! - Two-state model: "follow tail" (`scroll_from_bottom == 0`) vs
//!   "detached" (`detached_start` = absolute top line of the view).
//! - Stable scroll during resize and history append: while detached,
//!   `detached_start` is preserved as an absolute offset; while
//!   following tail, the view re-anchors to the new bottom.
//! - `scroll_by_lines(delta)` with `delta > 0` moving toward the top of
//!   the conversation (matches the TS convention).
//! - `scroll_by_page(direction)` returns whether anything changed so
//!   the caller can skip a re-render.

/// Direction for page-size scrolls.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageDirection {
    Up = -1,
    Down = 1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScrollMetrics {
    /// Visible body height (lines).
    pub body_height: usize,
    /// Total visual lines in the conversation.
    pub line_count: usize,
    /// Maximum scroll-from-top offset.
    pub max_scroll: usize,
    /// Absolute line index of the topmost visible row.
    pub start: usize,
    /// Distance from the bottom; 0 means we are following the tail.
    pub scroll_from_bottom: usize,
}

#[derive(Debug, Clone, Default)]
pub struct ScrollView {
    /// 0 means we are following the tail.
    pub scroll_from_bottom: usize,
    /// When we are not following the tail we hold the absolute start line
    /// so resize / append doesn't drift the view.
    pub detached_start: Option<usize>,
}

impl ScrollView {
    pub fn reset(&mut self) {
        self.scroll_from_bottom = 0;
        self.detached_start = None;
    }

    /// Re-anchor to the bottom of the conversation. Returns whether the
    /// scroll position changed.
    pub fn scroll_to_bottom(&mut self) -> bool {
        let changed = self.scroll_from_bottom != 0 || self.detached_start.is_some();
        self.scroll_from_bottom = 0;
        self.detached_start = None;
        changed
    }

    /// Compute current scroll metrics given the conversation's current
    /// line count and the visible body height. Updates internal state to
    /// stay within bounds.
    pub fn metrics(&mut self, line_count: usize, body_height: usize) -> ScrollMetrics {
        let max_scroll = line_count.saturating_sub(body_height);
        let start;
        if let Some(detached) = self.detached_start {
            let clamped = detached.min(max_scroll);
            start = clamped;
            self.scroll_from_bottom = line_count
                .saturating_sub(body_height)
                .saturating_sub(clamped);
            if clamped >= max_scroll {
                self.detached_start = None;
            }
        } else {
            self.scroll_from_bottom = self.scroll_from_bottom.min(max_scroll);
            start = line_count
                .saturating_sub(body_height)
                .saturating_sub(self.scroll_from_bottom);
        }
        ScrollMetrics {
            body_height,
            line_count,
            max_scroll,
            start,
            scroll_from_bottom: self.scroll_from_bottom,
        }
    }

    /// Scroll by `delta` lines. Positive delta moves toward the top of the
    /// conversation (away from the bottom). Returns whether the scroll
    /// position changed.
    pub fn scroll_by_lines(&mut self, delta: i32, line_count: usize, body_height: usize) -> bool {
        let max_scroll = line_count.saturating_sub(body_height);
        let cur = self.metrics(line_count, body_height).start;
        // delta > 0 → toward TOP (start decreases).
        // delta < 0 → toward BOTTOM (start increases).
        let target_unclamped = if delta >= 0 {
            cur.saturating_sub(delta as usize)
        } else {
            cur.saturating_add(delta.unsigned_abs() as usize)
        };
        let target = target_unclamped.min(max_scroll);
        let new_from_bottom = line_count
            .saturating_sub(body_height)
            .saturating_sub(target);
        let new_detached = if new_from_bottom == 0 {
            None
        } else {
            Some(target)
        };
        let changed =
            self.scroll_from_bottom != new_from_bottom || self.detached_start != new_detached;
        self.scroll_from_bottom = new_from_bottom;
        self.detached_start = new_detached;
        changed
    }

    /// Page-size scroll: `direction = -1` is page-up, `+1` is page-down.
    /// `page_size` should be the visible body height (or slightly less if
    /// you want a context overlap).
    pub fn scroll_by_page(
        &mut self,
        direction: PageDirection,
        page_size: usize,
        line_count: usize,
        body_height: usize,
    ) -> bool {
        let step = page_size.max(1);
        let delta = match direction {
            PageDirection::Up => step as i32,
            PageDirection::Down => -(step as i32),
        };
        self.scroll_by_lines(delta, line_count, body_height)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn follows_tail_by_default() {
        let mut sv = ScrollView::default();
        let m = sv.metrics(100, 10);
        assert_eq!(m.start, 90);
        assert_eq!(m.scroll_from_bottom, 0);
    }

    #[test]
    fn scroll_up_detaches() {
        let mut sv = ScrollView::default();
        let changed = sv.scroll_by_lines(5, 100, 10);
        assert!(changed);
        let m = sv.metrics(100, 10);
        // 100 - 10 - 5 = 85
        assert_eq!(m.start, 85);
        assert_eq!(m.scroll_from_bottom, 5);
        assert_eq!(sv.detached_start, Some(85));
    }

    #[test]
    fn scroll_down_re_attaches() {
        let mut sv = ScrollView::default();
        sv.scroll_by_lines(8, 100, 10);
        let changed = sv.scroll_by_lines(-8, 100, 10);
        assert!(changed);
        assert_eq!(sv.detached_start, None);
        assert_eq!(sv.scroll_from_bottom, 0);
    }

    #[test]
    fn scroll_clamps_to_max_scroll() {
        let mut sv = ScrollView::default();
        // Way overscroll: there are only 90 max_scroll positions.
        sv.scroll_by_lines(1000, 100, 10);
        let m = sv.metrics(100, 10);
        assert_eq!(m.start, 0);
        assert_eq!(m.scroll_from_bottom, 90);
    }

    #[test]
    fn detached_start_survives_resize() {
        // Conversation grows by 10 lines while we're scrolled away from
        // the bottom. The absolute start should stay where the user put it
        // so what they were looking at remains visible.
        let mut sv = ScrollView::default();
        sv.scroll_by_lines(5, 100, 10);
        let m1 = sv.metrics(100, 10);
        assert_eq!(m1.start, 85);
        // Grow history: now 110 lines, max_scroll = 100.
        let m2 = sv.metrics(110, 10);
        assert_eq!(m2.start, 85); // absolute preserved
        assert_eq!(m2.scroll_from_bottom, 15); // distance from new bottom grew
    }

    #[test]
    fn follow_tail_grows_with_history() {
        let mut sv = ScrollView::default();
        let m1 = sv.metrics(100, 10);
        assert_eq!(m1.start, 90);
        let m2 = sv.metrics(110, 10);
        assert_eq!(m2.start, 100);
    }

    #[test]
    fn page_scroll_up_and_down() {
        let mut sv = ScrollView::default();
        sv.scroll_by_page(PageDirection::Up, 8, 100, 10);
        let m = sv.metrics(100, 10);
        assert_eq!(m.start, 82);
        sv.scroll_by_page(PageDirection::Down, 8, 100, 10);
        let m = sv.metrics(100, 10);
        assert_eq!(m.start, 90);
    }

    #[test]
    fn scroll_to_bottom_clears_detached() {
        let mut sv = ScrollView::default();
        sv.scroll_by_lines(5, 100, 10);
        assert!(sv.detached_start.is_some());
        let changed = sv.scroll_to_bottom();
        assert!(changed);
        assert!(sv.detached_start.is_none());
        assert_eq!(sv.scroll_from_bottom, 0);
    }

    #[test]
    fn empty_conversation_clamps_to_zero() {
        let mut sv = ScrollView::default();
        let m = sv.metrics(0, 10);
        assert_eq!(m.start, 0);
        assert_eq!(m.scroll_from_bottom, 0);
    }

    #[test]
    fn short_conversation_no_scroll() {
        let mut sv = ScrollView::default();
        // Conversation shorter than body: max_scroll = 0.
        let m = sv.metrics(5, 10);
        assert_eq!(m.start, 0);
        assert_eq!(m.scroll_from_bottom, 0);
    }
}
