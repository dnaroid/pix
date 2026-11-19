//! App-menu entry "Open Project Supervisor" (0077). The item only forwards an
//! event to the focused Pix window; that window's frontend opens (or reopens)
//! the project supervisor session for its own workspace.

pub(crate) const MENU_ID: &str = "pix-open-supervisor";
/// Webview event received by `desktop/src/app/supervisor-session.ts` wiring.
pub(crate) const EVENT: &str = "pix-open-supervisor";

/// Picks the window that should receive the request: the focused one, else
/// the first visible one in label order (deterministic).
pub(crate) fn target_label(windows: &[(String, bool, bool)]) -> Option<String> {
    let mut sorted: Vec<&(String, bool, bool)> = windows.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    sorted
        .iter()
        .find(|(_, focused, _)| *focused)
        .or_else(|| sorted.iter().find(|(_, _, visible)| *visible))
        .map(|(label, _, _)| label.clone())
}

#[cfg(target_os = "macos")]
pub(crate) fn setup(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::MenuItem;
    use tauri::{Emitter, EventTarget, Manager};
    let Some(menu) = app.menu() else {
        return Ok(());
    };
    if let Some(submenu) = menu.items()?.first().and_then(|item| item.as_submenu()) {
        // After "About", separator and "Arrange windows" (window_tiling).
        submenu.insert(
            &MenuItem::with_id(app, MENU_ID, "Open Project Supervisor", true, None::<&str>)?,
            3,
        )?;
    }
    app.on_menu_event(|app, event| {
        if event.id().as_ref() != MENU_ID {
            return;
        }
        let windows = app
            .webview_windows()
            .into_iter()
            .filter(|(label, _)| !crate::image_viewer::is_viewer(label))
            .map(|(label, window)| {
                let focused = window.is_focused().unwrap_or(false);
                let visible = window.is_visible().unwrap_or(false);
                (label, focused, visible)
            })
            .collect::<Vec<_>>();
        let Some(label) = target_label(&windows) else {
            crate::logging::error(
                module_path!(),
                "no Pix window for Open Project Supervisor".into(),
            );
            return;
        };
        if let Err(error) = app.emit_to(EventTarget::webview_window(&label), EVENT, ()) {
            crate::logging::error(
                module_path!(),
                format!("failed to request the project supervisor: {error}"),
            );
        }
    });
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn setup(_app: &tauri::App) -> tauri::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::target_label;

    fn w(label: &str, focused: bool, visible: bool) -> (String, bool, bool) {
        (label.to_string(), focused, visible)
    }

    #[test]
    fn prefers_focused_then_first_visible_window() {
        assert_eq!(
            target_label(&[w("b", false, true), w("c", true, true)]),
            Some("c".into())
        );
        assert_eq!(
            target_label(&[
                w("c", false, true),
                w("b", false, true),
                w("a", false, false)
            ]),
            Some("b".into())
        );
        assert_eq!(target_label(&[w("a", false, false)]), None);
    }
}
