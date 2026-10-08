//! On-demand offline review details, separate from sparse overview health polling.
use std::path::Path;
use tauri::AppHandle;

use crate::{
    canonical_workspace, idx_launcher, run_blocking, run_idx_command, IdxCommandResult,
    IdxLauncher, IDX_QUERY_TIMEOUT, MAX_IDX_OUTPUT_BYTES,
};

fn knowledge_status_from(
    workspace: &Path,
    launcher: &IdxLauncher,
) -> Result<IdxCommandResult, String> {
    let root = canonical_workspace(workspace)?;
    if !root.join(".indexer-cli").is_dir() {
        return Err("this project is not initialized yet; initialize IDX first".to_owned());
    }
    // Preserve exit-2 JSON error reports; the frontend presents partial rows and warnings.
    run_idx_command(
        launcher,
        &root,
        &["knowledge".into(), "status".into(), "--json".into()],
        IDX_QUERY_TIMEOUT,
        MAX_IDX_OUTPUT_BYTES,
    )
}

#[tauri::command]
pub(crate) async fn idx_knowledge_status(
    app: AppHandle,
    workspace: String,
) -> Result<IdxCommandResult, String> {
    run_blocking(move || knowledge_status_from(Path::new(&workspace), &idx_launcher(&app)?)).await
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt};

    #[test]
    fn idx_knowledge_status_is_explicit_read_only_and_preserves_error_reports() {
        let root = std::env::temp_dir().join(format!("pix-idx-knowledge-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(".indexer-cli")).unwrap();
        let executable = root.join("idx");
        fs::write(&executable, "#!/bin/sh\nprintf '%s\\n' \"$*\" > args\nprintf '{\"status\":\"error\",\"specs\":[],\"warnings\":[\"incomplete\"]}\\n'\nexit 2\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let result =
            knowledge_status_from(&root, &IdxLauncher::System(executable.clone())).unwrap();
        assert_eq!(result.exit_code, Some(2));
        assert!(result.stdout.contains("incomplete"));
        assert!(!result.truncated);
        assert_eq!(
            fs::read_to_string(root.join("args")).unwrap(),
            "knowledge status --json\n"
        );
        fs::remove_dir(root.join(".indexer-cli")).unwrap();
        assert!(knowledge_status_from(&root, &IdxLauncher::System(executable)).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
