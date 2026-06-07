//! Mouse event resolver for the TUI.

use crossterm::event::{MouseButton, MouseEventKind};
use ratatui::layout::Rect;

use crate::ui::app::Block;
use crate::ui::links::LinkClickTarget;
use crate::ui::viewport::{Viewport, ViewportWidth};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MouseAction {
    /// Click on a conversation hyperlink. M1 surfaces the URL as a toast;
    /// opener integration is deferred to M2.
    ConversationLinkClick {
        url: String,
    },
    ConversationClick {
        block_idx: usize,
    },
    InputClick {
        visual_row: usize,
        visual_col: usize,
        width: usize,
    },
    ConversationScroll {
        lines: i32,
    },
    Unhandled,
}

pub fn resolve_mouse_event(
    kind: MouseEventKind,
    column: u16,
    row: u16,
    conversation_area: Rect,
    input_area: Rect,
    scroll_offset_lines: usize,
    viewport: &Viewport,
    blocks: &[Block],
    viewport_width: ViewportWidth,
    link_click_targets: &[LinkClickTarget],
) -> MouseAction {
    match kind {
        MouseEventKind::Down(MouseButton::Left) => {
            if contains_inner(conversation_area, column, row) {
                let local_row = row.saturating_sub(conversation_area.y + 1) as usize;
                let local_col = column.saturating_sub(conversation_area.x + 1) as usize;
                if let Some(target) = link_click_targets.iter().find(|target| {
                    target.line_idx == local_row
                        && local_col >= target.col_start
                        && local_col < target.col_end
                }) {
                    return MouseAction::ConversationLinkClick {
                        url: target.url.clone(),
                    };
                }
                let visual_line_offset = scroll_offset_lines + local_row;
                return viewport
                    .hit_test(blocks, viewport_width, visual_line_offset)
                    .map(|block_idx| MouseAction::ConversationClick { block_idx })
                    .unwrap_or(MouseAction::Unhandled);
            }

            if contains_inner(input_area, column, row) {
                return MouseAction::InputClick {
                    visual_row: row.saturating_sub(input_area.y + 1) as usize,
                    visual_col: column.saturating_sub(input_area.x + 1) as usize,
                    width: input_area.width.saturating_sub(2) as usize,
                };
            }

            MouseAction::Unhandled
        }
        MouseEventKind::ScrollDown => MouseAction::ConversationScroll { lines: 3 },
        MouseEventKind::ScrollUp => MouseAction::ConversationScroll { lines: -3 },
        _ => MouseAction::Unhandled,
    }
}

fn contains_inner(area: Rect, column: u16, row: u16) -> bool {
    column > area.x
        && column < area.right().saturating_sub(1)
        && row > area.y
        && row < area.bottom().saturating_sub(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conversation_area() -> Rect {
        Rect::new(0, 0, 40, 8)
    }

    fn input_area() -> Rect {
        Rect::new(0, 8, 40, 3)
    }

    fn blocks() -> Vec<Block> {
        vec![
            Block::User { text: "one".into() },
            Block::User { text: "two".into() },
        ]
    }

    #[test]
    fn mouse_conversation_click_resolves_block() {
        let blocks = blocks();
        let mut viewport = Viewport::new();
        let width = ViewportWidth(38);
        viewport.line_count(&blocks, width);

        let action = resolve_mouse_event(
            MouseEventKind::Down(MouseButton::Left),
            1,
            1,
            conversation_area(),
            input_area(),
            0,
            &viewport,
            &blocks,
            width,
            &[],
        );

        assert_eq!(action, MouseAction::ConversationClick { block_idx: 0 });
    }

    #[test]
    fn mouse_conversation_link_click_wins_over_block_click() {
        let blocks = blocks();
        let mut viewport = Viewport::new();
        let width = ViewportWidth(38);
        viewport.line_count(&blocks, width);
        let targets = vec![LinkClickTarget {
            line_idx: 0,
            col_start: 0,
            col_end: 5,
            url: "file:///tmp/a.rs".to_string(),
        }];

        let action = resolve_mouse_event(
            MouseEventKind::Down(MouseButton::Left),
            1,
            1,
            conversation_area(),
            input_area(),
            0,
            &viewport,
            &blocks,
            width,
            &targets,
        );

        assert_eq!(
            action,
            MouseAction::ConversationLinkClick {
                url: "file:///tmp/a.rs".to_string()
            }
        );
    }

    #[test]
    fn mouse_conversation_click_uses_scroll_offset() {
        let blocks = blocks();
        let mut viewport = Viewport::new();
        let width = ViewportWidth(38);
        viewport.line_count(&blocks, width);

        let action = resolve_mouse_event(
            MouseEventKind::Down(MouseButton::Left),
            1,
            1,
            conversation_area(),
            input_area(),
            2,
            &viewport,
            &blocks,
            width,
            &[],
        );

        assert_eq!(action, MouseAction::ConversationClick { block_idx: 1 });
    }

    #[test]
    fn mouse_scroll_down_requests_conversation_scroll_up() {
        let action = resolve_mouse_event(
            MouseEventKind::ScrollDown,
            0,
            0,
            conversation_area(),
            input_area(),
            0,
            &Viewport::new(),
            &[],
            ViewportWidth(38),
            &[],
        );

        assert_eq!(action, MouseAction::ConversationScroll { lines: 3 });
    }

    #[test]
    fn mouse_scroll_up_requests_conversation_scroll_down() {
        let action = resolve_mouse_event(
            MouseEventKind::ScrollUp,
            0,
            0,
            conversation_area(),
            input_area(),
            0,
            &Viewport::new(),
            &[],
            ViewportWidth(38),
            &[],
        );

        assert_eq!(action, MouseAction::ConversationScroll { lines: -3 });
    }

    #[test]
    fn mouse_input_click_resolves_visual_position() {
        let action = resolve_mouse_event(
            MouseEventKind::Down(MouseButton::Left),
            3,
            9,
            conversation_area(),
            input_area(),
            0,
            &Viewport::new(),
            &[],
            ViewportWidth(38),
            &[],
        );

        assert_eq!(
            action,
            MouseAction::InputClick {
                visual_row: 0,
                visual_col: 2,
                width: 38,
            }
        );
    }

    #[test]
    fn mouse_right_click_is_unhandled() {
        let action = resolve_mouse_event(
            MouseEventKind::Down(MouseButton::Right),
            1,
            1,
            conversation_area(),
            input_area(),
            0,
            &Viewport::new(),
            &[],
            ViewportWidth(38),
            &[],
        );

        assert_eq!(action, MouseAction::Unhandled);
    }

    #[test]
    fn mouse_input_prefix_widths_match_render_contract() {
        assert_eq!(
            unicode_width::UnicodeWidthStr::width(crate::ui::render::INPUT_FIRST_PREFIX),
            2
        );
        assert_eq!(
            unicode_width::UnicodeWidthStr::width(crate::ui::render::INPUT_CONT_PREFIX),
            2
        );
    }
}
