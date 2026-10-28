//! AppKit owns the drag. Finder owns file-URL transfers, including Move; never
//! delete a source in the completion callback (that would double-delete data).
use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, ProtocolObject},
    AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly, Message,
};
use objc2_app_kit::{
    NSApplication, NSDragOperation, NSDraggingContext, NSDraggingItem, NSDraggingSession,
    NSDraggingSource, NSEvent, NSEventModifierFlags, NSEventType, NSImage, NSView, NSWindow,
};
use objc2_foundation::{
    NSArray, NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString, NSURL,
};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
};
use tokio::sync::oneshot;

type Completion = oneshot::Sender<Result<(), String>>;
pub(crate) struct File {
    pub path: String,
    pub directory: bool,
}
struct Lifecycle {
    id: String,
    begun: Cell<bool>,
    finished: Cell<bool>,
    watchdog: RefCell<Option<oneshot::Sender<()>>>,
}
impl Lifecycle {
    fn new(id: String) -> Self {
        Self {
            id,
            begun: Cell::new(false),
            finished: Cell::new(false),
            watchdog: RefCell::new(None),
        }
    }
    fn can_cancel(&self, id: Option<&str>) -> bool {
        id.map_or(true, |id| id == self.id) && !self.begun.get() && !self.finished.get()
    }
    fn begin(&self) {
        self.begun.set(true);
        self.watchdog.borrow_mut().take();
    }
    fn finish(&self) {
        self.finished.set(true);
    }
    fn end(&self) {
        self.finish();
        self.watchdog.borrow_mut().take();
    }
    fn may_release(&self, buttons: usize) -> bool {
        self.finished.get() && !self.begun.get() && buttons & 1 == 0
    }
    fn watch(&self, id: &str) -> Option<oneshot::Receiver<()>> {
        if self.id != id || self.begun.get() || self.watchdog.borrow().is_some() {
            return None;
        }
        let (stop, stopped) = oneshot::channel();
        *self.watchdog.borrow_mut() = Some(stop);
        Some(stopped)
    }
}
struct SourceIvars {
    pointer: usize,
    // Prevent pointer reuse if the window is destroyed before AppKit ends the
    // drag. Released with the source immediately after the ended callback.
    _view: Retained<NSView>,
    origin: crate::project_entry_drag::Origin,
    lifecycle: Lifecycle,
    complete: RefCell<Option<Completion>>,
}
thread_local! { static SOURCES: RefCell<HashMap<usize, Retained<Source>>> = RefCell::new(HashMap::new()); }

fn remove_owned<T>(
    sources: &mut HashMap<usize, T>,
    pointer: usize,
    expected: usize,
    identity: impl Fn(&T) -> usize,
) -> Option<T> {
    if !sources
        .get(&pointer)
        .is_some_and(|source| identity(source) == expected)
    {
        return None;
    }
    sources.remove(&pointer)
}

fn operation(local: bool, command: bool) -> NSDragOperation {
    if local {
        NSDragOperation::Copy | NSDragOperation::Move
    } else if command {
        NSDragOperation::Move
    } else {
        NSDragOperation::Copy
    }
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements. The source, its ivars
    // and every AppKit callback are restricted to the main thread.
    #[unsafe(super = NSObject)]
    #[thread_kind = MainThreadOnly]
    #[name = "PixProjectFileDragSource"]
    #[ivars = SourceIvars]
    struct Source;
    unsafe impl NSObjectProtocol for Source {}
    unsafe impl NSDraggingSource for Source {
        #[unsafe(method(draggingSession:willBeginAtPoint:))]
        fn will_begin(&self, _session: &NSDraggingSession, _point: NSPoint) {
            self.ivars().lifecycle.begin();
        }
        #[unsafe(method(draggingSession:sourceOperationMaskForDraggingContext:))]
        fn mask(
            &self,
            _session: &NSDraggingSession,
            context: NSDraggingContext,
        ) -> NSDragOperation {
            if self.ivars().lifecycle.finished.get() {
                return NSDragOperation::None;
            }
            operation(
                context == NSDraggingContext::WithinApplication,
                NSEvent::modifierFlags_class().contains(NSEventModifierFlags::Command),
            )
        }
        #[unsafe(method(ignoreModifierKeysForDraggingSession:))]
        fn ignore_modifiers(&self, _session: &NSDraggingSession) -> bool {
            // The source implements explicit Cmd-Move, not AppKit's historical
            // Cmd-Generic filtering (which lets Finder pick a same-volume move).
            true
        }
        #[unsafe(method(draggingSession:endedAtPoint:operation:))]
        fn ended(
            &self,
            _session: &NSDraggingSession,
            _point: NSPoint,
            _operation: NSDragOperation,
        ) {
            self.ivars().lifecycle.end();
            let completion = self.ivars().complete.borrow_mut().take();
            // Keep the receiving object alive until this method returns.
            let _keep_alive = SOURCES.with_borrow_mut(|sources| {
                remove_owned(
                    sources,
                    self.ivars().pointer,
                    self as *const Self as usize,
                    |source| Retained::as_ptr(source) as usize,
                )
            });
            if let Some(sender) = completion {
                let _ = sender.send(Ok(()));
            }
        }
    }
);

pub(crate) fn origin(source: &AnyObject) -> Option<crate::project_entry_drag::Origin> {
    source
        .downcast_ref::<Source>()
        .map(|source| source.ivars().origin.clone())
}

pub(crate) fn start(
    pointer: usize,
    native_window: usize,
    paths: Vec<File>,
    origin: crate::project_entry_drag::Origin,
    id: String,
    app: tauri::AppHandle,
    sender: Completion,
) {
    let result = start_inner(pointer, native_window, paths, origin, id.clone(), sender);
    if let Err((sender, error)) = result {
        let _ = sender.send(Err(error));
        return;
    }
    let watchdog = SOURCES.with_borrow(|sources| {
        let source = sources.get(&pointer)?;
        source.ivars().lifecycle.watch(&id)
    });
    if let Some(mut stopped) = watchdog {
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut stopped => break,
                    _ = tokio::time::sleep(std::time::Duration::from_millis(750)) => {
                        let id = id.clone();
                        let (sender, receiver) = oneshot::channel();
                        if let Err(error) = app.run_on_main_thread(move || {
                            cancel_unstarted(pointer, Some(&id), true);
                            let pending = SOURCES.with_borrow(|sources| sources.get(&pointer).is_some_and(|source| source.ivars().lifecycle.id == id && !source.ivars().lifecycle.begun.get()));
                            let _ = sender.send(pending);
                        }) {
                            crate::logging::error(module_path!(), format!("Cannot expire unstarted native file drag: {error}"));
                            break;
                        }
                        if !receiver.await.unwrap_or(false) { break; }
                    }
                }
            }
        });
    }
}

// Acknowledgement is not ownership release: AppKit may still call willBegin.
// Quarantine the source in SOURCES (also preventing a second session on the same
// view) until its own ended callback, or button-up if it has never begun.
pub(crate) fn cancel_unstarted(pointer: usize, id: Option<&str>, timeout: bool) {
    let source = SOURCES.with_borrow(|sources| {
        let source = sources.get(&pointer)?;
        let lifecycle = &source.ivars().lifecycle;
        if lifecycle.begun.get() || id.is_some_and(|id| id != lifecycle.id) {
            return None;
        }
        Some(source.clone())
    });
    if let Some(source) = source {
        if source.ivars().lifecycle.can_cancel(id) {
            source.ivars().lifecycle.finish();
            let outcome = if timeout {
                let error =
                    "The native file drag did not start; release the mouse button and retry."
                        .to_owned();
                crate::logging::error(module_path!(), error.clone());
                Err(error)
            } else {
                Ok(())
            };
            if let Some(sender) = source.ivars().complete.borrow_mut().take() {
                let _ = sender.send(outcome);
            }
        }
        if source
            .ivars()
            .lifecycle
            .may_release(NSEvent::pressedMouseButtons())
        {
            SOURCES.with_borrow_mut(|sources| {
                remove_owned(
                    sources,
                    pointer,
                    Retained::as_ptr(&source) as usize,
                    |source| Retained::as_ptr(source) as usize,
                )
            });
        }
    }
}

fn start_inner(
    pointer: usize,
    native_window: usize,
    paths: Vec<File>,
    origin: crate::project_entry_drag::Origin,
    id: String,
    sender: Completion,
) -> Result<(), (Completion, String)> {
    let Some(main) = MainThreadMarker::new() else {
        return Err((sender, "File drag must start on the main thread.".into()));
    };
    // SAFETY: Tauri calls synchronously with the live window's native pointers.
    let view = unsafe { &*(pointer as *const NSView) };
    let window = unsafe { &*(native_window as *const NSWindow) };
    if NSEvent::pressedMouseButtons() & 1 == 0 || !window.isKeyWindow() {
        let _ = sender.send(Ok(()));
        return Ok(());
    }
    if SOURCES.with_borrow(|sources| sources.contains_key(&pointer)) {
        return Err((sender, "Another native file drag is active.".into()));
    }
    let Some(event) = NSApplication::sharedApplication(main).currentEvent() else {
        return Err((
            sender,
            "The file drag gesture expired; please retry.".into(),
        ));
    };
    if !matches!(
        event.r#type(),
        NSEventType::LeftMouseDown | NSEventType::LeftMouseDragged
    ) || event.windowNumber() != window.windowNumber()
    {
        return Err((
            sender,
            "The file drag gesture expired; please retry.".into(),
        ));
    }
    let point = view.convertPoint_fromView(event.locationInWindow(), None);
    // System templates are cached; don't perform per-file icon/disk lookups on
    // the UI thread. AppKit displays one real file-URL item per selected root.
    let image = NSImage::imageNamed(&NSString::from_str("NSMultipleDocuments"));
    let mut items = Vec::new();
    for (index, file) in paths.iter().enumerate() {
        let url =
            NSURL::fileURLWithPath_isDirectory(&NSString::from_str(&file.path), file.directory);
        let item = NSDraggingItem::initWithPasteboardWriter(
            NSDraggingItem::alloc(),
            ProtocolObject::from_ref(&*url),
        );
        let offset = (index.min(4) * 3) as f64;
        unsafe {
            item.setDraggingFrame_contents(
                NSRect::new(
                    NSPoint::new(point.x + offset, point.y - 32.0 - offset),
                    NSSize::new(32.0, 32.0),
                ),
                image.as_deref().map(|image| &***image),
            );
        }
        items.push(item);
    }
    let source = Source::alloc(main).set_ivars(SourceIvars {
        pointer,
        _view: view.retain(),
        origin,
        lifecycle: Lifecycle::new(id),
        complete: RefCell::new(Some(sender)),
    });
    let source: Retained<Source> = unsafe { msg_send![super(source), init] };
    SOURCES.with_borrow_mut(|sources| {
        sources.insert(pointer, source.clone());
    });
    let _session = view.beginDraggingSessionWithItems_event_source(
        &NSArray::from_retained_slice(&items),
        &event,
        ProtocolObject::from_ref(&*source),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_new_expired_gesture_cannot_steal_a_quarantined_sources_watchdog() {
        let old = Lifecycle::new("old".into());
        let mut stopped = old.watch("old").unwrap();
        old.finish();
        // start_inner may return Ok without inserting a new source when the
        // new gesture has already ended. Lookup still finds the old source.
        assert!(old.watch("new").is_none());
        assert!(old.watch("old").is_none());
        assert!(matches!(
            stopped.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        old.end();
        assert!(matches!(
            stopped.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
    }
    #[test]
    fn retired_sources_stay_owned_and_stale_end_cannot_remove_a_new_session() {
        use std::rc::Rc;
        let old = Rc::new(Lifecycle::new("old".into()));
        let old_id = Rc::as_ptr(&old) as usize;
        let weak = Rc::downgrade(&old);
        let mut sources = HashMap::from([(7, old.clone())]);
        old.finish();
        assert!(!old.may_release(1));
        drop(old);
        assert!(weak.upgrade().is_some());
        let source = sources.get(&7).unwrap();
        assert!(source.may_release(0));
        // A late willBegin after acknowledgement still needs a retained source.
        source.begin();
        assert!(!source.may_release(0));
        let ended = remove_owned(&mut sources, 7, old_id, |source| {
            Rc::as_ptr(source) as usize
        });
        assert!(weak.upgrade().is_some());
        let newer = Rc::new(Lifecycle::new("new".into()));
        let newer_id = Rc::as_ptr(&newer) as usize;
        sources.insert(7, newer);
        assert!(
            remove_owned(&mut sources, 7, old_id, |source| Rc::as_ptr(source)
                as usize)
            .is_none()
        );
        assert!(sources.contains_key(&7));
        assert!(
            remove_owned(&mut sources, 7, newer_id, |source| Rc::as_ptr(source)
                as usize)
            .is_some()
        );
        drop(ended);
        assert!(weak.upgrade().is_none());
    }
    #[test]
    fn lifecycle_cancellation_is_identity_checked_and_releases_watchdogs() {
        let lifecycle = Lifecycle::new("current".into());
        assert!(!lifecycle.can_cancel(Some("old")));
        assert!(lifecycle.can_cancel(Some("current")));
        let (stop, mut stopped) = oneshot::channel();
        *lifecycle.watchdog.borrow_mut() = Some(stop);
        lifecycle.begin();
        assert!(matches!(
            stopped.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
        assert!(!lifecycle.can_cancel(None));
        lifecycle.finish();
        assert!(!lifecycle.can_cancel(Some("current")));
        let unstarted = Lifecycle::new("unstarted".into());
        let (stop, mut stopped) = oneshot::channel();
        *unstarted.watchdog.borrow_mut() = Some(stop);
        unstarted.end();
        assert!(matches!(
            stopped.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
        assert!(!unstarted.can_cancel(None));
    }
    #[test]
    fn external_default_is_copy_and_command_is_move_without_generic_or_delete() {
        assert_eq!(operation(false, false), NSDragOperation::Copy);
        assert_eq!(operation(false, true), NSDragOperation::Move);
        assert_eq!(
            operation(true, false),
            NSDragOperation::Copy | NSDragOperation::Move
        );
        assert_eq!(operation(true, true), operation(true, false));
    }
}
