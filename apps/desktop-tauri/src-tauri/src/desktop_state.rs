use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;

const DESKTOP_STATE_FILE: &str = "pix-desktop-state.json";

#[derive(Default)]
pub struct DesktopStateCache {
    state: DesktopState,
    loaded: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    #[serde(default)]
    pub tabs_by_workspace: HashMap<String, PersistedTabs>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedTabs {
    #[serde(default)]
    pub open_tabs: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_tab_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub titles: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scroll: Option<HashMap<String, TabScrollState>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabScrollState {
    pub follow_output: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor_offset: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor_entry_offset: Option<u64>,
}

impl DesktopStateCache {
    pub fn workspace(&mut self) -> Result<Option<String>, String> {
        self.ensure_loaded()?;
        Ok(self.state.workspace.clone())
    }

    pub fn set_workspace(&mut self, workspace: Option<String>) -> Result<(), String> {
        self.ensure_loaded()?;
        self.state.workspace = workspace.filter(|value| !value.trim().is_empty());
        self.persist()
    }

    pub fn read_tabs(&mut self, workspace: String) -> Result<PersistedTabs, String> {
        self.ensure_loaded()?;
        Ok(self.state.tabs_by_workspace.get(&workspace).cloned().unwrap_or_default())
    }

    pub fn write_tabs(&mut self, workspace: String, tabs: PersistedTabs) -> Result<(), String> {
        self.ensure_loaded()?;
        if workspace.trim().is_empty() {
            return Ok(());
        }
        self.state.tabs_by_workspace.insert(workspace, normalize_tabs(tabs));
        self.persist()
    }

    pub fn open_tab(&mut self, workspace: String, path: String) -> Result<PersistedTabs, String> {
        self.ensure_loaded()?;
        let tabs = self.tabs_mut(&workspace);
        if !tabs.open_tabs.iter().any(|tab| tab == &path) {
            tabs.open_tabs.push(path.clone());
        }
        tabs.active_tab_id = Some(path);
        let normalized = normalize_tabs(tabs.clone());
        self.state.tabs_by_workspace.insert(workspace, normalized.clone());
        self.persist()?;
        Ok(normalized)
    }

    pub fn close_tab(&mut self, workspace: String, path: String) -> Result<PersistedTabs, String> {
        self.ensure_loaded()?;
        let tabs = self.tabs_mut(&workspace);
        tabs.open_tabs.retain(|tab| tab != &path);
        if let Some(titles) = tabs.titles.as_mut() {
            titles.remove(&path);
        }
        if let Some(scroll) = tabs.scroll.as_mut() {
            scroll.remove(&path);
        }
        if tabs.active_tab_id.as_deref() == Some(path.as_str()) {
            tabs.active_tab_id = tabs.open_tabs.last().cloned();
        }
        let normalized = normalize_tabs(tabs.clone());
        self.state.tabs_by_workspace.insert(workspace, normalized.clone());
        self.persist()?;
        Ok(normalized)
    }

    pub fn activate_tab(&mut self, workspace: String, path: String) -> Result<PersistedTabs, String> {
        self.ensure_loaded()?;
        let tabs = self.tabs_mut(&workspace);
        if !tabs.open_tabs.iter().any(|tab| tab == &path) {
            tabs.open_tabs.push(path.clone());
        }
        tabs.active_tab_id = Some(path);
        let normalized = normalize_tabs(tabs.clone());
        self.state.tabs_by_workspace.insert(workspace, normalized.clone());
        self.persist()?;
        Ok(normalized)
    }

    fn tabs_mut(&mut self, workspace: &str) -> &mut PersistedTabs {
        self.state.tabs_by_workspace.entry(workspace.to_string()).or_default()
    }

    fn ensure_loaded(&mut self) -> Result<(), String> {
        if self.loaded {
            return Ok(());
        }
        self.loaded = true;
        let path = desktop_state_path()?;
        let Ok(raw) = std::fs::read_to_string(path) else {
            self.state = DesktopState::default();
            return Ok(());
        };
        self.state = serde_json::from_str::<DesktopState>(&raw)
            .or_else(|_| serde_json::from_str::<Value>(&raw).map(desktop_state_from_legacy_value))
            .map_err(|e| format!("read desktop state failed: {e}"))?;
        Ok(())
    }

    fn persist(&self) -> Result<(), String> {
        let path = desktop_state_path()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create desktop state dir failed: {e}"))?;
        }
        let raw = serde_json::to_string_pretty(&self.state)
            .map_err(|e| format!("serialize desktop state failed: {e}"))?;
        std::fs::write(path, format!("{raw}\n"))
            .map_err(|e| format!("write desktop state failed: {e}"))
    }
}

fn normalize_tabs(tabs: PersistedTabs) -> PersistedTabs {
    let open_tabs = unique_non_empty(tabs.open_tabs);
    let active_tab_id = tabs
        .active_tab_id
        .filter(|active| open_tabs.iter().any(|tab| tab == active));
    let titles = normalize_string_map(tabs.titles, &open_tabs);
    let scroll = normalize_scroll_map(tabs.scroll, &open_tabs);
    PersistedTabs { open_tabs, active_tab_id, titles, scroll }
}

fn unique_non_empty(values: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for value in values {
        if value.is_empty() || out.iter().any(|existing| existing == &value) {
            continue;
        }
        out.push(value);
    }
    out
}

fn normalize_string_map(value: Option<HashMap<String, String>>, open_tabs: &[String]) -> Option<HashMap<String, String>> {
    let Some(value) = value else { return None };
    let mut out = HashMap::new();
    for (path, title) in value {
        if !open_tabs.iter().any(|tab| tab == &path) {
            continue;
        }
        let trimmed = title.trim();
        if !trimmed.is_empty() {
            out.insert(path, trimmed.to_string());
        }
    }
    if out.is_empty() { None } else { Some(out) }
}

fn normalize_scroll_map(value: Option<HashMap<String, TabScrollState>>, open_tabs: &[String]) -> Option<HashMap<String, TabScrollState>> {
    let Some(value) = value else { return None };
    let mut out = HashMap::new();
    for (path, state) in value {
        if !open_tabs.iter().any(|tab| tab == &path) {
            continue;
        }
        let anchor_id = state.anchor_id.filter(|id| !id.trim().is_empty());
        let anchor_offset = state.anchor_offset.filter(|value| value.is_finite()).map(|value| value.max(0.0));
        let anchor_entry_offset = state.anchor_entry_offset;
        if !state.follow_output && anchor_id.is_none() && anchor_entry_offset.is_none() {
            continue;
        }
        out.insert(path, TabScrollState {
            follow_output: state.follow_output,
            anchor_id,
            anchor_offset,
            anchor_entry_offset,
        });
    }
    if out.is_empty() { None } else { Some(out) }
}

fn desktop_state_from_legacy_value(value: Value) -> DesktopState {
    let Some(obj) = value.as_object() else { return DesktopState::default() };
    DesktopState {
        workspace: obj.get("workspace").and_then(Value::as_str).map(str::to_string),
        tabs_by_workspace: legacy_tabs_by_workspace(obj.get("tabsByWorkspace")),
    }
}

fn legacy_tabs_by_workspace(value: Option<&Value>) -> HashMap<String, PersistedTabs> {
    let mut out = HashMap::new();
    let Some(workspaces) = value.and_then(Value::as_object) else { return out };
    for (workspace, tabs) in workspaces {
        if let Some(parsed) = persisted_tabs_from_value(tabs) {
            out.insert(workspace.clone(), parsed);
        }
    }
    out
}

fn persisted_tabs_from_value(value: &Value) -> Option<PersistedTabs> {
    let obj = value.as_object()?;
    let open_tabs = obj
        .get("openTabs")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let active_tab_id = obj.get("activeTabId").and_then(Value::as_str).map(str::to_string);
    let titles = string_map_from_value(obj.get("titles"));
    let scroll = scroll_map_from_value(obj.get("scroll"));
    Some(normalize_tabs(PersistedTabs { open_tabs, active_tab_id, titles, scroll }))
}

fn string_map_from_value(value: Option<&Value>) -> Option<HashMap<String, String>> {
    let Some(obj) = value.and_then(Value::as_object) else { return None };
    let mut out = HashMap::new();
    for (key, value) in obj {
        if let Some(value) = value.as_str() {
            out.insert(key.clone(), value.to_string());
        }
    }
    if out.is_empty() { None } else { Some(out) }
}

fn scroll_map_from_value(value: Option<&Value>) -> Option<HashMap<String, TabScrollState>> {
    let Some(obj) = value.and_then(Value::as_object) else { return None };
    let mut out = HashMap::new();
    for (key, value) in obj {
        let Some(value_obj) = value.as_object() else { continue };
        let state = tab_scroll_from_object(value_obj);
        out.insert(key.clone(), state);
    }
    if out.is_empty() { None } else { Some(out) }
}

fn tab_scroll_from_object(obj: &Map<String, Value>) -> TabScrollState {
    let follow_output = obj.get("followOutput").and_then(Value::as_bool).unwrap_or(true);
    let anchor_id = obj.get("anchorId").and_then(Value::as_str).map(str::to_string);
    let anchor_offset = obj.get("anchorOffset").and_then(Value::as_f64);
    let anchor_entry_offset = obj.get("anchorEntryOffset").and_then(Value::as_u64);
    TabScrollState { follow_output, anchor_id, anchor_offset, anchor_entry_offset }
}

fn desktop_state_path() -> Result<PathBuf, String> {
    Ok(agent_dir()?.join(DESKTOP_STATE_FILE))
}

fn agent_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "home directory not available".to_string())?;
    Ok(home.join(".pi").join("agent"))
}
