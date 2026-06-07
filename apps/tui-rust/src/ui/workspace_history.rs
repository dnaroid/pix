//! Workspace cwd history and undo helpers.
//!
//! The TUI keeps this state locally. The sidecar owns the actual runtime cwd,
//! so callers must pair an `undo()` result with `pix:set_cwd` before updating
//! visible app state.

use std::path::{Path, PathBuf};

use serde_json::json;

use crate::bridge::protocol::Command;
use crate::bridge::{BridgeClient, BridgeError};

/// Bounded workspace cwd history.
///
/// `stack` is chronological from oldest to newest. `cursor` points at the
/// current entry; entries after the cursor are the redo branch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceHistory {
    pub stack: Vec<PathBuf>,
    pub cursor: Option<usize>,
    pub max_entries: usize,
}

impl WorkspaceHistory {
    pub fn new(max_entries: usize) -> Self {
        Self {
            stack: Vec::new(),
            cursor: None,
            max_entries,
        }
    }

    /// Record a successfully selected cwd.
    ///
    /// Recording from the middle of history discards the redo branch, matching
    /// browser-like undo/redo semantics. If the cwd is the current entry we
    /// keep the cursor in place and only discard any redo branch.
    pub fn record_cwd(&mut self, cwd: PathBuf) {
        if self.max_entries == 0 {
            self.stack.clear();
            self.cursor = None;
            return;
        }

        if let Some(cursor) = self.cursor {
            if cursor < self.stack.len() {
                let current = self.stack[cursor].clone();
                self.stack.truncate(cursor + 1);
                if current == cwd {
                    self.cursor = Some(cursor.min(self.stack.len().saturating_sub(1)));
                    return;
                }
            }
        }

        self.stack.push(cwd);
        self.trim_to_max_entries();
        self.cursor = self.stack.len().checked_sub(1);
    }

    /// Move one entry back and return the target cwd.
    pub fn undo(&mut self) -> Option<PathBuf> {
        let cursor = self.cursor?;
        if cursor == 0 || cursor >= self.stack.len() {
            return None;
        }
        let next_cursor = cursor - 1;
        self.cursor = Some(next_cursor);
        self.stack.get(next_cursor).cloned()
    }

    /// Move one entry forward and return the target cwd.
    pub fn redo(&mut self) -> Option<PathBuf> {
        let cursor = self.cursor?;
        let next_cursor = cursor + 1;
        if next_cursor >= self.stack.len() {
            return None;
        }
        self.cursor = Some(next_cursor);
        self.stack.get(next_cursor).cloned()
    }

    pub fn list(&self) -> &[PathBuf] {
        &self.stack
    }

    pub fn current(&self) -> Option<&Path> {
        self.cursor
            .and_then(|idx| self.stack.get(idx))
            .map(PathBuf::as_path)
    }

    pub fn can_undo(&self) -> bool {
        matches!(self.cursor, Some(cursor) if cursor > 0 && cursor < self.stack.len())
    }

    pub fn can_redo(&self) -> bool {
        matches!(self.cursor, Some(cursor) if cursor + 1 < self.stack.len())
    }

    pub fn set_max_entries(&mut self, max_entries: usize) {
        self.max_entries = max_entries;
        if max_entries == 0 {
            self.stack.clear();
            self.cursor = None;
            return;
        }
        self.trim_to_max_entries();
        if self.stack.is_empty() {
            self.cursor = None;
        } else {
            self.cursor = Some(
                self.cursor
                    .unwrap_or(self.stack.len() - 1)
                    .min(self.stack.len() - 1),
            );
        }
    }

    /// Ask the sidecar to switch the active runtime cwd.
    ///
    /// This intentionally uses the generic raw command variant because the
    /// Rust bridge does not otherwise need a typed `pix:set_cwd` helper yet.
    pub async fn request_cwd_switch(client: &BridgeClient, path: &Path) -> Result<(), BridgeError> {
        let id = client.alloc_id().await;
        let command = json!({
            "id": id,
            "type": "pix:set_cwd",
            "cwd": path.display().to_string(),
        });
        client.request(Command::Other(command)).await.map(|_| ())
    }

    fn trim_to_max_entries(&mut self) {
        if self.max_entries == 0 {
            self.stack.clear();
            self.cursor = None;
            return;
        }
        let excess = self.stack.len().saturating_sub(self.max_entries);
        if excess == 0 {
            return;
        }
        self.stack.drain(0..excess);
        self.cursor = self
            .cursor
            .and_then(|cursor| cursor.checked_sub(excess))
            .or(Some(0))
            .map(|cursor| cursor.min(self.stack.len().saturating_sub(1)));
        if self.stack.is_empty() {
            self.cursor = None;
        }
    }
}

impl Default for WorkspaceHistory {
    fn default() -> Self {
        Self::new(16)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(name: &str) -> PathBuf {
        PathBuf::from(format!("/workspace/{name}"))
    }

    #[test]
    fn record_and_undo_returns_previous_cwd() {
        let mut history = WorkspaceHistory::new(16);
        history.record_cwd(p("one"));
        history.record_cwd(p("two"));

        assert_eq!(history.undo(), Some(p("one")));
        assert_eq!(history.current(), Some(p("one").as_path()));
    }

    #[test]
    fn max_entries_trims_oldest_entries() {
        let mut history = WorkspaceHistory::new(3);
        history.record_cwd(p("one"));
        history.record_cwd(p("two"));
        history.record_cwd(p("three"));
        history.record_cwd(p("four"));

        assert_eq!(history.list(), &[p("two"), p("three"), p("four")]);
        assert_eq!(history.cursor, Some(2));
        assert_eq!(history.undo(), Some(p("three")));
    }

    #[test]
    fn redo_after_undo_moves_forward() {
        let mut history = WorkspaceHistory::new(16);
        history.record_cwd(p("one"));
        history.record_cwd(p("two"));
        history.record_cwd(p("three"));

        assert_eq!(history.undo(), Some(p("two")));
        assert_eq!(history.redo(), Some(p("three")));
        assert_eq!(history.current(), Some(p("three").as_path()));
    }

    #[test]
    fn new_entry_after_undo_clears_redo_branch() {
        let mut history = WorkspaceHistory::new(16);
        history.record_cwd(p("one"));
        history.record_cwd(p("two"));
        history.record_cwd(p("three"));
        assert_eq!(history.undo(), Some(p("two")));

        history.record_cwd(p("four"));

        assert_eq!(history.list(), &[p("one"), p("two"), p("four")]);
        assert!(!history.can_redo());
        assert_eq!(history.redo(), None);
    }

    #[test]
    fn empty_history_has_no_undo_or_redo() {
        let mut history = WorkspaceHistory::new(16);

        assert_eq!(history.undo(), None);
        assert_eq!(history.redo(), None);
        assert_eq!(history.current(), None);
    }

    #[test]
    fn cursor_semantics_at_boundaries() {
        let mut history = WorkspaceHistory::new(16);
        history.record_cwd(p("one"));
        history.record_cwd(p("two"));

        assert_eq!(history.cursor, Some(1));
        assert!(history.can_undo());
        assert!(!history.can_redo());
        assert_eq!(history.undo(), Some(p("one")));
        assert_eq!(history.cursor, Some(0));
        assert!(!history.can_undo());
        assert!(history.can_redo());
        assert_eq!(history.undo(), None);
        assert_eq!(history.cursor, Some(0));
    }

    #[test]
    fn duplicate_current_record_does_not_add_entry() {
        let mut history = WorkspaceHistory::new(16);
        history.record_cwd(p("one"));
        history.record_cwd(p("one"));

        assert_eq!(history.list(), &[p("one")]);
        assert_eq!(history.cursor, Some(0));
    }

    #[test]
    fn zero_max_entries_disables_history() {
        let mut history = WorkspaceHistory::new(0);
        history.record_cwd(p("one"));

        assert!(history.list().is_empty());
        assert_eq!(history.cursor, None);
    }
}
