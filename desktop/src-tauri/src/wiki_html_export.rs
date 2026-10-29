//! Self-contained static HTML export of the project Wiki, opened in the default
//! browser from a temp file (no server). Raw HTML in Markdown is escaped, links
//! are rewritten to in-page routes and images to `file://` URLs.
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use pulldown_cmark::{html, CowStr, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use serde::Serialize;
use sha2::{Digest, Sha256};

const MAX_PAGES: usize = 3000;
const MAX_PAGE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 32 * 1024 * 1024;
const MAX_DEPTH: usize = 16;
const TEMPLATE: &str = include_str!("wiki_export_template.html");

#[derive(Serialize)]
struct Page {
    path: String,
    title: String,
    html: String,
    text: String,
}

#[derive(Serialize)]
struct Export<'a> {
    title: &'a str,
    index: &'a str,
    pages: Vec<Page>,
}

fn is_markdown(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown")
}

fn collect(
    dir: &Path,
    prefix: &str,
    depth: usize,
    out: &mut Vec<(String, String)>,
    total: &mut u64,
) -> Result<(), String> {
    if depth > MAX_DEPTH {
        return Ok(());
    }
    let mut entries: Vec<_> = fs::read_dir(dir)
        .map_err(|error| format!("failed to read {}: {error}", dir.display()))?
        .filter_map(Result::ok)
        .collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let Ok(meta) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if meta.is_dir() {
            collect(&entry.path(), &rel, depth + 1, out, total)?;
        } else if meta.is_file() && is_markdown(&name) {
            if meta.len() > MAX_PAGE_BYTES {
                continue;
            }
            if out.len() >= MAX_PAGES || *total + meta.len() > MAX_TOTAL_BYTES {
                return Err("Wiki is too large to export as HTML".to_owned());
            }
            let Ok(text) = fs::read_to_string(entry.path()) else {
                continue;
            };
            *total += meta.len();
            out.push((rel, text));
        }
    }
    Ok(())
}

fn normalize(base_dir: &str, target: &str) -> Option<String> {
    let mut parts: Vec<&str> = if target.starts_with('/') {
        Vec::new()
    } else {
        base_dir.split('/').filter(|part| !part.is_empty()).collect()
    };
    for part in target.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            other => parts.push(other),
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(high * 16 + low);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'/') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn rewrite_url(
    url: &str,
    page_dir: &str,
    root: &Path,
    pages: &HashSet<String>,
    image: bool,
) -> String {
    const BLOCKED: &str = "#";
    if let Some(index) = url
        .find(':')
        .filter(|index| !url[..*index].contains(['/', '?', '#']))
    {
        let scheme = url[..index].to_ascii_lowercase();
        let allowed = scheme == "http" || scheme == "https" || (!image && scheme == "mailto");
        return if allowed { url.to_owned() } else { BLOCKED.to_owned() };
    }
    if url.starts_with("//") || url.starts_with('#') {
        return BLOCKED.to_owned();
    }
    let end = url.find(['?', '#']).unwrap_or(url.len());
    let Some(rel) = normalize(page_dir, &percent_decode(&url[..end])) else {
        return BLOCKED.to_owned();
    };
    if image {
        let absolute = root.join(&rel);
        format!("file://{}", percent_encode(&absolute.to_string_lossy()))
    } else if pages.contains(&rel) {
        format!("#/{}", percent_encode(&rel))
    } else {
        BLOCKED.to_owned()
    }
}

/// `Some(false)` image, `Some(true)` video, by the extension of a `file://` URL.
fn media_kind(url: &str) -> Option<bool> {
    if !url.starts_with("file://") {
        return None;
    }
    let ext = url.rsplit('.').next()?.to_ascii_lowercase();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "avif" => Some(false),
        "mp4" | "webm" | "mov" | "m4v" | "ogv" => Some(true),
        _ => None,
    }
}

fn media_html(url: &str, label: &str) -> String {
    let (src, alt) = (escape_html(url), escape_html(label));
    if media_kind(url) == Some(true) {
        format!("<video controls preload=\"metadata\" src=\"{src}\" title=\"{alt}\"></video>")
    } else {
        format!("<img src=\"{src}\" alt=\"{alt}\" loading=\"lazy\">")
    }
}

fn render_page(rel: &str, source: &str, root: &Path, pages: &HashSet<String>) -> Page {
    let dir = rel.rsplit_once('/').map_or("", |(dir, _)| dir);
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_FOOTNOTES;
    let mut title = String::new();
    let mut text = String::new();
    let mut in_title = false;
    let mut events: Vec<Event> = Vec::new();
    // Local image/video targets become inline media, whether written as a link or an image.
    let mut media: Option<(String, String)> = None;
    for event in Parser::new_ext(source, options) {
        if let Some((url, label)) = media.as_mut() {
            match event {
                Event::Text(value) | Event::Code(value) => label.push_str(&value),
                Event::End(TagEnd::Link) | Event::End(TagEnd::Image) => {
                    events.push(Event::Html(CowStr::from(media_html(url, label))));
                    media = None;
                }
                _ => {}
            }
            continue;
        }
        let event = match event {
            Event::Html(raw) | Event::InlineHtml(raw) => Event::Text(raw),
            Event::Start(Tag::Link { link_type, dest_url, title, id }) => {
                let url = rewrite_url(&dest_url, dir, root, pages, false);
                let local = rewrite_url(&dest_url, dir, root, pages, true);
                if media_kind(&local).is_some() {
                    media = Some((local, String::new()));
                    continue;
                }
                Event::Start(Tag::Link { link_type, dest_url: CowStr::from(url), title, id })
            }
            Event::Start(Tag::Image { link_type, dest_url, title, id }) => {
                let url = rewrite_url(&dest_url, dir, root, pages, true);
                if media_kind(&url) == Some(true) {
                    media = Some((url, String::new()));
                    continue;
                }
                Event::Start(Tag::Image { link_type, dest_url: CowStr::from(url), title, id })
            }
            other => other,
        };
        events.push(event);
    }
    for event in &events {
        match event {
            Event::Start(Tag::Heading { level: HeadingLevel::H1, .. }) => in_title = title.is_empty(),
            Event::End(TagEnd::Heading(HeadingLevel::H1)) => {
                in_title = false;
                text.push(' ');
            }
            Event::Text(value) | Event::Code(value) => {
                if in_title {
                    title.push_str(value);
                }
                text.push_str(value);
            }
            Event::End(_) | Event::SoftBreak | Event::HardBreak => text.push(' '),
            _ => {}
        }
    }
    let mut body = String::new();
    html::push_html(&mut body, events.into_iter());
    if title.trim().is_empty() {
        let name = rel.rsplit('/').next().unwrap_or(rel);
        title = name.rsplit_once('.').map_or(name, |(stem, _)| stem).to_owned();
    }
    Page {
        path: rel.to_owned(),
        title: title.trim().to_owned(),
        html: body,
        text,
    }
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn build_html(project: &str, root: &Path, index: &str, sources: &[(String, String)]) -> Result<String, String> {
    let known: HashSet<String> = sources.iter().map(|(path, _)| path.clone()).collect();
    let pages = sources
        .iter()
        .map(|(path, source)| render_page(path, source, root, &known))
        .collect();
    let data = serde_json::to_string(&Export {
        title: project,
        index,
        pages,
    })
    .map_err(|error| format!("failed to serialize Wiki: {error}"))?
    .replace('<', "\\u003c")
    .replace('\u{2028}', "\\u2028")
    .replace('\u{2029}', "\\u2029");
    // Title first: the data is inserted last and must never be re-scanned.
    Ok(TEMPLATE
        .replace("__PIX_WIKI_TITLE__", &escape_html(project))
        .replace("__PIX_WIKI_DATA__", &data))
}

fn export(workspace: &Path, path: &Path, index: &str) -> Result<PathBuf, String> {
    let (_, directory) = super::resolve_project_entry_path(workspace, path)?;
    if !directory.is_dir() {
        return Err("Wiki folder does not exist".to_owned());
    }
    let mut sources = Vec::new();
    collect(&directory, "", 0, &mut sources, &mut 0)?;
    if sources.is_empty() {
        return Err("Wiki has no Markdown pages to export".to_owned());
    }
    let project = workspace
        .file_name()
        .map_or_else(|| "Wiki".to_owned(), |name| name.to_string_lossy().into_owned());
    let page = build_html(&project, &directory, index, &sources)?;
    let digest = format!("{:x}", Sha256::digest(workspace.to_string_lossy().as_bytes()));
    let output = std::env::temp_dir().join(format!("pix-wiki-export-{}", &digest[..16]));
    fs::create_dir_all(&output)
        .map_err(|error| format!("failed to create export folder: {error}"))?;
    let file = output.join("index.html");
    let staging = output.join(format!(".index-{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&staging, page).map_err(|error| format!("failed to write Wiki HTML: {error}"))?;
    fs::rename(&staging, &file).map_err(|error| {
        let _ = fs::remove_file(&staging);
        format!("failed to write Wiki HTML: {error}")
    })?;
    Ok(file)
}

#[tauri::command]
pub(crate) async fn export_project_wiki_html(
    workspace: String,
    path: String,
    index: String,
) -> Result<(), String> {
    super::run_blocking(move || {
        let file = export(Path::new(&workspace), Path::new(&path), &index)?;
        #[cfg(target_os = "macos")]
        {
            super::project_browser::open_html_in_default_browser(&file)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = file;
            Err("Wiki HTML export is supported only on macOS".to_owned())
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_relative_paths_without_escaping_the_wiki() {
        assert_eq!(normalize("a/b", "../c.md").as_deref(), Some("a/c.md"));
        assert_eq!(normalize("a", "./x/./y.md").as_deref(), Some("a/x/y.md"));
        assert_eq!(normalize("", "../c.md"), None);
        assert_eq!(normalize("a", "/c.md").as_deref(), Some("c.md"));
    }

    #[test]
    fn rewrites_links_and_blocks_unsafe_schemes() {
        let pages: HashSet<String> = ["a/b.md".to_owned(), "c d.md".to_owned()].into();
        let root = Path::new("/w");
        let link = |url: &str| rewrite_url(url, "a", root, &pages, false);
        assert_eq!(link("b.md#x"), "#/a/b.md");
        assert_eq!(link("../c%20d.md"), "#/c%20d.md");
        assert_eq!(link("missing.md"), "#");
        assert_eq!(link("javascript:alert(1)"), "#");
        assert_eq!(link("//evil.example/x"), "#");
        assert_eq!(link("https://example.com/a:b"), "https://example.com/a:b");
        assert_eq!(rewrite_url("p ic.png", "a", root, &pages, true), "file:///w/a/p%20ic.png");
        assert_eq!(rewrite_url("data:image/png;base64,AA", "a", root, &pages, true), "#");
    }

    #[test]
    fn renders_local_media_links_inline() {
        let pages = HashSet::new();
        let page = render_page("a/p.md", "[x.png](i/x.png)\n\n![v](m.mp4)\n\n[d](d.md)", Path::new("/w"), &pages);
        assert!(page.html.contains("<img src=\"file:///w/a/i/x.png\" alt=\"x.png\""));
        assert!(page.html.contains("<video controls"));
        assert!(!page.html.contains("<a href=\"file"));
    }

    #[test]
    fn escapes_raw_html_and_embeds_safe_json() {
        let sources = vec![(
            "index.md".to_owned(),
            "# Home </script>\n\n<script>alert(1)</script>\n\n[x](b.md)".to_owned(),
        )];
        let html = build_html("P", Path::new("/w"), "index.md", &sources).unwrap();
        assert!(!html.contains("<script>alert"));
        assert!(!html.contains("Home </script>"));
        assert!(html.contains("\\u003cscript"));
    }

    #[test]
    fn exports_only_markdown_inside_the_wiki() {
        let root = std::env::temp_dir().join(format!("pix-wiki-exp-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("wiki/sub")).unwrap();
        fs::write(root.join("wiki/index.md"), "# Home\n[s](sub/s.md)").unwrap();
        fs::write(root.join("wiki/sub/s.md"), "text").unwrap();
        fs::write(root.join("wiki/skip.txt"), "no").unwrap();
        let file = export(&root, Path::new("wiki"), "index.md").unwrap();
        let html = fs::read_to_string(&file).unwrap();
        assert!(html.contains("sub/s.md") && !html.contains("skip.txt"));
        assert!(export(&root, Path::new("../x"), "index.md").is_err());
        fs::remove_dir_all(file.parent().unwrap()).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
