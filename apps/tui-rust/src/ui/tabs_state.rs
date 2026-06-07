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
    let prefix = " tabs ";
    let hint = "Ctrl+T picker";
    let hint_width = UnicodeWidthStr::width(hint);
    let max_width = if width == 0 { usize::MAX } else { width };
    let mut used = UnicodeWidthStr::width(prefix);
    let mut spans = vec![Span::styled(
        prefix.to_string(),
        theme.style_for(ThemeRole::StatusDim),
    )];

    let current_resolved = current_path.map(|path| path.to_string());
    let mut labels: Vec<(String, bool)> = state
        .tabs
        .iter()
        .map(|tab| {
            let active = state.active_path.as_deref() == Some(tab.path.as_str())
                || current_resolved.as_deref() == Some(tab.path.as_str());
            (tab_label(tab, current_id, current_name), active)
        })
        .collect();

    if labels.is_empty() {
        labels.push((current_session_label(current_name, current_id), true));
    }

    let total_labels = labels.len();
    let mut shown = 0usize;
    for (idx, (label, active)) in labels.iter().enumerate() {
        let chip = format!("[{}]", compact_label(label, 18));
        let chip_width = UnicodeWidthStr::width(chip.as_str()) + 1;
        let overflow = total_labels.saturating_sub(idx + 1);
        let overflow_width = if overflow > 0 {
            UnicodeWidthStr::width(format!("+{overflow}").as_str()) + 1
        } else {
            0
        };
        let remaining = max_width.saturating_sub(used);
        let reserved_hint = if max_width == usize::MAX || remaining > hint_width {
            hint_width + 1
        } else {
            0
        };
        if max_width != usize::MAX && used + chip_width + overflow_width + reserved_hint > max_width
        {
            break;
        }

        spans.push(render_chip(theme, &chip, *active));
        spans.push(Span::raw(" "));
        used += chip_width;
        shown += 1;
    }

    let hidden = total_labels.saturating_sub(shown);
    if hidden > 0 {
        let overflow = format!("+{hidden}");
        spans.push(Span::styled(
            overflow,
            theme.style_for(ThemeRole::StatusDim),
        ));
        spans.push(Span::raw(" "));
        used += UnicodeWidthStr::width(format!("+{hidden} ").as_str());
    }

    if max_width == usize::MAX || used + hint_width <= max_width {
        spans.push(Span::styled(
            hint.to_string(),
            theme.style_for(ThemeRole::ModelAccent),
        ));
    }

    Line::from(spans)
}

fn render_chip(theme: &Theme, chip: &str, active: bool) -> Span<'static> {
    let style = if active {
        theme
            .style_for(ThemeRole::SessionAccent)
            .add_modifier(Modifier::BOLD)
    } else {
        theme.style_for(ThemeRole::AssistantText)
    };
    Span::styled(chip.to_string(), style)
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
        assert!(text.contains("tabs"));
        assert!(text.contains("Alpha"));
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
