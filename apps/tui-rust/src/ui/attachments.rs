//! Virtual prompt attachments for the input editor.
//!
//! Attachments are represented in the text buffer by small tags such as
//! `[Image 1]`, while the bytes/text needed for submission live here.

use std::fs;
use std::path::Path;

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Attachment {
    Image {
        tag: String,
        data: String,
        mime_type: String,
    },
    PastedText {
        tag: String,
        text: String,
        line_count: usize,
    },
    File {
        tag: String,
        path: String,
        mime_type: String,
        data: Option<String>,
        is_image: bool,
    },
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct AttachmentCounts {
    pub images: usize,
    pub files: usize,
    pub pasted_texts: usize,
}

impl AttachmentCounts {
    pub fn total(self) -> usize {
        self.images + self.files + self.pasted_texts
    }

    pub fn summary(self) -> Option<String> {
        let mut parts = Vec::new();
        if self.images > 0 {
            parts.push(format!(
                "{} {}",
                self.images,
                pluralize(self.images, "image")
            ));
        }
        if self.files > 0 {
            parts.push(format!("{} {}", self.files, pluralize(self.files, "file")));
        }
        if self.pasted_texts > 0 {
            parts.push(format!(
                "{} {}",
                self.pasted_texts,
                pluralize(self.pasted_texts, "paste")
            ));
        }
        (!parts.is_empty()).then(|| parts.join(" · "))
    }
}

impl Attachment {
    pub fn tag(&self) -> &str {
        match self {
            Self::Image { tag, .. } | Self::PastedText { tag, .. } | Self::File { tag, .. } => tag,
        }
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct AttachmentManager {
    attachments: Vec<Attachment>,
    image_counter: usize,
    paste_counter: usize,
    file_counter: usize,
}

impl AttachmentManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn attach_image(
        &mut self,
        data: impl Into<String>,
        mime: impl Into<String>,
    ) -> &Attachment {
        self.image_counter += 1;
        let tag = format!("[Image {}]", self.image_counter);
        self.attachments.push(Attachment::Image {
            tag,
            data: data.into(),
            mime_type: mime.into(),
        });
        self.attachments.last().expect("just pushed attachment")
    }

    pub fn attach_pasted_text(&mut self, text: impl Into<String>) -> &Attachment {
        let normalized = text.into().replace("\r\n", "\n").replace('\r', "\n");
        let line_count = normalized.matches('\n').count() + 1;
        self.paste_counter += 1;
        let tag = format!(
            "[Paste {}: {} {}]",
            self.paste_counter,
            line_count,
            pluralize(line_count, "line")
        );
        self.attachments.push(Attachment::PastedText {
            tag,
            text: normalized,
            line_count,
        });
        self.attachments.last().expect("just pushed attachment")
    }

    pub fn attach_file(&mut self, path: impl AsRef<Path>) -> Result<&Attachment> {
        let path = path.as_ref();
        let mime_type = mime_type_for_path(path).to_string();
        let is_image = is_image_mime(&mime_type);
        let bytes =
            fs::read(path).with_context(|| format!("read attachment file {}", path.display()))?;
        let basename = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_else(|| path.to_str().unwrap_or("file"));

        if is_image {
            self.image_counter += 1;
            let tag = format!("[Image {}: {basename}]", self.image_counter);
            self.attachments.push(Attachment::File {
                tag,
                path: path.display().to_string(),
                mime_type,
                data: Some(STANDARD.encode(bytes)),
                is_image: true,
            });
        } else {
            self.file_counter += 1;
            let tag = format!("[File {}: {basename}]", self.file_counter);
            self.attachments.push(Attachment::File {
                tag,
                path: path.display().to_string(),
                mime_type,
                data: None,
                is_image: false,
            });
        }

        self.attachments
            .last()
            .ok_or_else(|| anyhow!("attachment was not recorded"))
    }

    pub fn remove_at_tag(&mut self, tag: &str) -> bool {
        let Some(idx) = self.attachments.iter().position(|att| att.tag() == tag) else {
            return false;
        };
        self.attachments.remove(idx);
        true
    }

    pub fn extract_images_for_prompt(&self) -> Vec<Value> {
        self.attachments
            .iter()
            .filter_map(|attachment| match attachment {
                Attachment::Image {
                    data, mime_type, ..
                } => Some(image_value(data, mime_type)),
                Attachment::File {
                    data: Some(data),
                    mime_type,
                    is_image: true,
                    ..
                } => Some(image_value(data, mime_type)),
                _ => None,
            })
            .collect()
    }

    pub fn clear(&mut self) {
        self.attachments.clear();
        self.image_counter = 0;
        self.paste_counter = 0;
        self.file_counter = 0;
    }

    pub fn set_attachments(&mut self, attachments: Vec<Attachment>) {
        self.attachments = attachments;
        self.image_counter = max_tag_counter(&self.attachments, "[Image ");
        self.paste_counter = max_tag_counter(&self.attachments, "[Paste ");
        self.file_counter = max_tag_counter(&self.attachments, "[File ");
    }

    pub fn has_attachments(&self) -> bool {
        !self.attachments.is_empty()
    }

    pub fn attachments(&self) -> &[Attachment] {
        &self.attachments
    }

    pub fn retain(&mut self, mut keep: impl FnMut(&Attachment) -> bool) {
        self.attachments.retain(|attachment| keep(attachment));
    }

    pub fn counts(&self) -> AttachmentCounts {
        let mut counts = AttachmentCounts::default();
        for attachment in &self.attachments {
            match attachment {
                Attachment::Image { .. } => counts.images += 1,
                Attachment::PastedText { .. } => counts.pasted_texts += 1,
                Attachment::File { is_image, .. } if *is_image => counts.images += 1,
                Attachment::File { .. } => counts.files += 1,
            }
        }
        counts
    }

    pub fn image_tags_in_text(&self, text: &str) -> Vec<(usize, usize)> {
        let mut ranges = Vec::new();
        for attachment in &self.attachments {
            let tag = attachment.tag();
            let mut search_from = 0usize;
            while let Some(rel) = text[search_from..].find(tag) {
                let start = search_from + rel;
                let end = start + tag.len();
                ranges.push((start, end));
                search_from = end;
                if search_from >= text.len() {
                    break;
                }
            }
        }
        ranges.sort_by_key(|(start, _)| *start);
        ranges
    }
}

fn image_value(data: &str, mime_type: &str) -> Value {
    json!({
        "type": "image",
        "source": {
            "type": "base64",
            "mediaType": mime_type,
            "data": data,
        },
    })
}

pub fn is_image_path(path: impl AsRef<Path>) -> bool {
    is_image_mime(mime_type_for_path(path.as_ref()))
}

pub fn mime_type_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("svg") => "image/svg+xml",
        Some("txt") | Some("md") | Some("rs") | Some("ts") | Some("tsx") | Some("js")
        | Some("jsx") | Some("json") | Some("toml") | Some("yaml") | Some("yml") | Some("css")
        | Some("html") | Some("xml") | Some("sh") | Some("py") => "text/plain",
        _ => "application/octet-stream",
    }
}

fn is_image_mime(mime_type: &str) -> bool {
    matches!(
        mime_type,
        "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/bmp" | "image/svg+xml"
    )
}

fn pluralize(count: usize, singular: &str) -> &str {
    if count == 1 {
        singular
    } else {
        match singular {
            "paste" => "pastes",
            "image" => "images",
            "file" => "files",
            "line" => "lines",
            _ => singular,
        }
    }
}

fn max_tag_counter(attachments: &[Attachment], prefix: &str) -> usize {
    attachments
        .iter()
        .filter_map(|attachment| parse_tag_counter(attachment.tag(), prefix))
        .max()
        .unwrap_or(0)
}

fn parse_tag_counter(tag: &str, prefix: &str) -> Option<usize> {
    let suffix = tag.strip_prefix(prefix)?;
    let digits: String = suffix
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .collect();
    (!digits.is_empty()).then(|| digits.parse().ok()).flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(name: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("pix-tui-attachment-{unique}"));
        fs::create_dir_all(&dir).expect("create temp attachment dir");
        dir.join(name)
    }

    #[test]
    fn attach_image_creates_tag() {
        let mut manager = AttachmentManager::new();
        let attachment = manager.attach_image("abc", "image/png");
        assert_eq!(attachment.tag(), "[Image 1]");
        assert!(manager.has_attachments());
    }

    #[test]
    fn attach_pasted_text_creates_tag() {
        let mut manager = AttachmentManager::new();
        let attachment = manager.attach_pasted_text("a\nb\nc");
        assert_eq!(attachment.tag(), "[Paste 1: 3 lines]");
        assert!(matches!(
            attachment,
            Attachment::PastedText { line_count: 3, .. }
        ));
    }

    #[test]
    fn attach_file_image_creates_image_attachment() {
        let path = temp_path("image.png");
        fs::write(&path, b"not really png").expect("write");
        let mut manager = AttachmentManager::new();
        let attachment = manager.attach_file(&path).expect("attach");
        assert_eq!(attachment.tag(), "[Image 1: image.png]");
        assert!(matches!(
            attachment,
            Attachment::File {
                is_image: true,
                data: Some(_),
                ..
            }
        ));
        fs::remove_file(path).ok();
    }

    #[test]
    fn attach_file_text_creates_file_attachment() {
        let path = temp_path("note.txt");
        fs::write(&path, b"hello").expect("write");
        let mut manager = AttachmentManager::new();
        let attachment = manager.attach_file(&path).expect("attach");
        assert!(attachment.tag().starts_with("[File 1: "));
        assert!(attachment.tag().contains("note.txt"));
        assert!(matches!(
            attachment,
            Attachment::File {
                is_image: false,
                data: None,
                ..
            }
        ));
        fs::remove_file(path).ok();
    }

    #[test]
    fn extract_images_for_prompt_includes_all_images() {
        let path = temp_path("image.jpg");
        fs::write(&path, b"jpeg").expect("write");
        let mut manager = AttachmentManager::new();
        manager.attach_image("direct", "image/png");
        manager.attach_file(&path).expect("attach");
        manager.attach_pasted_text("a\nb");
        let images = manager.extract_images_for_prompt();
        assert_eq!(images.len(), 2);
        assert_eq!(images[0]["source"]["data"], "direct");
        assert_eq!(images[1]["source"]["mediaType"], "image/jpeg");
        fs::remove_file(path).ok();
    }

    #[test]
    fn remove_at_tag_removes_correct_one() {
        let mut manager = AttachmentManager::new();
        manager.attach_image("one", "image/png");
        manager.attach_image("two", "image/png");
        assert!(manager.remove_at_tag("[Image 1]"));
        assert_eq!(manager.attachments().len(), 1);
        assert_eq!(manager.attachments()[0].tag(), "[Image 2]");
    }

    #[test]
    fn image_tags_in_text_finds_ranges() {
        let mut manager = AttachmentManager::new();
        let image_tag = manager.attach_image("one", "image/png").tag().to_string();
        let paste_tag = manager.attach_pasted_text("a\nb").tag().to_string();
        let line = format!("x {image_tag} y {paste_tag}");
        assert_eq!(
            manager.image_tags_in_text(&line),
            vec![
                (2, 2 + image_tag.len()),
                (5 + image_tag.len(), 5 + image_tag.len() + paste_tag.len())
            ]
        );
    }

    #[test]
    fn clear_resets_counters() {
        let mut manager = AttachmentManager::new();
        manager.attach_image("one", "image/png");
        manager.attach_pasted_text("a\nb");
        let path = temp_path("note.txt");
        fs::write(&path, b"hello").expect("write");
        manager.attach_file(&path).expect("attach");
        manager.clear();
        let attachment = manager.attach_image("two", "image/png");
        assert_eq!(attachment.tag(), "[Image 1]");
        let attachment = manager.attach_pasted_text("x");
        assert_eq!(attachment.tag(), "[Paste 1: 1 line]");
        let attachment = manager.attach_file(&path).expect("attach");
        assert_eq!(attachment.tag(), "[File 1: note.txt]");
        fs::remove_file(path).ok();
    }

    #[test]
    fn multiple_images_have_distinct_tags() {
        let mut manager = AttachmentManager::new();
        let first = manager.attach_image("one", "image/png").tag().to_string();
        let second = manager.attach_image("two", "image/png").tag().to_string();
        assert_eq!(first, "[Image 1]");
        assert_eq!(second, "[Image 2]");
    }

    #[test]
    fn duplicate_basenames_still_get_unique_file_tags() {
        let path_one = temp_path("note.txt");
        let path_two = temp_path("note.txt");
        fs::write(&path_one, b"one").expect("write");
        fs::write(&path_two, b"two").expect("write");

        let mut manager = AttachmentManager::new();
        let first = manager
            .attach_file(&path_one)
            .expect("attach")
            .tag()
            .to_string();
        let second = manager
            .attach_file(&path_two)
            .expect("attach")
            .tag()
            .to_string();

        assert_eq!(first, "[File 1: note.txt]");
        assert_eq!(second, "[File 2: note.txt]");

        fs::remove_file(path_one).ok();
        fs::remove_file(path_two).ok();
    }

    #[test]
    fn counts_summarize_attachment_mix() {
        let path = temp_path("note.txt");
        fs::write(&path, b"hello").expect("write");

        let mut manager = AttachmentManager::new();
        manager.attach_image("one", "image/png");
        manager.attach_file(&path).expect("attach");
        manager.attach_pasted_text("a\nb");

        let counts = manager.counts();
        assert_eq!(counts.images, 1);
        assert_eq!(counts.files, 1);
        assert_eq!(counts.pasted_texts, 1);
        assert_eq!(counts.total(), 3);
        assert_eq!(
            counts.summary().as_deref(),
            Some("1 image · 1 file · 1 paste")
        );

        fs::remove_file(path).ok();
    }
}
