//! Catch microphone-position F5 before macOS Dictation. No I/O in the HID callback.
use tauri::{AppHandle, WebviewWindow};

#[cfg(any(target_os = "macos", test))]
#[derive(Debug, PartialEq)]
enum KeyAction {
    Keep,
    Drop,
    Toggle,
}

#[cfg(any(target_os = "macos", test))]
#[derive(Default)]
struct KeyFilter {
    pressed: bool,
}

#[cfg(any(target_os = "macos", test))]
#[derive(Default)]
struct WindowOwners(std::collections::HashMap<String, std::collections::HashSet<String>>);

#[cfg(any(target_os = "macos", test))]
impl WindowOwners {
    fn set(&mut self, label: String, owner: String, enabled: bool) {
        if enabled {
            self.0.entry(label).or_default().insert(owner);
        } else if let Some(owners) = self.0.get_mut(&label) {
            owners.remove(&owner);
            if owners.is_empty() {
                self.0.remove(&label);
            }
        }
    }
    fn contains(&self, label: &str) -> bool {
        self.0.contains_key(label)
    }
    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    fn remove(&mut self, label: &str) {
        self.0.remove(label);
    }
}

#[cfg(any(target_os = "macos", test))]
impl KeyFilter {
    fn route(&mut self, keycode: i64, down: bool, eligible: bool, repeat: bool) -> KeyAction {
        if keycode != 0x60 {
            return KeyAction::Keep;
        }
        if !down {
            return if std::mem::take(&mut self.pressed) {
                KeyAction::Drop
            } else {
                KeyAction::Keep
            };
        }
        if self.pressed {
            return KeyAction::Drop;
        }
        if !eligible || repeat {
            return KeyAction::Keep;
        }
        self.pressed = true;
        KeyAction::Toggle
    }
}

#[tauri::command]
pub(crate) async fn desktop_set_dictation_shortcut(
    app: AppHandle,
    window: WebviewWindow,
    owner: String,
    enabled: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let label = window.label().to_owned();
        let handle = app.clone();
        on_main(&app, move || {
            macos::set_window(&handle, label, owner, enabled)
        })
        .await?;
        if enabled {
            refresh(&app).await?;
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, window, owner, enabled);
    Ok(())
}

/// Recheck after Settings saves and window activation, never inside the event tap.
pub(crate) async fn refresh(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::sync::atomic::{AtomicU64, Ordering};
        use tauri::Manager;
        static GENERATION: AtomicU64 = AtomicU64::new(0);
        let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        let home = app.path().home_dir().map_err(|error| error.to_string())?;
        let handle = app.clone();
        let configured = crate::run_blocking(move || {
            let state = handle.state::<crate::UserConfigState>();
            let _guard = state
                .lock
                .read()
                .map_err(|_| "user config state is poisoned")?;
            let key = std::env::var("DEEPGRAM_API_KEY")
                .ok()
                .map(|key| key.trim().to_owned())
                .filter(|key| !key.is_empty());
            // Key presence, not a network probe. Bad/missing config leaves the system key alone.
            Ok(crate::resolve_deepgram_runtime_config(&home, key).is_ok())
        })
        .await?;
        let handle = app.clone();
        on_main(app, move || {
            if GENERATION.load(Ordering::SeqCst) != generation {
                return Ok(());
            }
            macos::configure(&handle, configured)
        })
        .await?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    Ok(())
}

#[cfg(target_os = "macos")]
async fn on_main(
    app: &AppHandle,
    action: impl FnOnce() -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = send.send(action());
    })
    .map_err(|error| error.to_string())?;
    receive.await.map_err(|error| error.to_string())?
}

pub(crate) fn destroyed(label: &str) {
    #[cfg(target_os = "macos")]
    macos::remove_window(label);
    #[cfg(not(target_os = "macos"))]
    let _ = label;
}

pub(crate) fn shutdown() {
    #[cfg(target_os = "macos")]
    macos::shutdown();
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use core_foundation::{
        base::TCFType,
        boolean::CFBoolean,
        dictionary::{CFDictionary, CFDictionaryRef},
        runloop::{kCFRunLoopCommonModes, CFRunLoop, CFRunLoopSource},
        string::{CFString, CFStringRef},
    };
    use core_graphics::event::{
        CGEvent, CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions,
        CGEventTapPlacement, CGEventType, CallbackResult, EventField,
    };
    use objc2::{runtime::AnyObject, MainThreadMarker};
    use objc2_app_kit::NSApplication;
    use std::{cell::RefCell, rc::Rc};
    use tauri::{Emitter, Manager};

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
        static kAXTrustedCheckOptionPrompt: CFStringRef;
    }

    #[derive(Default)]
    struct Host {
        windows: WindowOwners,
        configured: bool,
        prompted: bool,
        keys: KeyFilter,
        tap: Option<Rc<Tap>>,
    }
    struct Tap {
        event: CGEventTap<'static>,
        source: CFRunLoopSource,
    }
    impl Drop for Tap {
        fn drop(&mut self) {
            CFRunLoop::get_main().remove_source(&self.source, unsafe { kCFRunLoopCommonModes });
            // CGEventTap's Drop invalidates its port and releases the callback.
        }
    }
    thread_local! { static HOST: RefCell<Host> = RefCell::new(Host::default()); }

    pub(super) fn set_window(
        app: &AppHandle,
        label: String,
        owner: String,
        enabled: bool,
    ) -> Result<(), String> {
        let enabled = enabled && app.get_webview_window(&label).is_some();
        let removed = HOST.with_borrow_mut(|host| {
            host.windows.set(label, owner, enabled);
            if host.windows.is_empty() {
                host.keys = KeyFilter::default();
                host.tap.take()
            } else {
                None
            }
        });
        drop(removed);
        Ok(())
    }
    pub(super) fn remove_window(label: &str) {
        let removed = HOST.with_borrow_mut(|host| {
            host.windows.remove(label);
            if host.windows.is_empty() {
                host.keys = KeyFilter::default();
                host.tap.take()
            } else {
                None
            }
        });
        drop(removed);
    }
    pub(super) fn shutdown() {
        let removed = HOST.with_borrow_mut(std::mem::take);
        drop(removed);
    }

    fn key_window(app: &AppHandle) -> Option<WebviewWindow> {
        let native = NSApplication::sharedApplication(MainThreadMarker::new()?);
        if !native.isActive() {
            return None;
        }
        let key = native.keyWindow()?;
        let pointer = (&*key as *const _ as *const AnyObject).cast::<std::ffi::c_void>();
        app.webview_windows().into_values().find(|window| {
            window
                .ns_window()
                .is_ok_and(|window| window.cast_const() == pointer)
        })
    }

    pub(super) fn configure(app: &AppHandle, configured: bool) -> Result<(), String> {
        let (removed, prompt) = HOST.with_borrow_mut(|host| {
            host.configured = configured;
            if !configured || host.windows.is_empty() {
                host.keys = KeyFilter::default();
                return (host.tap.take(), None);
            }
            if host.tap.is_some() {
                return (None, None);
            }
            let prompt = !host.prompted;
            host.prompted = true;
            (None, Some(prompt))
        });
        drop(removed);
        let Some(prompt) = prompt else {
            return Ok(());
        };
        // Never hold HOST across native calls: permission UI and delivery may re-enter.
        let key = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) };
        let options = CFDictionary::from_CFType_pairs(&[(key, CFBoolean::from(prompt))]);
        if !unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) } {
            return Err("To use the microphone key, allow Pix in System Settings → Privacy & Security → Accessibility, then return to Pix. The on-screen microphone and macOS dictation remain available.".into());
        }
        let handle = app.clone();
        let event = CGEventTap::new(CGEventTapLocation::HID,
            CGEventTapPlacement::HeadInsertEventTap, CGEventTapOptions::Default,
            vec![CGEventType::KeyDown, CGEventType::KeyUp], move |_, kind, event| on_key(&handle, kind, event))
            .map_err(|_| "Could not intercept the microphone key. Check Pix Accessibility permission, then return to Pix.".to_owned())?;
        let source = event
            .mach_port()
            .create_runloop_source(0)
            .map_err(|_| "Could not attach the microphone key to the macOS run loop".to_owned())?;
        let tap = Rc::new(Tap { event, source });
        let installed = HOST.with_borrow_mut(|host| {
            // Permission UI could have changed eligibility or installed a newer tap.
            if !host.configured || host.windows.is_empty() || host.tap.is_some() {
                return false;
            }
            host.tap = Some(tap.clone());
            true
        });
        if installed {
            CFRunLoop::get_main().add_source(&tap.source, unsafe { kCFRunLoopCommonModes });
            tap.event.enable();
        }
        Ok(())
    }

    fn on_key(app: &AppHandle, kind: CGEventType, event: &CGEvent) -> CallbackResult {
        // Keep native resources alive while delivering, without borrowing shared state.
        let Some(tap) = HOST.with_borrow(|host| host.tap.clone()) else {
            return CallbackResult::Keep;
        };
        if matches!(
            kind,
            CGEventType::TapDisabledByTimeout | CGEventType::TapDisabledByUserInput
        ) {
            tap.event.enable();
            return CallbackResult::Keep;
        }
        let keycode = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
        if keycode != 0x60 {
            return CallbackResult::Keep;
        }
        let modifiers = CGEventFlags::CGEventFlagShift
            | CGEventFlags::CGEventFlagControl
            | CGEventFlags::CGEventFlagAlternate
            | CGEventFlags::CGEventFlagCommand;
        let target = if !event.get_flags().intersects(modifiers)
            && HOST.with_borrow(|host| host.configured)
        {
            key_window(app)
        } else {
            None
        };
        let action = HOST.with_borrow_mut(|host| {
            let eligible = host.configured
                && target
                    .as_ref()
                    .is_some_and(|target| host.windows.contains(target.label()));
            host.keys.route(
                keycode,
                matches!(kind, CGEventType::KeyDown),
                eligible,
                event.get_integer_value_field(EventField::KEYBOARD_EVENT_AUTOREPEAT) != 0,
            )
        });
        match action {
            KeyAction::Keep => CallbackResult::Keep,
            KeyAction::Drop => CallbackResult::Drop,
            KeyAction::Toggle => {
                if target
                    .expect("eligible key has target")
                    .emit("pix:dictation-shortcut", ())
                    .is_ok()
                {
                    CallbackResult::Drop
                } else {
                    HOST.with_borrow_mut(|host| host.keys.pressed = false);
                    CallbackResult::Keep
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_or_unconfigured_composers_leave_system_dictation_alone() {
        let mut keys = KeyFilter::default();
        assert_eq!(keys.route(0x60, true, false, false), KeyAction::Keep);
        assert_eq!(keys.route(0x60, false, false, false), KeyAction::Keep);
    }

    #[test]
    fn one_toggle_per_press_and_matching_release_even_after_focus_change() {
        let mut keys = KeyFilter::default();
        assert_eq!(keys.route(0x60, true, true, false), KeyAction::Toggle);
        assert_eq!(keys.route(0x60, true, true, true), KeyAction::Drop);
        assert_eq!(keys.route(0x60, true, false, true), KeyAction::Drop);
        assert_eq!(keys.route(0x60, false, false, false), KeyAction::Drop);
        assert_eq!(keys.route(0x60, true, true, false), KeyAction::Toggle);
    }

    #[test]
    fn other_keys_and_repeats_of_unowned_presses_are_not_intercepted() {
        let mut keys = KeyFilter::default();
        assert_eq!(keys.route(0x60, true, true, true), KeyAction::Keep);
        assert_eq!(keys.route(0x61, true, true, false), KeyAction::Keep);
        assert_eq!(keys.route(0x61, false, true, false), KeyAction::Keep);
        assert_eq!(keys.route(0x60, false, true, false), KeyAction::Keep);
    }

    #[test]
    fn stale_composer_teardown_does_not_disable_a_new_owner_in_the_same_window() {
        let mut owners = WindowOwners::default();
        owners.set("main".into(), "old".into(), true);
        owners.set("main".into(), "new".into(), true);
        owners.set("main".into(), "old".into(), false);
        assert!(owners.contains("main"));
        owners.set("main".into(), "new".into(), false);
        assert!(owners.is_empty());
    }

    #[test]
    fn destroying_a_window_removes_all_owners_but_preserves_other_windows() {
        let mut owners = WindowOwners::default();
        owners.set("main".into(), "old".into(), true);
        owners.set("main".into(), "new".into(), true);
        owners.set("other".into(), "owner".into(), true);
        owners.remove("main");
        assert!(!owners.contains("main"));
        assert!(owners.contains("other"));
    }
}
