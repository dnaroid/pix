use tauri::{window::Color, Theme, WebviewWindow};

pub(crate) fn apply_to(window: &WebviewWindow) {
    let theme = match window.theme() {
        Ok(theme) => theme,
        Err(error) => {
            eprintln!("failed to resolve the Pix startup theme: {error}");
            return;
        }
    };

    if let Err(error) = window.set_background_color(Some(background_for(theme))) {
        eprintln!("failed to set the Pix startup background: {error}");
    }
}

fn background_for(theme: Theme) -> Color {
    match theme {
        Theme::Dark => Color(0x0f, 0x11, 0x15, 0xff),
        Theme::Light => Color(0xfa, 0xf9, 0xf5, 0xff),
        _ => Color(0xfa, 0xf9, 0xf5, 0xff),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_background_matches_the_desktop_theme_palette() {
        assert_eq!(background_for(Theme::Light), Color(0xfa, 0xf9, 0xf5, 0xff));
        assert_eq!(background_for(Theme::Dark), Color(0x0f, 0x11, 0x15, 0xff));
    }
}
