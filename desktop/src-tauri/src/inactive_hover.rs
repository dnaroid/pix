//! Focus follows the pointer over a visible Pix webview on macOS. AppKit
//! activates the app and makes the hovered window key; WebKit delivers hover
//! normally. No synthetic events or WebKit tracking-owner forwarding.

#[cfg(not(target_os = "macos"))]
pub(crate) fn install(_window: &tauri::WebviewWindow) -> tauri::Result<()> {
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn install(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    window.with_webview(|webview| {
        // SAFETY: with_webview runs on the main thread and provides the live
        // WKWebView (an NSView subclass). No raw pointer escapes this callback.
        let view = unsafe { &*webview.inner().cast::<objc2_app_kit::NSView>() };
        native::attach(view);
    })
}

#[cfg(target_os = "macos")]
mod native {
    use objc2::{
        define_class, msg_send, rc::Retained, AnyThread, ClassType, MainThreadMarker,
        MainThreadOnly,
    };
    use objc2_app_kit::{
        NSApplication, NSAutoresizingMaskOptions, NSEvent, NSTrackingArea,
        NSTrackingAreaOptions as Options, NSView,
    };
    use objc2_foundation::{NSObjectProtocol, NSPoint};

    define_class!(
        // SAFETY: NSView callbacks are main-thread-only. This passive child
        // owns no external resources and never intercepts hit testing.
        #[unsafe(super = NSView)]
        #[name = "PixInactiveHoverView"]
        struct HoverView;

        unsafe impl NSObjectProtocol for HoverView {}

        impl HoverView {
            #[unsafe(method(hitTest:))]
            fn hit_test(&self, _point: NSPoint) -> *mut NSView {
                std::ptr::null_mut()
            }

            #[unsafe(method(mouseMoved:))]
            fn mouse_moved(&self, _event: &NSEvent) {
                self.focus_window();
            }

            #[unsafe(method(mouseEntered:))]
            fn mouse_entered(&self, _event: &NSEvent) {
                self.focus_window();
            }
        }
    );

    fn bridge_options() -> Options {
        Options::MouseMoved
            | Options::MouseEnteredAndExited
            | Options::ActiveAlways
            | Options::InVisibleRect
    }

    fn should_focus(visible: bool, minimized: bool, app_active: bool, key: bool) -> bool {
        visible && !minimized && (!app_active || !key)
    }

    impl HoverView {
        fn focus_window(&self) {
            // SAFETY: AppKit calls this on main; superview is retained locally.
            // The parent owns this child, not vice versa (no retention cycle).
            let Some(view) = (unsafe { self.superview() }) else {
                return;
            };
            let Some(window) = view.window() else { return };
            let app = NSApplication::sharedApplication(self.mtm());
            if !should_focus(
                window.isVisible(),
                window.isMiniaturized(),
                app.isActive(),
                window.isKeyWindow(),
            ) {
                return;
            }
            // Deliberate focus transfer, requested by the user. Preserve the
            // window's existing first responder rather than focusing an input.
            #[allow(deprecated)]
            app.activateIgnoringOtherApps(true);
            window.makeKeyAndOrderFront(None);
        }
    }

    pub(super) fn attach(view: &NSView) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        // Idempotent if a future creation path installs twice. WebKit's own
        // tracking areas are neither removed nor replaced.
        if view
            .subviews()
            .iter()
            .any(|child| child.isKindOfClass(HoverView::class()))
        {
            return;
        }
        let child: Retained<HoverView> =
            unsafe { msg_send![HoverView::alloc(mtm), initWithFrame: view.bounds()] };
        child.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewHeightSizable,
        );
        let area = unsafe {
            NSTrackingArea::initWithRect_options_owner_userInfo(
                NSTrackingArea::alloc(),
                child.bounds(),
                bridge_options(),
                Some(&child),
                None,
            )
        };
        child.addTrackingArea(&area);
        view.addSubview(&child);
        // NSView retains its child and tracking area; area.owner is unretained.
        // InVisibleRect/autoresizing follow resize without listeners/timers;
        // destroying the webview releases the entire bridge synchronously.
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn focus_transfers_from_another_app_or_pix_window() {
            assert!(should_focus(true, false, false, false));
            assert!(should_focus(true, false, false, true));
            assert!(should_focus(true, false, true, false));
            assert!(!should_focus(true, false, true, true));
        }

        #[test]
        fn hidden_and_minimized_windows_never_take_focus() {
            for app_active in [false, true] {
                for key in [false, true] {
                    assert!(!should_focus(false, false, app_active, key));
                    assert!(!should_focus(true, true, app_active, key));
                }
            }
        }

        #[test]
        fn bridge_follows_visible_bounds_without_intercepting_drag_or_cursor_updates() {
            let options = bridge_options();
            assert!(options.contains(Options::ActiveAlways | Options::InVisibleRect));
            assert!(options.contains(Options::MouseMoved | Options::MouseEnteredAndExited));
            assert!(!options.intersects(
                Options::EnabledDuringMouseDrag | Options::CursorUpdate | Options::AssumeInside
            ));
        }
    }
}
