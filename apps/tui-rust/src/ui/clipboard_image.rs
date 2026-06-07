//! Clipboard image import for prompt attachments.

use std::io::Cursor;

use anyhow::{anyhow, Context, Result};
use arboard::Clipboard;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::codecs::png::PngEncoder;
use image::imageops::FilterType;
use image::{ColorType, DynamicImage, ImageBuffer, ImageEncoder, Rgba};

const MAX_IMAGE_DIMENSION: u32 = 2000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClipboardImage {
    pub data: String,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    pub resized: bool,
}

pub fn read_clipboard_image() -> Result<Option<ClipboardImage>> {
    let mut clipboard = Clipboard::new().map_err(|e| {
        anyhow!("could not access system clipboard ({e}); is a desktop display server available?")
    })?;

    let image = match clipboard.get_image() {
        Ok(image) => image,
        Err(arboard::Error::ContentNotAvailable) => return Ok(None),
        Err(e) => return Err(anyhow!("could not read image from clipboard: {e}")),
    };

    let width = u32::try_from(image.width).context("clipboard image width too large")?;
    let height = u32::try_from(image.height).context("clipboard image height too large")?;
    encode_clipboard_image(width, height, image.bytes.into_owned())
}

fn encode_clipboard_image(
    width: u32,
    height: u32,
    bytes: Vec<u8>,
) -> Result<Option<ClipboardImage>> {
    let rgba = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_raw(width, height, bytes)
        .ok_or_else(|| anyhow!("clipboard image had invalid RGBA dimensions"))?;
    let mut dynamic = DynamicImage::ImageRgba8(rgba);
    let mut resized = false;

    if width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION {
        resized = true;
        dynamic = dynamic.resize(
            MAX_IMAGE_DIMENSION,
            MAX_IMAGE_DIMENSION,
            FilterType::Lanczos3,
        );
    }

    let rgba = dynamic.to_rgba8();
    let mut png_bytes = Vec::new();
    {
        let mut cursor = Cursor::new(&mut png_bytes);
        let encoder = PngEncoder::new(&mut cursor);
        encoder
            .write_image(
                rgba.as_raw(),
                rgba.width(),
                rgba.height(),
                ColorType::Rgba8.into(),
            )
            .context("encode clipboard image as png")?;
    }

    Ok(Some(ClipboardImage {
        data: STANDARD.encode(png_bytes),
        mime_type: "image/png".to_string(),
        width: rgba.width(),
        height: rgba.height(),
        resized,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_clipboard_image_preserves_small_dimensions() {
        let image = encode_clipboard_image(32, 12, vec![255; 32 * 12 * 4])
            .expect("encode")
            .expect("image");

        assert_eq!(image.width, 32);
        assert_eq!(image.height, 12);
        assert!(!image.resized);
        assert_eq!(image.mime_type, "image/png");
        assert!(!image.data.is_empty());
    }

    #[test]
    fn encode_clipboard_image_resizes_large_images() {
        let image = encode_clipboard_image(3_001, 10, vec![255; 3_001 * 10 * 4])
            .expect("encode")
            .expect("image");

        assert!(image.resized);
        assert_eq!(image.width, 2_000);
        assert!(image.height <= 10);
    }
}
