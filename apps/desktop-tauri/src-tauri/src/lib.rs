//! Pix Desktop — Tauri host library.
//!
//! Phase 1 surface: typed desktop commands over the SDK sidecar.
//! - `rpc_subscribe(on_event)` registers a Tauri Channel that receives all
//!   streaming events (`message_update`, `tool_execution_*`, etc.).
//! - `set_workspace(path)` opens a project folder: validates it and forwards
//!   a `pix:set_cwd` command to the sidecar, which switches the active
//!   session to one scoped to that folder.
//!
//! See `sidecar.rs` for the protocol and framing details.

mod sidecar;
mod history;
mod desktop_state;
mod pty;

use crate::sidecar::SidecarHandle;
use crate::history::{list_sessions_for_workspace, read_chat_window, save_viewport, ChatHistoryWindow, HistoryCache, SessionList, ViewportCursor};
use crate::desktop_state::{DesktopStateCache, PersistedTabs};
use crate::pty::{PtyRegistry, PtyStartOptions, PtyStartResult};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{Manager, State};
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};

#[cfg(target_os = "macos")]
mod macos_titlebar {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSToolbar, NSWindow, NSWindowToolbarStyle};
    use std::ffi::c_void;

    pub fn configure_raw(raw_window: *mut c_void) {
        if raw_window.is_null() {
            return;
        }

        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };

        unsafe {
            let ns_window: &NSWindow = &*raw_window.cast();
            let toolbar = NSToolbar::new(mtm);
            #[allow(deprecated)]
            toolbar.setShowsBaselineSeparator(false);
            ns_window.setToolbar(Some(&toolbar));
            ns_window.setToolbarStyle(NSWindowToolbarStyle::UnifiedCompact);
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

async fn sidecar_call(
    sidecar: &State<'_, Arc<Mutex<SidecarHandle>>>,
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

#[tauri::command]
async fn list_workspace_sessions(cwd: String) -> Result<SessionList, String> {
    list_sessions_for_workspace(cwd)
}

#[tauri::command]
async fn read_session_messages_window(
    history_cache: State<'_, Arc<Mutex<HistoryCache>>>,
    session_path: String,
    offset: Option<usize>,
    limit: Option<usize>,
    from_end: Option<bool>,
    anchor_id: Option<String>,
    anchor_entry_offset: Option<u64>,
    before: Option<usize>,
    after: Option<usize>,
    before_offset: Option<bool>,
    restore_viewport: Option<bool>,
) -> Result<ChatHistoryWindow, String> {
    let mut cache = history_cache.lock().await;
    read_chat_window(
        &mut cache,
        session_path,
        offset,
        limit,
        from_end,
        anchor_id,
        anchor_entry_offset,
        before,
        after,
        before_offset,
        restore_viewport,
    )
}

#[tauri::command]
async fn save_session_viewport(
    history_cache: State<'_, Arc<Mutex<HistoryCache>>>,
    session_path: String,
    follow_output: bool,
    anchor_id: Option<String>,
    anchor_offset: Option<f64>,
    anchor_entry_offset: Option<u64>,
) -> Result<ViewportCursor, String> {
    let mut cache = history_cache.lock().await;
    save_viewport(&mut cache, session_path, follow_output, anchor_id, anchor_offset, anchor_entry_offset)
}

#[tauri::command]
async fn get_desktop_workspace(
    desktop_state: State<'_, Arc<Mutex<DesktopStateCache>>>,
) -> Result<Option<String>, String> {
    desktop_state.lock().await.workspace()
}

#[tauri::command]
async fn save_desktop_workspace(
    desktop_state: State<'_, Arc<Mutex<DesktopStateCache>>>,
    workspace: Option<String>,
) -> Result<(), String> {
    desktop_state.lock().await.set_workspace(workspace)
}

#[tauri::command]
async fn read_desktop_tabs(
    desktop_state: State<'_, Arc<Mutex<DesktopStateCache>>>,
    workspace: String,
) -> Result<PersistedTabs, String> {
    desktop_state.lock().await.read_tabs(workspace)
}

#[tauri::command]
async fn write_desktop_tabs(
    desktop_state: State<'_, Arc<Mutex<DesktopStateCache>>>,
    workspace: String,
    tabs: PersistedTabs,
) -> Result<(), String> {
    desktop_state.lock().await.write_tabs(workspace, tabs)
}

#[tauri::command]
async fn open_desktop_tab(
    desktop_state: State<'_, Arc<Mutex<DesktopStateCache>>>,
    workspace: String,
    path: String,
) -> Result<PersistedTabs, String> {
    desktop_state.lock().await.open_tab(workspace, path)
}

#[tauri::command]
async fn close_desktop_tab(
    desktop_state: State<'_, Arc<Mutex<DesktopStateCache>>>,
    workspace: String,
    path: String,
) -> Result<PersistedTabs, String> {
    desktop_state.lock().await.close_tab(workspace, path)
}

#[tauri::command]
async fn activate_desktop_tab(
    desktop_state: State<'_, Arc<Mutex<DesktopStateCache>>>,
    workspace: String,
    path: String,
) -> Result<PersistedTabs, String> {
    desktop_state.lock().await.activate_tab(workspace, path)
}

#[tauri::command]
async fn switch_desktop_session(
    sidecar: State<'_, Arc<Mutex<SidecarHandle>>>,
    desktop_state: State<'_, Arc<Mutex<DesktopStateCache>>>,
    workspace: String,
    session_path: String,
) -> Result<Value, String> {
    let resp = sidecar
        .lock()
        .await
        .call(json!({ "type": "switch_session", "sessionPath": session_path }))
        .await
        .map_err(|e| format!("sidecar switch_session failed: {e}"))?;
    if resp.get("success").and_then(Value::as_bool) == Some(false) {
        return Ok(resp);
    }
    let tabs = desktop_state
        .lock()
        .await
        .activate_tab(workspace, session_path)
        .map_err(|e| format!("persist active tab failed: {e}"))?;
    let mut resp = resp;
    if let Some(obj) = resp.as_object_mut() {
        obj.insert("tabs".to_string(), serde_json::to_value(tabs).unwrap_or(Value::Null));
    }
    Ok(resp)
}

#[tauri::command]
async fn desktop_switch_session(
    sidecar: State<'_, Arc<Mutex<SidecarHandle>>>,
    session_path: String,
) -> Result<Value, String> {
    sidecar_call(&sidecar, json!({ "type": "switch_session", "sessionPath": session_path })).await
}

#[tauri::command]
async fn desktop_get_state(sidecar: State<'_, Arc<Mutex<SidecarHandle>>>) -> Result<Value, String> {
    sidecar_call(&sidecar, json!({ "type": "get_state" })).await
}

#[tauri::command]
async fn desktop_get_commands(sidecar: State<'_, Arc<Mutex<SidecarHandle>>>) -> Result<Value, String> {
    sidecar_call(&sidecar, json!({ "type": "get_commands" })).await
}

#[tauri::command]
async fn desktop_get_models(sidecar: State<'_, Arc<Mutex<SidecarHandle>>>) -> Result<Value, String> {
    sidecar_call(&sidecar, json!({ "type": "get_models" })).await
}

#[tauri::command]
async fn desktop_set_model(
    sidecar: State<'_, Arc<Mutex<SidecarHandle>>>,
    model_ref: String,
) -> Result<Value, String> {
    sidecar_call(&sidecar, json!({ "type": "set_model", "ref": model_ref })).await
}

#[tauri::command]
async fn desktop_compact(
    sidecar: State<'_, Arc<Mutex<SidecarHandle>>>,
    instructions: Option<String>,
) -> Result<Value, String> {
    sidecar_call(&sidecar, json!({ "type": "compact", "instructions": instructions })).await
}

#[tauri::command]
async fn desktop_undo_last_turn(sidecar: State<'_, Arc<Mutex<SidecarHandle>>>) -> Result<Value, String> {
    sidecar_call(&sidecar, json!({ "type": "undo_last_turn" })).await
}

#[tauri::command]
async fn desktop_new_session(sidecar: State<'_, Arc<Mutex<SidecarHandle>>>) -> Result<Value, String> {
    sidecar_call(&sidecar, json!({ "type": "new_session" })).await
}

#[tauri::command]
async fn desktop_abort(sidecar: State<'_, Arc<Mutex<SidecarHandle>>>) -> Result<Value, String> {
    sidecar_call(&sidecar, json!({ "type": "abort" })).await
}

#[tauri::command]
async fn desktop_prompt(
    sidecar: State<'_, Arc<Mutex<SidecarHandle>>>,
    message: String,
    images: Option<Value>,
) -> Result<Value, String> {
    let mut cmd = json!({ "type": "prompt", "message": message });
    if let Some(images) = images {
        if !images.is_null() {
            if let Some(obj) = cmd.as_object_mut() {
                obj.insert("images".to_string(), images);
            }
        }
    }
    sidecar_call(&sidecar, cmd).await
}

#[tauri::command]
async fn desktop_get_command_completions(
    sidecar: State<'_, Arc<Mutex<SidecarHandle>>>,
    command: String,
    argument_prefix: String,
) -> Result<Value, String> {
    sidecar_call(&sidecar, json!({
        "type": "get_command_completions",
        "command": command,
        "argumentPrefix": argument_prefix,
    })).await
}

#[tauri::command]
async fn desktop_get_messages(
    sidecar: State<'_, Arc<Mutex<SidecarHandle>>>,
    cmd: Value,
) -> Result<Value, String> {
    let mut forwarded = cmd;
    if let Some(obj) = forwarded.as_object_mut() {
        obj.insert("type".to_string(), Value::String("get_messages".to_string()));
    } else {
        forwarded = json!({ "type": "get_messages" });
    }
    sidecar_call(&sidecar, forwarded).await
}

#[tauri::command]
async fn desktop_extension_ui_response(
    sidecar: State<'_, Arc<Mutex<SidecarHandle>>>,
    request_id: String,
    payload: Value,
) -> Result<Value, String> {
    let mut cmd = json!({ "type": "extension_ui_response", "id": request_id });
    if let (Some(dst), Some(src)) = (cmd.as_object_mut(), payload.as_object()) {
        for (key, value) in src {
            dst.insert(key.clone(), value.clone());
        }
    }
    sidecar_call(&sidecar, cmd).await
}

#[tauri::command]
async fn pty_start(
    pty_registry: State<'_, Arc<std::sync::Mutex<PtyRegistry>>>,
    opts: PtyStartOptions,
    on_event: Channel<Value>,
) -> Result<PtyStartResult, String> {
    pty::start(pty_registry.inner(), opts, on_event)
}

#[tauri::command]
async fn pty_write(
    pty_registry: State<'_, Arc<std::sync::Mutex<PtyRegistry>>>,
    id: String,
    data: String,
) -> Result<(), String> {
    pty::write(pty_registry.inner(), id, data)
}

#[tauri::command]
async fn pty_resize(
    pty_registry: State<'_, Arc<std::sync::Mutex<PtyRegistry>>>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    pty::resize(pty_registry.inner(), id, cols, rows)
}

#[tauri::command]
async fn pty_kill(
    pty_registry: State<'_, Arc<std::sync::Mutex<PtyRegistry>>>,
    id: String,
) -> Result<(), String> {
    pty::kill(pty_registry.inner(), id)
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
            app.manage(Arc::new(Mutex::new(HistoryCache::default())));
            app.manage(Arc::new(Mutex::new(DesktopStateCache::default())));
            app.manage(Arc::new(std::sync::Mutex::new(PtyRegistry::default())));

            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(raw_window) = window.ns_window() {
                    macos_titlebar::configure_raw(raw_window);
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            rpc_subscribe,
            set_workspace,
            run_shell,
            complete_path,
            list_workspace_sessions,
            read_session_messages_window,
            save_session_viewport,
            get_desktop_workspace,
            save_desktop_workspace,
            read_desktop_tabs,
            write_desktop_tabs,
            open_desktop_tab,
            close_desktop_tab,
            activate_desktop_tab,
            switch_desktop_session,
            desktop_switch_session,
            desktop_get_state,
            desktop_get_commands,
            desktop_get_models,
            desktop_set_model,
            desktop_compact,
            desktop_undo_last_turn,
            desktop_new_session,
            desktop_abort,
            desktop_prompt,
            desktop_get_command_completions,
            desktop_get_messages,
            desktop_extension_ui_response,
            pty_start,
            pty_write,
            pty_resize,
            pty_kill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
