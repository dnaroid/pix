//! Selected 02 square-P silhouette, in its original 32×32 coordinates.
const SIZE: usize = 64;

fn glyph(x: f64, y: f64) -> bool {
    let outer = (4.0..12.0).contains(&x) && (4.0..28.0).contains(&y)
        || (12.0..24.0).contains(&x) && (4.0..24.0).contains(&y)
        || (24.0..28.0).contains(&x) && (8.0..20.0).contains(&y);
    outer && !((12.0..20.0).contains(&x) && (12.0..16.0).contains(&y))
}

pub(crate) fn rgba(attention: bool) -> Vec<u8> {
    let mut pixels = vec![0; SIZE * SIZE * 4];
    // Two samples per axis give the small circular badge a smooth edge.
    for y in 0..SIZE {
        for x in 0..SIZE {
            let mut color = [0_u32; 4];
            for dy in [0.25, 0.75] {
                for dx in [0.25, 0.75] {
                    let px = (x as f64 + dx) / 2.0;
                    let py = (y as f64 + dy) / 2.0;
                    let distance = (px - 26.0).powi(2) + (py - 25.0).powi(2);
                    let sample = if attention && distance <= 25.0 {
                        [255, 193, 90, 255] // #ffc15a, matching the chosen preview.
                    } else if glyph(px, py) && (!attention || distance >= 36.0) {
                        [255, 255, 255, 255]
                    } else {
                        [0; 4]
                    };
                    for i in 0..4 {
                        color[i] += sample[i];
                    }
                }
            }
            let alpha = color[3];
            if alpha > 0 {
                // Tauri expects straight, not premultiplied, RGBA.
                for i in 0..3 {
                    pixels[(y * SIZE + x) * 4 + i] = (color[i] * 255 / alpha) as u8;
                }
                pixels[(y * SIZE + x) * 4 + 3] = (alpha / 4) as u8;
            }
        }
    }
    pixels
}

#[cfg(target_os = "macos")]
pub(crate) fn image(attention: bool) -> tauri::image::Image<'static> {
    static ICONS: std::sync::OnceLock<[tauri::image::Image<'static>; 2]> =
        std::sync::OnceLock::new();
    ICONS.get_or_init(|| {
        [
            tauri::image::Image::new_owned(rgba(false), SIZE as u32, SIZE as u32),
            tauri::image::Image::new_owned(rgba(true), SIZE as u32, SIZE as u32),
        ]
    })[usize::from(attention)]
    .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pixel(pixels: &[u8], x: usize, y: usize) -> &[u8] {
        &pixels[(y * SIZE + x) * 4..(y * SIZE + x) * 4 + 4]
    }

    #[test]
    fn exact_square_p_is_white_with_transparent_hole_and_background() {
        let idle = rgba(false);
        for y in 0..SIZE {
            for x in 0..SIZE {
                assert_eq!(
                    pixel(&idle, x, y)[3] == 255,
                    glyph((x as f64 + 0.5) / 2.0, (y as f64 + 0.5) / 2.0)
                );
            }
        }
        assert_eq!(pixel(&idle, 10, 10), &[255; 4]);
        assert_eq!(pixel(&idle, 30, 26), &[0; 4]);
        assert_eq!(pixel(&idle, 0, 0), &[0; 4]);
        assert_eq!(pixel(&idle, 52, 50), &[0; 4]);
    }

    #[test]
    fn attention_adds_an_amber_dot_without_filling_the_hole() {
        let active = rgba(true);
        assert_eq!(pixel(&active, 52, 50), &[255, 193, 90, 255]);
        assert_eq!(pixel(&active, 10, 10), &[255; 4]);
        assert_eq!(pixel(&active, 30, 26), &[0; 4]);
        assert!(active.chunks_exact(4).any(|p| p[3] > 0 && p[3] < 255));
    }
}
