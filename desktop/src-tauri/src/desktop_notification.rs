//! Native notification delivery owns the center delegate; the notification plugin
//! is permission-only (its notify command is denied in capabilities/default.json).
//! Routing lives in each notification's userInfo, not in per-notification tasks.

#[cfg(any(target_os = "macos", test))]
mod routing {
    use serde::{Deserialize, Serialize};
    use std::collections::HashMap;

    #[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct Route {
        pub window: String,
        pub owner: String,
        pub session_id: Option<String>,
    }

    #[derive(Clone, Debug, Serialize, PartialEq, Eq)]
    #[serde(rename_all = "camelCase")]
    pub struct Activation {
        pub session_id: Option<String>,
    }

    #[derive(Default)]
    pub struct Routing {
        // At most one entry per live window; no notification registry or timers.
        owners: HashMap<String, (usize, String)>,
        stopped: bool,
    }

    impl Routing {
        pub fn capture(
            &mut self,
            window: &str,
            invoking_native_id: usize,
            current_native_id: usize,
            session_id: Option<String>,
            new_owner: impl FnOnce() -> String,
        ) -> Result<Route, String> {
            if self.stopped || invoking_native_id != current_native_id {
                return Err("Notification window is no longer alive".into());
            }
            let entry = self
                .owners
                .entry(window.to_owned())
                .or_insert_with(|| (invoking_native_id, new_owner()));
            // Destruction removes entries before a replacement can send.
            if entry.0 != invoking_native_id {
                return Err("Notification window identity changed".into());
            }
            Ok(Route {
                window: window.to_owned(),
                owner: entry.1.clone(),
                session_id,
            })
        }

        pub fn activate(&self, route: &Route, body_clicked: bool) -> Option<Activation> {
            if self.stopped || !body_clicked {
                return None;
            }
            let (_, owner) = self.owners.get(&route.window)?;
            (owner == &route.owner).then(|| Activation {
                session_id: route.session_id.clone(),
            })
        }

        pub fn destroyed(&mut self, window: &str) {
            self.owners.remove(window);
        }

        pub fn shutdown(&mut self) {
            self.stopped = true;
            self.owners.clear();
        }
    }
}

#[cfg(target_os = "macos")]
#[allow(deprecated)] // Same macOS delivery API as the installed Tauri plugin.
mod native {
    use super::routing::{Route, Routing};
    use objc2::{
        define_class, msg_send,
        rc::Retained,
        runtime::{AnyObject, ProtocolObject},
        AnyThread, DefinedClass,
    };
    use objc2_foundation::{
        ns_string, NSDictionary, NSObject, NSObjectProtocol, NSString, NSUserNotification,
        NSUserNotificationActivationType, NSUserNotificationCenter,
        NSUserNotificationCenterDelegate,
    };
    use std::{
        cell::RefCell,
        sync::{Arc, Mutex, OnceLock},
    };
    use tauri::{AppHandle, Emitter, EventTarget, Manager, WebviewWindow};

    const EVENT: &str = "desktop-notification-activated";

    #[derive(Default)]
    pub struct State(pub Arc<Mutex<Routing>>);

    struct DelegateIvars {
        app: AppHandle,
        routing: Arc<Mutex<Routing>>,
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements. All ivars are
        // thread-safe; callbacks only copy metadata and schedule main-loop work.
        #[unsafe(super = NSObject)]
        #[name = "PixDesktopNotificationDelegate"]
        #[ivars = DelegateIvars]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl NSUserNotificationCenterDelegate for Delegate {
            #[unsafe(method(userNotificationCenter:shouldPresentNotification:))]
            fn should_present(
                &self,
                _center: &NSUserNotificationCenter,
                _notification: &NSUserNotification,
            ) -> bool {
                true
            }

            #[unsafe(method(userNotificationCenter:didActivateNotification:))]
            fn activated(
                &self,
                center: &NSUserNotificationCenter,
                notification: &NSUserNotification,
            ) {
                // Closing/dismissing is never activation. Ignore action/reply too.
                if !is_body_activation(notification.activationType()) {
                    return;
                }
                let Some(route) = read_route(notification) else {
                    return;
                };
                center.removeDeliveredNotification(notification);
                let app = self.ivars().app.clone();
                let routing = self.ivars().routing.clone();
                let dispatch = app.clone();
                // No waiter, thread, task or timer survives delivery. A queued
                // click revalidates ownership after window destruction/shutdown.
                let _ = dispatch.run_on_main_thread(move || {
                    let activation = routing
                        .lock()
                        .ok()
                        .and_then(|state| state.activate(&route, true));
                    if let Some(payload) = activation {
                        if app.get_webview_window(&route.window).is_some() {
                            let _ = app.emit_to(
                                EventTarget::webview_window(&route.window),
                                EVENT,
                                payload,
                            );
                        }
                    }
                });
            }
        }
    );

    impl Delegate {
        fn new(app: AppHandle, routing: Arc<Mutex<Routing>>) -> Retained<Self> {
            let this = Self::alloc().set_ivars(DelegateIvars { app, routing });
            // SAFETY: NSObject init has this signature and initializes our superclass.
            unsafe { msg_send![super(this), init] }
        }
    }

    struct Bridge {
        center: Retained<NSUserNotificationCenter>,
        // The center does not retain its delegate. Keep it alive until detach.
        _delegate: Retained<Delegate>,
    }

    impl Drop for Bridge {
        fn drop(&mut self) {
            // SAFETY: Main-loop-owned bridge detaches before releasing delegate.
            unsafe { self.center.setDelegate(None) };
        }
    }

    thread_local! {
        static BRIDGE: RefCell<Option<Bridge>> = const { RefCell::new(None) };
    }

    fn read_route(notification: &NSUserNotification) -> Option<Route> {
        let info = notification.userInfo()?;
        let value = info
            .objectForKey(ns_string!("pixDesktopRoute"))?
            .downcast::<NSString>()
            .ok()?;
        serde_json::from_str(&value.to_string()).ok()
    }

    fn is_body_activation(action: NSUserNotificationActivationType) -> bool {
        action == NSUserNotificationActivationType::ContentsClicked
    }

    pub fn setup(app: &mut tauri::App) -> Result<(), String> {
        app.manage(State::default());
        Ok(())
    }

    fn send(
        window: WebviewWindow,
        title: String,
        body: Option<String>,
        session_id: Option<String>,
    ) -> Result<(), String> {
        let app = window.app_handle();
        let current = app
            .get_webview_window(window.label())
            .ok_or("Notification window is no longer alive")?;
        // Comparing the invoking instance with the current instance rejects a
        // stale queued send even when a window label has been reused.
        // Use raw view identities without dereferencing Cocoa objects belonging
        // to a possibly destroyed invoking window.
        let invoking_id = window.ns_view().map_err(|error| error.to_string())? as usize;
        let current_id = current.ns_view().map_err(|error| error.to_string())? as usize;
        let route = app
            .state::<State>()
            .0
            .lock()
            .map_err(|error| error.to_string())?
            .capture(window.label(), invoking_id, current_id, session_id, || {
                uuid::Uuid::new_v4().to_string()
            })?;
        let metadata =
            NSString::from_str(&serde_json::to_string(&route).map_err(|error| error.to_string())?);
        let info = NSDictionary::<NSString, AnyObject>::from_slices(
            &[ns_string!("pixDesktopRoute")],
            &[&*metadata],
        );
        let notification = NSUserNotification::new();
        notification.setTitle(Some(&NSString::from_str(&title)));
        if let Some(body) = body {
            notification.setInformativeText(Some(&NSString::from_str(&body)));
        }
        notification.setIdentifier(Some(&NSString::from_str(&uuid::Uuid::new_v4().to_string())));
        // SAFETY: The dictionary really contains NSString keys and NSString
        // values (NSObject subclasses), all property-list-compatible objects.
        unsafe { notification.setUserInfo(Some(&info)) };
        BRIDGE.with(|slot| {
            let mut bridge = slot.borrow_mut();
            if bridge.is_none() {
                // Initialize only after the dev identity helper has completed,
                // and only when an enabled frontend actually asks for delivery.
                let delegate = Delegate::new(app.clone(), app.state::<State>().0.clone());
                let center = NSUserNotificationCenter::defaultUserNotificationCenter();
                // SAFETY: Bridge retains delegate until detaching at shutdown.
                unsafe { center.setDelegate(Some(ProtocolObject::from_ref(&*delegate))) };
                *bridge = Some(Bridge {
                    center,
                    _delegate: delegate,
                });
            }
            let bridge = bridge
                .as_ref()
                .ok_or("Notification bridge is not available")?;
            bridge.center.deliverNotification(&notification);
            Ok(())
        })
    }

    pub async fn send_command(
        window: WebviewWindow,
        title: String,
        body: Option<String>,
        session_id: Option<String>,
    ) -> Result<(), String> {
        // Like the plugin, unbundled dev runs borrow Terminal's identity. The
        // Launch Services lookup must not block the main loop, and its failure
        // must not prevent Pix startup. Cancellation cannot reset the process-
        // wide identity helper: the owned blocking task completes its OnceLock.
        if tauri::is_dev() {
            tauri::async_runtime::spawn_blocking(|| {
                static IDENTITY: OnceLock<Result<(), String>> = OnceLock::new();
                IDENTITY
                    .get_or_init(|| {
                        mac_notification_sys::set_application("com.apple.Terminal")
                            .map_err(|error| error.to_string())
                    })
                    .clone()
            })
            .await
            .map_err(|error| error.to_string())??;
        }
        let (tx, rx) = tokio::sync::oneshot::channel();
        let app = window.app_handle().clone();
        app.run_on_main_thread(move || {
            let _ = tx.send(send(window, title, body, session_id));
        })
        .map_err(|error| error.to_string())?;
        // This only waits for the queued delivery call, never for a user click.
        rx.await
            .map_err(|_| "Notification delivery was cancelled".to_owned())?
    }

    pub fn destroyed(app: &AppHandle, label: &str) {
        if let Some(state) = app.try_state::<State>() {
            if let Ok(mut routing) = state.0.lock() {
                routing.destroyed(label);
            }
        }
    }

    pub fn shutdown(app: &AppHandle) {
        if let Some(state) = app.try_state::<State>() {
            if let Ok(mut routing) = state.0.lock() {
                routing.shutdown();
            }
        }
        BRIDGE.with(|slot| {
            slot.borrow_mut().take();
        });
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn native_metadata_is_property_list_compatible_and_round_trips() {
            objc2::rc::autoreleasepool(|_| {
                for session_id in [None, Some("session-\"quoted\"-雪".to_owned())] {
                    let route = Route {
                        window: "project-two".into(),
                        owner: "owner".into(),
                        session_id,
                    };
                    let value = NSString::from_str(&serde_json::to_string(&route).unwrap());
                    let info = NSDictionary::<NSString, AnyObject>::from_slices(
                        &[ns_string!("pixDesktopRoute")],
                        &[&*value],
                    );
                    let notification = NSUserNotification::new();
                    // SAFETY: Property-list-compatible NSString keys and values.
                    unsafe { notification.setUserInfo(Some(&info)) };
                    assert_eq!(read_route(&notification), Some(route));
                }
                assert_eq!(read_route(&NSUserNotification::new()), None);
                let invalid = NSString::from_str("not a route");
                let info = NSDictionary::<NSString, AnyObject>::from_slices(
                    &[ns_string!("pixDesktopRoute")],
                    &[&*invalid],
                );
                let notification = NSUserNotification::new();
                // SAFETY: Property-list-compatible NSString keys and values.
                unsafe { notification.setUserInfo(Some(&info)) };
                assert_eq!(read_route(&notification), None);
            });
        }

        #[test]
        fn only_native_contents_clicked_is_activation() {
            assert!(is_body_activation(
                NSUserNotificationActivationType::ContentsClicked
            ));
            for action in [
                NSUserNotificationActivationType::None,
                NSUserNotificationActivationType::ActionButtonClicked,
                NSUserNotificationActivationType::Replied,
                NSUserNotificationActivationType::AdditionalActionClicked,
            ] {
                assert!(!is_body_activation(action));
            }
        }
    }
}

pub fn setup(app: &mut tauri::App) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return native::setup(app);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(())
    }
}

pub fn destroyed(app: &tauri::AppHandle, label: &str) {
    #[cfg(target_os = "macos")]
    native::destroyed(app, label);
    #[cfg(not(target_os = "macos"))]
    let _ = (app, label);
}

pub fn shutdown(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    native::shutdown(app);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[tauri::command]
pub async fn desktop_send_notification(
    window: tauri::WebviewWindow,
    title: String,
    body: Option<String>,
    session_id: Option<String>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return native::send_command(window, title, body, session_id).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, title, body, session_id);
        Err("Desktop notifications are supported on macOS only".into())
    }
}

#[cfg(test)]
mod tests {
    use super::routing::{Activation, Route, Routing};

    #[test]
    fn plugin_permission_api_cannot_replace_native_delivery_delegate() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let permissions = capability["permissions"].as_array().unwrap();
        for permission in [
            "notification:allow-is-permission-granted",
            "notification:allow-request-permission",
            "notification:deny-notify",
        ] {
            assert!(permissions.contains(&serde_json::json!(permission)));
        }
        assert!(!permissions.contains(&serde_json::json!("notification:default")));
        assert!(!permissions.contains(&serde_json::json!("notification:allow-notify")));
    }

    fn capture(state: &mut Routing, window: &str, session: Option<&str>) -> Route {
        state
            .capture(window, 1, 1, session.map(str::to_owned), || {
                format!("owner-{window}")
            })
            .unwrap()
    }

    #[test]
    fn out_of_order_notifications_keep_their_own_window_and_session() {
        let mut state = Routing::default();
        let first = capture(&mut state, "main", Some("session-a"));
        let second = capture(&mut state, "main", Some("session-b"));
        let other = capture(&mut state, "project-two", Some("session-c"));
        assert_eq!(
            state.activate(&second, true).unwrap().session_id.as_deref(),
            Some("session-b")
        );
        assert_eq!(
            state.activate(&other, true).unwrap().session_id.as_deref(),
            Some("session-c")
        );
        assert_eq!(
            state.activate(&first, true).unwrap().session_id.as_deref(),
            Some("session-a")
        );
        assert_eq!(first.window, "main");
        assert_eq!(other.window, "project-two");
    }

    #[test]
    fn dismissal_and_non_body_actions_never_activate() {
        let mut state = Routing::default();
        let route = capture(&mut state, "main", Some("session"));
        assert_eq!(state.activate(&route, false), None);
    }

    #[test]
    fn null_session_round_trips_and_payload_has_only_session_id() {
        let mut state = Routing::default();
        let route = capture(&mut state, "main", None);
        let restored: Route =
            serde_json::from_str(&serde_json::to_string(&route).unwrap()).unwrap();
        assert_eq!(restored, route);
        assert_eq!(
            serde_json::to_value(state.activate(&restored, true).unwrap()).unwrap(),
            serde_json::json!({"sessionId": null})
        );
        assert_eq!(
            serde_json::to_value(Activation {
                session_id: Some("s".into())
            })
            .unwrap(),
            serde_json::json!({"sessionId": "s"})
        );
    }

    #[test]
    fn closed_window_and_reused_label_cannot_receive_old_click() {
        let mut state = Routing::default();
        let route = capture(&mut state, "main", Some("old"));
        let other = capture(&mut state, "project-two", None);
        state.destroyed("main");
        assert_eq!(state.activate(&route, true), None);
        let replacement = state
            .capture("main", 1, 1, Some("new".into()), || "new-owner".into())
            .unwrap();
        assert_eq!(state.activate(&route, true), None);
        assert!(state.activate(&replacement, true).is_some());
        assert!(state.activate(&other, true).is_some());
    }

    #[test]
    fn stale_queued_send_cannot_register_replacement_window() {
        let mut state = Routing::default();
        assert!(state
            .capture("main", 1, 2, None, || panic!("stale send registered"))
            .is_err());
        let current = state
            .capture("main", 2, 2, None, || "current".into())
            .unwrap();
        assert!(state.activate(&current, true).is_some());
    }

    #[test]
    fn teardown_rejects_queued_clicks_and_new_sends() {
        let mut state = Routing::default();
        let route = capture(&mut state, "main", Some("session"));
        state.shutdown();
        assert_eq!(state.activate(&route, true), None);
        assert!(state
            .capture("main", 1, 1, None, || panic!("registered after teardown"))
            .is_err());
    }

    #[test]
    fn foreign_owner_and_previous_process_routes_do_not_activate() {
        let mut state = Routing::default();
        let mut route = capture(&mut state, "main", Some("session"));
        route.owner = "previous-process-owner".into();
        assert_eq!(state.activate(&route, true), None);
        route.window = "unknown-window".into();
        assert_eq!(state.activate(&route, true), None);
    }
}
