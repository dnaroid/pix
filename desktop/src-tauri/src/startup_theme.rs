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
    // Temporary QA uses incognito; explicit persistent QA uses its own UUID store.
    // Neither may fall back to the working app's default WKWebView store.
    let builder = crate::qa_profile::configure_webview(manager, builder);
    // Let WebKit negotiate native file drops with DOM destinations. Wry's
    // interception forces Copy and omits the modifier state needed for Cmd-Move.
    #[cfg(target_os = "macos")]
    let builder = builder.disable_drag_drop_handler();
    let window = builder
        .visible(false)
        .on_navigation(allow_workbench_navigation)
        .on_page_load(move |window, payload| {
            #[cfg(target_os = "macos")]
            if matches!(payload.event(), PageLoadEvent::Started)
                && matches!(payload.url().scheme(), "tauri" | "http")
            {
                crate::project_entry_drag_destination::reset(window.label());
            }
            if claim_initial_reveal(payload.event(), visible, &revealed) {
                reveal(window.clone());
            }
        })
        .build()?;
    #[cfg(target_os = "macos")]
    crate::project_entry_drag_destination::install(&window)?;
    Ok(window)
}

fn claim_initial_reveal(event: PageLoadEvent, visible: bool, revealed: &AtomicBool) -> bool {
    matches!(event, PageLoadEvent::Finished) && visible && !revealed.swap(true, Ordering::Relaxed)
}

fn reveal(window: WebviewWindow) {
    let app = window.app_handle().clone();
    if let Err(error) = app.run_on_main_thread(move || {
        if window
            .state::<crate::AcpProcessState>()
            .exiting
            .load(Ordering::Acquire)
        {
            return;
        }
        apply_to(&window);
        if let Err(error) = window.show() {
            crate::logging::error(
                module_path!(),
                format!("failed to show the Pix startup window: {error}"),
            );
            return;
        }
        // Showing a previously hidden window alone does not activate Pix. Each
        // restored window must be ordered forward once its document is ready.
        #[cfg(target_os = "macos")]
        if !crate::desktop_notification::foreground_window(&window) {
            crate::logging::error(
                module_path!(),
                format!("failed to foreground the Pix startup window"),
            );
        }
        #[cfg(not(target_os = "macos"))]
        if let Err(error) = window.set_focus() {
            crate::logging::error(
                module_path!(),
                format!("failed to focus the Pix startup window: {error}"),
            );
        }
    }) {
        crate::logging::error(
            module_path!(),
            format!("failed to dispatch the Pix startup reveal: {error}"),
        );
    }
}

fn apply_to(window: &WebviewWindow) {
    let theme = match window.theme() {
        Ok(theme) => theme,
        Err(error) => {
            crate::logging::error(
                module_path!(),
                format!("failed to resolve the Pix startup theme: {error}"),
            );
            return;
        }
    };

    if let Err(error) = window.set_background_color(Some(background_for(theme))) {
        crate::logging::error(
            module_path!(),
            format!("failed to set the Pix startup background: {error}"),
        );
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
    fn restored_windows_each_claim_their_own_initial_reveal() {
        let windows = [AtomicBool::new(false), AtomicBool::new(false)];
        for window in &windows {
            assert!(claim_initial_reveal(PageLoadEvent::Finished, true, window));
        }
        for window in &windows {
            assert!(!claim_initial_reveal(PageLoadEvent::Finished, true, window));
        }
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
            assert!(
                !allow_workbench_navigation(&Url::parse(denied).unwrap()),
                "{denied}"
            );
        }
        for allowed in [
            "about:blank",
            "about:srcdoc",
            "tauri://localhost/index.html",
        ] {
            assert!(
                allow_workbench_navigation(&Url::parse(allowed).unwrap()),
                "{allowed}"
            );
        }
        assert_eq!(
            allow_workbench_navigation(&Url::parse("http://127.0.0.1:1420/index.html").unwrap()),
            cfg!(debug_assertions)
        );
    }
}
