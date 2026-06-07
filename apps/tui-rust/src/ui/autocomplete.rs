//! Input autocomplete for slash commands and workspace file references.

use std::cmp::Ordering;
use std::fs;
use std::path::Path;

use ratatui::style::Modifier;
use ratatui::text::{Line, Span};

use crate::ui::input_editor::InputEditor;
use crate::ui::slash;
use crate::ui::theme::{Theme, ThemeRole};

const MAX_FILE_SUGGESTIONS: usize = 20;
const MAX_FILE_SCAN_DEPTH: usize = 3;
const SKIP_NAMES: &[&str] = &[".git", "node_modules", "target", ".DS_Store"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TriggerKind {
    Slash,
    FilePath,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutocompleteTrigger {
    pub kind: TriggerKind,
    pub prefix: String,
    pub replace_start: usize,
    pub replace_end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutocompleteSuggestion {
    pub label: String,
    pub detail: Option<String>,
    pub replace_text: String,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct AutocompleteState {
    pub trigger: Option<AutocompleteTrigger>,
    pub suggestions: Vec<AutocompleteSuggestion>,
    pub selected: usize,
}

pub fn detect_trigger(input: &str, cursor: usize) -> Option<AutocompleteTrigger> {
    if cursor > input.len() || !input.is_char_boundary(cursor) {
        return None;
    }

    if input.starts_with('/') && cursor > 0 {
        let command_end = input.find(char::is_whitespace).unwrap_or(input.len());
        if cursor <= command_end {
            return Some(AutocompleteTrigger {
                kind: TriggerKind::Slash,
                prefix: input[..cursor].to_string(),
                replace_start: 0,
                replace_end: command_end,
            });
        }
    }

    let (word_start, word_end) = word_range_at_cursor(input, cursor)?;
    let word = &input[word_start..word_end];
    let cursor_in_word = cursor.saturating_sub(word_start);
    if cursor_in_word > word.len() || !word.is_char_boundary(cursor_in_word) {
        return None;
    }
    let before_cursor = &word[..cursor_in_word];
    let at_rel = before_cursor.rfind('@')?;
    if at_rel + '@'.len_utf8() == cursor_in_word {
        return None;
    }

    let replace_start = word_start + at_rel;
    Some(AutocompleteTrigger {
        kind: TriggerKind::FilePath,
        prefix: input[replace_start..cursor].to_string(),
        replace_start,
        replace_end: word_end,
    })
}

impl AutocompleteState {
    pub fn refresh(&mut self, input: &str, cursor: usize, workspace_root: Option<&Path>) {
        let Some(trigger) = detect_trigger(input, cursor) else {
            self.dismiss();
            return;
        };

        let suggestions = match trigger.kind {
            TriggerKind::Slash => slash_suggestions(&trigger),
            TriggerKind::FilePath => file_path_suggestions(&trigger, workspace_root),
        };

        self.trigger = Some(trigger);
        self.suggestions = suggestions;
        if self.suggestions.is_empty() {
            self.selected = 0;
        } else {
            self.selected = self.selected.min(self.suggestions.len() - 1);
        }
    }

    pub fn selected_suggestion(&self) -> Option<&AutocompleteSuggestion> {
        self.suggestions.get(self.selected)
    }

    pub fn next(&mut self) {
        if self.suggestions.is_empty() {
            self.selected = 0;
            return;
        }
        self.selected = (self.selected + 1) % self.suggestions.len();
    }

    pub fn prev(&mut self) {
        if self.suggestions.is_empty() {
            self.selected = 0;
            return;
        }
        self.selected = if self.selected == 0 {
            self.suggestions.len() - 1
        } else {
            self.selected - 1
        };
    }

    pub fn accept(&self, editor: &mut InputEditor) -> bool {
        let Some(trigger) = &self.trigger else {
            return false;
        };
        let Some(suggestion) = self.selected_suggestion() else {
            return false;
        };

        let text = editor.text();
        if trigger.replace_start > trigger.replace_end
            || trigger.replace_end > text.len()
            || !text.is_char_boundary(trigger.replace_start)
            || !text.is_char_boundary(trigger.replace_end)
        {
            return false;
        }

        let mut next_text = String::with_capacity(
            text.len() - (trigger.replace_end - trigger.replace_start)
                + suggestion.replace_text.len(),
        );
        next_text.push_str(&text[..trigger.replace_start]);
        next_text.push_str(&suggestion.replace_text);
        next_text.push_str(&text[trigger.replace_end..]);
        let next_cursor = trigger.replace_start + suggestion.replace_text.len();

        editor.set_text(next_text);
        editor.move_to_start();
        while editor.cursor() < next_cursor {
            let before = editor.cursor();
            editor.move_right();
            if editor.cursor() == before {
                break;
            }
        }
        true
    }

    pub fn dismiss(&mut self) {
        self.trigger = None;
        self.suggestions.clear();
        self.selected = 0;
    }

    pub fn is_active(&self) -> bool {
        self.trigger.is_some() && !self.suggestions.is_empty()
    }
}

pub fn render_suggestions(
    state: &AutocompleteState,
    max_rows: usize,
    theme: &Theme,
) -> Vec<Line<'static>> {
    if !state.is_active() || max_rows == 0 {
        return Vec::new();
    }

    let total = state.suggestions.len();
    let selected = state.selected.min(total.saturating_sub(1));
    let start = if selected >= max_rows {
        selected + 1 - max_rows
    } else {
        0
    };
    let end = (start + max_rows).min(total);

    let mut lines = Vec::with_capacity(max_rows.saturating_add(1));
    if start > 0 {
        lines.push(overflow_line(theme));
    }

    lines.extend(
        state.suggestions[start..end]
            .iter()
            .enumerate()
            .map(|(rel, suggestion)| suggestion_line(suggestion, start + rel == selected, theme)),
    );

    if start == 0 && end < total {
        lines.push(overflow_line(theme));
    }

    lines
}

fn slash_suggestions(trigger: &AutocompleteTrigger) -> Vec<AutocompleteSuggestion> {
    slash::filter_catalog(trigger.prefix.trim_start_matches('/'))
        .into_iter()
        .map(|info| AutocompleteSuggestion {
            label: format!("/{}", info.name),
            detail: Some(info.hint.to_string()),
            replace_text: format!("/{}", info.name),
        })
        .collect()
}

fn file_path_suggestions(
    trigger: &AutocompleteTrigger,
    workspace_root: Option<&Path>,
) -> Vec<AutocompleteSuggestion> {
    let Some(root) = workspace_root else {
        return Vec::new();
    };
    if !root.is_dir() {
        return Vec::new();
    }

    let prefix = trigger.prefix.trim_start_matches('@');
    if prefix.is_empty() {
        return Vec::new();
    }
    let needle = normalize_path(prefix);
    let mut candidates = Vec::new();
    scan_workspace(root, root, 0, &needle, &mut candidates);
    candidates.sort_by(compare_file_candidates);
    candidates.truncate(MAX_FILE_SUGGESTIONS);

    candidates
        .into_iter()
        .map(|candidate| AutocompleteSuggestion {
            label: format!("@{}", candidate.rel_path),
            detail: Some(if candidate.is_dir { "dir" } else { "file" }.to_string()),
            replace_text: format!("@{}", candidate.rel_path),
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileCandidate {
    rel_path: String,
    is_dir: bool,
    starts_with: bool,
}

fn scan_workspace(
    root: &Path,
    dir: &Path,
    depth: usize,
    needle: &str,
    out: &mut Vec<FileCandidate>,
) {
    if depth > MAX_FILE_SCAN_DEPTH {
        return;
    }

    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if should_skip_name(&name) {
            continue;
        }

        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let is_dir = file_type.is_dir();
        let Some(rel_path) = rel_path_string(root, &path, is_dir) else {
            continue;
        };
        let haystack = normalize_path(&rel_path);
        let starts_with = haystack.starts_with(needle);
        if starts_with || haystack.contains(needle) {
            out.push(FileCandidate {
                rel_path,
                is_dir,
                starts_with,
            });
        }

        if is_dir && depth < MAX_FILE_SCAN_DEPTH {
            scan_workspace(root, &path, depth + 1, needle, out);
        }
    }
}

fn compare_file_candidates(a: &FileCandidate, b: &FileCandidate) -> Ordering {
    b.starts_with
        .cmp(&a.starts_with)
        .then_with(|| a.rel_path.len().cmp(&b.rel_path.len()))
        .then_with(|| a.rel_path.cmp(&b.rel_path))
}

fn rel_path_string(root: &Path, path: &Path, is_dir: bool) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let mut out = path_to_forward_slashes(rel);
    if is_dir && !out.ends_with('/') {
        out.push('/');
    }
    (!out.is_empty()).then_some(out)
}

fn path_to_forward_slashes(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn normalize_path(path: &str) -> String {
    path.replace('\\', "/").to_ascii_lowercase()
}

fn should_skip_name(name: &str) -> bool {
    SKIP_NAMES.contains(&name)
}

fn word_range_at_cursor(input: &str, cursor: usize) -> Option<(usize, usize)> {
    if cursor > input.len() || !input.is_char_boundary(cursor) {
        return None;
    }

    let mut start = cursor;
    while start > 0 {
        let prev = prev_char_boundary(input, start);
        let ch = input[prev..start].chars().next()?;
        if !is_path_word_char(ch) {
            break;
        }
        start = prev;
    }

    let mut end = cursor;
    while end < input.len() {
        let ch = input[end..].chars().next()?;
        if !is_path_word_char(ch) {
            break;
        }
        end += ch.len_utf8();
    }

    (start < end).then_some((start, end))
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

fn suggestion_line(
    suggestion: &AutocompleteSuggestion,
    selected: bool,
    theme: &Theme,
) -> Line<'static> {
    let arrow = if selected { "› " } else { "  " };
    let base = theme.style_for(ThemeRole::AssistantText);
    let dim = theme.style_for(ThemeRole::StatusDim);
    let selected_style = base.add_modifier(Modifier::REVERSED);
    let selected_dim = dim.add_modifier(Modifier::REVERSED);
    let label_style = if selected { selected_style } else { base };
    let detail_style = if selected { selected_dim } else { dim };

    let mut spans = vec![
        Span::styled(arrow.to_string(), detail_style),
        Span::styled(suggestion.label.clone(), label_style),
    ];
    if let Some(detail) = &suggestion.detail {
        spans.push(Span::styled("  ".to_string(), detail_style));
        spans.push(Span::styled(detail.clone(), detail_style));
    }
    Line::from(spans)
}

fn overflow_line(theme: &Theme) -> Line<'static> {
    Line::from(Span::styled(
        "  ...".to_string(),
        theme.style_for(ThemeRole::StatusDim),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn line_text(lines: &[Line<'static>]) -> Vec<String> {
        lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect()
    }

    fn temp_workspace() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("pix-tui-ac-{unique}"));
        fs::create_dir_all(&root).expect("create temp workspace");
        root
    }

    fn slash_trigger(prefix: &str) -> AutocompleteTrigger {
        AutocompleteTrigger {
            kind: TriggerKind::Slash,
            prefix: prefix.to_string(),
            replace_start: 0,
            replace_end: prefix.len(),
        }
    }

    fn suggestion(label: &str) -> AutocompleteSuggestion {
        AutocompleteSuggestion {
            label: label.to_string(),
            detail: None,
            replace_text: label.to_string(),
        }
    }

    fn state_with(labels: &[&str], selected: usize) -> AutocompleteState {
        AutocompleteState {
            trigger: Some(slash_trigger("/")),
            suggestions: labels.iter().map(|label| suggestion(label)).collect(),
            selected,
        }
    }

    #[test]
    fn detect_trigger_none_in_middle_text() {
        assert_eq!(detect_trigger("hello /he", 9), None);
    }

    #[test]
    fn detect_trigger_slash_at_start() {
        assert_eq!(detect_trigger("/he", 3), Some(slash_trigger("/he")));
    }

    #[test]
    fn detect_trigger_file_path_after_at() {
        assert_eq!(
            detect_trigger("open @src/ma now", 12),
            Some(AutocompleteTrigger {
                kind: TriggerKind::FilePath,
                prefix: "@src/ma".to_string(),
                replace_start: 5,
                replace_end: 12,
            })
        );
    }

    #[test]
    fn detect_trigger_no_file_path_when_prefix_empty() {
        assert_eq!(detect_trigger("open @", 6), None);
    }

    #[test]
    fn refresh_slash_trigger_produces_catalog_suggestions() {
        let mut state = AutocompleteState::default();
        state.refresh("/he", 3, None);
        assert!(state.is_active());
        assert!(state.suggestions.iter().any(|s| s.label == "/help"));
    }

    #[test]
    fn refresh_file_path_with_nonexistent_workspace_returns_empty() {
        let mut state = AutocompleteState::default();
        state.refresh("see @src", 8, Some(Path::new("/definitely/not/pix-tui")));
        assert!(!state.is_active());
        assert!(state.suggestions.is_empty());
    }

    #[test]
    fn refresh_file_path_scans_workspace_files() {
        let root = temp_workspace();
        fs::create_dir_all(root.join("src/foo")).expect("create src");
        fs::write(root.join("src/foo/bar.rs"), "").expect("write file");
        fs::create_dir_all(root.join("node_modules/src_skip")).expect("create skipped");
        fs::write(root.join("node_modules/src_skip/file.rs"), "").expect("write skipped");

        let mut state = AutocompleteState::default();
        state.refresh("see @src/foo", 12, Some(&root));
        let labels: Vec<_> = state.suggestions.iter().map(|s| s.label.as_str()).collect();

        assert!(labels.contains(&"@src/foo/bar.rs"));
        assert!(!labels.iter().any(|label| label.contains("node_modules")));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn next_prev_wrap_selection() {
        let mut state = state_with(&["a", "b"], 0);
        state.prev();
        assert_eq!(state.selected, 1);
        state.next();
        assert_eq!(state.selected, 0);
    }

    #[test]
    fn accept_replaces_range_and_moves_cursor() {
        let mut editor = InputEditor::with_text("open @src/ma now");
        editor.move_to_start();
        for _ in 0..12 {
            editor.move_right();
        }
        let state = AutocompleteState {
            trigger: detect_trigger(editor.text(), editor.cursor()),
            suggestions: vec![suggestion("@src/main.rs")],
            selected: 0,
        };

        assert!(state.accept(&mut editor));
        assert_eq!(editor.text(), "open @src/main.rs now");
        assert_eq!(editor.cursor(), "open @src/main.rs".len());
    }

    #[test]
    fn dismiss_clears_state() {
        let mut state = AutocompleteState::default();
        state.refresh("/", 1, None);
        assert!(state.is_active());
        state.dismiss();
        assert_eq!(state, AutocompleteState::default());
    }

    #[test]
    fn render_suggestions_empty_state_returns_empty() {
        assert!(render_suggestions(&AutocompleteState::default(), 8, &Theme::default()).is_empty());
    }

    #[test]
    fn render_suggestions_populated_keeps_order_and_overflow() {
        let mut state = state_with(&["/a", "/b", "/c"], 1);
        state.suggestions[0].detail = Some("first".to_string());

        let text = line_text(&render_suggestions(&state, 2, &Theme::default()));
        assert_eq!(text, vec!["  /a  first", "› /b", "  ..."]);
    }

    #[test]
    fn refresh_after_dismiss_can_revive() {
        let mut state = AutocompleteState::default();
        state.refresh("/he", 3, None);
        state.dismiss();
        state.refresh("/he", 3, None);
        assert!(state.is_active());
    }
}
