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

#[derive(Deserialize, Serialize)]
struct Snapshot {
    version: u8,
    windows: Vec<SavedWindow>,
}

#[derive(Default)]
struct Registry {
    windows: BTreeMap<String, SavedWindow>,
    exiting: bool,
}

impl Registry {
    fn update(&mut self, label: &str, workspace: String) {
        if !self.exiting {
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
            self.windows.remove(label);
        }
    }

    fn freeze(&mut self) -> Vec<SavedWindow> {
        self.exiting = true;
        self.windows.values().cloned().collect()
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

fn parse(bytes: &[u8]) -> Result<Vec<SavedWindow>, String> {
    if bytes.len() as u64 > MAX_BYTES {
        return Err("window snapshot is too large".into());
    }
    let snapshot: Snapshot = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    if snapshot.version != 1 || snapshot.windows.is_empty() || snapshot.windows.len() > MAX_WINDOWS
    {
        return Err("invalid window snapshot".into());
    }
    let mut labels = std::collections::HashSet::new();
    for window in &snapshot.windows {
        if !valid_label(&window.label)
            || !valid_workspace(&window.workspace)
            || !labels.insert(window.label.clone())
        {
            return Err("invalid saved window".into());
        }
    }
    Ok(snapshot.windows)
}

fn load(path: &Path) -> Vec<SavedWindow> {
    let result = (|| {
        let mut bytes = Vec::new();
        fs::File::open(path)?
            .take(MAX_BYTES + 1)
            .read_to_end(&mut bytes)?;
        parse(&bytes).map_err(std::io::Error::other)
    })();
    result.unwrap_or_default()
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
        None => Vec::new(),
    };
    let restoring = !saved.is_empty();
    let fallback = SavedWindow {
        label: "main".into(),
        workspace: String::new(),
        geometry: None,
    };
    let windows = if restoring { saved } else { vec![fallback] };
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
            Err(error) => eprintln!("could not restore window {}: {error}", window.label),
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
        registry.update(window.label(), workspace);
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
    Ok(())
}

#[tauri::command]
pub(crate) fn desktop_open_project_window(
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
    let state = app.state::<WindowRestoreState>();
    if state.0.lock().map_err(|e| e.to_string())?.exiting {
        return Err("application is exiting".into());
    }
    let mut config = app.config().app.windows[0].clone();
    config.label = label.clone();
    config.url = route(&workspace);
    config.title = workspace_window_title(&workspace);
    let window = crate::startup_theme::build(&app, &config).map_err(|e| e.to_string())?;
    if app.get_webview_window(&label).is_some() {
        track(&window, workspace, None);
    }
    Ok(())
}

pub(crate) fn destroyed(app: &AppHandle, label: &str) {
    let state = app.state::<WindowRestoreState>();
    let mut registry = state.0.lock().unwrap();
    // Closing the last window is also an application exit: keep it for relaunch.
    // Once explicit Quit has frozen the snapshot, teardown cannot erase it.
    registry.destroyed(label, !app.webview_windows().is_empty());
}

pub(crate) fn freeze(app: &AppHandle) -> Vec<SavedWindow> {
    for window in app.webview_windows().values() {
        record_geometry(window);
    }
    app.state::<WindowRestoreState>().0.lock().unwrap().freeze()
}

pub(crate) fn save(
    app: &AppHandle,
    windows: Vec<SavedWindow>,
) -> Result<(), Box<dyn std::error::Error>> {
    let Some(filename) = persistence_file() else {
        return Ok(());
    };
    if windows.is_empty() {
        return Ok(());
    }
    let bytes = serde_json::to_vec(&Snapshot {
        version: 1,
        windows,
    })?;
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
mod tests {
    use super::*;

    #[test]
    fn native_window_title_identifies_the_current_project() {
        assert_eq!(workspace_window_title("/projects/pix"), "Pix — pix");
        assert_eq!(workspace_window_title("/projects/Мой проект/"), "Pix — Мой проект");
        assert_eq!(workspace_window_title("/"), "Pix — /");
        assert_eq!(workspace_window_title(""), "Pix");
    }

    #[test]
    fn qa_restore_opt_in_never_uses_user_membership_storage() {
        assert_eq!(snapshot_file(false, false, false), Some(FILE_NAME));
        assert_eq!(snapshot_file(false, false, true), Some(FILE_NAME));
        assert_eq!(snapshot_file(true, false, false), None);
        assert_eq!(snapshot_file(true, false, true), Some(QA_FILE_NAME));
        assert_eq!(snapshot_file(false, true, true), None);
        assert_eq!(snapshot_file(true, true, true), None);
    }

    #[test]
    fn closing_one_window_excludes_it_but_last_window_is_retained() {
        let mut registry = Registry::default();
        registry.update("main", "/a".into());
        registry.update("project-1", "/b".into());
        registry.destroyed("main", true);
        registry.destroyed("project-1", false);
        let snapshot = registry.freeze();
        assert_eq!(
            snapshot,
            vec![SavedWindow {
                label: "project-1".into(),
                workspace: "/b".into(),
                geometry: None,
            }]
        );
    }

    #[test]
    fn quit_freezes_membership_and_workspaces_before_async_teardown() {
        let mut registry = Registry::default();
        registry.update("main", "/a".into());
        registry.update("project-1", "/b".into());
        let geometry = Geometry {
            width: 1100.0,
            height: 750.0,
            x: 40.0,
            y: -900.0,
        };
        registry.geometry("project-1", geometry);
        let snapshot = registry.freeze();
        registry.destroyed("main", true);
        registry.update("project-1", "/stale".into());
        registry.update("project-late", "/late".into());
        registry.geometry(
            "project-1",
            Geometry {
                width: 430.0,
                ..geometry
            },
        );
        assert_eq!(registry.freeze(), snapshot);
        assert_eq!(snapshot.len(), 2);
        assert_eq!(snapshot[1].geometry, Some(geometry));
    }

    #[test]
    fn workspace_update_preserves_normal_geometry_and_last_close_keeps_it() {
        let mut registry = Registry::default();
        registry.update("main", "/a".into());
        let geometry = Geometry {
            width: 1100.0,
            height: 750.0,
            x: 40.0,
            y: -900.0,
        };
        registry.geometry("main", geometry);
        registry.update("main", "/b".into());
        registry.destroyed("main", false);
        let snapshot = registry.freeze();
        assert_eq!(snapshot[0].geometry, Some(geometry));
        assert_eq!(snapshot[0].workspace, "/b");
        let bytes = serde_json::to_vec(&Snapshot {
            version: 1,
            windows: snapshot.clone(),
        })
        .unwrap();
        assert_eq!(parse(&bytes).unwrap(), snapshot);
    }

    #[test]
    fn snapshot_keeps_stable_labels_and_repeated_projects() {
        let bytes = br#"{"version":1,"windows":[{"label":"main","workspace":"/a"},{"label":"project-123-abc","workspace":"/a"}]}"#;
        let windows = parse(bytes).unwrap();
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[1].label, "project-123-abc");
        assert_eq!(
            parse(
                &serde_json::to_vec(&Snapshot {
                    version: 1,
                    windows: windows.clone()
                })
                .unwrap()
            )
            .unwrap(),
            windows
        );
    }

    #[test]
    fn invalid_snapshots_fall_back_instead_of_creating_arbitrary_windows() {
        for bytes in [
            r#"{"version":2,"windows":[]}"#,
            r#"{"version":1,"windows":[{"label":"other","workspace":"/a"}]}"#,
            r#"{"version":1,"windows":[{"label":"main","workspace":"relative"}]}"#,
            r#"{"version":1,"windows":[{"label":"main","workspace":"/a"},{"label":"main","workspace":"/b"}]}"#,
            "not json",
        ] {
            assert!(parse(bytes.as_bytes()).is_err());
        }
        assert!(parse(&vec![b' '; MAX_BYTES as usize + 1]).is_err());
    }

    #[test]
    fn route_encodes_paths_without_turning_them_into_query_or_fragment() {
        let WebviewUrl::App(path) = route("/space & ?# проект") else {
            panic!()
        };
        let url = tauri::Url::parse(&format!("http://localhost/{}", path.display())).unwrap();
        assert_eq!(
            url.query_pairs().find(|(k, _)| k == "workspace").unwrap().1,
            "/space & ?# проект"
        );
        assert!(url.fragment().is_none());
    }
}
