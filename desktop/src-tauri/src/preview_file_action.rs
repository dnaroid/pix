//! Native actions for a file currently shown in Preview.
#[cfg(any(target_os = "macos", test))]
use std::path::Path;
#[cfg(target_os = "macos")]
use std::{process::Command, sync::mpsc};
use tauri::AppHandle;
#[cfg(target_os = "macos")]
use tauri_plugin_opener::OpenerExt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FileAction {
    Copy,
    Open,
    Reveal,
}

impl TryFrom<&str> for FileAction {
    type Error = String;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "copy" => Ok(Self::Copy),
            "open" => Ok(Self::Open),
            "reveal" => Ok(Self::Reveal),
            _ => Err(format!("unsupported preview file action: {value}")),
        }
    }
}

#[tauri::command]
pub(crate) async fn preview_file_action(
    app: AppHandle,
    path: String,
    action: String,
) -> Result<(), String> {
    let action = FileAction::try_from(action.as_str())?;
    #[cfg(target_os = "macos")]
    {
        return super::run_blocking(move || {
            let path = super::resolve_local_file_path(Path::new(&path))?;
            perform_macos_action(app, path, action)
        })
        .await;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, path, action);
        Err("preview file actions are supported only on macOS".to_owned())
    }
}

#[cfg(target_os = "macos")]
fn perform_macos_action(
    app: AppHandle,
    path: std::path::PathBuf,
    action: FileAction,
) -> Result<(), String> {
    match action {
        FileAction::Copy => copy_file_url_to_pasteboard(app, path),
        FileAction::Open => app
            .opener()
            .open_path(path.to_string_lossy(), None::<&str>)
            .map_err(|error| format!("failed to open preview file: {error}")),
        FileAction::Reveal => {
            let status = Command::new("/usr/bin/open")
                .arg("-R")
                .arg(&path)
                .status()
                .map_err(|error| format!("failed to reveal preview file in Finder: {error}"))?;
            if status.success() {
                Ok(())
            } else {
                Err(format!(
                    "Finder could not reveal preview file (exit status {status})"
                ))
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn copy_file_url_to_pasteboard(app: AppHandle, path: std::path::PathBuf) -> Result<(), String> {
    let (sender, receiver) = mpsc::channel();
    app.run_on_main_thread(move || {
        let result = write_file_url_to_pasteboard(&path);
        let _ = sender.send(result);
    })
    .map_err(|error| format!("failed to schedule native clipboard update: {error}"))?;
    receiver
        .recv()
        .map_err(|error| format!("native clipboard update failed: {error}"))?
}

#[cfg(target_os = "macos")]
fn write_file_url_to_pasteboard(path: &Path) -> Result<(), String> {
    use objc2::{rc::Retained, runtime::ProtocolObject};
    use objc2_app_kit::{NSPasteboard, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSString, NSURL};

    let path_string = path
        .to_str()
        .ok_or_else(|| "preview file path is not valid UTF-8".to_owned())?;
    let native_path = NSString::from_str(path_string);
    let file_url = NSURL::fileURLWithPath(&native_path);
    let object: Retained<ProtocolObject<dyn NSPasteboardWriting>> =
        ProtocolObject::from_retained(file_url);
    let objects = NSArray::from_retained_slice(&[object]);
    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    if pasteboard.writeObjects(&objects) {
        Ok(())
    } else {
        Err("could not place preview file URL on the clipboard".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_the_public_action_names() {
        assert_eq!(FileAction::try_from("copy"), Ok(FileAction::Copy));
        assert_eq!(FileAction::try_from("open"), Ok(FileAction::Open));
        assert_eq!(FileAction::try_from("reveal"), Ok(FileAction::Reveal));
        assert!(FileAction::try_from("copy;open").is_err());
        assert!(FileAction::try_from("COPY").is_err());
    }

    #[test]
    fn file_resolution_requires_an_existing_absolute_file() {
        let root = std::env::temp_dir().join(format!(
            "pix-preview-action-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("media [1].png");
        std::fs::write(&file, b"test").unwrap();
        assert_eq!(
            super::super::resolve_local_file_path(&file).unwrap(),
            std::fs::canonicalize(&file).unwrap()
        );
        assert!(super::super::resolve_local_file_path(Path::new("relative.png")).is_err());
        assert!(super::super::resolve_local_file_path(&root.join("missing.png")).is_err());
        assert!(super::super::resolve_local_file_path(&root).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
