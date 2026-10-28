//! Interoperable file clipboard: native file URLs plus a Pix reference on Copy.
//! Reads never rewrite the pasteboard; ordinary text paths are not references.
#[cfg(any(target_os = "macos", test))]
use std::{fs, path::Path};

#[cfg(target_os = "macos")]
const PIX_REFERENCE_TYPE: &str = "dev.pix.project-entry";

#[cfg(target_os = "macos")]
static COPY_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[cfg(target_os = "macos")]
fn check_copy_generation(
    expected: u64,
    current: u64,
    clipboard: isize,
    current_clipboard: isize,
) -> Result<(), String> {
    if expected != current || clipboard != current_clipboard {
        return Err("Clipboard changed while preparing Copy; please retry.".into());
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn write_project_entry_clipboard(
    app: tauri::AppHandle,
    workspace: String,
    paths: Vec<String>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::sync::atomic::Ordering;
        let generation = COPY_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
        let (sender, receiver) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = sender.send(objc2_app_kit::NSPasteboard::generalPasteboard().changeCount());
        })
        .map_err(|error| format!("Cannot schedule clipboard snapshot: {error}"))?;
        let clipboard = receiver
            .await
            .map_err(|error| format!("Clipboard snapshot failed: {error}"))?;
        let (text, paths) =
            crate::run_blocking(move || prepare_copy(Path::new(&workspace), paths)).await?;
        let (sender, receiver) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let result = copy_items(&text, &paths).and_then(|items| {
                use objc2_app_kit::NSPasteboard;
                use objc2_foundation::NSArray;
                let objects: Vec<_> = items
                    .into_iter()
                    .map(objc2::runtime::ProtocolObject::from_retained)
                    .collect();
                let pasteboard = NSPasteboard::generalPasteboard();
                // Filesystem validation can finish late. Do not replace a newer
                // Copy, Cut, copied path, or another application's clipboard.
                check_copy_generation(
                    generation,
                    COPY_GENERATION.load(Ordering::Relaxed),
                    clipboard,
                    pasteboard.changeCount(),
                )?;
                // Prepare every representation before replacing the old clipboard.
                pasteboard.clearContents();
                if pasteboard.writeObjects(&NSArray::from_retained_slice(&objects)) {
                    Ok(())
                } else {
                    Err("Cannot place project files on the clipboard.".into())
                }
            });
            let _ = sender.send(result);
        })
        .map_err(|error| format!("Cannot schedule file clipboard write: {error}"))?;
        receiver
            .await
            .map_err(|error| format!("File clipboard write failed: {error}"))?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, workspace, paths);
        Err("Native file clipboard is supported only on macOS.".into())
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn prepare_copy(workspace: &Path, paths: Vec<String>) -> Result<(String, Vec<String>), String> {
    use std::path::Component;
    if paths.is_empty() || paths.len() > 1000 {
        return Err("Select between 1 and 1000 clipboard entries.".into());
    }
    let root = crate::canonical_workspace(workspace)?;
    let mut entries = Vec::new();
    let mut sources = Vec::new();
    for path in &paths {
        if path.is_empty()
            || path.contains(['\\', '\0'])
            || path
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err("Expected a workspace-relative clipboard path.".into());
        }
        let mut source = root.clone();
        for part in Path::new(path).components() {
            let Component::Normal(part) = part else {
                return Err("Expected a workspace-relative clipboard path.".into());
            };
            source.push(part);
            let meta = fs::symlink_metadata(&source)
                .map_err(|error| format!("Cannot access copied entry: {error}"))?;
            if meta.file_type().is_symlink() || (!meta.is_dir() && !meta.is_file()) {
                return Err("Cannot copy symbolic links or special files.".into());
            }
        }
        // All inputs are validated, even if a selected parent will cover them.
        let source_string = source
            .to_str()
            .ok_or("Clipboard path is not valid UTF-8.")?
            .to_owned();
        if sources.contains(&source_string)
            || paths
                .iter()
                .any(|parent| path.starts_with(&format!("{parent}/")))
        {
            continue;
        }
        let entry = crate::project_tree_entry_from_path(&root, &source)?;
        entries.push(serde_json::json!({ "path": entry.path, "kind": entry.kind }));
        sources.push(source_string);
    }
    let text = serde_json::json!({
        "format": "pix-project-entry", "version": 2,
        "workspace": root.to_str().ok_or("Workspace path is not valid UTF-8.")?,
        "operation": "copy", "entries": entries,
    })
    .to_string();
    if text.len() > 32_768 {
        return Err("Clipboard file selection is too large; copy fewer entries.".into());
    }
    Ok((text, sources))
}

#[cfg(target_os = "macos")]
fn copy_items(
    text: &str,
    paths: &[String],
) -> Result<Vec<objc2::rc::Retained<objc2_app_kit::NSPasteboardItem>>, String> {
    use objc2_app_kit::NSPasteboardItem;
    use objc2_foundation::{NSString, NSURL};
    let mut items = Vec::new();
    for (index, path) in paths.iter().enumerate() {
        // Explicit URL construction avoids probing the filesystem on the main
        // thread. A file URL need not end in / to identify a folder in Finder.
        let url = NSURL::fileURLWithPath_isDirectory(&NSString::from_str(path), false)
            .absoluteString()
            .ok_or("Cannot encode clipboard file URL.")?;
        let item = NSPasteboardItem::new();
        if !item.setString_forType(&url, &NSString::from_str("public.file-url")) {
            return Err("Cannot encode clipboard file item.".into());
        }
        if index == 0 {
            let text = NSString::from_str(text);
            if !item.setString_forType(&text, &NSString::from_str(PIX_REFERENCE_TYPE))
                || !item.setString_forType(&text, &NSString::from_str("public.utf8-plain-text"))
            {
                return Err("Cannot encode Pix clipboard reference.".into());
            }
        }
        items.push(item);
    }
    Ok(items)
}

#[tauri::command]
pub(crate) async fn read_project_entry_clipboard(
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = sender.send(read_pasteboard_snapshot());
        })
        .map_err(|error| format!("Cannot schedule file clipboard read: {error}"))?;
        let (text, paths) = receiver
            .await
            .map_err(|error| format!("File clipboard read failed: {error}"))??;
        if paths.is_empty() {
            return Ok(text);
        }
        return crate::run_blocking(move || encode_file_paths(&paths).map(Some)).await;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("Finder file clipboard is supported only on macOS.".into())
    }
}

#[cfg(target_os = "macos")]
fn read_pasteboard_snapshot() -> Result<(Option<String>, Vec<String>), String> {
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::NSString;

    let pasteboard = NSPasteboard::generalPasteboard();
    let generation = pasteboard.changeCount();
    let pix_reference = pasteboard.stringForType(&NSString::from_str(PIX_REFERENCE_TYPE));
    let text = pix_reference
        .as_ref()
        .map(|value| value.to_string())
        .or_else(|| {
            pasteboard
                .stringForType(&NSString::from_str("public.utf8-plain-text"))
                .map(|value| value.to_string())
        });
    // Preserve the Pix workspace and operation instead of converting our dual
    // representation to a Finder import. Plain-text legacy Pix copies still work.
    let mut paths = Vec::new();
    if let Some(items) = pasteboard
        .pasteboardItems()
        .filter(|_| pix_reference.is_none())
    {
        if items.len() > 1000 {
            return Err("Select at most 1000 clipboard entries.".into());
        }
        let file_type = NSString::from_str("public.file-url");
        for item in items.iter() {
            if let Some(value) = item.stringForType(&file_type) {
                paths.push(file_url_path(&value.to_string())?);
            }
        }
    }
    if pasteboard.changeCount() != generation {
        return Err("Clipboard changed while reading files; please retry Paste.".into());
    }
    Ok((text, paths))
}

#[cfg(target_os = "macos")]
pub(crate) fn file_url_path(value: &str) -> Result<String, String> {
    use objc2_foundation::{NSString, NSURL};
    let url = NSURL::URLWithString(&NSString::from_str(value))
        .ok_or_else(|| "Invalid clipboard file URL.".to_owned())?;
    if !url.isFileURL()
        || url.host().is_some_and(|host| {
            let host = host.to_string();
            !host.is_empty() && !host.eq_ignore_ascii_case("localhost")
        })
    {
        return Err("Clipboard entries must be local file URLs.".into());
    }
    url.path()
        .map(|path| path.to_string())
        .ok_or_else(|| "Clipboard file URL has no path.".to_owned())
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn encode_file_paths(paths: &[String]) -> Result<String, String> {
    if paths.is_empty() || paths.len() > 1000 {
        return Err("Select between 1 and 1000 clipboard files.".into());
    }
    let mut entries = Vec::new();
    for value in paths {
        let path = Path::new(value);
        if !path.is_absolute() || value.contains(['\0', '\\']) {
            return Err("Clipboard file paths must be absolute local paths.".into());
        }
        let name = path.file_name().ok_or("Cannot paste a filesystem root.")?;
        // Resolve macOS aliases such as /var -> /private/var in the parent only.
        // Keep the leaf untouched so a symbolic link is rejected, not imported.
        let parent = fs::canonicalize(path.parent().ok_or("Missing clipboard file parent.")?)
            .map_err(|error| format!("Cannot access clipboard file parent: {error}"))?;
        let source = parent.join(name);
        let metadata = fs::symlink_metadata(&source)
            .map_err(|error| format!("Cannot access clipboard file: {error}"))?;
        if metadata.file_type().is_symlink() || (!metadata.is_file() && !metadata.is_dir()) {
            return Err("Cannot paste symbolic links or special files.".into());
        }
        let relative = source
            .strip_prefix("/")
            .map_err(|error| error.to_string())?
            .to_str()
            .ok_or("Clipboard file path is not valid UTF-8.")?
            .to_owned();
        entries.push(serde_json::json!({
            "path": relative,
            "kind": if metadata.is_dir() { "directory" } else { "file" },
        }));
    }
    // Reuse the validated cross-workspace copy request and undoable batch logic.
    let encoded = serde_json::json!({
        "format": "pix-project-entry", "version": 2, "workspace": "/",
        "operation": "copy", "entries": entries,
    })
    .to_string();
    if encoded.len() > 32_768 {
        return Err("Clipboard file selection is too large; paste fewer entries.".into());
    }
    Ok(encoded)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn late_copy_cannot_replace_a_newer_copy_or_external_clipboard_write() {
        assert!(check_copy_generation(1, 1, 10, 10).is_ok());
        assert!(check_copy_generation(1, 2, 10, 10).is_err());
        assert!(check_copy_generation(1, 1, 10, 11).is_err());
    }

    #[test]
    fn copy_items_offer_file_urls_for_finder_and_a_pix_reference_on_the_first_item() {
        use objc2_foundation::NSString;
        let text = r#"{"format":"pix-project-entry","version":2,"workspace":"/project","operation":"copy","entries":[{"path":"a #%.txt","kind":"file"},{"path":"папка","kind":"directory"}]}"#;
        let paths = vec!["/project/a #%.txt".to_owned(), "/project/папка".to_owned()];
        let items = copy_items(text, &paths).unwrap();
        assert_eq!(items.len(), 2);
        for (item, path) in items.iter().zip(&paths) {
            let url = item
                .stringForType(&NSString::from_str("public.file-url"))
                .unwrap();
            assert_eq!(file_url_path(&url.to_string()).unwrap(), *path);
        }
        for kind in [PIX_REFERENCE_TYPE, "public.utf8-plain-text"] {
            assert_eq!(
                items[0]
                    .stringForType(&NSString::from_str(kind))
                    .unwrap()
                    .to_string(),
                text
            );
            assert!(items[1].stringForType(&NSString::from_str(kind)).is_none());
        }
    }

    #[test]
    fn prepare_copy_validates_all_sources_and_deduplicates_selected_descendants() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../.pi/artifacts/finder-copy-tests")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(root.join("folder")).unwrap();
        fs::write(root.join("folder/a #%.txt"), "content").unwrap();
        let (text, paths) = prepare_copy(
            &root,
            vec!["folder/a #%.txt".into(), "folder".into(), "folder".into()],
        )
        .unwrap();
        let reference: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(reference["operation"], "copy");
        assert_eq!(reference["entries"].as_array().unwrap().len(), 1);
        assert_eq!(reference["entries"][0]["kind"], "directory");
        assert_eq!(
            reference["workspace"],
            fs::canonicalize(&root).unwrap().to_str().unwrap()
        );
        assert_eq!(
            paths,
            vec![fs::canonicalize(root.join("folder"))
                .unwrap()
                .to_str()
                .unwrap()
                .to_owned()]
        );
        std::os::unix::fs::symlink(root.join("folder"), root.join("link")).unwrap();
        for paths in [
            vec![],
            vec!["../escape".into()],
            vec!["/etc/passwd".into()],
            vec!["folder/./a #%.txt".into()],
            vec!["missing".into()],
            vec!["link/a #%.txt".into()],
            vec!["link".into()],
            vec!["folder".into(), "folder/missing".into()],
            vec!["folder".into(); 1001],
        ] {
            assert!(prepare_copy(&root, paths).is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn native_urls_decode_unicode_spaces_and_reserved_characters() {
        assert_eq!(
            file_url_path("file:///Users/test/%D1%82%D0%B5%D1%81%D1%82%20%23%25.txt").unwrap(),
            "/Users/test/тест #%.txt"
        );
        assert!(file_url_path("https://example.org/file").is_err());
        assert!(file_url_path("file://remote.example/share/a").is_err());
    }

    #[test]
    fn native_files_encode_as_a_copy_batch_and_reject_links_and_missing_files() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../.pi/artifacts/finder-clipboard-tests")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(root.join("папка")).unwrap();
        fs::write(root.join("a #%.txt"), "content").unwrap();
        let paths = [root.join("a #%.txt"), root.join("папка")]
            .map(|path| path.to_str().unwrap().to_owned());
        let value: serde_json::Value =
            serde_json::from_str(&encode_file_paths(&paths).unwrap()).unwrap();
        assert_eq!(value["workspace"], "/");
        assert_eq!(value["operation"], "copy");
        assert_eq!(value["entries"][0]["kind"], "file");
        assert_eq!(value["entries"][1]["kind"], "directory");
        assert_eq!(
            value["entries"][0]["path"],
            fs::canonicalize(&paths[0])
                .unwrap()
                .strip_prefix("/")
                .unwrap()
                .to_str()
                .unwrap()
        );
        std::os::unix::fs::symlink(root.join("a #%.txt"), root.join("link")).unwrap();
        for invalid in [
            root.join("link"),
            root.join("missing"),
            Path::new("relative").into(),
            Path::new("/").into(),
        ] {
            assert!(encode_file_paths(&[invalid.to_str().unwrap().to_owned()]).is_err());
        }
        assert!(encode_file_paths(&[]).is_err());
        assert!(encode_file_paths(&vec![paths[0].clone(); 1001]).is_err());
        assert!(encode_file_paths(&vec![paths[0].clone(); 1000]).is_err()); // Encoded size bound.
        fs::remove_dir_all(root).unwrap();
    }
}
