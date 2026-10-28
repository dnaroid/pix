//! Standard AppKit file drags. Never use or replace the general clipboard.
#[cfg(target_os = "macos")]
use tauri::Manager;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct Origin {
    pub workspace: String,
    pub paths: Vec<String>,
}
#[derive(serde::Serialize)]
pub(crate) struct DropReference {
    reference: String,
    source: Option<Origin>,
}
#[derive(serde::Serialize, serde::Deserialize)]
pub(crate) struct NativeSnapshot {
    pub id: u64,
    pub urls: Vec<String>,
    pub source: Option<Origin>,
}

// Capture synchronously by label: with_webview dispatches to the event loop and
// cannot be waited on here. Async validation receives only this immutable value.
#[tauri::command]
pub(crate) fn capture_project_entry_drag(
    webview: tauri::Webview,
) -> Result<NativeSnapshot, String> {
    #[cfg(target_os = "macos")]
    {
        if objc2::MainThreadMarker::new().is_none() {
            return Err("Native file drop capture must run on the main thread.".into());
        }
        crate::project_entry_drag_destination::take(webview.label())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = webview;
        Err("Native file drag is supported only on macOS.".into())
    }
}

#[tauri::command]
pub(crate) async fn read_project_entry_drag(
    snapshot: NativeSnapshot,
) -> Result<DropReference, String> {
    #[cfg(target_os = "macos")]
    {
        crate::run_blocking(move || {
            if snapshot.urls.is_empty()
                || snapshot.urls.len() > 1000
                || snapshot.urls.iter().map(String::len).sum::<usize>() > 131_072
            {
                return Err("The native file drag is empty or too large.".into());
            }
            if let Some(origin) = &snapshot.source {
                if origin.paths.len() > 1000
                    || origin.workspace.len() + origin.paths.iter().map(String::len).sum::<usize>()
                        > 131_072
                {
                    return Err("The native file drag origin is too large.".into());
                }
            }
            let paths = resolve_urls(snapshot.urls)?;
            Ok(DropReference {
                reference: crate::project_entry_clipboard::encode_file_paths(&paths)?,
                source: snapshot.source,
            })
        })
        .await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = snapshot;
        Err("Native file drag is supported only on macOS.".into())
    }
}

#[cfg(target_os = "macos")]
fn resolve_urls(urls: Vec<String>) -> Result<Vec<String>, String> {
    use objc2_foundation::{NSString, NSURL};
    let mut paths = Vec::new();
    for value in urls {
        let url =
            NSURL::URLWithString(&NSString::from_str(&value)).ok_or("Invalid dragged file URL.")?;
        let url = url
            .filePathURL()
            .ok_or("The dragged file no longer exists.")?;
        let value = url
            .absoluteString()
            .ok_or("Invalid dragged file path URL.")?;
        paths.push(crate::project_entry_clipboard::file_url_path(
            &value.to_string(),
        )?);
    }
    Ok(paths)
}

#[tauri::command]
pub(crate) async fn start_project_entry_drag(
    window: tauri::WebviewWindow,
    workspace: String,
    paths: Vec<String>,
    drag_id: String,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if drag_id.len() > 100 {
            return Err("Invalid file drag identifier.".into());
        }
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let id = drag_id.clone();
        window
            .with_webview(move |webview| {
                let _ = sender.send(crate::project_entry_drag_destination::prepare(
                    webview.inner() as usize,
                    &id,
                ));
            })
            .map_err(|error| error.to_string())?;
        if !receiver.await.map_err(|error| error.to_string())?? {
            return Ok(());
        }
        let origin = Origin {
            workspace: workspace.clone(),
            paths: paths.clone(),
        };
        let prepared = crate::run_blocking(move || {
            let (_, paths) = crate::project_entry_clipboard::prepare_copy(
                std::path::Path::new(&workspace),
                paths,
            )?;
            paths
                .into_iter()
                .map(|path| {
                    let metadata = std::fs::symlink_metadata(&path)
                        .map_err(|error| format!("Cannot prepare dragged file: {error}"))?;
                    if metadata.file_type().is_symlink()
                        || (!metadata.is_file() && !metadata.is_dir())
                    {
                        return Err("Only regular files and folders can be dragged.".into());
                    }
                    Ok(crate::project_entry_drag_source::File {
                        path,
                        directory: metadata.is_dir(),
                    })
                })
                .collect::<Result<Vec<_>, String>>()
        })
        .await;
        let paths = match prepared {
            Ok(paths) => paths,
            Err(error) => {
                cancel_project_entry_drag(window, drag_id)?;
                return Err(error);
            }
        };
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let app = window.app_handle().clone();
        window
            .with_webview(move |webview| {
                let pointer = webview.inner() as usize;
                if !crate::project_entry_drag_destination::claim(pointer, &drag_id) {
                    let _ = sender.send(Ok(()));
                    return;
                }
                crate::project_entry_drag_source::start(
                    pointer,
                    webview.ns_window() as usize,
                    paths,
                    origin,
                    drag_id,
                    app,
                    sender,
                );
            })
            .map_err(|error| format!("Cannot schedule native file drag: {error}"))?;
        receiver
            .await
            .map_err(|error| format!("File drag ended unexpectedly: {error}"))?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, workspace, paths, drag_id);
        Err("Native file drag is supported only on macOS.".into())
    }
}

#[tauri::command]
pub(crate) fn cancel_project_entry_drag(
    window: tauri::WebviewWindow,
    drag_id: String,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        window
            .with_webview(move |webview| {
                crate::project_entry_drag_destination::cancel(webview.inner() as usize, &drag_id);
                crate::project_entry_drag_source::cancel_unstarted(
                    webview.inner() as usize,
                    Some(&drag_id),
                    false,
                );
            })
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, drag_id);
        Ok(())
    }
}
