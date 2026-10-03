//! Close/quit confirmation belongs in the native event path: macOS Cmd+Q does
//! not dispatch a WebView close event. No resources are torn down before consent.
use std::{collections::HashSet, sync::Mutex};
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[derive(Default)]
pub(crate) struct CloseGuardState(Mutex<CloseGuard>);

#[derive(Default)]
struct CloseGuard {
    running_windows: HashSet<String>,
    pending: bool,
    quit_approved: bool,
}

#[derive(Debug, PartialEq)]
enum Action {
    Allow,
    Ask,
    Wait,
}

impl CloseGuard {
    fn request(&mut self, window: Option<&str>) -> Action {
        if self.pending {
            return Action::Wait;
        }
        if window.is_none() && self.quit_approved {
            self.quit_approved = false;
            return Action::Allow;
        }
        let running = window.map_or(!self.running_windows.is_empty(), |label| {
            self.running_windows.contains(label)
        });
        if !running {
            return Action::Allow;
        }
        self.pending = true;
        Action::Ask
    }
}

#[tauri::command]
pub(crate) fn desktop_set_running_activity(
    window: WebviewWindow,
    state: tauri::State<'_, CloseGuardState>,
    running: bool,
) {
    let mut guard = state.0.lock().unwrap();
    if running {
        guard.running_windows.insert(window.label().into());
    } else {
        guard.running_windows.remove(window.label());
    }
}

pub(crate) fn destroyed(app: &AppHandle, label: &str) {
    app.state::<CloseGuardState>()
        .0
        .lock()
        .unwrap()
        .running_windows
        .remove(label);
}

/// Returns true when the native request must be prevented. The async native
/// warning resumes the request only after an explicit affirmative response.
pub(crate) fn prevent(app: &AppHandle, label: Option<&str>, exit_code: Option<i32>) -> bool {
    let action = app
        .state::<CloseGuardState>()
        .0
        .lock()
        .unwrap()
        .request(label);
    match action {
        Action::Allow => return false,
        Action::Wait => return true,
        Action::Ask => {}
    }
    let window = label.and_then(|label| app.get_webview_window(label));
    let quitting = label.is_none();
    let mut dialog = app.dialog().message(if quitting {
        "Conversations are still running. Quitting Pix will stop all active runs in all windows."
    } else {
        "Conversations are still running in this window. Closing it will stop their active runs."
    }).title(if quitting { "Quit with active runs?" } else { "Close running window?" })
      .kind(MessageDialogKind::Warning)
      .buttons(MessageDialogButtons::OkCancelCustom(
          if quitting { "Quit Pix" } else { "Close window" }.into(), "Cancel".into(),
      ));
    // Attach to the affected window when possible. Quit is application-wide.
    if let Some(window) = &window {
        dialog = dialog.parent(window);
    }
    let app = app.clone();
    dialog.show(move |confirmed| {
        {
            let state = app.state::<CloseGuardState>();
            let mut guard = state.0.lock().unwrap();
            guard.pending = false;
            if confirmed && quitting {
                guard.quit_approved = true;
            }
        }
        if !confirmed {
            return;
        }
        if quitting {
            app.exit(exit_code.unwrap_or(0));
        } else if let Some(window) = window {
            // Consent has been obtained; avoid another CloseRequested dialog.
            if let Err(error) = window.destroy() {
                eprintln!("failed to close confirmed window: {error}");
            }
        }
    });
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_and_other_windows_close_without_warning() {
        let mut guard = CloseGuard::default();
        assert_eq!(guard.request(None), Action::Allow);
        guard.running_windows.insert("project-1".into());
        assert_eq!(guard.request(Some("main")), Action::Allow);
        assert_eq!(guard.request(Some("project-1")), Action::Ask);
    }

    #[test]
    fn quit_includes_background_windows_and_coalesces_requests() {
        let mut guard = CloseGuard::default();
        guard.running_windows.insert("project-1".into());
        assert_eq!(guard.request(None), Action::Ask);
        assert_eq!(guard.request(None), Action::Wait);
        assert_eq!(guard.request(Some("main")), Action::Wait);
        // Cancel leaves activity and future protection intact.
        guard.pending = false;
        assert_eq!(guard.request(None), Action::Ask);
        guard.pending = false;
        guard.quit_approved = true;
        assert_eq!(guard.request(None), Action::Allow);
        assert_eq!(guard.request(None), Action::Ask);
    }

    #[test]
    fn settled_or_destroyed_windows_no_longer_block_quit() {
        let mut guard = CloseGuard::default();
        guard.running_windows.insert("main".into());
        guard.running_windows.remove("main");
        assert_eq!(guard.request(None), Action::Allow);
    }
}
