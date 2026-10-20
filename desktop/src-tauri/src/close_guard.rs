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
    restart_blocking_windows: HashSet<String>,
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
    fn request_restart(&mut self) -> Action {
        let action = if self.pending {
            Action::Wait
        } else if self.restart_blocking_windows.is_empty() {
            Action::Allow
        } else {
            self.pending = true;
            Action::Ask
        };
        if action == Action::Allow {
            self.pending = true;
        }
        action
    }

    fn finish_restart(&mut self, requested: bool) {
        self.pending = false;
        self.quit_approved = requested;
    }

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
    restart_blocking: Option<bool>,
) {
    let mut guard = state.0.lock().unwrap();
    if running {
        guard.running_windows.insert(window.label().into());
    } else {
        guard.running_windows.remove(window.label());
    }
    if running && restart_blocking.unwrap_or(running) {
        guard.restart_blocking_windows.insert(window.label().into());
    } else {
        guard.restart_blocking_windows.remove(window.label());
    }
}

pub(crate) fn destroyed(app: &AppHandle, label: &str) {
    let state = app.state::<CloseGuardState>();
    let mut guard = state.0.lock().unwrap();
    guard.running_windows.remove(label);
    guard.restart_blocking_windows.remove(label);
}

/// Watch restarts must obtain consent before publishing the restart marker.
/// Returning false also covers another close/quit dialog already being open.
pub(crate) async fn confirm_restart(app: &AppHandle) -> bool {
    let action = app
        .state::<CloseGuardState>()
        .0
        .lock()
        .unwrap()
        .request_restart();
    match action {
        Action::Allow => return true,
        Action::Wait => return false,
        Action::Ask => {}
    }
    let (send, receive) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    show_confirmation(app, None, move |confirmed| {
        // Keep ownership through marker publication so another quit cannot
        // insert a second confirmation between consent and the actual exit.
        let state = handle.state::<CloseGuardState>();
        let mut guard = state.0.lock().unwrap();
        let delivered = send.send(confirmed).is_ok();
        if !confirmed || !delivered {
            guard.finish_restart(false);
        }
    });
    receive.await.unwrap_or(false)
}

/// Release the reservation, approving exit only after marker publication.
pub(crate) fn finish_restart(app: &AppHandle, requested: bool) {
    app.state::<CloseGuardState>()
        .0
        .lock()
        .unwrap()
        .finish_restart(requested);
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
    let handle = app.clone();
    show_confirmation(app, label, move |confirmed| {
        let app = handle;
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
                crate::logging::error(
                    module_path!(),
                    format!("failed to close confirmed window: {error}"),
                );
            }
        }
    });
    true
}

fn show_confirmation(
    app: &AppHandle,
    label: Option<&str>,
    respond: impl FnOnce(bool) + Send + 'static,
) {
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
    dialog.show(respond);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recoverable_question_waits_skip_restart_warning_but_not_quit_warning() {
        let mut guard = CloseGuard::default();
        guard.running_windows.insert("question-window".into());
        assert_eq!(guard.request_restart(), Action::Allow);
        assert_eq!(guard.request(None), Action::Wait);
        guard.finish_restart(false);
        assert_eq!(guard.request(None), Action::Ask);
        guard.pending = false;
        guard
            .restart_blocking_windows
            .insert("background-run".into());
        assert_eq!(guard.request_restart(), Action::Ask);
        guard.finish_restart(true);
        assert_eq!(guard.request(None), Action::Allow);
    }

    #[test]
    fn restart_reserves_quit_until_marker_publication_and_releases_failed_requests() {
        let mut guard = CloseGuard::default();
        assert_eq!(guard.request_restart(), Action::Allow);
        assert_eq!(guard.request(None), Action::Wait);
        guard.finish_restart(false);
        guard.running_windows.insert("main".into());
        guard.restart_blocking_windows.insert("main".into());
        assert_eq!(guard.request_restart(), Action::Ask);
        assert_eq!(guard.request_restart(), Action::Wait);
        // Cancellation leaves the next restart protected by confirmation.
        guard.finish_restart(false);
        assert_eq!(guard.request_restart(), Action::Ask);
        // Confirmed consent still owns the guard while writing the marker.
        assert_eq!(guard.request(None), Action::Wait);
        guard.finish_restart(true);
        assert_eq!(guard.request(None), Action::Allow);
        assert_eq!(guard.request(None), Action::Ask);
    }

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
