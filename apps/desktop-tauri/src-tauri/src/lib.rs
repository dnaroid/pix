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
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{Manager, State};
use tokio::sync::Mutex;

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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![rpc_call, rpc_subscribe, set_workspace])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
