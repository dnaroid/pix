//! Explicit app-menu equivalents for window cycling in accessory presentation.
//! Regular-policy apps retain AppKit's default cycling behavior.

#[cfg(any(target_os = "macos", test))]
fn destination(mut labels: Vec<String>, current: &str, reverse: bool) -> Option<String> {
    labels.sort();
    labels.dedup();
    if labels.len() < 2 {
        return None;
    }
    let index = labels.iter().position(|label| label == current)?;
    let offset = if reverse { labels.len() - 1 } else { 1 };
    Some(labels[(index + offset) % labels.len()].clone())
}

#[cfg(target_os = "macos")]
mod native {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSWindow};
    use tauri::{
        menu::{MenuItem, WINDOW_SUBMENU_ID},
        AppHandle, Manager,
    };

    const NEXT_ID: &str = "pix.window.next";
    const PREVIOUS_ID: &str = "pix.window.previous";

    pub(super) fn install(app: &AppHandle) -> Result<(), String> {
        let menu = app.menu().ok_or("Pix main menu is unavailable")?;
        let submenu = menu
            .get(WINDOW_SUBMENU_ID)
            .and_then(|item| item.as_submenu().cloned())
            .ok_or("Pix Window menu is unavailable")?;
        if submenu.get(NEXT_ID).is_some() {
            return Ok(());
        }
        let next = MenuItem::with_id(app, NEXT_ID, "Next Pix window", true, Some("Cmd+Backquote"))
            .map_err(|error| error.to_string())?;
        let previous = MenuItem::with_id(
            app,
            PREVIOUS_ID,
            "Previous Pix window",
            true,
            Some("Cmd+Shift+Backquote"),
        )
        .map_err(|error| error.to_string())?;
        submenu.append(&next).map_err(|error| error.to_string())?;
        if let Err(error) = submenu.append(&previous) {
            let _ = submenu.remove(&next);
            return Err(error.to_string());
        }
        app.on_menu_event(|app, event| match event.id().as_ref() {
            NEXT_ID => cycle(app, false),
            PREVIOUS_ID => cycle(app, true),
            _ => {}
        });
        Ok(())
    }

    fn cycle(app: &AppHandle, reverse: bool) {
        if app
            .state::<crate::AcpProcessState>()
            .exiting
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return;
        }
        let Some(main_thread) = MainThreadMarker::new() else {
            return;
        };
        let application = NSApplication::sharedApplication(main_thread);
        if !application.isActive() {
            return;
        }
        let Some(key_window) = application.keyWindow() else {
            return;
        };
        let mut candidates = Vec::new();
        let mut current = None;
        for (label, window) in app.webview_windows() {
            let Ok(pointer) = window.ns_window() else {
                continue;
            };
            // SAFETY: the live WebviewWindow owns this NSWindow throughout the
            // synchronous main-thread check. Never store the native pointer.
            let Some(native) = (unsafe { pointer.cast::<NSWindow>().as_ref() }) else {
                continue;
            };
            if !native.isVisible() || native.isMiniaturized() {
                continue;
            }
            if std::ptr::eq(native, &*key_window) {
                current = Some(label.clone());
            }
            candidates.push(label);
        }
        let Some(current) = current else {
            return;
        };
        if let Some(label) = super::destination(candidates, &current, reverse) {
            if let Some(window) = app.get_webview_window(&label) {
                crate::desktop_notification::foreground_window(&window);
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn install(app: &tauri::AppHandle) -> Result<(), String> {
    native::install(app)
}

#[cfg(test)]
mod tests {
    use super::destination;

    fn labels(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).into()).collect()
    }

    #[test]
    fn deterministic_ring_cycles_both_directions_and_wraps() {
        let windows = labels(&["project-b", "main", "project-a"]);
        assert_eq!(
            destination(windows.clone(), "main", false).as_deref(),
            Some("project-a")
        );
        assert_eq!(
            destination(windows.clone(), "main", true).as_deref(),
            Some("project-b")
        );
        assert_eq!(
            destination(windows.clone(), "project-b", false).as_deref(),
            Some("main")
        );
        assert_eq!(
            destination(windows, "project-b", true).as_deref(),
            Some("project-a")
        );
    }

    #[test]
    fn noop_for_missing_owner_or_fewer_than_two_live_candidates() {
        assert_eq!(destination(vec![], "main", false), None);
        assert_eq!(destination(labels(&["main"]), "main", true), None);
        assert_eq!(destination(labels(&["main", "main"]), "main", false), None);
        assert_eq!(destination(labels(&["a", "b"]), "closed", false), None);
    }
}
