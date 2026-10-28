//! Snapshot the actual NSDraggingInfo pasteboard, then preserve WebKit's DOM
//! negotiation. Hooks are restricted to wry's private class, never WKWebView.
use objc2::{
    msg_send,
    runtime::{AnyClass, AnyObject, Bool, Imp, ProtocolObject, Sel},
    sel, ClassType,
};
use objc2_app_kit::{NSDragOperation, NSDraggingInfo, NSPasteboard};
use objc2_foundation::{NSArray, NSURL};
use std::{
    cell::RefCell,
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::WebviewWindow;

#[derive(Default)]
struct Context {
    label: String,
    drop: Option<DropSlot>,
    pending: Option<String>,
    cancelled: Option<String>,
}
struct DropSlot {
    id: u64,
    captured: Instant,
    value: Result<(Vec<String>, Option<crate::project_entry_drag::Origin>), String>,
}
static DROP_ID: AtomicU64 = AtomicU64::new(1);
thread_local! {
    static CONTEXTS: RefCell<HashMap<usize, Context>> = RefCell::new(HashMap::new());
}
#[derive(Debug)]
struct Hooks {
    class: &'static AnyClass,
    superclass: &'static AnyClass,
}
static HOOKS: OnceLock<Result<Hooks, String>> = OnceLock::new();

fn key(view: &AnyObject) -> usize {
    view as *const _ as usize
}

// The four signatures match NSDraggingDestination and the installed wry 0.55
// overrides. No ivars, object classes, or ownership conventions are changed.
unsafe extern "C-unwind" fn entered(
    view: &AnyObject,
    _sel: Sel,
    info: &ProtocolObject<dyn NSDraggingInfo>,
) -> NSDragOperation {
    begin(key(view));
    unsafe { msg_send![super(view, superclass()), draggingEntered: info] }
}
fn begin(pointer: usize) {
    CONTEXTS.with_borrow_mut(|contexts| {
        if let Some(context) = contexts.get_mut(&pointer) {
            context.drop = None;
        }
    });
}
unsafe extern "C-unwind" fn updated(
    view: &AnyObject,
    _sel: Sel,
    info: &ProtocolObject<dyn NSDraggingInfo>,
) -> NSDragOperation {
    // Wry forces None to Copy even when its handler is disabled. Bypass that
    // override: the DOM destination owns copy/move/rejection and the OS badge.
    unsafe { msg_send![super(view, superclass()), draggingUpdated: info] }
}
unsafe extern "C-unwind" fn exited(
    view: &AnyObject,
    _sel: Sel,
    info: Option<&ProtocolObject<dyn NSDraggingInfo>>,
) {
    unsafe {
        let _: () = msg_send![super(view, superclass()), draggingExited: info];
    }
}
unsafe extern "C-unwind" fn dropped(
    view: &AnyObject,
    _sel: Sel,
    info: &ProtocolObject<dyn NSDraggingInfo>,
) -> Bool {
    let board = info.draggingPasteboard();
    let source = info
        .draggingSource()
        .as_deref()
        .and_then(crate::project_entry_drag_source::origin);
    let snapshot = snapshot(&board)
        .unwrap_or_else(|| Err("The drag contains no native file URLs.".into()))
        .map(|urls| (urls, source));
    let id = DROP_ID.fetch_add(1, Ordering::Relaxed);
    CONTEXTS.with_borrow_mut(|contexts| {
        if let Some(context) = contexts.get_mut(&key(view)) {
            context.drop = Some(DropSlot {
                id,
                captured: Instant::now(),
                value: snapshot,
            });
        }
    });
    let accepted: Bool =
        unsafe { msg_send![super(view, superclass()), performDragOperation: info] };
    if !accepted.as_bool() {
        CONTEXTS.with_borrow_mut(|contexts| {
            if let Some(context) = contexts.get_mut(&key(view)) {
                if context.drop.as_ref().is_some_and(|drop| drop.id == id) {
                    context.drop = None;
                }
            }
        });
    }
    accepted
}

fn superclass() -> &'static AnyClass {
    // Published only after every method/ABI check, before installing callbacks.
    HOOKS
        .get()
        .and_then(|value| value.as_ref().ok())
        .map(|hooks| hooks.superclass)
        .expect("file drag hooks installed")
}

fn snapshot(board: &NSPasteboard) -> Option<Result<Vec<String>, String>> {
    let items = board.pasteboardItems()?;
    let file_type = objc2_foundation::NSString::from_str("public.file-url");
    if !items.iter().any(|item| {
        item.types()
            .iter()
            .any(|kind| kind.isEqualToString(&file_type))
    }) {
        return None;
    }
    Some((|| {
        if items.is_empty() || items.len() > 1000 {
            return Err("Drag between 1 and 1000 files or folders.".into());
        }
        // NSURL supports Finder file-reference URLs as well as normal path URLs.
        let classes = NSArray::from_slice(&[NSURL::class()]);
        let objects = unsafe { board.readObjectsForClasses_options(&classes, None) }
            .ok_or("Cannot read dragged file URLs.")?;
        if objects.len() != items.len() {
            return Err("The drag contains a non-file item.".into());
        }
        let mut urls = Vec::new();
        let mut bytes = 0;
        for object in objects.iter() {
            let url = object
                .downcast_ref::<NSURL>()
                .ok_or("The drag contains a non-file URL.")?;
            if !url.isFileURL() {
                return Err("Only local file URLs can be dropped.".into());
            }
            let value = url
                .absoluteString()
                .ok_or("Missing dragged file URL.")?
                .to_string();
            bytes += value.len();
            if bytes > 131_072 {
                return Err("The file drag is too large.".into());
            }
            urls.push(value);
        }
        Ok(urls)
    })())
}

fn wry_class(mut class: &'static AnyClass) -> Option<&'static AnyClass> {
    // Resolve the installed type, not an assumed Objective-C runtime name.
    let expected = wry::WryWebView::class();
    loop {
        if class == expected {
            return Some(class);
        }
        class = class.superclass()?;
    }
}

fn install_hooks(view_class: &'static AnyClass) -> Result<Hooks, String> {
    // AppKit/WebKit can give the live view a dynamic KVO subclass. Hook only
    // the pinned Wry ancestor, never the wrapper or its inherited WK methods.
    let class = wry_class(view_class).ok_or_else(|| {
        format!(
            "Unexpected native file drag class: {}; expected {}.",
            view_class.name().to_string_lossy(),
            wry::WryWebView::class().name().to_string_lossy(),
        )
    })?;
    let superclass = class.superclass().ok_or("Missing WebKit superclass.")?;
    if superclass.name() != c"WKWebView" {
        return Err("Unexpected WebKit class hierarchy; native file drops disabled.".into());
    }
    let selectors = [
        sel!(draggingEntered:),
        sel!(draggingUpdated:),
        sel!(draggingExited:),
        sel!(performDragOperation:),
    ];
    // Validate all selectors before mutating any method. Check encodings against
    // WebKit's own methods rather than hard-coding architecture-specific ABI.
    for selector in selectors {
        let method = class
            .instance_method(selector)
            .ok_or("Missing wry drag selector.")?;
        let parent = superclass
            .instance_method(selector)
            .ok_or("Missing WebKit drag selector.")?;
        if method.arguments_count() != 3
            || method.return_type().as_ref() != parent.return_type().as_ref()
            || (0..3).any(|index| {
                method.argument_type(index).as_deref() != parent.argument_type(index).as_deref()
            })
        {
            return Err("Unexpected native drag method ABI.".into());
        }
    }
    Ok(Hooks { class, superclass })
}

pub(crate) fn install(window: &WebviewWindow) -> tauri::Result<()> {
    let owner = window.clone();
    window.with_webview(move |webview| {
        // The live view guarantees registration; a short Objective-C name lookup
        // silently missed Wry's actual class and left every source unprepared.
        let view = unsafe { &*(webview.inner() as *const AnyObject) };
        let hooks = HOOKS.get_or_init(|| install_hooks(view.class()));
        let Ok(hooks) = hooks else {
            crate::logging::error(module_path!(), hooks.as_ref().unwrap_err().clone());
            return;
        };
        if wry_class(view.class()) != Some(hooks.class) {
            crate::logging::error(
                module_path!(),
                "Native file drag WebView class changed.".into(),
            );
            return;
        }
        static ATTACHED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        if !ATTACHED.swap(true, std::sync::atomic::Ordering::Relaxed) {
            let class = hooks.class;
            // SAFETY: checked compatible methods above. These function pointers
            // have the Objective-C ABI and only call the original WK superclass.
            unsafe {
                for (selector, implementation) in [
                    (
                        sel!(draggingEntered:),
                        std::mem::transmute::<
                            unsafe extern "C-unwind" fn(
                                &AnyObject,
                                Sel,
                                &ProtocolObject<dyn NSDraggingInfo>,
                            )
                                -> NSDragOperation,
                            Imp,
                        >(entered),
                    ),
                    (
                        sel!(draggingUpdated:),
                        std::mem::transmute::<
                            unsafe extern "C-unwind" fn(
                                &AnyObject,
                                Sel,
                                &ProtocolObject<dyn NSDraggingInfo>,
                            )
                                -> NSDragOperation,
                            Imp,
                        >(updated),
                    ),
                    (
                        sel!(draggingExited:),
                        std::mem::transmute::<
                            unsafe extern "C-unwind" fn(
                                &AnyObject,
                                Sel,
                                Option<&ProtocolObject<dyn NSDraggingInfo>>,
                            ),
                            Imp,
                        >(exited),
                    ),
                    (
                        sel!(performDragOperation:),
                        std::mem::transmute::<
                            unsafe extern "C-unwind" fn(
                                &AnyObject,
                                Sel,
                                &ProtocolObject<dyn NSDraggingInfo>,
                            ) -> Bool,
                            Imp,
                        >(dropped),
                    ),
                ] {
                    class
                        .instance_method(selector)
                        .unwrap()
                        .set_implementation(implementation);
                }
            }
        }
        let pointer = webview.inner() as usize;
        CONTEXTS.with_borrow_mut(|contexts| {
            contexts.insert(
                pointer,
                Context {
                    label: owner.label().into(),
                    ..Context::default()
                },
            );
        });
        owner.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                CONTEXTS.with_borrow_mut(|contexts| {
                    contexts.remove(&pointer);
                });
                crate::project_entry_drag_source::cancel_unstarted(pointer, None, false);
            }
        });
    })
}

pub(crate) fn take(label: &str) -> Result<crate::project_entry_drag::NativeSnapshot, String> {
    CONTEXTS.with_borrow_mut(|contexts| {
        let context = contexts
            .values_mut()
            .find(|context| context.label == label)
            .ok_or("Native file drops are unavailable; restart Pix.")?;
        let drop = context
            .drop
            .take()
            .ok_or("No native file drop snapshot; please retry.")?;
        if drop.captured.elapsed() > Duration::from_secs(5) {
            return Err("The native file drop expired; please retry.".into());
        }
        let (urls, source) = drop.value?;
        Ok(crate::project_entry_drag::NativeSnapshot {
            id: drop.id,
            urls,
            source,
        })
    })
}

pub(crate) fn reset(label: &str) {
    CONTEXTS.with_borrow_mut(|contexts| {
        if let Some(context) = contexts.values_mut().find(|context| context.label == label) {
            *context = Context {
                label: label.into(),
                ..Context::default()
            };
        }
    });
}

pub(crate) fn prepare(pointer: usize, id: &str) -> Result<bool, String> {
    CONTEXTS.with_borrow_mut(|contexts| {
        let context = contexts
            .get_mut(&pointer)
            .ok_or_else(|| match HOOKS.get() {
                Some(Err(error)) => format!("Native file drag is unavailable: {error}"),
                _ => "Native file drag is not initialized for this window.".to_owned(),
            })?;
        if context.cancelled.as_deref() == Some(id) {
            return Ok(false);
        }
        context.pending = Some(id.into());
        Ok(true)
    })
}
pub(crate) fn claim(pointer: usize, id: &str) -> bool {
    CONTEXTS.with_borrow_mut(|contexts| {
        let Some(context) = contexts.get_mut(&pointer) else {
            return false;
        };
        if context.pending.as_deref() != Some(id) {
            return false;
        }
        context.pending = None;
        true
    })
}
pub(crate) fn cancel(pointer: usize, id: &str) {
    CONTEXTS.with_borrow_mut(|contexts| {
        if let Some(context) = contexts.get_mut(&pointer) {
            if context.pending.as_deref() == Some(id) {
                context.pending = None;
            }
            context.cancelled = Some(id.into());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bridge_validates_the_installed_wry_class_and_rejects_unrelated_classes() {
        let class = wry::WryWebView::class();
        let hooks = install_hooks(class).unwrap();
        assert_eq!(hooks.class, class);
        assert_eq!(hooks.superclass.name(), c"WKWebView");
        assert!(install_hooks(NSURL::class()).is_err());
    }

    #[test]
    fn unavailable_bridge_reports_an_error_instead_of_silently_cancelling() {
        assert_eq!(
            prepare(usize::MAX, "unavailable").unwrap_err(),
            "Native file drag is not initialized for this window.",
        );
    }

    #[test]
    fn runtime_subclasses_resolve_to_the_exact_ancestor_without_hooking_wrappers() {
        use objc2::runtime::ClassBuilder;

        let base = wry::WryWebView::class();
        let wrapper = ClassBuilder::new(c"PixDragTestKVOWrapper", base)
            .unwrap()
            .register();
        let nested = ClassBuilder::new(c"PixDragTestNestedWrapper", wrapper)
            .unwrap()
            .register();
        assert_eq!(install_hooks(base).unwrap().class, base);
        assert_eq!(install_hooks(wrapper).unwrap().class, base);
        assert_eq!(install_hooks(nested).unwrap().class, base);
        // The same resolution applies to subsequent windows with other wrappers.
        let another = ClassBuilder::new(c"PixDragTestAnotherWindowWrapper", base)
            .unwrap()
            .register();
        assert_eq!(install_hooks(another).unwrap().class, base);
        assert_eq!(wry_class(NSURL::class()), None);
    }
    #[test]
    fn snapshots_are_label_scoped_consumed_once_and_cleared_before_new_sessions() {
        let pointer = 1;
        CONTEXTS.with_borrow_mut(|contexts| {
            let context = Context {
                label: "first".into(),
                drop: Some(DropSlot {
                    id: 1,
                    captured: Instant::now(),
                    value: Ok((
                        vec!["file:///first".into()],
                        Some(crate::project_entry_drag::Origin {
                            workspace: "/source".into(),
                            paths: vec!["first".into()],
                        }),
                    )),
                }),
                ..Context::default()
            };
            contexts.insert(pointer, context);
        });
        assert!(take("another-window").is_err());
        let first = take("first").unwrap();
        assert_eq!(first.id, 1);
        assert_eq!(first.urls, ["file:///first"]);
        assert_eq!(first.source.unwrap().paths, ["first"]);
        assert!(take("first").is_err());
        CONTEXTS.with_borrow_mut(|contexts| {
            contexts.get_mut(&pointer).unwrap().drop = Some(DropSlot {
                id: 2,
                captured: Instant::now(),
                value: Ok((vec!["file:///missed-dom-drop".into()], None)),
            });
        });
        begin(pointer);
        // Unsupported promises must never consume an older real-file snapshot.
        assert!(take("first").is_err());
        CONTEXTS.with_borrow_mut(|contexts| {
            contexts.get_mut(&pointer).unwrap().drop = Some(DropSlot {
                id: 3,
                captured: Instant::now(),
                value: Err("unsupported promised file".into()),
            });
        });
        assert_eq!(
            take("first").err().as_deref(),
            Some("unsupported promised file")
        );
        assert!(take("first").is_err());
        CONTEXTS.with_borrow_mut(|contexts| {
            contexts.get_mut(&pointer).unwrap().drop = Some(DropSlot {
                id: 4,
                captured: Instant::now() - Duration::from_secs(6),
                value: Ok((vec!["file:///expired".into()], None)),
            });
        });
        assert!(take("first").err().unwrap().contains("expired"));
        assert!(prepare(pointer, "reload").unwrap());
        reset("first");
        assert!(!claim(pointer, "reload"));
        CONTEXTS.with_borrow_mut(|contexts| {
            contexts.remove(&pointer);
        });
    }
    #[test]
    fn pending_source_cancellation_and_teardown_cannot_start_a_late_drag() {
        let pointer = 2;
        CONTEXTS.with_borrow_mut(|contexts| {
            contexts.insert(pointer, Context::default());
        });
        cancel(pointer, "cancel-before-prepare");
        assert!(!prepare(pointer, "cancel-before-prepare").unwrap());
        assert!(prepare(pointer, "cancel-after-prepare").unwrap());
        cancel(pointer, "cancel-after-prepare");
        assert!(!claim(pointer, "cancel-after-prepare"));
        assert!(prepare(pointer, "old").unwrap());
        assert!(prepare(pointer, "new").unwrap());
        assert!(!claim(pointer, "old"));
        assert!(claim(pointer, "new"));
        assert!(!claim(pointer, "new"));
        assert!(prepare(pointer, "destroyed").unwrap());
        CONTEXTS.with_borrow_mut(|contexts| {
            contexts.remove(&pointer);
        });
        assert!(!claim(pointer, "destroyed"));
        assert!(prepare(pointer, "destroyed").is_err());
    }
}
