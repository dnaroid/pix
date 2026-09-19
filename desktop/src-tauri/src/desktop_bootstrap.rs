use crate::backend_runtime::BackendRuntime;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Component, Path, PathBuf},
    process::Stdio,
};
use tauri::{AppHandle, Manager};

const IDX_PACKAGE: &str = "indexer-cli";

#[tauri::command]
pub async fn desktop_bootstrap_inspect(app: AppHandle) -> Result<Value, String> {
    super::run_blocking(move || {
        let mut value = run_bootstrap_action(&app, "inspect")?;
        let system_idx = super::resolve_named_executable("idx");
        value["runtime"] = json!({
            "ready": true,
            "bundled": cfg!(feature = "bundled-runtime"),
            "pi": "bundled",
            "suite": "bundled"
        });
        value["idx"]["systemExecutable"] = system_idx
            .as_ref()
            .map(|path| Value::String(path.to_string_lossy().into_owned()))
            .unwrap_or(Value::Null);
        value["idx"]["available"] = Value::Bool(
            system_idx.is_some()
                || value["idx"]["installed"].as_bool().unwrap_or(false),
        );
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

#[tauri::command]
pub async fn desktop_bootstrap_install_idx(app: AppHandle) -> Result<Value, String> {
    super::run_blocking(move || run_bootstrap_action(&app, "install-idx")).await
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

pub(crate) fn managed_tools_root(home: &Path) -> PathBuf {
    home.join(".pi").join("pix-desktop-tools")
}

pub(crate) fn managed_idx_entry(home: &Path) -> Result<Option<PathBuf>, String> {
    let package_root = managed_tools_root(home)
        .join("node_modules")
        .join(IDX_PACKAGE);
    let manifest_path = package_root.join("package.json");
    let content = match fs::read_to_string(&manifest_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "failed to read managed IDX package metadata {}: {error}",
                manifest_path.display()
            ))
        }
    };
    let manifest: Value = serde_json::from_str(&content)
        .map_err(|error| format!("managed IDX package metadata is invalid: {error}"))?;
    let bin = manifest
        .get("bin")
        .and_then(|value| {
            value
                .as_str()
                .or_else(|| value.as_object()?.get("idx")?.as_str())
        })
        .ok_or_else(|| "managed indexer-cli package does not expose an idx binary".to_owned())?;
    let relative = Path::new(bin);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
    {
        return Err("managed indexer-cli exposes an unsafe idx path".to_owned());
    }
    let entry = package_root.join(relative);
    if !entry.is_file() {
        return Ok(None);
    }
    Ok(Some(entry))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_home(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let home = std::env::temp_dir().join(format!(
            "pix-bootstrap-{name}-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(&home).expect("create temp home");
        home
    }

    #[test]
    fn resolves_managed_idx_entry_from_package_metadata() {
        let home = temp_home("idx");
        let package = managed_tools_root(&home)
            .join("node_modules")
            .join(IDX_PACKAGE);
        fs::create_dir_all(package.join("dist")).expect("create package");
        fs::write(
            package.join("package.json"),
            r#"{"name":"indexer-cli","version":"1.2.3","bin":{"idx":"dist/cli.js"}}"#,
        )
        .expect("write package");
        fs::write(package.join("dist/cli.js"), "console.log('idx')").expect("write entry");

        assert_eq!(
            managed_idx_entry(&home).expect("resolve managed idx"),
            Some(package.join("dist/cli.js"))
        );
        fs::remove_dir_all(home).expect("remove temp home");
    }

    #[test]
    fn rejects_managed_idx_path_traversal() {
        let home = temp_home("idx-traversal");
        let package = managed_tools_root(&home)
            .join("node_modules")
            .join(IDX_PACKAGE);
        fs::create_dir_all(&package).expect("create package");
        fs::write(
            package.join("package.json"),
            r#"{"name":"indexer-cli","bin":{"idx":"../outside.js"}}"#,
        )
        .expect("write package");

        assert!(managed_idx_entry(&home).is_err());
        fs::remove_dir_all(home).expect("remove temp home");
    }
}
