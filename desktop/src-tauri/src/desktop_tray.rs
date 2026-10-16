//! Optional macOS menu-bar icon. One process-wide icon, no timers or hidden
//! window ownership; closing the last window retains the normal quit behavior.

#[cfg(any(target_os = "macos", test))]
fn tray_enabled(source: &str) -> Result<bool, String> {
    let value: serde_json::Value = serde_json::from_str(&crate::normalize_jsonc(source)?)
        .map_err(|error| error.to_string())?;
    // Retain the original preference key for existing installations. It now
    // enables only the icon, never accessory presentation or Dock suppression.
    Ok(value
        .pointer("/desktop/trayOnly")
        .and_then(|value| value.as_bool())
        == Some(true))
}

#[cfg(any(target_os = "macos", test))]
fn window_entries(
    mut windows: Vec<(String, String)>,
    attention: &[String],
) -> Vec<(String, String)> {
    for (_, title) in &mut windows {
        if let Some(workspace) = title
            .strip_prefix("Pix — ")
            .or_else(|| title.strip_prefix("Pix - "))
        {
            *title = workspace.to_owned();
        }
    }
    // A native title can be shared by multiple windows. Keep every label and
    // disambiguate duplicate titles without making menu ids depend on copy.
    windows.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
    windows
        .iter()
        .map(|(label, title)| {
            let mut text = if windows.iter().filter(|(_, other)| other == title).count() > 1 {
                format!("{title} ({label})")
            } else {
                title.clone()
            };
            // Mark unseen attention without changing sort order or menu ids.
            if attention.contains(label) {
                text = format!("● {text}");
            }
            (format!("pix.tray.window.{label}"), text)
        })
        .collect()
}

#[cfg(target_os = "macos")]
mod native {
    use tauri::{
        menu::{Menu, MenuItem, PredefinedMenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
        AppHandle, Manager,
    };

    const TRAY_ID: &str = "pix.tray";
    const QUIT_ID: &str = "pix.tray.quit";
    const SHOW_ALL_ID: &str = "pix.tray.show-all";
    const ARRANGE_ID: &str = "pix.tray.arrange";

    fn exiting(app: &AppHandle) -> bool {
        app.state::<crate::AcpProcessState>()
            .exiting
            .load(std::sync::atomic::Ordering::Acquire)
    }

    fn attention_labels(app: &AppHandle) -> Vec<String> {
        let live = app
            .webview_windows()
            .into_iter()
            .filter_map(|(label, window)| window.ns_view().ok().map(|view| (label, view as usize)))
            .collect::<Vec<_>>();
        app.state::<crate::desktop_tray_attention::State>()
            .0
            .lock()
            .map(|mut state| state.snapshot(&live))
            .unwrap_or_default()
    }

    fn attention(app: &AppHandle) -> bool {
        !attention_labels(app).is_empty()
    }

    fn update_icon(app: &AppHandle) -> tauri::Result<()> {
        if let Some(tray) = app.tray_by_id(TRAY_ID) {
            tray.set_icon(Some(crate::desktop_tray_icon::image(attention(app))))?;
        }
        Ok(())
    }

    // Menu entries carry per-window attention markers, so attention changes
    // rebuild the menu, not only the icon.
    fn update_menu(app: &AppHandle) -> tauri::Result<()> {
        if let Some(tray) = app.tray_by_id(TRAY_ID) {
            tray.set_menu(Some(menu(app)?))?;
        }
        Ok(())
    }

    fn show_all(app: &AppHandle) {
        raise_windows(app.webview_windows().into_iter().collect());
    }

    fn raise_windows(mut windows: Vec<(String, tauri::WebviewWindow)>) {
        // Restore every window but keep the previously focused owner on top.
        windows
            .sort_by_key(|(label, window)| (window.is_focused().unwrap_or(false), label.clone()));
        for (_, window) in windows {
            crate::desktop_notification::foreground_window(&window);
        }
    }

    fn is_show_all_click(event: &TrayIconEvent) -> bool {
        matches!(
            event,
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
        )
    }

    fn menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
        let menu = Menu::new(app)?;
        menu.append(&MenuItem::with_id(
            app,
            SHOW_ALL_ID,
            "Show all windows",
            true,
            None::<&str>,
        )?)?;
        menu.append(&MenuItem::with_id(
            app,
            ARRANGE_ID,
            "Arrange windows",
            true,
            None::<&str>,
        )?)?;
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        let attention = attention_labels(app);
        let entries = super::window_entries(
            app.webview_windows()
                .into_iter()
                .map(|(label, window)| (label, window.title().unwrap_or_else(|_| "Pix".into())))
                .collect(),
            &attention,
        );
        for (id, title) in entries {
            menu.append(&MenuItem::with_id(app, id, title, true, None::<&str>)?)?;
        }
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        menu.append(&MenuItem::with_id(
            app,
            QUIT_ID,
            "Quit Pix",
            true,
            None::<&str>,
        )?)?;
        Ok(menu)
    }

    fn enable(app: &AppHandle) -> tauri::Result<()> {
        let menu = menu(app)?;
        // The tray is additive: leave AppKit's activation policy and main menu
        // untouched so Dock, application menus and native window cycling remain.
        TrayIconBuilder::with_id(TRAY_ID)
            .icon(crate::desktop_tray_icon::image(attention(app)))
            // Literal white silhouette and colored badge; AppKit template tint
            // would discard the badge color.
            .icon_as_template(false)
            .tooltip("Pix — open windows")
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_tray_icon_event(|tray, event| {
                let app = tray.app_handle();
                if !exiting(app) && is_show_all_click(&event) {
                    show_all(app);
                }
            })
            .on_menu_event(|app, event| {
                if exiting(app) {
                    return;
                }
                if event.id().as_ref() == QUIT_ID {
                    // Use the ordinary exit path, including the active-run guard.
                    app.exit(0);
                } else if event.id().as_ref() == SHOW_ALL_ID {
                    show_all(app);
                } else if event.id().as_ref() == ARRANGE_ID {
                    crate::window_tiling::arrange(app);
                } else if let Some(label) = event.id().as_ref().strip_prefix("pix.tray.window.") {
                    if let Some(window) = app.get_webview_window(label) {
                        crate::desktop_notification::foreground_window(&window);
                    }
                }
            })
            .build(app)?;
        // Asynchronous tray setup may finish after initial page reveals.
        // Reassert their foreground order, without exposing unpainted windows;
        // those will activate independently when their first document finishes.
        raise_windows(
            app.webview_windows()
                .into_iter()
                .filter(|(_, window)| window.is_visible().unwrap_or(false))
                .collect(),
        );
        Ok(())
    }

    pub(super) fn setup(app: &AppHandle) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let reader = app.clone();
            let enabled = crate::run_blocking(move || {
                let home = reader
                    .path()
                    .home_dir()
                    .map_err(|error| error.to_string())?;
                let document = crate::read_user_config_from(&home, crate::UserConfigKind::Desktop)?;
                super::tray_enabled(&document.content)
            })
            .await;
            match enabled {
                Ok(true) => {
                    let target = app.clone();
                    if let Err(error) = app.run_on_main_thread(move || {
                        if exiting(&target) {
                            return;
                        }
                        if let Err(error) = enable(&target) {
                            crate::logging::error(module_path!(), format!("tray setup: {error}"));
                        }
                    }) {
                        crate::logging::error(module_path!(), format!("tray setup: {error}"));
                    }
                }
                Ok(false) => {}
                Err(error) => {
                    crate::logging::error(module_path!(), format!("tray preferences: {error}"))
                }
            }
        });
    }

    pub(super) fn refresh(app: &AppHandle) {
        let target = app.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            if exiting(&target) {
                return;
            }
            // Resolve both the icon and live membership when the task executes,
            // not when scheduled; stale queued updates cannot resurrect windows.
            if let Err(error) = update_menu(&target) {
                crate::logging::error(module_path!(), format!("tray menu refresh: {error}"));
            }
            if let Err(error) = update_icon(&target) {
                crate::logging::error(module_path!(), format!("tray icon refresh: {error}"));
            }
        }) {
            crate::logging::error(module_path!(), format!("tray menu refresh: {error}"));
        }
    }

    pub(super) fn shutdown(app: &AppHandle) {
        if let Ok(mut state) = app.state::<crate::desktop_tray_attention::State>().0.lock() {
            state.shutdown();
        }
        app.remove_tray_by_id(TRAY_ID);
    }

    pub(super) async fn set_attention(
        window: tauri::WebviewWindow,
        value: bool,
    ) -> Result<(), String> {
        let app = window.app_handle().clone();
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let app = window.app_handle();
            let result = (|| {
                if exiting(app) {
                    return Ok(());
                }
                let Some(current) = app.get_webview_window(window.label()) else {
                    return Ok(());
                };
                let invoking_id = window.ns_view().map_err(|error| error.to_string())? as usize;
                let current_id = current.ns_view().map_err(|error| error.to_string())? as usize;
                app.state::<crate::desktop_tray_attention::State>()
                    .0
                    .lock()
                    .map_err(|error| error.to_string())?
                    .set(window.label(), invoking_id, current_id, value);
                let menu_result = update_menu(app);
                let icon_result = update_icon(app);
                menu_result.and(icon_result).map_err(|error| {
                    crate::logging::error(
                        module_path!(),
                        format!("tray attention refresh: {error}"),
                    );
                    error.to_string()
                })
            })();
            let _ = tx.send(result);
        })
        .map_err(|error| error.to_string())?;
        rx.await
            .map_err(|_| "Tray attention update cancelled".to_owned())?
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn click(button: MouseButton, button_state: MouseButtonState) -> TrayIconEvent {
            TrayIconEvent::Click {
                id: TRAY_ID.into(),
                position: Default::default(),
                rect: Default::default(),
                button,
                button_state,
            }
        }

        #[test]
        fn left_release_shows_all_windows_once() {
            assert!(is_show_all_click(&click(
                MouseButton::Left,
                MouseButtonState::Up
            )));
            assert!(!is_show_all_click(&click(
                MouseButton::Left,
                MouseButtonState::Down
            )));
        }

        #[test]
        fn other_buttons_leave_native_menu_handling_untouched() {
            for button in [MouseButton::Right, MouseButton::Middle] {
                for state in [MouseButtonState::Up, MouseButtonState::Down] {
                    assert!(!is_show_all_click(&click(button, state)));
                }
            }
        }
    }
}

pub(crate) fn setup(_app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    native::setup(_app);
}

pub(crate) fn refresh(_app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    native::refresh(_app);
}

pub(crate) fn shutdown(_app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    native::shutdown(_app);
}

pub(crate) fn destroyed(app: &tauri::AppHandle, label: &str) {
    use tauri::Manager;
    if let Ok(mut state) = app.state::<crate::desktop_tray_attention::State>().0.lock() {
        state.destroyed(label);
    }
    refresh(app);
}

#[tauri::command]
pub(crate) async fn desktop_set_tray_attention(
    window: tauri::WebviewWindow,
    attention: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return native::set_attention(window, attention).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, attention);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requires_explicit_true_and_accepts_jsonc() {
        for source in [
            "{}",
            r#"{"desktop":{}}"#,
            r#"{"desktop":{"trayOnly":false}}"#,
            r#"{"desktop":{"trayOnly":"true"}}"#,
        ] {
            assert!(!tray_enabled(source).unwrap());
        }
        assert!(tray_enabled("{ // opt in\n\"desktop\": {\"trayOnly\": true,},}").unwrap());
        assert!(tray_enabled("{").is_err());
    }

    #[test]
    fn lists_every_window_with_stable_identity_and_disambiguated_titles() {
        assert_eq!(
            window_entries(
                vec![
                    ("project-b".into(), "Pix — repo".into()),
                    ("project-a".into(), "Pix — repo".into()),
                    ("main".into(), "Pix".into()),
                ],
                &[]
            ),
            vec![
                ("pix.tray.window.main".into(), "Pix".into()),
                (
                    "pix.tray.window.project-a".into(),
                    "repo (project-a)".into()
                ),
                (
                    "pix.tray.window.project-b".into(),
                    "repo (project-b)".into()
                ),
            ]
        );
        // A removed window is not retained in a later snapshot.
        assert_eq!(
            window_entries(vec![("main".into(), "Pix — renamed".into())], &[]),
            vec![("pix.tray.window.main".into(), "renamed".into())]
        );
        assert!(window_entries(vec![], &[]).is_empty());
    }

    #[test]
    fn removes_only_the_app_prefix_and_disambiguates_display_titles() {
        assert_eq!(
            window_entries(
                vec![
                    ("a".into(), "Pix — repo".into()),
                    ("b".into(), "Pix - repo".into()),
                    ("c".into(), "project Pix — notes".into()),
                ],
                &[]
            ),
            vec![
                ("pix.tray.window.c".into(), "project Pix — notes".into()),
                ("pix.tray.window.a".into(), "repo (a)".into()),
                ("pix.tray.window.b".into(), "repo (b)".into()),
            ]
        );
    }

    #[test]
    fn attention_marks_only_its_owner_without_changing_order_or_identity() {
        let windows = vec![
            ("a".into(), "Pix — repo".into()),
            ("b".into(), "Pix - repo".into()),
        ];
        assert_eq!(
            window_entries(windows.clone(), &["b".into(), "destroyed".into()]),
            vec![
                ("pix.tray.window.a".into(), "repo (a)".into()),
                ("pix.tray.window.b".into(), "● repo (b)".into()),
            ]
        );
        assert_eq!(
            window_entries(windows, &[]),
            vec![
                ("pix.tray.window.a".into(), "repo (a)".into()),
                ("pix.tray.window.b".into(), "repo (b)".into()),
            ]
        );
    }
}
