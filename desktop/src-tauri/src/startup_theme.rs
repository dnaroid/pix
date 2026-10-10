use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    webview::PageLoadEvent, window::Color, Manager, Theme, Url, WebviewWindow, WebviewWindowBuilder,
};

/// WKNavigationDelegate observes both top-level AND iframe navigations. The
/// HTML sandbox cannot rely on guest CSP alone to block `window.location`
/// requests: even "default-src 'none'" does not stop self-navigation.
/// Keep the workbench at its own origin and deny external navigations before
/// WebKit issues the request. Normal external links use the OS opener plugin.
fn allow_workbench_navigation(url: &Url) -> bool {
    match url.scheme() {
        "about" => matches!(url.as_str(), "about:blank" | "about:srcdoc"),
        "tauri" => url.host_str() == Some("localhost"),
        // The macOS dev workbench is served by Vite on this configured port.
        "http" if cfg!(debug_assertions) => {
            matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
                && url.port_or_known_default() == Some(1420)
        }
        _ => false,
    }
}

/// WKWebView's unpainted surface is white even when the native window is dark:
/// Tauri's background-color API does not cover the macOS webview layer.
/// Keep every creation path hidden until the document's startup CSS is loaded.
pub(crate) fn build(
    manager: &impl Manager<tauri::Wry>,
    config: &tauri::utils::config::WindowConfig,
) -> tauri::Result<WebviewWindow> {
    let visible = config.visible;
    let revealed = AtomicBool::new(false);
    let builder = WebviewWindowBuilder::from_config(manager, config)?;
    // WKWebView uses a non-persistent store, never the working app's store.
    // Apply this to restored, fallback and subsequently opened windows alike.
    let builder = if crate::qa_profile::isolated(manager) {
        builder.incognito(true)
    } else {
        builder
    };
    let window = builder
        .visible(false)
        .on_navigation(allow_workbench_navigation)
        .on_page_load(move |window, payload| {
            if claim_initial_reveal(payload.event(), visible, &revealed) {
                apply_to(&window);
                if let Err(error) = window.show() {
                    eprintln!("failed to show the Pix startup window: {error}");
                }
            }
        })
        .build()?;
    Ok(window)
}

fn claim_initial_reveal(event: PageLoadEvent, visible: bool, revealed: &AtomicBool) -> bool {
    matches!(event, PageLoadEvent::Finished) && visible && !revealed.swap(true, Ordering::Relaxed)
}

fn apply_to(window: &WebviewWindow) {
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

    #[test]
    fn window_is_revealed_only_after_the_first_finished_document() {
        let revealed = AtomicBool::new(false);
        assert!(!claim_initial_reveal(
            PageLoadEvent::Started,
            true,
            &revealed
        ));
        assert!(claim_initial_reveal(
            PageLoadEvent::Finished,
            true,
            &revealed
        ));
        // Reload/navigation must not reopen a window the user has since hidden.
        assert!(!claim_initial_reveal(
            PageLoadEvent::Started,
            true,
            &revealed
        ));
        assert!(!claim_initial_reveal(
            PageLoadEvent::Finished,
            true,
            &revealed
        ));
    }

    #[test]
    fn intentionally_hidden_windows_remain_hidden() {
        let revealed = AtomicBool::new(false);
        assert!(!claim_initial_reveal(
            PageLoadEvent::Started,
            false,
            &revealed
        ));
        assert!(!claim_initial_reveal(
            PageLoadEvent::Finished,
            false,
            &revealed
        ));
    }

    #[test]
    fn webview_navigation_blocks_external_urls_even_in_guest_frames() {
        for denied in [
            "https://example.com/leak?payload=secret",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,hello",
            "http://127.0.0.1:11111/leak",
            "https://tauri.localhost",
        ] {
            assert!(!allow_workbench_navigation(&Url::parse(denied).unwrap()), "{denied}");
        }
        for allowed in ["about:blank", "about:srcdoc", "tauri://localhost/index.html"] {
            assert!(allow_workbench_navigation(&Url::parse(allowed).unwrap()), "{allowed}");
        }
        assert_eq!(
            allow_workbench_navigation(&Url::parse("http://127.0.0.1:1420/index.html").unwrap()),
            cfg!(debug_assertions)
        );
    }
}
