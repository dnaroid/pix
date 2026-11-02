//! Membership, workspace and logical normal-geometry persistence. The plugin
//! only owns maximization, keyed by the same stable labels.
use crate::window_geometry::{self, Geometry};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, io::Read, path::Path, sync::Mutex};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow};

const FILE_NAME: &str = "open-windows.json";
const QA_FILE_NAME: &str = "qa-open-windows.json";
const MAX_BYTES: u64 = 64 * 1024;
const MAX_WINDOWS: usize = 128;
const MAX_CLOSED_WINDOWS: usize = 32;

fn snapshot_file(ui_qa: bool, smoke: bool, qa_restore: bool) -> Option<&'static str> {
    if smoke {
        None
    } else if ui_qa {
        qa_restore.then_some(QA_FILE_NAME)
    } else {
        Some(FILE_NAME)
    }
}

fn persistence_file() -> Option<&'static str> {
    let enabled = |key| std::env::var(key).as_deref() == Ok("1");
    snapshot_file(
        enabled("PI_UI_QA"),
        enabled("PIX_RELEASE_SMOKE"),
        enabled("PI_UI_QA_WINDOW_RESTORE"),
    )
}

pub(crate) fn geometry_file() -> &'static str {
    if persistence_file() == Some(QA_FILE_NAME) {
        ".qa-restore-window-state.json"
    } else {
        ".window-state.json"
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub(crate) struct SavedWindow {
    label: String,
    workspace: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    geometry: Option<Geometry>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub(crate) struct Snapshot {
    version: u8,
    windows: Vec<SavedWindow>,
    #[serde(
        default,
        rename = "closedWindows",
        skip_serializing_if = "Vec::is_empty"
    )]
    closed_windows: Vec<SavedWindow>,
}

impl Snapshot {
    fn encode(mut self) -> Result<Vec<u8>, serde_json::Error> {
        let mut bytes = serde_json::to_vec(&self)?;
        // Closed history is optional: it must never crowd out live membership.
        while bytes.len() as u64 > MAX_BYTES && !self.closed_windows.is_empty() {
            self.closed_windows.remove(0);
            bytes = serde_json::to_vec(&self)?;
        }
        Ok(bytes)
    }
}

#[derive(Default)]
struct Registry {
    windows: BTreeMap<String, SavedWindow>,
    // Oldest first. Closed windows are not part of startup membership.
    closed_windows: Vec<SavedWindow>,
    // Reserve identities while the native builder runs without holding the lock.
    opening: BTreeMap<String, Option<SavedWindow>>,
    exiting: bool,
}

impl Registry {
    fn update(&mut self, label: &str, workspace: String) {
        if !self.exiting {
            self.closed_windows.retain(|window| window.label != label);
            self.windows
                .entry(label.into())
                .and_modify(|window| {
                    window.workspace = workspace.clone();
                })
                .or_insert(SavedWindow {
                    label: label.into(),
                    workspace,
                    geometry: None,
                });
        }
    }

    fn geometry(&mut self, label: &str, geometry: Geometry) {
        if !self.exiting {
            if let Some(window) = self.windows.get_mut(label) {
                window.geometry = Some(geometry);
            }
        }
    }

    fn destroyed(&mut self, label: &str, other_windows_remain: bool) {
        if !self.exiting && other_windows_remain {
            if let Some(window) = self.windows.remove(label) {
                self.remember_closed(window);
            }
        }
    }

    fn remember_closed(&mut self, window: SavedWindow) {
        self.closed_windows
            .retain(|saved| saved.label != window.label);
        self.closed_windows.push(window);
        if self.closed_windows.len() > MAX_CLOSED_WINDOWS {
            self.closed_windows.remove(0);
        }
    }

    fn begin_open(&mut self, label: String, workspace: String) -> Result<SavedWindow, String> {
        if self.exiting {
            return Err("application is exiting".into());
        }
        if self.windows.contains_key(&label)
            || self.opening.contains_key(&label)
            || self
                .closed_windows
                .iter()
                .any(|window| window.label == label)
        {
            return Err("window identity is already in use".into());
        }
        let previous = self
            .closed_windows
            .iter()
            .rposition(|window| {
                window.workspace == workspace
                    && !self.windows.contains_key(&window.label)
                    && !self.opening.contains_key(&window.label)
            })
            .map(|index| self.closed_windows.remove(index));
        let window = previous.clone().unwrap_or(SavedWindow {
            label,
            workspace,
            geometry: None,
        });
        self.opening.insert(window.label.clone(), previous);
        Ok(window)
    }

    fn finish_open(&mut self, window: SavedWindow, created: bool) -> bool {
        // Keep reservations intact after freeze: repeated exit snapshots must
        // still retain any closed identity whose creation raced Quit.
        if self.exiting {
            return false;
        }
        let Some(previous) = self.opening.remove(&window.label) else {
            return false;
        };
        if created {
            self.closed_windows
                .retain(|saved| saved.label != window.label);
            self.windows.entry(window.label.clone()).or_insert(window);
            true
        } else {
            if let Some(previous) = previous {
                // Early frontend registration/destruction may already have a
                // newer record, or retain this as the last window for relaunch.
                if !self.windows.contains_key(&previous.label)
                    && !self
                        .closed_windows
                        .iter()
                        .any(|saved| saved.label == previous.label)
                {
                    self.remember_closed(previous);
                }
            }
            false
        }
    }

    fn freeze(&mut self) -> Snapshot {
        self.exiting = true;
        let mut closed_windows = self.closed_windows.clone();
        closed_windows.extend(
            self.opening
                .values()
                .flatten()
                .filter(|window| {
                    !self.windows.contains_key(&window.label)
                        && !self
                            .closed_windows
                            .iter()
                            .any(|saved| saved.label == window.label)
                })
                .cloned(),
        );
        if closed_windows.len() > MAX_CLOSED_WINDOWS {
            closed_windows.drain(..closed_windows.len() - MAX_CLOSED_WINDOWS);
        }
        Snapshot {
            version: 1,
            windows: self.windows.values().cloned().collect(),
            closed_windows,
        }
    }
}

#[derive(Default)]
pub(crate) struct WindowRestoreState(Mutex<Registry>);

fn valid_label(label: &str) -> bool {
    label == "main"
        || (label.starts_with("project-")
            && label.len() <= 128
            && label
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-'))
}

fn valid_workspace(workspace: &str) -> bool {
    workspace.is_empty() || (Path::new(workspace).is_absolute() && !workspace.contains('\0'))
}

fn workspace_window_title(workspace: &str) -> String {
    if workspace.is_empty() {
        return "Pix".into();
    }
    let name = Path::new(workspace)
        .file_name()
        .map(|name| name.to_string_lossy());
    format!("Pix — {}", name.as_deref().unwrap_or(workspace))
}

fn parse(bytes: &[u8]) -> Result<Snapshot, String> {
    if bytes.len() as u64 > MAX_BYTES {
        return Err("window snapshot is too large".into());
    }
    let snapshot: Snapshot = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    if snapshot.version != 1
        || snapshot.windows.is_empty()
        || snapshot.windows.len() > MAX_WINDOWS
        || snapshot.closed_windows.len() > MAX_CLOSED_WINDOWS
    {
        return Err("invalid window snapshot".into());
    }
    let mut labels = std::collections::HashSet::new();
    for window in snapshot.windows.iter().chain(&snapshot.closed_windows) {
        if !valid_label(&window.label)
            || !valid_workspace(&window.workspace)
            || !labels.insert(window.label.clone())
        {
            return Err("invalid saved window".into());
        }
    }
    Ok(snapshot)
}

fn load(path: &Path) -> Option<Snapshot> {
    let result = (|| {
        let mut bytes = Vec::new();
        fs::File::open(path)?
            .take(MAX_BYTES + 1)
            .read_to_end(&mut bytes)?;
        parse(&bytes).map_err(std::io::Error::other)
    })();
    result.ok()
}

fn route(workspace: &str) -> WebviewUrl {
    let mut url = tauri::Url::parse("http://localhost/index.html").unwrap();
    url.query_pairs_mut()
        .append_pair("restoreWindow", "1")
        .append_pair("workspace", workspace);
    WebviewUrl::App(format!("index.html?{}", url.query().unwrap()).into())
}

pub(crate) fn setup(app: &mut tauri::App) -> Result<bool, Box<dyn std::error::Error>> {
    // This bounded startup read happens before creating any windows; no ongoing
    // window event callback performs disk IO. QA/smoke ignore the user's layout;
    // opt-in restore QA uses separate membership AND plugin geometry files.
    let saved = match persistence_file() {
        Some(filename) => load(&app.path().app_config_dir()?.join(filename)),
        None => None,
    };
    let restoring = saved.is_some();
    let fallback = SavedWindow {
        label: "main".into(),
        workspace: String::new(),
        geometry: None,
    };
    let windows = if let Some(saved) = saved {
        app.state::<WindowRestoreState>()
            .0
            .lock()
            .unwrap()
            .closed_windows = saved.closed_windows;
        saved.windows
    } else {
        vec![fallback]
    };
    let monitors: Vec<_> = app
        .available_monitors()?
        .iter()
        .map(window_geometry::logical_monitor)
        .collect();
    for window in &windows {
        let mut config = app.config().app.windows[0].clone();
        config.label = window.label.clone();
        config.title = workspace_window_title(&window.workspace);
        if restoring {
            config.url = route(&window.workspace);
        }
        window_geometry::apply(&mut config, window.geometry, &monitors);
        match crate::startup_theme::build(app, &config) {
            Ok(created) => {
                track(&created, window.workspace.clone(), window.geometry);
            }
            Err(error) => crate::logging::error(
                module_path!(),
                format!("could not restore window {}: {error}", window.label),
            ),
        }
    }
    if app.webview_windows().is_empty() {
        let mut config = app.config().app.windows[0].clone();
        config.title = workspace_window_title("");
        let created = crate::startup_theme::build(app, &config)?;
        track(&created, String::new(), None);
    }
    Ok(restoring)
}

fn record_geometry(window: &WebviewWindow) {
    if let Some(geometry) = window_geometry::capture(window) {
        window
            .state::<WindowRestoreState>()
            .0
            .lock()
            .unwrap()
            .geometry(window.label(), geometry);
    }
}

fn track(window: &WebviewWindow, workspace: String, saved: Option<Geometry>) {
    let geometry = window_geometry::capture(window).or(saved);
    {
        let state = window.state::<WindowRestoreState>();
        let mut registry = state.0.lock().unwrap();
        // Destruction can win after the builder completes but before tracking.
        if registry.exiting
            || window
                .app_handle()
                .get_webview_window(window.label())
                .is_none()
        {
            return;
        }
        // An early frontend workspace update is newer than the builder input.
        if !registry.windows.contains_key(window.label()) {
            registry.update(window.label(), workspace);
        }
        if let Some(geometry) = geometry {
            registry.geometry(window.label(), geometry);
        }
    }
    let tracked = window.clone();
    window.on_window_event(move |event| {
        if matches!(
            event,
            tauri::WindowEvent::Moved(_)
                | tauri::WindowEvent::Resized(_)
                | tauri::WindowEvent::CloseRequested { .. }
        ) {
            // Native getters only; disk persistence remains on the exit worker.
            record_geometry(&tracked);
        }
    });
}

#[tauri::command]
pub(crate) fn desktop_window_workspace(
    window: WebviewWindow,
    workspace: String,
) -> Result<(), String> {
    if !valid_workspace(&workspace) {
        return Err("invalid window workspace".into());
    }
    window
        .set_title(&workspace_window_title(&workspace))
        .map_err(|e| e.to_string())?;
    let state = window.state::<WindowRestoreState>();
    let mut registry = state.0.lock().map_err(|e| e.to_string())?;
    if valid_label(window.label())
        && window
            .app_handle()
            .get_webview_window(window.label())
            .is_some()
    {
        registry.update(window.label(), workspace);
    }
    drop(registry);
    crate::desktop_tray::refresh(window.app_handle());
    Ok(())
}

// Async: a sync command runs on the main thread, and building a webview
// window there blocks the event loop for the whole creation (and can
// deadlock on some platforms). Tauri dispatches the native work itself.
#[tauri::command]
pub(crate) async fn desktop_open_project_window(
    app: AppHandle,
    label: String,
    workspace: String,
) -> Result<(), String> {
    if !valid_label(&label)
        || label == "main"
        || workspace.is_empty()
        || !valid_workspace(&workspace)
    {
        return Err("invalid project window".into());
    }
    let monitors: Vec<_> = app
        .available_monitors()
        .map_err(|e| e.to_string())?
        .iter()
        .map(window_geometry::logical_monitor)
        .collect();
    let state = app.state::<WindowRestoreState>();
    let saved = state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .begin_open(label, workspace)?;
    let mut config = app.config().app.windows[0].clone();
    config.label = saved.label.clone();
    config.url = route(&saved.workspace);
    config.title = workspace_window_title(&saved.workspace);
    window_geometry::apply(&mut config, saved.geometry, &monitors);
    let built = crate::startup_theme::build(&app, &config);
    let accepted = {
        let mut registry = state.0.lock().map_err(|e| e.to_string())?;
        let created = built.is_ok() && app.get_webview_window(&saved.label).is_some();
        registry.finish_open(saved.clone(), created)
    };
    let window = built.map_err(|e| e.to_string())?;
    if !accepted {
        if app.get_webview_window(&saved.label).is_some() {
            if let Err(error) = window.close() {
                crate::logging::error(
                    module_path!(),
                    format!("could not close late project window: {error}"),
                );
            }
        }
        // Closing a newly created window (or quitting) is not an open failure.
        return Ok(());
    }
    track(&window, saved.workspace, saved.geometry);
    crate::desktop_tray::refresh(&app);
    Ok(())
}

pub(crate) fn destroyed(app: &AppHandle, label: &str) {
    let state = app.state::<WindowRestoreState>();
    let mut registry = state.0.lock().unwrap();
    // Closing the last window is also an application exit: keep it for relaunch.
    // Once explicit Quit has frozen the snapshot, teardown cannot erase it.
    registry.destroyed(
        label,
        app.webview_windows()
            .keys()
            .any(|label| !crate::image_viewer::is_viewer(label)),
    );
}

pub(crate) fn freeze(app: &AppHandle) -> Snapshot {
    for window in app.webview_windows().values() {
        record_geometry(window);
    }
    app.state::<WindowRestoreState>().0.lock().unwrap().freeze()
}

pub(crate) fn save(app: &AppHandle, snapshot: Snapshot) -> Result<(), Box<dyn std::error::Error>> {
    let Some(filename) = persistence_file() else {
        return Ok(());
    };
    if snapshot.windows.is_empty() {
        return Ok(());
    }
    let bytes = snapshot.encode()?;
    // Never replace a usable snapshot with one we cannot load next time.
    parse(&bytes).map_err(std::io::Error::other)?;
    let dir = app.path().app_config_dir()?;
    fs::create_dir_all(&dir)?;
    let temporary = dir.join(format!("{filename}.tmp"));
    fs::write(&temporary, bytes)?;
    fs::rename(temporary, dir.join(filename))?;
    Ok(())
}

#[cfg(test)]
#[path = "window_restore/tests.rs"]
mod tests;
