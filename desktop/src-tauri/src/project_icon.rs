//! Project logo images stored as canonical `.pi/project-icon.<ext>` files.
//!
//! Images enter Desktop only through Rust-owned paths: the native file chooser,
//! AI generation, or a previously stored canonical project icon. The webview
//! never supplies arbitrary filesystem paths to read or copy.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Serialize;
use serde_json::Value;
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// Canonical project icon files. Keep in sync with the `.pi` canonical list.
pub(crate) const PROJECT_ICON_FILE_NAMES: &[&str] = &[
    "project-icon.png",
    "project-icon.jpg",
    "project-icon.webp",
    "project-icon.gif",
    "project-icon.svg",
];
pub(crate) const PROJECT_ICON_TEMP_PREFIX: &str = ".project-icon.";
const MAX_PROJECT_ICON_BYTES: u64 = 4 * 1024 * 1024;
const MAX_README_EXCERPT_CHARS: usize = 1000;
const MAX_README_READ_BYTES: u64 = 64 * 1024;
const MAX_USER_PROMPT_CHARS: usize = 1000;
const DEFAULT_PROJECT_ICON_MODEL: &str = "google/gemini-2.5-flash-image";
const OPENROUTER_CHAT_URL: &str = "https://openrouter.ai/api/v1/chat/completions";
static PROJECT_ICON_WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IconFormat {
    Png,
    Jpeg,
    Webp,
    Gif,
    Svg,
}

impl IconFormat {
    fn mime(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Webp => "image/webp",
            Self::Gif => "image/gif",
            Self::Svg => "image/svg+xml",
        }
    }

    fn file_name(self) -> &'static str {
        match self {
            Self::Png => "project-icon.png",
            Self::Jpeg => "project-icon.jpg",
            Self::Webp => "project-icon.webp",
            Self::Gif => "project-icon.gif",
            Self::Svg => "project-icon.svg",
        }
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectIconImage {
    mime_type: String,
    data_base64: String,
}

fn detect_icon_format(bytes: &[u8]) -> Option<IconFormat> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some(IconFormat::Png);
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some(IconFormat::Jpeg);
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some(IconFormat::Gif);
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some(IconFormat::Webp);
    }
    let head = &bytes[..bytes.len().min(1024)];
    let text = std::str::from_utf8(head).ok().or_else(|| {
        // A multibyte character may be split at the 1 KB boundary.
        std::str::from_utf8(&head[..head.len().saturating_sub(3)]).ok()
    })?;
    let text = text.trim_start_matches('\u{feff}').trim_start().to_ascii_lowercase();
    if text.starts_with("<svg") || ((text.starts_with("<?xml") || text.starts_with("<!--")) && text.contains("<svg")) {
        return Some(IconFormat::Svg);
    }
    None
}

fn icon_image(bytes: &[u8]) -> Result<ProjectIconImage, String> {
    if bytes.len() as u64 > MAX_PROJECT_ICON_BYTES {
        return Err("project icon is too large (maximum 4 MB)".to_owned());
    }
    let format = detect_icon_format(bytes)
        .ok_or_else(|| "project icon must be a PNG, JPEG, WebP, GIF, or SVG image".to_owned())?;
    Ok(ProjectIconImage {
        mime_type: format.mime().to_owned(),
        data_base64: BASE64.encode(bytes),
    })
}

fn read_bounded_file(path: &Path, max_bytes: u64) -> Result<Vec<u8>, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("failed to inspect image: {error}"))?;
    if !metadata.is_file() {
        return Err("selected path is not a file".to_owned());
    }
    if metadata.len() > max_bytes {
        return Err("project icon is too large (maximum 4 MB)".to_owned());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|error| format!("failed to open image: {error}"))?
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read image: {error}"))?;
    if bytes.len() as u64 > max_bytes {
        return Err("project icon is too large (maximum 4 MB)".to_owned());
    }
    Ok(bytes)
}

/// Open a native image chooser and return the validated image for preview.
/// Nothing is written until the user saves project settings.
#[tauri::command]
pub(crate) async fn pick_project_icon_image(app: AppHandle) -> Result<Option<ProjectIconImage>, String> {
    crate::run_blocking(move || {
        let Some(selected) = app
            .dialog()
            .file()
            .set_title("Choose project logo")
            .add_filter("Images", &["png", "jpg", "jpeg", "webp", "gif", "svg"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = selected
            .into_path()
            .map_err(|error| format!("failed to resolve the selected image: {error}"))?;
        let bytes = read_bounded_file(&path, MAX_PROJECT_ICON_BYTES)?;
        icon_image(&bytes).map(Some)
    })
    .await
}

fn readme_excerpt(root: &Path) -> Option<String> {
    for name in ["README.md", "readme.md", "Readme.md", "README", "README.txt"] {
        let path = root.join(name);
        let Ok(metadata) = fs::symlink_metadata(&path) else { continue };
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            continue;
        }
        let mut bytes = Vec::new();
        if fs::File::open(&path)
            .and_then(|file| file.take(MAX_README_READ_BYTES).read_to_end(&mut bytes))
            .is_err()
        {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        let excerpt: String = text.chars().take(MAX_README_EXCERPT_CHARS).collect();
        let excerpt = excerpt.trim();
        if !excerpt.is_empty() {
            return Some(excerpt.to_owned());
        }
    }
    None
}

fn project_icon_prompt(project_name: &str, readme: Option<&str>, user_prompt: Option<&str>) -> String {
    let mut prompt = format!(
        "Design a square app icon / logo for a software project named \"{project_name}\". \
It will be displayed tiny (16-24 px) in a dark desktop titlebar, so legibility at that size matters most. \
Requirements: one single bold, simple, recognizable symbol that fills about 75-85% of the canvas; \
thick solid shapes, no thin lines, outlines, fine detail, or small elements; \
bright, saturated, high-contrast colors with a clearly lighter or more vivid symbol than its background; \
the background must fill the entire square edge to edge with a solid color or simple gradient, \
and must not be near-black or dark gray; avoid dark-on-dark and low-contrast palettes; \
flat design, no text, letters, words, watermarks, frames, borders, rounded-corner masks, or drop shadows."
    );
    if let Some(user_prompt) = user_prompt {
        prompt.push_str("\n\nAdditional user requirements (take priority over the default style):\n");
        prompt.push_str(user_prompt);
    }
    if let Some(readme) = readme {
        prompt.push_str("\n\nProject README excerpt for context (do not render any of this text):\n");
        prompt.push_str(readme);
    }
    prompt
}

fn image_from_openrouter_response(body: &Value) -> Result<Vec<u8>, String> {
    let message = body
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .ok_or_else(|| "OpenRouter returned no image".to_owned())?;
    let url = message
        .get("images")
        .and_then(Value::as_array)
        .and_then(|images| {
            images.iter().find_map(|image| {
                image
                    .get("image_url")
                    .and_then(|value| value.get("url"))
                    .and_then(Value::as_str)
            })
        })
        .ok_or_else(|| "The selected model returned no image. Choose an image-capable model.".to_owned())?;
    let (_, data) = url
        .strip_prefix("data:")
        .and_then(|rest| rest.split_once(";base64,"))
        .ok_or_else(|| "OpenRouter returned an unsupported image URL".to_owned())?;
    BASE64
        .decode(data.trim())
        .map_err(|_| "OpenRouter returned malformed image data".to_owned())
}

fn openrouter_error_message(status: u16, body: &str) -> String {
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .map(|message| message.chars().take(300).collect::<String>());
    match detail {
        Some(message) => format!("OpenRouter image generation failed ({status}): {message}"),
        None => format!("OpenRouter image generation failed ({status})"),
    }
}

fn normalize_user_prompt(prompt: Option<&str>) -> Result<Option<String>, String> {
    let Some(prompt) = prompt.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if prompt.chars().count() > MAX_USER_PROMPT_CHARS {
        return Err(format!("logo prompt is too long (maximum {MAX_USER_PROMPT_CHARS} characters)"));
    }
    Ok(Some(prompt.to_owned()))
}

/// Generate a logo preview with an OpenRouter image model. The project name and
/// the first README characters are sent to OpenRouter; nothing is written.
#[tauri::command]
pub(crate) async fn generate_project_icon_image(
    workspace: String,
    model: Option<String>,
    prompt: Option<String>,
) -> Result<ProjectIconImage, String> {
    crate::run_blocking(move || {
        let root = crate::canonical_workspace(Path::new(&workspace))?;
        let api_key = crate::native_repository_semantic_config::openrouter_api_key().ok_or_else(|| {
            "Set OPENROUTER_API_KEY or add an OpenRouter key to Pi auth to generate a logo.".to_owned()
        })?;
        let model = model
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| DEFAULT_PROJECT_ICON_MODEL.to_owned());
        let project_name = root
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "project".to_owned());
        let user_prompt = normalize_user_prompt(prompt.as_deref())?;
        let prompt = project_icon_prompt(
            &project_name,
            readme_excerpt(&root).as_deref(),
            user_prompt.as_deref(),
        );
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(180))
            .build()
            .map_err(|error| format!("failed to create the OpenRouter HTTP client: {error}"))?;
        let response = client
            .post(OPENROUTER_CHAT_URL)
            .bearer_auth(api_key)
            .header("X-Title", "Pix Desktop")
            .json(&serde_json::json!({
                "model": model,
                "modalities": ["image", "text"],
                "image_config": { "aspect_ratio": "1:1" },
                "messages": [{ "role": "user", "content": prompt }],
            }))
            .send()
            .map_err(|error| format!("failed to reach OpenRouter: {error}"))?;
        let status = response.status();
        let body = response
            .text()
            .map_err(|error| format!("failed to read the OpenRouter response: {error}"))?;
        if !status.is_success() {
            return Err(openrouter_error_message(status.as_u16(), &body));
        }
        let parsed: Value = serde_json::from_str(&body)
            .map_err(|_| "OpenRouter returned a malformed response".to_owned())?;
        icon_image(&image_from_openrouter_response(&parsed)?)
    })
    .await
}

fn project_pi_directory(root: &Path) -> Result<PathBuf, String> {
    let directory = root.join(".pi");
    match fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(".pi must not be a symbolic link".to_owned())
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&directory)
                .map_err(|error| format!("failed to create {}: {error}", directory.display()))?;
        }
        Err(error) => return Err(format!("failed to inspect {}: {error}", directory.display())),
    }
    crate::canonical_project_directory(root, &directory)
}

pub(crate) fn save_project_icon_from(workspace: &Path, data_base64: &str) -> Result<String, String> {
    let bytes = BASE64
        .decode(data_base64.trim())
        .map_err(|_| "project icon data is malformed".to_owned())?;
    if bytes.len() as u64 > MAX_PROJECT_ICON_BYTES {
        return Err("project icon is too large (maximum 4 MB)".to_owned());
    }
    let format = detect_icon_format(&bytes)
        .ok_or_else(|| "project icon must be a PNG, JPEG, WebP, GIF, or SVG image".to_owned())?;
    let root = crate::canonical_workspace(workspace)?;
    let directory = project_pi_directory(&root)?;
    let target = directory.join(format.file_name());
    if fs::symlink_metadata(&target).is_ok_and(|metadata| !metadata.is_file()) {
        return Err(format!(".pi/{} is not a regular file", format.file_name()));
    }
    let sequence = PROJECT_ICON_WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temp = directory.join(format!(
        "{PROJECT_ICON_TEMP_PREFIX}{}.{sequence}.tmp",
        std::process::id()
    ));
    let write = (|| -> std::io::Result<()> {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temp, &target)
    })();
    if let Err(error) = write {
        let _ = fs::remove_file(&temp);
        return Err(format!("failed to save .pi/{}: {error}", format.file_name()));
    }
    // Keep exactly one canonical icon so stale variants cannot reappear.
    for name in PROJECT_ICON_FILE_NAMES {
        if *name == format.file_name() {
            continue;
        }
        let other = directory.join(name);
        if fs::symlink_metadata(&other).is_ok_and(|metadata| metadata.is_file()) {
            let _ = fs::remove_file(&other);
        }
    }
    Ok(format!(".pi/{}", format.file_name()))
}

/// Store a previewed logo as the canonical `.pi/project-icon.<ext>` file and
/// return its workspace-relative path for `.pi/workspace.jsonc`.
#[tauri::command]
pub(crate) async fn save_project_icon(workspace: String, data_base64: String) -> Result<String, String> {
    crate::run_blocking(move || save_project_icon_from(Path::new(&workspace), &data_base64)).await
}

pub(crate) fn read_project_icon_from(workspace: &Path, relative_path: &str) -> Result<ProjectIconImage, String> {
    let name = relative_path
        .strip_prefix(".pi/")
        .filter(|name| PROJECT_ICON_FILE_NAMES.contains(name))
        .ok_or_else(|| "project icon must be a canonical .pi/project-icon file".to_owned())?;
    let root = crate::canonical_workspace(workspace)?;
    let directory = crate::canonical_project_directory(&root, &root.join(".pi"))?;
    let path = directory.join(name);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| format!("failed to inspect .pi/{name}: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(".pi/{name} is not a regular file"));
    }
    let bytes = read_bounded_file(&path, MAX_PROJECT_ICON_BYTES)?;
    let image = icon_image(&bytes)?;
    let expected = detect_icon_format(&bytes).map(IconFormat::file_name);
    if expected != Some(name) {
        return Err(format!(".pi/{name} does not match its image format"));
    }
    Ok(image)
}

#[tauri::command]
pub(crate) async fn read_project_icon(workspace: String, path: String) -> Result<ProjectIconImage, String> {
    crate::run_blocking(move || read_project_icon_from(Path::new(&workspace), &path)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nrest";

    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "pix-project-icon-{label}-{}-{}",
                std::process::id(),
                PROJECT_ICON_WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).expect("create test workspace");
            Self(path)
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn detects_supported_formats_by_content() {
        assert_eq!(detect_icon_format(PNG), Some(IconFormat::Png));
        assert_eq!(detect_icon_format(&[0xFF, 0xD8, 0xFF, 0xE0]), Some(IconFormat::Jpeg));
        assert_eq!(detect_icon_format(b"GIF89a..."), Some(IconFormat::Gif));
        assert_eq!(detect_icon_format(b"RIFF\0\0\0\0WEBPVP8 "), Some(IconFormat::Webp));
        assert_eq!(detect_icon_format(b"<?xml version=\"1.0\"?><svg/>"), Some(IconFormat::Svg));
        assert_eq!(detect_icon_format(b"  <svg xmlns=\"x\"/>"), Some(IconFormat::Svg));
        assert_eq!(detect_icon_format(b"<html></html>"), None);
        assert_eq!(detect_icon_format(b"plain"), None);
    }

    #[test]
    fn saves_one_canonical_icon_and_reads_it_back() {
        let workspace = TestDirectory::new("save");
        fs::create_dir(workspace.0.join(".pi")).unwrap();
        fs::write(workspace.0.join(".pi/project-icon.svg"), b"<svg/>").unwrap();
        let path = save_project_icon_from(&workspace.0, &BASE64.encode(PNG)).expect("save icon");
        assert_eq!(path, ".pi/project-icon.png");
        assert!(!workspace.0.join(".pi/project-icon.svg").exists());
        let image = read_project_icon_from(&workspace.0, &path).expect("read icon");
        assert_eq!(image.mime_type, "image/png");
        assert_eq!(BASE64.decode(image.data_base64).unwrap(), PNG);
        let leftovers = fs::read_dir(workspace.0.join(".pi"))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(PROJECT_ICON_TEMP_PREFIX))
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn creates_pi_directory_and_rejects_non_images() {
        let workspace = TestDirectory::new("create");
        assert!(save_project_icon_from(&workspace.0, &BASE64.encode(b"not an image")).is_err());
        assert_eq!(
            save_project_icon_from(&workspace.0, &BASE64.encode(PNG)).unwrap(),
            ".pi/project-icon.png"
        );
    }

    #[test]
    fn read_rejects_non_canonical_paths_and_mismatched_formats() {
        let workspace = TestDirectory::new("read");
        fs::create_dir(workspace.0.join(".pi")).unwrap();
        fs::write(workspace.0.join(".pi/workspace.jsonc"), b"{}").unwrap();
        assert!(read_project_icon_from(&workspace.0, ".pi/workspace.jsonc").is_err());
        assert!(read_project_icon_from(&workspace.0, "../project-icon.png").is_err());
        assert!(read_project_icon_from(&workspace.0, ".pi/../.pi/project-icon.png").is_err());
        fs::write(workspace.0.join(".pi/project-icon.jpg"), PNG).unwrap();
        assert!(read_project_icon_from(&workspace.0, ".pi/project-icon.jpg").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn read_rejects_symlinked_icons() {
        let workspace = TestDirectory::new("symlink");
        fs::create_dir(workspace.0.join(".pi")).unwrap();
        fs::write(workspace.0.join("outside.png"), PNG).unwrap();
        std::os::unix::fs::symlink(
            workspace.0.join("outside.png"),
            workspace.0.join(".pi/project-icon.png"),
        )
        .unwrap();
        assert!(read_project_icon_from(&workspace.0, ".pi/project-icon.png").is_err());
    }

    #[test]
    fn extracts_openrouter_image_and_builds_prompt() {
        let body = serde_json::json!({
            "choices": [{ "message": { "images": [{ "image_url": {
                "url": format!("data:image/png;base64,{}", BASE64.encode(PNG))
            } }] } }]
        });
        assert_eq!(image_from_openrouter_response(&body).unwrap(), PNG);
        assert!(image_from_openrouter_response(&serde_json::json!({"choices": [{"message": {"content": "no"}}]})).is_err());
        let prompt = project_icon_prompt("pix", Some("# Pix\nAgent harness"), Some("a blue fox"));
        assert!(prompt.contains("\"pix\""));
        assert!(prompt.contains("Agent harness"));
        assert!(prompt.contains("a blue fox"));
        assert!(prompt.contains("75-85% of the canvas"));
        assert!(prompt.contains("must not be near-black"));
        assert!(!project_icon_prompt("pix", None, None).contains("Additional user requirements"));
        assert_eq!(normalize_user_prompt(Some("  ")).unwrap(), None);
        assert_eq!(normalize_user_prompt(Some(" fox ")).unwrap().as_deref(), Some("fox"));
        assert!(normalize_user_prompt(Some(&"x".repeat(MAX_USER_PROMPT_CHARS + 1))).is_err());
        assert_eq!(
            openrouter_error_message(402, r#"{"error":{"message":"Insufficient credits"}}"#),
            "OpenRouter image generation failed (402): Insufficient credits"
        );
    }

    #[test]
    fn readme_excerpt_is_bounded() {
        let workspace = TestDirectory::new("readme");
        fs::write(workspace.0.join("README.md"), "x".repeat(5000)).unwrap();
        assert_eq!(readme_excerpt(&workspace.0).unwrap().chars().count(), MAX_README_EXCERPT_CHARS);
    }
}
