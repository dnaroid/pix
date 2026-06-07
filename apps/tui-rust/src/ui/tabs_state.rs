//! Persisted open-tab state for the Rust TUI.
//!
//! This is intentionally smaller than the TS pix `AppTabsController`: the
//! Rust TUI still has a single live bridge/session runtime, but we persist the
//! set of open session tabs plus the active session path so startup restore and
//! the tab strip behave much closer to pix.

use std::fs;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ratatui::style::Modifier;
use ratatui::text::{Line, Span};
use serde::{Deserialize, Serialize};
use unicode_width::UnicodeWidthStr;

use crate::ui::input_editor::InputDraftState;
use crate::ui::session_list::SessionSummary;
use crate::ui::theme::{Theme, ThemeRole};

const TABS_STATE_VERSION: u8 = 2;
const MAX_TABS: usize = 8;
const TAB_SEPARATOR: &str = " │ ";
const EMPTY_NEW_TAB_PREFIX: &str = "│ ";
const CHECK_ICON: &str = "\u{f05e0}";
const CLOSE_ICON: &str = "\u{f0156}";
const PLUS_ICON: &str = "\u{f0415}";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TabTargetKind {
    Tab,
    Close,
    NewTab,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TabLineTarget {
    pub kind: TabTargetKind,
    pub path: Option<String>,
    pub active: bool,
    /// 1-based inclusive start column, matching the TypeScript tab layout contract.
    pub start_column: usize,
    /// 1-based exclusive end column, matching the TypeScript tab layout contract.
    pub end_column: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TabLineLayout {
    pub top: Line<'static>,
    pub bottom: Line<'static>,
    pub targets: Vec<TabLineTarget>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct OpenTab {
    pub path: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub draft: Option<InputDraftState>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct TabsState {
    #[serde(default = "default_version")]
    pub version: u8,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub tabs: Vec<OpenTab>,
    #[serde(rename = "activePath", default)]
    pub active_path: Option<String>,
}

fn default_version() -> u8 {
    TABS_STATE_VERSION
}

impl TabsState {
    pub fn load_for_workspace(workspace_root: &Path) -> std::io::Result<Self> {
        let file_path = file_path_for_workspace(workspace_root);
        let raw = fs::read_to_string(file_path)?;
        let mut parsed: Self = serde_json::from_str(&raw).unwrap_or_default();
        if parsed.version == 0 {
            parsed.version = TABS_STATE_VERSION;
        }
        Ok(parsed)
    }

    pub fn save_for_workspace(&self, workspace_root: &Path) -> std::io::Result<()> {
        let file_path = file_path_for_workspace(workspace_root);
        if self.tabs.is_empty() {
            let _ = fs::remove_file(&file_path);
            return Ok(());
        }
        if let Some(parent) = file_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let payload = serde_json::to_string_pretty(self)?;
        let tmp_path = file_path.with_extension(format!(
            "json.tmp.{}.{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        fs::write(&tmp_path, payload)?;
        fs::rename(tmp_path, file_path)?;
        Ok(())
    }

    pub fn startup_restore_path(&self) -> Option<String> {
        self.active_path.clone().filter(|p| !p.trim().is_empty())
    }

    pub fn sync_current_session(
        &mut self,
        workspace_root: &Path,
        session_path: Option<&str>,
        session_id: Option<&str>,
        session_name: Option<&str>,
    ) -> bool {
        let Some(session_path) = session_path.filter(|p| !p.trim().is_empty()) else {
            return false;
        };

        let resolved = resolve_like(workspace_root, session_path);
        let resolved_str = resolved.display().to_string();
        let mut changed = false;

        if let Some(tab) = self.tabs.iter_mut().find(|tab| tab.path == resolved_str) {
            let next_id = session_id.map(str::to_string);
            let next_name = session_name
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_string);
            if tab.session_id != next_id {
                tab.session_id = next_id;
                changed = true;
            }
            if tab.name != next_name {
                tab.name = next_name;
                changed = true;
            }
        } else {
            self.tabs.push(OpenTab {
                path: resolved_str.clone(),
                session_id: session_id.map(str::to_string),
                name: session_name
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .map(str::to_string),
                draft: None,
            });
            changed = true;
        }

        if self.tabs.len() > MAX_TABS {
            self.tabs.drain(0..self.tabs.len().saturating_sub(MAX_TABS));
            changed = true;
        }

        if self.active_path.as_deref() != Some(resolved_str.as_str()) {
            self.active_path = Some(resolved_str);
            changed = true;
        }
        if self.cwd != workspace_root.display().to_string() {
            self.cwd = workspace_root.display().to_string();
            changed = true;
        }
        changed
    }

    pub fn close_active(&mut self) -> bool {
        let Some(active_path) = self.active_path.clone() else {
            return false;
        };
        let len_before = self.tabs.len();
        self.tabs.retain(|tab| tab.path != active_path);
        if self.tabs.len() == len_before {
            return false;
        }
        self.active_path = self.tabs.last().map(|tab| tab.path.clone());
        true
    }

    pub fn next_path_after_closing_active(&self) -> Option<String> {
        let active_path = self.active_path.as_deref()?;
        let index = self.tabs.iter().position(|tab| tab.path == active_path)?;
        self.tabs
            .get(index + 1)
            .or_else(|| index.checked_sub(1).and_then(|prev| self.tabs.get(prev)))
            .map(|tab| tab.path.clone())
    }

    pub fn switch_relative(&mut self, delta: isize) -> Option<String> {
        if self.tabs.is_empty() {
            return None;
        }
        let current_idx = self
            .active_path
            .as_deref()
            .and_then(|path| self.tabs.iter().position(|tab| tab.path == path))
            .unwrap_or(0);
        let len = self.tabs.len() as isize;
        let next_idx = (current_idx as isize + delta).rem_euclid(len) as usize;
        let next = self.tabs.get(next_idx)?.path.clone();
        self.active_path = Some(next.clone());
        Some(next)
    }

    pub fn replace_from_session_list(&mut self, sessions: &[SessionSummary]) {
        for session in sessions {
            if self.tabs.iter().any(|tab| tab.path == session.path) {
                continue;
            }
            if self.tabs.len() >= MAX_TABS {
                break;
            }
            self.tabs.push(OpenTab {
                path: session.path.clone(),
                session_id: Some(session.id.clone()),
                name: session.name.clone(),
                draft: None,
            });
        }
    }

    pub fn active_draft(&self) -> Option<&InputDraftState> {
        let active_path = self.active_path.as_deref()?;
        self.tabs
            .iter()
            .find(|tab| tab.path == active_path)
            .and_then(|tab| tab.draft.as_ref())
    }

    pub fn save_active_draft(&mut self, draft: InputDraftState) -> bool {
        let active_path = match self.active_path.as_deref() {
            Some(path) => path,
            None => return false,
        };
        let Some(tab) = self.tabs.iter_mut().find(|tab| tab.path == active_path) else {
            return false;
        };
        let next_draft = (!draft.text.is_empty() || !draft.attachments.is_empty()).then_some(draft);
        if tab.draft == next_draft {
            return false;
        }
        tab.draft = next_draft;
        true
    }

    pub fn remove_path(&mut self, session_path: &str) -> bool {
        let len_before = self.tabs.len();
        self.tabs.retain(|tab| tab.path != session_path);
        if self.tabs.len() == len_before {
            return false;
        }
        if self.active_path.as_deref() == Some(session_path) {
            self.active_path = self.tabs.last().map(|tab| tab.path.clone());
        }
        true
    }
}

pub fn tabs_line(
    state: &TabsState,
    theme: &Theme,
    width: usize,
    current_path: Option<&str>,
    current_id: Option<&str>,
    current_name: Option<&str>,
) -> Line<'static> {
    tabs_layout(state, theme, width, current_path, current_id, current_name).top
}

pub fn tabs_layout(
    state: &TabsState,
    theme: &Theme,
    width: usize,
    current_path: Option<&str>,
    current_id: Option<&str>,
    current_name: Option<&str>,
) -> TabLineLayout {
    let max_width = if width == 0 { usize::MAX } else { width };
    let mut spans = Vec::new();
    let mut targets = Vec::new();
    let mut separator_columns = Vec::new();
    let separator_width = UnicodeWidthStr::width(TAB_SEPARATOR);

    let current_resolved = current_path.map(|path| path.to_string());
    let mut labels: Vec<(String, Option<String>, bool)> = state
        .tabs
        .iter()
        .map(|tab| {
            let active = state.active_path.as_deref() == Some(tab.path.as_str())
                || current_resolved.as_deref() == Some(tab.path.as_str());
            (
                tab_label(tab, current_id, current_name),
                Some(tab.path.clone()),
                active,
            )
        })
        .collect();

    if labels.is_empty() {
        labels.push((
            current_session_label(current_name, current_id),
            current_resolved,
            true,
        ));
    }

    let tabs_count = labels.len();
    let new_tab_prefix = if tabs_count > 0 {
        TAB_SEPARATOR
    } else {
        EMPTY_NEW_TAB_PREFIX
    };
    let new_tab_prefix_width = UnicodeWidthStr::width(new_tab_prefix);
    let new_tab_width = UnicodeWidthStr::width(PLUS_ICON);
    let separator_count = tabs_count.saturating_sub(1);
    let tabs_width = max_width.saturating_sub(new_tab_width + new_tab_prefix_width);
    let natural_buttons: Vec<String> = labels
        .iter()
        .map(|(label, _, _)| button_text(label, None))
        .collect();
    let natural_width = natural_buttons
        .iter()
        .map(|button| UnicodeWidthStr::width(button.as_str()))
        .sum::<usize>()
        + separator_count * separator_width;
    let button_max_width = if natural_width <= tabs_width || tabs_count == 0 {
        None
    } else {
        Some(std::cmp::max(
            7,
            tabs_width
                .saturating_sub(separator_count * separator_width)
                .max(1)
                / tabs_count,
        ))
    };

    let mut display_column = 1usize;
    for (idx, (label, path, active)) in labels.iter().enumerate() {
        if idx > 0 {
            separator_columns.push(display_column + 1);
            spans.push(Span::styled(
                TAB_SEPARATOR.to_string(),
                theme.style_for(ThemeRole::InputBorder),
            ));
            display_column += separator_width;
        }

        let button = button_text(label, button_max_width);
        let button_width = UnicodeWidthStr::width(button.as_str());
        let close_width = UnicodeWidthStr::width(CLOSE_ICON);
        let close_start = display_column + button_width.saturating_sub(close_width);
        targets.push(TabLineTarget {
            kind: TabTargetKind::Close,
            path: path.clone(),
            active: *active,
            start_column: close_start,
            end_column: close_start + close_width,
        });
        targets.push(TabLineTarget {
            kind: TabTargetKind::Tab,
            path: path.clone(),
            active: *active,
            start_column: display_column,
            end_column: display_column + button_width,
        });
        spans.extend(button_spans(theme, &button, *active));
        display_column += button_width;
    }

    if display_column > 1 || tabs_count > 0 {
        let divider_column = display_column + if tabs_count > 0 { 1 } else { 0 };
        if divider_column <= max_width {
            separator_columns.push(divider_column);
        }
        spans.push(Span::styled(
            new_tab_prefix.to_string(),
            theme.style_for(ThemeRole::InputBorder),
        ));
        display_column += new_tab_prefix_width;
    }
    targets.push(TabLineTarget {
        kind: TabTargetKind::NewTab,
        path: None,
        active: false,
        start_column: display_column,
        end_column: display_column + new_tab_width,
    });
    spans.push(Span::styled(
        PLUS_ICON.to_string(),
        theme
            .style_for(ThemeRole::ModelAccent)
            .add_modifier(Modifier::BOLD),
    ));

    let top = Line::from(spans);
    let bottom = Line::from(Span::styled(
        bottom_text(width, &targets, &separator_columns),
        theme.style_for(ThemeRole::InputBorder),
    ));

    TabLineLayout {
        top,
        bottom,
        targets: targets
            .into_iter()
            .filter(|target| target.start_column <= max_width)
            .collect(),
    }
}

fn button_spans(theme: &Theme, button: &str, active: bool) -> Vec<Span<'static>> {
    let title_style = if active {
        theme
            .style_for(ThemeRole::SessionAccent)
            .add_modifier(Modifier::BOLD)
    } else {
        theme.style_for(ThemeRole::AssistantText)
    };
    let mut chars = button.chars();
    let status = chars.next().unwrap_or(' ').to_string();
    let rest: String = chars.collect();
    let close_index = rest.rfind(CLOSE_ICON).unwrap_or(rest.len());
    let (title, close_and_after) = rest.split_at(close_index);
    vec![
        Span::styled(status, theme.style_for(ThemeRole::StatusDim)),
        Span::styled(title.to_string(), title_style),
        Span::styled(
            close_and_after.to_string(),
            theme.style_for(ThemeRole::StatusDim),
        ),
    ]
}

fn button_text(label: &str, max_width: Option<usize>) -> String {
    let prefix = format!("{CHECK_ICON} ");
    let suffix = format!(" {CLOSE_ICON}");
    let natural = format!("{prefix}{label}{suffix}");
    let Some(max_width) = max_width else {
        return natural;
    };
    if UnicodeWidthStr::width(natural.as_str()) <= max_width {
        return natural;
    }
    let title_width = max_width
        .saturating_sub(UnicodeWidthStr::width(prefix.as_str()))
        .saturating_sub(UnicodeWidthStr::width(suffix.as_str()));
    if title_width == 0 {
        return compact_label(&format!("{CHECK_ICON}{CLOSE_ICON}"), max_width);
    }
    format!("{prefix}{}{suffix}", ellipsize_display(label, title_width))
}

fn bottom_text(width: usize, targets: &[TabLineTarget], separator_columns: &[usize]) -> String {
    let mut chars = vec!["─"; width];
    if let Some(active) = targets
        .iter()
        .find(|target| target.kind == TabTargetKind::Tab && target.active)
    {
        let left_separator = separator_columns
            .iter()
            .copied()
            .filter(|column| *column < active.start_column)
            .max()
            .unwrap_or(0);
        let right_separator = separator_columns
            .iter()
            .copied()
            .filter(|column| *column >= active.end_column)
            .min()
            .unwrap_or(width + 1);
        let clear_start = (left_separator + 1).max(1);
        let clear_end = right_separator.saturating_sub(1).min(width);
        for column in clear_start..=clear_end {
            if let Some(ch) = chars.get_mut(column - 1) {
                *ch = " ";
            }
        }
    }
    for column in separator_columns {
        if *column < 1 || *column > width {
            continue;
        }
        let has_left = *column > 1 && chars.get(column - 2) == Some(&"─");
        let has_right = chars.get(*column) == Some(&"─");
        chars[*column - 1] = if has_left && has_right {
            "┴"
        } else if has_left {
            "┘"
        } else if has_right {
            "└"
        } else {
            "╵"
        };
    }
    chars.join("")
}

fn tab_label(tab: &OpenTab, current_id: Option<&str>, current_name: Option<&str>) -> String {
    if let Some(name) = tab.name.as_deref().filter(|name| !name.trim().is_empty()) {
        return name.trim().to_string();
    }
    if let Some(id) = tab.session_id.as_deref().filter(|id| !id.trim().is_empty()) {
        return short_id(id);
    }
    current_session_label(current_name, current_id)
}

fn current_session_label(current_name: Option<&str>, current_id: Option<&str>) -> String {
    if let Some(name) = current_name.filter(|name| !name.trim().is_empty()) {
        return name.trim().to_string();
    }
    if let Some(id) = current_id.filter(|id| !id.trim().is_empty()) {
        return short_id(id);
    }
    "No session".to_string()
}

fn short_id(id: &str) -> String {
    id.chars().take(8).collect()
}

fn compact_label(text: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }
    let mut chars = text.chars();
    let mut out: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() && max_chars > 0 {
        out.pop();
        out.push('…');
    }
    out
}

fn ellipsize_display(text: &str, max_width: usize) -> String {
    if UnicodeWidthStr::width(text) <= max_width {
        return text.to_string();
    }
    if max_width == 0 {
        return String::new();
    }
    let ellipsis_width = UnicodeWidthStr::width("…");
    let mut out = String::new();
    let mut used = 0usize;
    for ch in text.chars() {
        let w = UnicodeWidthStr::width(ch.to_string().as_str());
        if used + w + ellipsis_width > max_width {
            break;
        }
        out.push(ch);
        used += w;
    }
    out.push('…');
    out
}

fn resolve_like(workspace_root: &Path, session_path: &str) -> PathBuf {
    let path = PathBuf::from(session_path);
    if path.is_absolute() {
        path
    } else {
        workspace_root.join(path)
    }
}

fn file_path_for_workspace(workspace_root: &Path) -> PathBuf {
    let key = URL_SAFE_NO_PAD.encode(workspace_root.display().to_string());
    agent_dir()
        .join("pix")
        .join("tabs")
        .join(format!("{key}.json"))
}

fn agent_dir() -> PathBuf {
    if let Some(path) = std::env::var_os("PIX_SIDECAR_AGENT_DIR") {
        return PathBuf::from(path);
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".pi")
        .join("agent")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::theme::Theme;

    #[test]
    fn sync_current_session_upserts_and_sets_active() {
        let root = Path::new("/tmp/workspace");
        let mut state = TabsState::default();
        assert!(state.sync_current_session(
            root,
            Some("/tmp/a.jsonl"),
            Some("abcdef1234"),
            Some("Alpha")
        ));
        assert_eq!(state.tabs.len(), 1);
        assert_eq!(state.active_path.as_deref(), Some("/tmp/a.jsonl"));
        assert_eq!(state.tabs[0].name.as_deref(), Some("Alpha"));
    }

    #[test]
    fn switch_relative_cycles() {
        let mut state = TabsState {
            version: 1,
            cwd: "/tmp/ws".to_string(),
            tabs: vec![
                OpenTab {
                    path: "/tmp/a.jsonl".to_string(),
                    session_id: None,
                    name: Some("A".to_string()),
                    draft: None,
                },
                OpenTab {
                    path: "/tmp/b.jsonl".to_string(),
                    session_id: None,
                    name: Some("B".to_string()),
                    draft: None,
                },
            ],
            active_path: Some("/tmp/a.jsonl".to_string()),
        };
        assert_eq!(state.switch_relative(1).as_deref(), Some("/tmp/b.jsonl"));
        assert_eq!(state.switch_relative(1).as_deref(), Some("/tmp/a.jsonl"));
    }

    #[test]
    fn tabs_line_shows_tabs_prefix() {
        let theme = Theme::by_name("default");
        let state = TabsState {
            version: 2,
            cwd: "/tmp/ws".to_string(),
            tabs: vec![OpenTab {
                path: "/tmp/a.jsonl".to_string(),
                session_id: Some("abcdef12".to_string()),
                name: Some("Alpha".to_string()),
                draft: None,
            }],
            active_path: Some("/tmp/a.jsonl".to_string()),
        };
        let line = tabs_line(
            &state,
            &theme,
            80,
            Some("/tmp/a.jsonl"),
            Some("abcdef12"),
            Some("Alpha"),
        );
        let text: String = line
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect();
        assert!(text.contains(CHECK_ICON));
        assert!(text.contains("Alpha"));
        assert!(text.contains(CLOSE_ICON));
        assert!(text.contains(PLUS_ICON));
    }

    #[test]
    fn tabs_layout_exposes_click_targets_and_bottom_cutout() {
        let theme = Theme::by_name("default");
        let state = TabsState {
            version: 2,
            cwd: "/tmp/ws".to_string(),
            tabs: vec![
                OpenTab {
                    path: "/tmp/a.jsonl".to_string(),
                    session_id: Some("aaaaaaaa".to_string()),
                    name: Some("Alpha".to_string()),
                    draft: None,
                },
                OpenTab {
                    path: "/tmp/b.jsonl".to_string(),
                    session_id: Some("bbbbbbbb".to_string()),
                    name: Some("Beta".to_string()),
                    draft: None,
                },
            ],
            active_path: Some("/tmp/a.jsonl".to_string()),
        };

        let layout = tabs_layout(
            &state,
            &theme,
            80,
            Some("/tmp/a.jsonl"),
            Some("aaaaaaaa"),
            Some("Alpha"),
        );
        let top: String = layout
            .top
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect();
        let bottom: String = layout
            .bottom
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect();

        assert!(top.starts_with(&format!(
            "{CHECK_ICON} Alpha {CLOSE_ICON} │ {CHECK_ICON} Beta {CLOSE_ICON} │ {PLUS_ICON}"
        )));
        assert!(bottom.starts_with("          └"));
        assert!(layout.targets.iter().any(|target| {
            target.kind == TabTargetKind::Tab && target.path.as_deref() == Some("/tmp/a.jsonl")
        }));
        assert!(layout.targets.iter().any(|target| {
            target.kind == TabTargetKind::Close && target.path.as_deref() == Some("/tmp/a.jsonl")
        }));
        assert!(layout
            .targets
            .iter()
            .any(|target| target.kind == TabTargetKind::NewTab));
    }

    #[test]
    fn save_active_draft_round_trips() {
        let mut state = TabsState {
            version: 2,
            cwd: "/tmp/ws".to_string(),
            tabs: vec![OpenTab {
                path: "/tmp/a.jsonl".to_string(),
                session_id: Some("abcdef12".to_string()),
                name: Some("Alpha".to_string()),
                draft: None,
            }],
            active_path: Some("/tmp/a.jsonl".to_string()),
        };

        assert!(state.save_active_draft(InputDraftState {
            text: "draft".to_string(),
            cursor: 5,
            attachments: Vec::new(),
        }));
        assert_eq!(
            state.active_draft().map(|draft| draft.text.as_str()),
            Some("draft")
        );
        assert!(state.save_active_draft(InputDraftState::default()));
        assert!(state.active_draft().is_none());
    }
}
