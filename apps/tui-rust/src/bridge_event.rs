//! Unified event type fed into the App's main loop.
//!
//! Combines terminal events (keyboard, resize) with bridge events (agent
//! streams, sidecar stderr/exit) so the App owns a single select loop.

use crate::bridge::{BridgeClient, BridgeEvent, BridgeHandle};
use crate::ui::app::DiagKind;
use crate::ui::enhancer::EnhancerError;
use crate::ui::model_picker::ModelSummary;
use crate::ui::session_list::SessionSummary;
use crate::ui::tabs_state::TabsState;
use crate::ui::voice::VoiceEvent;
use crossterm::event::Event as TermEvent;
use serde_json::Value;

#[derive(Clone)]
pub struct CloseTabRollback {
    pub tabs: TabsState,
    pub loading_runtime_key: Option<String>,
    pub pending_new_tab: bool,
    pub previous_runtime_key: Option<String>,
}

pub enum AppEvent {
    /// Terminal: key press, resize, focus, mouse, paste.
    Term(TermEvent),
    /// Sidecar -> TUI: assistant tokens, tool blocks, stderr lines, exit.
    Bridge(BridgeEvent),
    /// Sidecar -> TUI for a specific live tab runtime.
    TabBridge {
        runtime_id: String,
        event: BridgeEvent,
    },
    /// Local async task diagnostic to surface in the conversation pane.
    Diag(DiagKind, String),
    /// Local async task session state response to apply to the app.
    SessionState(Value),
    /// Local async task session state response scoped to one live tab runtime.
    TabSessionState { runtime_id: String, state: Value },
    /// Result of switching tabs/sessions; reset conversation then apply state.
    SwitchedSessionState(Value),
    /// Result of activating a live tab runtime.
    ActivatedTabState { runtime_id: String, state: Value },
    /// Result of spawning a live tab runtime in the background.
    SpawnedTabRuntime {
        runtime_id: String,
        client: BridgeClient,
        handle: BridgeHandle,
        state: Value,
        activate: bool,
    },
    /// Background runtime activation/spawn failure.
    RuntimeActivationFailed {
        message: String,
        session_key: Option<String>,
    },
    /// Background-loaded history tail for a specific live tab runtime.
    RuntimeHistoryLoaded {
        runtime_id: String,
        result: Result<Value, String>,
    },
    /// Result of starting a new session; reset conversation then apply state.
    NewSessionState(Value),
    /// Result of starting a new live tab runtime/session.
    NewTabRuntimeState { runtime_id: String, state: Value },
    /// Result of closing a tab and landing on another session/new tab.
    ClosedTabState { state: Value, closed_path: String },
    /// Result of closing a live tab runtime and landing on another runtime.
    ClosedTabRuntimeState {
        runtime_id: String,
        state: Value,
        closed_path: String,
    },
    /// Result of spawning a new runtime while closing an active tab.
    SpawnedClosedTabRuntime {
        runtime_id: String,
        client: BridgeClient,
        handle: BridgeHandle,
        state: Value,
        closed_path: String,
    },
    /// Failed background close-tab follow-up; restore previous UI state.
    CloseTabFailed {
        message: String,
        rollback: CloseTabRollback,
    },
    /// Refreshed persisted sessions for the current workspace.
    SessionList(Result<Vec<SessionSummary>, String>),
    /// Result of an async prompt enhancement request.
    EnhancerResult(Result<String, EnhancerError>),
    /// Async model catalog load for the model picker.
    ModelPickerLoaded(Result<Vec<ModelSummary>, String>),
    /// Async model switch result toast.
    ModelSwitchResult(Result<String, String>),
    /// Async thinking-level switch result toast.
    ThinkingSwitchResult(Result<String, String>),
    /// Voice dictation state/progress/transcript updates.
    VoiceEvent(VoiceEvent),
    /// Internal tick (e.g. cursor blink). Currently unused in the slice.
    Tick,
}
