//! Multi-line input editor for the prompt area.
//!
//! Ported (with M0 scope) from `src/input-editor.ts`. We model:
//!
//! - Text buffer with `\n` line separators
//! - Byte-offset cursor (always at a UTF-8 char boundary)
//! - Logical-line ↔ offset helpers
//! - Word-boundary helpers (ASCII-style)
//! - `render()` that wraps each logical line into visual rows and tracks
//!   the cursor's visual position + auto-scroll offset
//!
//! Out of scope for M0 (deferred to M1+):
//!
//! - Selection / shift-arrow extend
//! - Undo / redo
//! - Bracketed-paste mode
//! - Suggestion / tag spans
//!
//! See `plans/tui-rust.md` for the full port roadmap.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use super::attachments::{Attachment, AttachmentManager};

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InputDraftState {
    pub text: String,
    pub cursor: usize,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
}

#[derive(Debug, Default, Clone)]
pub struct InputEditor {
    text: String,
    cursor: usize,
    attachments: AttachmentManager,
    content_version: u64,
    scroll_offset: Option<usize>,
}

#[derive(Debug, Clone)]
pub struct RenderedInput {
    /// Visual rows in top-to-bottom order. Each row's text already
    /// includes the chosen prefix (`first_prefix` or `cont_prefix`).
    pub visual_lines: Vec<InputVisualLine>,
    pub cursor_visual_row: usize,
    pub cursor_screen_col: usize,
    pub scroll_offset: usize,
    pub cursor_visible: bool,
}

#[derive(Debug, Clone)]
pub struct InputVisualLine {
    /// Full row text including prefix.
    pub text: String,
    /// True if this row exists only because the previous logical line
    /// wrapped (not because a `\n` started a new logical line).
    pub wrapped: bool,
    /// Inclusive start byte offset (in editor.text) of the chunk this
    /// row renders. Points at a char boundary.
    pub start_offset: usize,
    /// Exclusive end byte offset. The chunk this row covers is
    /// `&editor.text[start_offset..end_offset]`.
    pub end_offset: usize,
}

#[derive(Debug, Clone)]
struct AttachmentTagRange {
    tag: String,
    start: usize,
    end: usize,
    remove_end: usize,
}

impl InputEditor {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_text(text: impl Into<String>) -> Self {
        let mut ed = Self::new();
        ed.text = text.into();
        ed.cursor = ed.text.len();
        ed
    }

    // -------- accessors ---------------------------------------------------

    pub fn text(&self) -> &str {
        &self.text
    }
    pub fn cursor(&self) -> usize {
        self.cursor
    }
    pub fn char_at_offset(&self, offset: usize) -> Option<char> {
        if offset >= self.text.len() || !self.text.is_char_boundary(offset) {
            return None;
        }
        self.text[offset..].chars().next()
    }
    pub fn word_at_cursor(&self) -> Option<(usize, usize)> {
        if self.cursor > self.text.len() || !self.text.is_char_boundary(self.cursor) {
            return None;
        }

        let mut start = self.cursor;
        while start > 0 {
            let prev = prev_char_boundary(&self.text, start);
            let ch = self.text[prev..start].chars().next()?;
            if !is_path_word_char(ch) {
                break;
            }
            start = prev;
        }

        let mut end = self.cursor;
        while end < self.text.len() {
            let ch = self.text[end..].chars().next()?;
            if !is_path_word_char(ch) {
                break;
            }
            end += ch.len_utf8();
        }

        (start < end).then_some((start, end))
    }
    pub fn content_version(&self) -> u64 {
        self.content_version
    }
    pub fn attachments_ref(&self) -> &AttachmentManager {
        &self.attachments
    }
    pub fn has_attachments(&self) -> bool {
        self.attachments.has_attachments()
    }
    pub fn attachment_summary(&self) -> Option<String> {
        self.attachments.counts().summary()
    }
    pub fn images_for_prompt(&self) -> Vec<Value> {
        self.attachments.extract_images_for_prompt()
    }
    pub fn text_for_submit(&self) -> String {
        let mut result = self.text.clone();
        for attachment in self.attachments.attachments() {
            if let Attachment::PastedText { tag, text, .. } = attachment {
                result = result.replace(tag, text);
            }
        }
        result
    }
    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }
    pub fn is_multiline(&self) -> bool {
        self.text.contains('\n')
    }
    pub fn draft_state(&self) -> InputDraftState {
        InputDraftState {
            text: self.text.clone(),
            cursor: self.cursor,
            attachments: self.attachments.attachments().to_vec(),
        }
    }
    pub fn starts_with_slash(&self) -> bool {
        self.text().starts_with('/')
    }
    /// True when the cursor is on the first logical line.
    pub fn cursor_on_first_line(&self) -> bool {
        !self.text[..self.cursor].contains('\n')
    }
    /// True when the cursor is on the last logical line.
    pub fn cursor_on_last_line(&self) -> bool {
        !self.text[self.cursor..].contains('\n')
    }

    // -------- bulk setters ------------------------------------------------

    pub fn clear(&mut self) {
        if self.text.is_empty() && self.cursor == 0 && !self.attachments.has_attachments() {
            return;
        }
        self.text.clear();
        self.cursor = 0;
        self.attachments.clear();
        self.scroll_offset = None;
        self.bump_version();
    }

    pub fn set_text(&mut self, text: impl Into<String>) {
        self.text = text.into();
        self.cursor = self.text.len();
        self.scroll_offset = None;
        self.clamp_cursor();
        self.sync_attachments_with_text();
        self.bump_version();
    }

    pub fn set_draft_state(&mut self, state: InputDraftState) {
        self.text = state.text;
        self.cursor = state.cursor.min(self.text.len());
        self.attachments.set_attachments(state.attachments);
        self.scroll_offset = None;
        self.clamp_cursor();
        self.sync_attachments_with_text();
        self.bump_version();
    }

    // -------- mutations ---------------------------------------------------

    /// Insert a string at the cursor.
    pub fn insert(&mut self, s: &str) {
        if s.is_empty() {
            return;
        }
        self.detach_attachment_being_edited();
        self.text.insert_str(self.cursor, s);
        self.cursor += s.len();
        self.clamp_cursor();
        self.sync_attachments_with_text();
        self.bump_version();
    }

    pub fn insert_char(&mut self, c: char) {
        self.detach_attachment_being_edited();
        self.text.insert(self.cursor, c);
        self.cursor += c.len_utf8();
        self.sync_attachments_with_text();
        self.bump_version();
    }

    pub fn insert_newline(&mut self) {
        self.detach_attachment_being_edited();
        self.text.insert(self.cursor, '\n');
        self.cursor += 1;
        self.sync_attachments_with_text();
        self.bump_version();
    }

    pub fn attach_image(&mut self, data: impl Into<String>, mime: impl Into<String>) {
        let tag = self.attachments.attach_image(data, mime).tag().to_string();
        self.insert(&format!("{tag} "));
    }

    pub fn attach_pasted_text(&mut self, text: impl Into<String>) {
        let tag = self.attachments.attach_pasted_text(text).tag().to_string();
        self.insert(&format!("{tag} "));
    }

    pub fn attach_file(&mut self, path: impl AsRef<std::path::Path>) -> Result<()> {
        let tag = self.attachments.attach_file(path)?.tag().to_string();
        self.insert(&format!("{tag} "));
        Ok(())
    }

    pub fn replace_range_with_file_attachment(
        &mut self,
        start: usize,
        end: usize,
        path: impl AsRef<std::path::Path>,
    ) -> Result<()> {
        if start > end
            || end > self.text.len()
            || !self.text.is_char_boundary(start)
            || !self.text.is_char_boundary(end)
        {
            return Ok(());
        }
        let tag = self.attachments.attach_file(path)?.tag().to_string();
        self.remove_text_range_inner(start, end, false);
        self.insert(&format!("{tag} "));
        Ok(())
    }

    pub fn remove_attachment_at_cursor(&mut self) -> bool {
        let Some(range) = self.attachment_range_at_cursor(false) else {
            return false;
        };
        let removed = self.remove_attachment_range(range);
        if removed {
            self.bump_version();
        }
        removed
    }

    pub fn delete_backward(&mut self) {
        if self.cursor == 0 {
            return;
        }
        if let Some(range) = self.attachment_range_at_cursor(true) {
            if self.remove_attachment_range(range) {
                self.bump_version();
            }
            return;
        }
        let prev = prev_char_boundary(&self.text, self.cursor);
        self.text.drain(prev..self.cursor);
        self.cursor = prev;
        self.bump_version();
    }

    pub fn delete_forward(&mut self) {
        if self.cursor >= self.text.len() {
            return;
        }
        if let Some(range) = self.attachment_range_at_cursor(false) {
            if self.remove_attachment_range(range) {
                self.bump_version();
            }
            return;
        }
        let next = next_char_boundary(&self.text, self.cursor);
        self.text.drain(self.cursor..next);
        self.bump_version();
    }

    /// Delete from the start of the current logical line back to the
    /// cursor. If the cursor is already at the line start, delete the
    /// trailing newline of the previous line instead (joining lines).
    pub fn delete_to_line_start_or_previous_line_end(&mut self) {
        let line_start = self.find_line_start(self.cursor);
        if line_start < self.cursor {
            self.remove_text_range(line_start, self.cursor);
            self.bump_version();
        } else if line_start > 0 {
            // Delete the '\n' immediately before us.
            self.remove_text_range(line_start - 1, line_start);
            self.bump_version();
        }
    }

    /// Delete the word immediately before the cursor (ASCII whitespace +
    /// punctuation boundaries, mirroring `find_word_start`).
    pub fn delete_word_backward(&mut self) {
        if self.cursor == 0 {
            return;
        }
        let word_start = self.find_word_start(self.cursor);
        if word_start < self.cursor {
            self.remove_text_range(word_start, self.cursor);
            self.bump_version();
        }
    }

    // -------- movement ----------------------------------------------------

    pub fn move_left(&mut self) {
        if self.cursor == 0 {
            return;
        }
        self.cursor = prev_char_boundary(&self.text, self.cursor);
        self.scroll_offset = None;
    }

    pub fn move_right(&mut self) {
        if self.cursor >= self.text.len() {
            return;
        }
        self.cursor = next_char_boundary(&self.text, self.cursor);
        self.scroll_offset = None;
    }

    /// Move the cursor up one logical line (M0: no visual wrap
    /// awareness for vertical movement). Returns `true` if it moved.
    pub fn move_up(&mut self) -> bool {
        self.move_logical(-1)
    }
    /// Move the cursor down one logical line. Returns `true` if it moved.
    pub fn move_down(&mut self) -> bool {
        self.move_logical(1)
    }

    fn move_logical(&mut self, direction: i32) -> bool {
        let (row, col) = self.offset_to_row_col(self.cursor);
        let logical_lines = self.text.split('\n').count().max(1);
        let new_row = if direction > 0 {
            (row + 1).min(logical_lines - 1)
        } else {
            row.saturating_sub(1)
        };
        if new_row == row {
            return false;
        }
        self.cursor = self.row_col_to_offset(new_row, col);
        self.scroll_offset = None;
        true
    }

    pub fn move_to_line_start(&mut self) {
        self.cursor = self.find_line_start(self.cursor);
        self.scroll_offset = None;
    }
    pub fn move_to_line_end(&mut self) {
        self.cursor = self.find_line_end(self.cursor);
        self.scroll_offset = None;
    }
    pub fn move_to_start(&mut self) {
        self.cursor = 0;
        self.scroll_offset = None;
    }
    pub fn move_to_end(&mut self) {
        self.cursor = self.text.len();
        self.scroll_offset = None;
    }
    pub fn move_word_left(&mut self) {
        self.cursor = self.find_word_start(self.cursor);
        self.scroll_offset = None;
    }
    pub fn move_word_right(&mut self) {
        self.cursor = self.find_word_end(self.cursor);
        self.scroll_offset = None;
    }

    // -------- rendering ---------------------------------------------------

    /// Render the editor into visual rows. Mirrors `InputEditor.render`
    /// from `src/input-editor.ts` minus the attachment/tag/suggestion
    /// span bookkeeping. The `width` argument is the *full* widget width
    /// (including the prefix).
    pub fn render(
        &mut self,
        width: usize,
        max_rows: usize,
        first_prefix: &str,
        cont_prefix: &str,
    ) -> RenderedInput {
        let first_prefix_w = UnicodeWidthStr::width(first_prefix);
        let cont_prefix_w = UnicodeWidthStr::width(cont_prefix);

        let mut visual: Vec<InputVisualLine> = Vec::new();
        let mut logical_offset = 0usize;

        for (li, line) in self.text.split('\n').enumerate() {
            let line_byte_len = line.len();
            let line_start_off = logical_offset;
            let line_end_off = logical_offset + line_byte_len;
            let is_first_logical = li == 0;

            if line.is_empty() {
                let prefix = if is_first_logical && visual.is_empty() {
                    first_prefix
                } else {
                    cont_prefix
                };
                visual.push(InputVisualLine {
                    text: prefix.to_string(),
                    wrapped: false,
                    start_offset: line_start_off,
                    end_offset: line_start_off,
                });
                logical_offset += 1; // count the '\n' separator
                continue;
            }

            // Walk the logical line in display-width-bounded chunks.
            let mut chunk_start_byte = 0usize; // byte offset relative to line
            let mut first_chunk = true;
            while chunk_start_byte < line.len() {
                let prefix: &str = if first_chunk && is_first_logical && visual.is_empty() {
                    first_prefix
                } else if first_chunk {
                    if is_first_logical {
                        first_prefix
                    } else {
                        cont_prefix
                    }
                } else {
                    cont_prefix
                };
                let prefix_w = if first_chunk && is_first_logical {
                    first_prefix_w
                } else if first_chunk {
                    if is_first_logical {
                        first_prefix_w
                    } else {
                        cont_prefix_w
                    }
                } else {
                    cont_prefix_w
                };
                let avail = width.saturating_sub(prefix_w).max(1);

                let (chunk_text, chunk_byte_len) =
                    take_width_bounded_chunk(&line[chunk_start_byte..], avail);

                let start_off = line_start_off + chunk_start_byte;
                let end_off = line_start_off + chunk_start_byte + chunk_byte_len;
                visual.push(InputVisualLine {
                    text: format!("{prefix}{chunk_text}"),
                    wrapped: !first_chunk,
                    start_offset: start_off,
                    end_offset: end_off,
                });
                chunk_start_byte += chunk_byte_len;
                first_chunk = false;
            }
            logical_offset = line_end_off + 1; // +1 for '\n' separator
        }

        if visual.is_empty() {
            visual.push(InputVisualLine {
                text: first_prefix.to_string(),
                wrapped: false,
                start_offset: 0,
                end_offset: 0,
            });
        }

        // Compute cursor row using the (start, end) byte ranges we just
        // recorded. Cursor at end-of-line falls on the row that ends at
        // that offset (i.e. the last row of that logical line).
        let mut cursor_visual_row = 0usize;
        for (i, row) in visual.iter().enumerate() {
            let contains_cursor = self.cursor >= row.start_offset && self.cursor <= row.end_offset;
            if contains_cursor {
                cursor_visual_row = i;
                if !(self.cursor == row.start_offset
                    && i + 1 < visual.len()
                    && visual[i + 1].start_offset == self.cursor)
                {
                    // We pick the first row that contains the cursor OR
                    // whose end exactly matches the cursor. The exception
                    // is when the cursor is exactly at a wrap boundary:
                    // we want to stay on the *previous* row, not the
                    // empty next one. That case is handled by the
                    // exact-wrap-boundary insertion below.
                    break;
                }
            }
        }

        // If the cursor sits exactly at the end of a row whose line
        // filled the width, append an empty wrap row so the cursor has a
        // visible cell.
        let at_exact_boundary = visual
            .get(cursor_visual_row)
            .map(|row| {
                let prefix_w = if cursor_visual_row == 0 {
                    first_prefix_w
                } else {
                    cont_prefix_w
                };
                let avail = width.saturating_sub(prefix_w).max(1);
                let chunk_w = UnicodeWidthStr::width(&self.text[row.start_offset..row.end_offset]);
                self.cursor == row.end_offset
                    && chunk_w == avail
                    && row.end_offset == self.text.len()
                // only add empty trailing row if we're at the very end
            })
            .unwrap_or(false);
        if at_exact_boundary {
            let cursor_line = InputVisualLine {
                text: cont_prefix.to_string(),
                wrapped: true,
                start_offset: self.cursor,
                end_offset: self.cursor,
            };
            cursor_visual_row = visual.len();
            visual.push(cursor_line);
        }

        let safe_max_rows = max_rows.max(1);
        let max_scroll = visual.len().saturating_sub(safe_max_rows);
        let auto = if cursor_visual_row >= safe_max_rows {
            cursor_visual_row - safe_max_rows + 1
        } else {
            0
        };
        let auto = auto.min(max_scroll);
        let scroll_offset = self
            .scroll_offset
            .map(|v| v.min(max_scroll))
            .unwrap_or(auto);
        let cursor_visible =
            cursor_visual_row >= scroll_offset && cursor_visual_row < scroll_offset + safe_max_rows;

        let cursor_screen_col = self.compute_cursor_screen_col(first_prefix, cont_prefix);

        RenderedInput {
            visual_lines: visual,
            cursor_visual_row,
            cursor_screen_col,
            scroll_offset,
            cursor_visible,
        }
    }

    pub fn scroll_by_visual_lines(
        &mut self,
        delta: i32,
        width: usize,
        max_rows: usize,
        first_prefix: &str,
        cont_prefix: &str,
    ) -> bool {
        let rendered = self.render(width, max_rows, first_prefix, cont_prefix);
        self.set_visual_scroll_offset(
            rendered.scroll_offset as i32 + delta,
            width,
            max_rows,
            first_prefix,
            cont_prefix,
        )
    }

    pub fn set_visual_scroll_offset(
        &mut self,
        offset: i32,
        width: usize,
        max_rows: usize,
        first_prefix: &str,
        cont_prefix: &str,
    ) -> bool {
        let rendered = self.render(width, max_rows, first_prefix, cont_prefix);
        let max_scroll = rendered.visual_lines.len().saturating_sub(max_rows.max(1));
        if max_scroll == 0 {
            let was = self.scroll_offset.is_some();
            self.scroll_offset = None;
            return was;
        }
        let next = offset.max(0).min(max_scroll as i32) as usize;
        if next == rendered.scroll_offset && self.scroll_offset.is_some() {
            return false;
        }
        self.scroll_offset = Some(next);
        true
    }

    pub fn click_at_visual_position(
        &mut self,
        visual_row: usize,
        visual_col: usize,
        first_prefix: &str,
        cont_prefix: &str,
        width: usize,
    ) -> bool {
        let rendered = self.render(width, usize::MAX, first_prefix, cont_prefix);
        let Some(line) = rendered.visual_lines.get(visual_row) else {
            return false;
        };

        let prefix_w = if visual_row == 0 {
            UnicodeWidthStr::width(first_prefix)
        } else {
            UnicodeWidthStr::width(cont_prefix)
        };
        let mut col = prefix_w;
        let mut new_cursor = line.start_offset;

        for (i, ch) in self.text[line.start_offset..line.end_offset].char_indices() {
            if col >= visual_col {
                break;
            }
            col += UnicodeWidthChar::width(ch).unwrap_or(0);
            new_cursor = line.start_offset + i + ch.len_utf8();
        }

        self.cursor = new_cursor;
        self.scroll_offset = None;
        true
    }

    pub fn attachment_tag_ranges_for_line(&self, line: &str) -> Vec<(usize, usize)> {
        self.attachments.image_tags_in_text(line)
    }

    // -------- private helpers --------------------------------------------

    fn bump_version(&mut self) {
        self.content_version = self.content_version.wrapping_add(1);
    }

    fn clamp_cursor(&mut self) {
        if self.cursor > self.text.len() {
            self.cursor = self.text.len();
        }
        while !self.text.is_char_boundary(self.cursor) {
            self.cursor = self.cursor.saturating_sub(1);
        }
    }

    fn attachment_tag_ranges(&self) -> Vec<AttachmentTagRange> {
        let mut ranges = Vec::new();
        for attachment in self.attachments.attachments() {
            let tag = attachment.tag();
            let Some(start) = self.text.find(tag) else {
                continue;
            };
            let end = start + tag.len();
            let remove_end = if self.text[end..].starts_with(' ') {
                end + 1
            } else {
                end
            };
            ranges.push(AttachmentTagRange {
                tag: tag.to_string(),
                start,
                end,
                remove_end,
            });
        }
        ranges.sort_by_key(|range| range.start);
        ranges
    }

    fn attachment_range_at_cursor(&self, backward_delete: bool) -> Option<AttachmentTagRange> {
        self.attachment_tag_ranges().into_iter().find(|range| {
            if backward_delete {
                self.cursor > range.start && self.cursor <= range.remove_end
            } else {
                self.cursor >= range.start && self.cursor < range.end
            }
        })
    }

    fn attachment_range_being_edited(&self) -> Option<AttachmentTagRange> {
        self.attachment_tag_ranges()
            .into_iter()
            .find(|range| self.cursor > range.start && self.cursor < range.end)
    }

    fn detach_attachment_being_edited(&mut self) {
        if let Some(range) = self.attachment_range_being_edited() {
            let _ = self.remove_attachment_range(range);
        }
    }

    fn remove_attachment_range(&mut self, range: AttachmentTagRange) -> bool {
        if range.remove_end > self.text.len() {
            return false;
        }
        self.text.drain(range.start..range.remove_end);
        self.cursor = range.start;
        self.attachments.remove_at_tag(&range.tag)
    }

    fn remove_text_range(&mut self, start: usize, end: usize) {
        self.remove_text_range_inner(start, end, true);
    }

    fn remove_text_range_inner(&mut self, start: usize, end: usize, sync_attachments: bool) {
        let Some((start, end)) = self.expand_text_range_to_attachment_boundaries(start, end) else {
            return;
        };

        let tags_to_remove = self
            .attachment_tag_ranges()
            .into_iter()
            .filter(|range| range.start >= start && range.remove_end <= end)
            .map(|range| range.tag)
            .collect::<Vec<_>>();

        self.text.drain(start..end);
        self.cursor = start;
        for tag in tags_to_remove {
            self.attachments.remove_at_tag(&tag);
        }
        if sync_attachments {
            self.sync_attachments_with_text();
        }
    }

    fn expand_text_range_to_attachment_boundaries(
        &self,
        start: usize,
        end: usize,
    ) -> Option<(usize, usize)> {
        if start > end
            || end > self.text.len()
            || !self.text.is_char_boundary(start)
            || !self.text.is_char_boundary(end)
        {
            return None;
        }

        let mut expanded_start = start;
        let mut expanded_end = end;
        loop {
            let mut changed = false;
            for range in self.attachment_tag_ranges() {
                if range.start < expanded_end && range.remove_end > expanded_start {
                    let next_start = expanded_start.min(range.start);
                    let next_end = expanded_end.max(range.remove_end);
                    if next_start != expanded_start || next_end != expanded_end {
                        expanded_start = next_start;
                        expanded_end = next_end;
                        changed = true;
                    }
                }
            }
            if !changed {
                break;
            }
        }
        Some((expanded_start, expanded_end))
    }

    fn sync_attachments_with_text(&mut self) {
        let text = self.text.clone();
        self.attachments
            .retain(|attachment| count_occurrences(&text, attachment.tag()) == 1);
    }

    fn find_line_start(&self, offset: usize) -> usize {
        let at = offset.min(self.text.len());
        match self.text[..at].rfind('\n') {
            Some(i) => i + 1,
            None => 0,
        }
    }

    fn find_line_end(&self, offset: usize) -> usize {
        let at = offset.min(self.text.len());
        match self.text[at..].find('\n') {
            Some(i) => at + i,
            None => self.text.len(),
        }
    }

    fn find_word_start(&self, offset: usize) -> usize {
        let bytes = self.text.as_bytes();
        let mut i = offset.min(bytes.len());
        // Skip trailing whitespace at the cursor.
        while i > 0 && bytes[i - 1].is_ascii_whitespace() {
            i -= 1;
        }
        if i == 0 {
            return 0;
        }
        // Walk over the previous word: same character class as the last
        // non-whitespace byte.
        let class_prev = char_class(bytes[i - 1]);
        while i > 0 && char_class(bytes[i - 1]) == class_prev && !bytes[i - 1].is_ascii_whitespace()
        {
            i -= 1;
        }
        i
    }

    fn find_word_end(&self, offset: usize) -> usize {
        let bytes = self.text.as_bytes();
        let mut i = offset.min(bytes.len());
        // Skip leading whitespace.
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() {
            return bytes.len();
        }
        let class_cur = char_class(bytes[i]);
        while i < bytes.len()
            && char_class(bytes[i]) == class_cur
            && !bytes[i].is_ascii_whitespace()
        {
            i += 1;
        }
        i
    }

    /// (logical_row, byte_offset_within_line_starting_at_zero_for_each_line).
    fn offset_to_row_col(&self, offset: usize) -> (usize, usize) {
        let at = offset.min(self.text.len());
        let mut row = 0;
        let mut start = 0;
        for (i, ch) in self.text[..at].char_indices() {
            if ch == '\n' {
                row += 1;
                start = i + 1;
            }
        }
        (row, at - start)
    }

    fn row_col_to_offset(&self, row: usize, col: usize) -> usize {
        let mut current_row = 0;
        let mut line_start = 0;
        let bytes = self.text.as_bytes();
        for (i, &b) in bytes.iter().enumerate() {
            if current_row == row {
                let line_end = bytes[i..]
                    .iter()
                    .position(|&c| c == b'\n')
                    .map(|p| i + p)
                    .unwrap_or(bytes.len());
                return (line_start + col).min(line_end);
            }
            if b == b'\n' {
                current_row += 1;
                line_start = i + 1;
            }
        }
        if current_row == row {
            return (line_start + col).min(bytes.len());
        }
        bytes.len()
    }

    fn compute_cursor_screen_col(&self, first_prefix: &str, cont_prefix: &str) -> usize {
        let line_start = self.find_line_start(self.cursor);
        let prefix = if line_start == 0 {
            first_prefix
        } else {
            cont_prefix
        };
        let prefix_w = UnicodeWidthStr::width(prefix);
        let segment = &self.text[line_start..self.cursor];
        let seg_w = UnicodeWidthStr::width(segment);
        prefix_w + seg_w + 1 // 1-based column
    }
}

/// Take a chunk of `s` that fits within `avail` display columns. Returns
/// the chunk text and its byte length within `s`.
fn take_width_bounded_chunk(s: &str, avail: usize) -> (String, usize) {
    let mut col = 0usize;
    let mut end_byte = 0usize;
    let mut last_boundary_byte = 0usize;
    let mut last_was_boundary = false;

    for (idx, ch) in s.char_indices() {
        let w = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
        if ch.is_whitespace() {
            // Word boundary — remember it as a wrap candidate.
            last_boundary_byte = idx + ch.len_utf8();
            last_was_boundary = true;
        }
        if col + w > avail {
            if last_was_boundary && last_boundary_byte > 0 {
                let chunk = &s[..last_boundary_byte];
                let trimmed = chunk.trim_end_matches(|c: char| c.is_whitespace());
                let bytes = trimmed.len();
                return (trimmed.to_string(), bytes);
            }
            // Hard break in the middle of a long word.
            if end_byte == 0 {
                // Wide char with no fit at all — emit one char to make progress.
                end_byte = idx + ch.len_utf8();
            }
            break;
        }
        col += w;
        end_byte = idx + ch.len_utf8();
        if col == avail {
            break;
        }
    }
    let chunk = &s[..end_byte];
    let trimmed = chunk.trim_end_matches(|c: char| c.is_whitespace());
    let bytes = trimmed.len();
    (trimmed.to_string(), bytes)
}

fn char_class(b: u8) -> u8 {
    if b.is_ascii_alphanumeric() || b == b'_' {
        0
    } else if b.is_ascii_whitespace() {
        2
    } else {
        1
    }
}

fn is_path_word_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-' | '/' | '@')
}

fn prev_char_boundary(s: &str, cursor: usize) -> usize {
    if cursor == 0 {
        return 0;
    }
    let mut i = cursor - 1;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn next_char_boundary(s: &str, cursor: usize) -> usize {
    let mut i = cursor + 1;
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i.min(s.len())
}

fn count_occurrences(haystack: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }

    let mut count = 0usize;
    let mut search_from = 0usize;
    while let Some(rel) = haystack[search_from..].find(needle) {
        count += 1;
        search_from += rel + needle.len();
        if search_from >= haystack.len() {
            break;
        }
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_editor_renders_one_row() {
        let mut ed = InputEditor::new();
        let r = ed.render(20, 5, "> ", "  ");
        assert_eq!(r.visual_lines.len(), 1);
        assert_eq!(r.visual_lines[0].text, "> ");
        assert_eq!(r.cursor_visual_row, 0);
        assert!(r.cursor_visible);
    }

    #[test]
    fn insert_and_cursor_advances() {
        let mut ed = InputEditor::new();
        ed.insert_char('a');
        ed.insert_char('b');
        ed.insert_char('c');
        assert_eq!(ed.text(), "abc");
        assert_eq!(ed.cursor(), 3);
    }

    #[test]
    fn newline_creates_second_row() {
        let mut ed = InputEditor::new();
        ed.insert("hi\nthere");
        let r = ed.render(20, 5, "> ", "  ");
        assert_eq!(r.visual_lines.len(), 2);
        assert_eq!(r.visual_lines[0].text, "> hi");
        assert_eq!(r.visual_lines[1].text, "  there");
    }

    #[test]
    fn backspace_at_newline_joins_lines() {
        let mut ed = InputEditor::with_text("hi\nworld");
        ed.cursor = 3; // start of "world"
        ed.delete_backward();
        assert_eq!(ed.text(), "hiworld");
        assert_eq!(ed.cursor(), 2);
    }

    #[test]
    fn delete_word_backward_stops_at_word_boundary() {
        let mut ed = InputEditor::with_text("foo bar.baz");
        ed.cursor = ed.text().len();
        ed.delete_word_backward();
        assert_eq!(ed.text(), "foo bar.");
    }

    #[test]
    fn move_up_then_back_down_logical_lines() {
        let mut ed = InputEditor::with_text("line one\nline two\nline three");
        ed.move_to_end();
        // cursor at end of last line
        assert!(ed.move_up());
        // Should land on row 1 col same
        let (row, _col) = ed.offset_to_row_col(ed.cursor());
        assert_eq!(row, 1);
        assert!(ed.move_up());
        let (row2, _) = ed.offset_to_row_col(ed.cursor());
        assert_eq!(row2, 0);
        assert!(!ed.move_up()); // already on first line
    }

    #[test]
    fn line_start_and_end() {
        let mut ed = InputEditor::with_text("aaa\nbbb\nccc");
        ed.cursor = 5; // middle of "bbb"
        ed.move_to_line_start();
        assert_eq!(ed.cursor(), 4);
        ed.move_to_line_end();
        assert_eq!(ed.cursor(), 7);
    }

    #[test]
    fn render_wraps_long_line_into_multiple_rows() {
        let mut ed = InputEditor::with_text("the quick brown fox jumps over the lazy dog");
        let r = ed.render(14, 10, "> ", "  ");
        assert!(
            r.visual_lines.len() > 1,
            "got {} rows",
            r.visual_lines.len()
        );
        // First row has the primary prefix.
        assert!(r.visual_lines[0].text.starts_with("> "));
        // Wrap rows carry the continuation prefix.
        for v in r.visual_lines.iter().skip(1) {
            assert!(v.text.starts_with("  "));
            assert!(v.wrapped);
        }
    }

    #[test]
    fn cursor_row_on_first_line_when_at_start() {
        let mut ed = InputEditor::with_text("aa\nbb\ncc");
        ed.cursor = 0;
        let r = ed.render(20, 5, "> ", "  ");
        assert_eq!(r.cursor_visual_row, 0);
    }

    #[test]
    fn cursor_row_on_last_line_when_at_end() {
        let mut ed = InputEditor::with_text("aa\nbb\ncc");
        ed.move_to_end();
        let r = ed.render(20, 5, "> ", "  ");
        assert_eq!(r.cursor_visual_row, 2);
    }

    #[test]
    fn cursor_row_in_middle_line() {
        let mut ed = InputEditor::with_text("aa\nbb\ncc");
        ed.cursor = 4; // middle of "bb"
        let r = ed.render(20, 5, "> ", "  ");
        assert_eq!(r.cursor_visual_row, 1);
    }

    #[test]
    fn clear_resets_state() {
        let mut ed = InputEditor::with_text("hello");
        ed.clear();
        assert_eq!(ed.text(), "");
        assert_eq!(ed.cursor(), 0);
        assert!(ed.is_empty());
    }

    #[test]
    fn multiline_detection() {
        let mut ed = InputEditor::new();
        assert!(!ed.is_multiline());
        ed.insert("a");
        assert!(!ed.is_multiline());
        ed.insert_newline();
        assert!(ed.is_multiline());
    }

    #[test]
    fn empty_logical_line_renders_blank_with_prefix() {
        let mut ed = InputEditor::with_text("a\n\nb");
        let r = ed.render(20, 5, "> ", "  ");
        assert_eq!(r.visual_lines.len(), 3);
        assert_eq!(r.visual_lines[1].text, "  ");
    }

    #[test]
    fn delete_to_line_start_or_previous_line_end_joins_when_at_line_start() {
        let mut ed = InputEditor::with_text("hello\nworld");
        ed.cursor = 6; // start of "world"
        ed.delete_to_line_start_or_previous_line_end();
        assert_eq!(ed.text(), "helloworld");
        assert_eq!(ed.cursor(), 5);
    }

    #[test]
    fn render_cursor_screen_col_moves_with_cursor() {
        let mut ed = InputEditor::with_text("abcd");
        ed.cursor = 2;
        let r = ed.render(20, 5, "> ", "  ");
        // prefix "> " is 2 wide; cursor at byte 2 ("ab|cd") -> col 2 + 2 + 1 = 5
        assert_eq!(r.cursor_screen_col, 5);
    }

    #[test]
    fn render_auto_scrolls_when_cursor_below_viewport() {
        let mut ed = InputEditor::with_text("a\nb\nc\nd\ne\nf\ng\nh");
        ed.move_to_end();
        let r = ed.render(20, 3, "> ", "  "); // 3 rows visible
        assert!(r.scroll_offset > 0);
        assert!(r.cursor_visible);
    }

    #[test]
    fn click_at_visual_position_moves_cursor_to_clicked_offset() {
        let mut ed = InputEditor::with_text("hello");
        ed.move_to_start();

        let moved = ed.click_at_visual_position(0, 4, "❯ ", "  ", 20);

        assert!(moved);
        assert_eq!(ed.cursor(), 2);
    }

    #[test]
    fn click_at_visual_position_outside_rendered_rows_returns_false() {
        let mut ed = InputEditor::with_text("hello");
        ed.move_to_start();

        let moved = ed.click_at_visual_position(1, 4, "❯ ", "  ", 20);

        assert!(!moved);
        assert_eq!(ed.cursor(), 0);
    }

    #[test]
    fn attach_then_backspace_removes_tag() {
        let mut ed = InputEditor::new();
        ed.attach_image("abc", "image/png");

        assert_eq!(ed.text(), "[Image 1] ");
        assert!(ed.has_attachments());

        ed.delete_backward();

        assert_eq!(ed.text(), "");
        assert!(!ed.has_attachments());
    }

    #[test]
    fn attachments_round_trip_through_text() {
        let mut ed = InputEditor::new();
        ed.insert("look ");
        ed.attach_image("abc", "image/png");
        ed.attach_pasted_text("one\ntwo");

        assert_eq!(ed.images_for_prompt().len(), 1);
        assert_eq!(ed.text_for_submit(), "look [Image 1] one\ntwo ");
        assert_eq!(ed.attachments_ref().attachments().len(), 2);
    }

    #[test]
    fn typing_inside_attachment_detaches_it() {
        let mut ed = InputEditor::new();
        ed.attach_image("abc", "image/png");
        ed.cursor = 3;

        ed.insert_char('x');

        assert_eq!(ed.text(), "x");
        assert!(!ed.has_attachments());
    }

    #[test]
    fn set_text_drops_attachments_when_tags_disappear() {
        let mut ed = InputEditor::new();
        ed.attach_image("abc", "image/png");
        ed.attach_pasted_text("one\ntwo");

        ed.set_text("rewritten prompt");

        assert_eq!(ed.text(), "rewritten prompt");
        assert!(!ed.has_attachments());
        assert!(ed.images_for_prompt().is_empty());
    }

    #[test]
    fn deleting_word_over_attachment_removes_whole_tag() {
        let mut ed = InputEditor::new();
        ed.insert("look ");
        ed.attach_image("abc", "image/png");

        ed.delete_word_backward();

        assert_eq!(ed.text(), "look ");
        assert!(!ed.has_attachments());
    }

    #[test]
    fn delete_to_line_start_removes_overlapping_attachment() {
        let mut ed = InputEditor::new();
        ed.insert("look ");
        ed.attach_pasted_text("one\ntwo");
        ed.insert("tail");

        ed.delete_to_line_start_or_previous_line_end();

        assert_eq!(ed.text(), "");
        assert!(!ed.has_attachments());
    }

    #[test]
    fn duplicating_tag_text_detaches_attachment() {
        let mut ed = InputEditor::new();
        ed.attach_image("abc", "image/png");
        let tag = ed.text().trim().to_string();
        ed.insert(&tag);

        assert!(!ed.has_attachments());
        assert!(ed.images_for_prompt().is_empty());
    }
}
