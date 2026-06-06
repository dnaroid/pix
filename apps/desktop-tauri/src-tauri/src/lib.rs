//! Pix Desktop — Tauri host library.
//!
//! Phase 1 surface: generic RPC bridge to the SDK sidecar.
//! - `rpc_call(cmd)`  sends an RPC command and awaits its response.
//! - `rpc_subscribe(on_event)` registers a Tauri Channel that receives all
//!   streaming events (`message_update`, `tool_execution_*`, etc.).
//! - `set_workspace(path)` opens a project folder: validates it and forwards
//!   a `pix:set_cwd` command to the sidecar, which switches the active
//!   session to one scoped to that folder.
//!
//! See `sidecar.rs` for the protocol and framing details.

mod sidecar;

use crate::sidecar::SidecarHandle;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{Manager, State, Window, WindowEvent};
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};

#[cfg(target_os = "macos")]
mod macos_titlebar {
    use objc2_app_kit::{NSWindow, NSWindowButton};
    use std::ffi::c_void;
    use tauri::Window;

    const TRAFFIC_LIGHT_X: f64 = 14.0;
    const TRAFFIC_LIGHT_Y: f64 = 24.0;

    pub fn apply(window: &Window) {
        let Ok(raw_window) = window.ns_window() else {
            return;
        };

        apply_raw(raw_window);
    }

    pub fn apply_raw(raw_window: *mut c_void) {
        if raw_window.is_null() {
            return;
        }

        unsafe {
            let ns_window: &NSWindow = &*raw_window.cast();
            let Some(close_button) = ns_window.standardWindowButton(NSWindowButton::CloseButton) else {
                return;
            };
            let Some(minimize_button) = ns_window.standardWindowButton(NSWindowButton::MiniaturizeButton) else {
                return;
            };
            let Some(zoom_button) = ns_window.standardWindowButton(NSWindowButton::ZoomButton) else {
                return;
            };
            let Some(buttons_row) = close_button.superview() else {
                return;
            };
            let Some(titlebar_container) = buttons_row.superview() else {
                return;
            };

            let close_frame = close_button.frame();
            let button_height = close_frame.size.height;
            let titlebar_height = button_height + TRAFFIC_LIGHT_Y;

            let mut titlebar_frame = titlebar_container.frame();
            titlebar_frame.size.height = titlebar_height;
            titlebar_frame.origin.y = ns_window.frame().size.height - titlebar_height;
            titlebar_container.setFrame(titlebar_frame);

            let spacing = minimize_button.frame().origin.x - close_frame.origin.x;
            for (index, button) in [close_button, minimize_button, zoom_button].into_iter().enumerate() {
                let mut frame = button.frame();
                frame.origin.x = TRAFFIC_LIGHT_X + (index as f64 * spacing);
                button.setFrameOrigin(frame.origin);
            }
        }
    }
}

#[derive(Debug, Serialize)]
struct ShellRunResult {
    code: Option<i32>,
    signal: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

#[derive(Debug, Serialize)]
struct PathCompletionItem {
    label: String,
    value: String,
    description: Option<String>,
    is_dir: bool,
}

/// Tauri command: send an RPC command to the sidecar and await the response.
///
/// React invokes this as `invoke('rpc_call', { cmd: {...} })`. The command
/// forwards `cmd` (with auto-assigned `id` if missing) to the sidecar over
/// stdin and resolves with the matching response object.
#[tauri::command]
async fn rpc_call(
    sidecar: State<'_, Arc<Mutex<SidecarHandle>>>,
    cmd: Value,
) -> Result<Value, String> {
    sidecar.lock().await.call(cmd).await.map_err(|e| e.to_string())
}

/// Tauri command: subscribe to sidecar events.
///
/// React creates a `Channel` (`new Channel<unknown>()` from
/// `@tauri-apps/api/core`), passes it as `onEvent`, and listens via
/// `channel.onmessage = (event) => ...`. Events flow indefinitely until the
/// channel is dropped on the JS side.
#[tauri::command]
async fn rpc_subscribe(
    sidecar: State<'_, Arc<Mutex<SidecarHandle>>>,
    on_event: Channel<Value>,
) -> Result<(), String> {
    sidecar.lock().await.subscribe(on_event).await;
    Ok(())
}

/// Tauri command: set the active workspace folder.
///
/// Called from React after the native folder picker returns a path. The
/// path is validated (must exist and be a directory), then forwarded to the
/// sidecar as `pix:set_cwd {cwd}`. The sidecar switches the active session
/// to one scoped to that folder (creating a fresh session if needed).
#[tauri::command]
async fn set_workspace(
    sidecar: State<'_, Arc<Mutex<SidecarHandle>>>,
    path: String,
) -> Result<Value, String> {
    let candidate = PathBuf::from(&path);
    let canonical = std::fs::canonicalize(&candidate)
        .map_err(|e| format!("workspace path not accessible: {e}"))?;
    if !canonical.is_dir() {
        return Err(format!("not a directory: {}", canonical.display()));
    }

    let cmd = json!({
        "type": "pix:set_cwd",
        "cwd": canonical.to_string_lossy(),
    });
    sidecar
        .lock()
        .await
        .call(cmd)
        .await
        .map_err(|e| format!("sidecar pix:set_cwd failed: {e}"))
}

/// Tauri command: run a short, non-interactive shell command in the selected
/// workspace and return captured stdout/stderr. This powers the desktop `!cmd`
/// flow; raw TTY shells are intentionally not handled here.
#[tauri::command]
async fn run_shell(cwd: String, command: String) -> Result<ShellRunResult, String> {
    let canonical = std::fs::canonicalize(PathBuf::from(&cwd))
        .map_err(|e| format!("shell cwd not accessible: {e}"))?;
    if !canonical.is_dir() {
        return Err(format!("shell cwd is not a directory: {}", canonical.display()));
    }

    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("shell command is empty".to_string());
    }

    #[cfg(windows)]
    let child = tokio::process::Command::new("cmd")
        .arg("/C")
        .arg(trimmed)
        .current_dir(canonical)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("spawn shell failed: {e}"))?;

    #[cfg(not(windows))]
    let child = tokio::process::Command::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string()))
        .arg("-lc")
        .arg(trimmed)
        .current_dir(canonical)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("spawn shell failed: {e}"))?;

    let output = match timeout(Duration::from_secs(60), child.wait_with_output()).await {
        Ok(result) => result.map_err(|e| format!("wait shell failed: {e}"))?,
        Err(_) => {
            return Ok(ShellRunResult {
                code: None,
                signal: None,
                stdout: String::new(),
                stderr: "Command timed out after 60s".to_string(),
                timed_out: true,
            });
        }
    };

    #[cfg(unix)]
    let signal = std::os::unix::process::ExitStatusExt::signal(&output.status);
    #[cfg(not(unix))]
    let signal = None;

    Ok(ShellRunResult {
        code: output.status.code(),
        signal,
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        timed_out: false,
    })
}

/// Tauri command: return lightweight filesystem path completions scoped to the
/// selected workspace. The frontend uses this for composer autocomplete in
/// shell commands, slash arguments, and @path mentions.
#[tauri::command]
async fn complete_path(cwd: String, prefix: String) -> Result<Vec<PathCompletionItem>, String> {
    let canonical_cwd = std::fs::canonicalize(PathBuf::from(&cwd))
        .map_err(|e| format!("completion cwd not accessible: {e}"))?;
    if !canonical_cwd.is_dir() {
        return Err(format!("completion cwd is not a directory: {}", canonical_cwd.display()));
    }

    let trimmed = prefix.trim_start_matches("./");
    let prefix_path = PathBuf::from(trimmed);
    if prefix_path.is_absolute() || trimmed.split(['/', '\\']).any(|part| part == "..") {
        return Ok(Vec::new());
    }

    let (base_rel, file_prefix) = match trimmed.rsplit_once(['/', '\\']) {
        Some((base, file)) => (base, file),
        None => ("", trimmed),
    };
    let base = if base_rel.is_empty() {
        canonical_cwd.clone()
    } else {
        canonical_cwd.join(base_rel)
    };
    let base = match std::fs::canonicalize(&base) {
        Ok(path) => path,
        Err(_) => return Ok(Vec::new()),
    };
    if !base.starts_with(&canonical_cwd) || !base.is_dir() {
        return Ok(Vec::new());
    }

    let mut items = Vec::new();
    let entries = std::fs::read_dir(&base).map_err(|e| format!("read completion dir failed: {e}"))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') && !file_prefix.starts_with('.') {
            continue;
        }
        if !name.to_lowercase().starts_with(&file_prefix.to_lowercase()) {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        let is_dir = metadata.is_dir();
        let rel = if base_rel.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", base_rel.replace('\\', "/"), name)
        };
        let value = if is_dir { format!("{rel}/") } else { rel.clone() };
        items.push(PathCompletionItem {
            label: if is_dir { format!("{name}/") } else { name },
            value,
            description: Some(if is_dir { "directory".to_string() } else { "file".to_string() }),
            is_dir,
        });
        if items.len() >= 50 {
            break;
        }
    }

    items.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.label.to_lowercase().cmp(&b.label.to_lowercase())));
    items.truncate(20);
    Ok(items)
}

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,pix_desktop_lib=debug")),
        )
        .with_writer(std::io::stderr)
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Tauri provides its own tokio runtime; block on sidecar spawn so the
            // handle is available before any invoke() lands.
            let handle = tauri::async_runtime::block_on(sidecar::spawn_default())
                .map_err(|e| format!("failed to start sidecar: {e}"))?;
            app.manage(Arc::new(Mutex::new(handle)));

            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(raw_window) = window.ns_window() {
                    macos_titlebar::apply_raw(raw_window);
                }
            }

            Ok(())
        })
        .on_window_event(|window: &Window, event: &WindowEvent| {
            #[cfg(target_os = "macos")]
            if window.label() == "main" {
                match event {
                    WindowEvent::Resized(_) | WindowEvent::ThemeChanged(_) => macos_titlebar::apply(window),
                    _ => {}
                }
            }
        })
        .invoke_handler(tauri::generate_handler![rpc_call, rpc_subscribe, set_workspace, run_shell, complete_path])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
