//! Bounded reads for the interactive Preview, separate from config/file I/O limits.
use serde::Serialize;
use std::{fs, io::Read, path::Path};
use tauri::{AppHandle, Manager};

const MAX_BYTES: u64 = 256 * 1024;
const MAX_LINES: usize = 2_000;

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum PreviewRead {
    Text { file: super::ProjectFilePreview },
    External,
}

fn resolve_target(
    home: &Path,
    workspace: Option<&str>,
    path: &str,
) -> Result<(std::path::PathBuf, String), String> {
    if let Some(workspace) = workspace {
        let (root, target) =
            super::resolve_project_file_path(Path::new(workspace), Path::new(path))?;
        let display = target
            .strip_prefix(root)
            .unwrap_or(Path::new(path))
            .to_string_lossy()
            .replace('\\', "/");
        Ok((target, display))
    } else if path.starts_with("~/") {
        let (root, target) = super::resolve_home_file_path(home, Path::new(path))?;
        let display = format!(
            "~/{}",
            target
                .strip_prefix(root)
                .map_err(|error| error.to_string())?
                .to_string_lossy()
                .replace('\\', "/")
        );
        Ok((target, display))
    } else {
        let target = super::resolve_local_file_path(Path::new(path))?;
        let display = target.to_string_lossy().into_owned();
        Ok((target, display))
    }
}

fn read_bounded(target: &Path, display_path: String) -> Result<PreviewRead, String> {
    let file = fs::File::open(target)
        .map_err(|error| format!("failed to open {}: {error}", target.display()))?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err(format!("{display_path} is not a regular file"));
    }
    if metadata.len() > MAX_BYTES {
        return Ok(PreviewRead::External);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    // A concurrent append must not bypass the cap or create an unbounded read.
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read {display_path}: {error}"))?;
    classify_bytes(bytes, display_path)
}

fn classify_bytes(bytes: Vec<u8>, path: String) -> Result<PreviewRead, String> {
    if bytes.len() as u64 > MAX_BYTES
        || bytes.iter().filter(|&&byte| byte == b'\n').count() >= MAX_LINES
    {
        return Ok(PreviewRead::External);
    }
    let content =
        String::from_utf8(bytes).map_err(|_| format!("{path} is not a UTF-8 text file"))?;
    Ok(PreviewRead::Text {
        file: super::ProjectFilePreview { path, content },
    })
}

#[tauri::command]
pub(crate) async fn read_preview_file(
    app: AppHandle,
    workspace: Option<String>,
    path: String,
) -> Result<PreviewRead, String> {
    super::run_blocking(move || {
        let home = app.path().home_dir().map_err(|error| error.to_string())?;
        let (target, display) = resolve_target(&home, workspace.as_deref(), &path)?;
        read_bounded(&target, display)
    })
    .await
}

#[tauri::command]
pub(crate) async fn open_preview_file_in_editor(
    app: AppHandle,
    workspace: Option<String>,
    path: String,
    editor: String,
) -> Result<(), String> {
    super::run_blocking(move || {
        let home = app.path().home_dir().map_err(|error| error.to_string())?;
        // Revalidate confinement before launching; never trust a frontend-resolved path.
        let (target, _) = resolve_target(&home, workspace.as_deref(), &path)?;
        super::launch_external_editor(&editor, &target)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_byte_and_line_boundaries() {
        assert!(matches!(
            classify_bytes(vec![b'a'; MAX_BYTES as usize], "a".into()),
            Ok(PreviewRead::Text { .. })
        ));
        assert!(matches!(
            classify_bytes(vec![b'a'; MAX_BYTES as usize + 1], "a".into()),
            Ok(PreviewRead::External)
        ));
        assert!(matches!(
            classify_bytes(vec![b'\n'; MAX_LINES - 1], "a".into()),
            Ok(PreviewRead::Text { .. })
        ));
        assert!(matches!(
            classify_bytes(vec![b'\n'; MAX_LINES], "a".into()),
            Ok(PreviewRead::External)
        ));
        assert_eq!(
            serde_json::to_value(PreviewRead::External).unwrap(),
            serde_json::json!({ "kind": "external" })
        );
        assert!(classify_bytes(vec![0xff], "a".into()).is_err());
    }

    #[test]
    fn preview_read_is_bounded_and_preserves_small_content() {
        let root = std::env::temp_dir().join(format!(
            "pix-preview-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let target = root.join("inputs.json");
        fs::write(&target, "{\"small\":true}").unwrap();
        match read_bounded(&target, "inputs.json".into()).unwrap() {
            PreviewRead::Text { file } => {
                assert_eq!(file.path, "inputs.json");
                assert_eq!(file.content, "{\"small\":true}");
            }
            _ => panic!("small file must stay in Preview"),
        }
        fs::File::create(&target)
            .unwrap()
            .set_len(10 * 1024 * 1024)
            .unwrap();
        assert!(matches!(
            read_bounded(&target, "inputs.json".into()),
            Ok(PreviewRead::External)
        ));
        fs::write(&target, "x\n".repeat(MAX_LINES)).unwrap();
        assert!(matches!(
            read_bounded(&target, "inputs.json".into()),
            Ok(PreviewRead::External)
        ));
        assert!(resolve_target(&root, Some(root.to_str().unwrap()), "../outside").is_err());
        assert!(resolve_target(&root, None, "~/../outside").is_err());
        assert!(resolve_target(&root, None, "relative.json").is_err());
        for (workspace, path) in [
            (Some(root.to_str().unwrap()), "inputs.json".to_owned()),
            (None, "~/inputs.json".to_owned()),
            (None, target.to_string_lossy().into_owned()),
        ] {
            let (resolved, _) = resolve_target(&root, workspace, &path).unwrap();
            assert_eq!(resolved, fs::canonicalize(&target).unwrap());
        }
        #[cfg(unix)]
        {
            let workspace = root.join("workspace");
            fs::create_dir(&workspace).unwrap();
            let link = workspace.join("link.json");
            fs::write(&link, "{}").unwrap();
            assert!(
                resolve_target(&workspace, Some(workspace.to_str().unwrap()), "link.json").is_ok()
            );
            // A target that changes after classification must be confined again at launch.
            fs::remove_file(&link).unwrap();
            std::os::unix::fs::symlink(&target, &link).unwrap();
            assert!(
                resolve_target(&workspace, Some(workspace.to_str().unwrap()), "link.json").is_err()
            );
            assert!(resolve_target(&workspace, None, "~/link.json").is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }
}
