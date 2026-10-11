use crate::backend_runtime::BackendRuntime;
use serde_json::{json, Value};
use std::process::Stdio;
use tauri::{AppHandle, Manager};

#[tauri::command]
pub async fn desktop_bootstrap_inspect(app: AppHandle) -> Result<Value, String> {
    super::run_blocking(move || {
        let mut value = run_bootstrap_action(&app, "inspect")?;
        value["runtime"] = json!({
            "ready": true,
            "bundled": cfg!(feature = "bundled-runtime"),
            "pi": "bundled",
            "suite": "bundled"
        });
        // Older bundled bootstrap scripts may still report legacy tool metadata.
        // Do not expose it or resolve/install tools from the retired integration.
        if let Some(object) = value.as_object_mut() {
            object.remove("idx");
        }
        Ok(value)
    })
    .await
}

#[tauri::command]
pub async fn desktop_bootstrap_import_opencode(app: AppHandle) -> Result<Value, String> {
    super::run_blocking(move || run_bootstrap_action(&app, "import-opencode")).await
}

#[tauri::command]
pub async fn desktop_bootstrap_import_codex_api_key(app: AppHandle) -> Result<Value, String> {
    super::run_blocking(move || run_bootstrap_action(&app, "import-codex-api-key")).await
}

fn run_bootstrap_action(app: &AppHandle, action: &str) -> Result<Value, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("failed to resolve Pix resources: {error}"))?;
    let runtime = BackendRuntime::resolve(&resource_dir)?;
    let mut command = runtime.bootstrap_command(action)?;
    let output = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("failed to run Pix Desktop bootstrap: {error}"))?;
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(if error.is_empty() {
            format!("Pix Desktop bootstrap {action} failed")
        } else {
            error
        });
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Pix Desktop bootstrap returned invalid JSON: {error}"))
}
