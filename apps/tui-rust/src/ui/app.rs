//! Conversation model.
//!
//! We accumulate a flat list of `Block`s. Each event from the sidecar
//! either appends a new block, mutates the trailing block, or is
//! rendered as a raw event line (so we never lose information while the
//! event-type catalogue is still being fleshed out).
//!
//! Scroll state lives in `ScrollView`; layout/render caching lives in
//! `Viewport`. Both are owned by `App` and exposed for the renderer and
//! the input handler.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde_json::Value;

use crate::bridge::protocol::{get_nonempty_str, get_str, EventKind};
use crate::config::PixConfig;
use crate::ui::autocomplete::AutocompleteState;
use crate::ui::input_editor::{InputDraftState, InputEditor};
use crate::ui::links::LinkClickTarget;
use crate::ui::model_picker::ModelPickerState;
use crate::ui::popup::{ActivePopup, PopupKind};
use crate::ui::scroll::ScrollView;
use crate::ui::session_list::SessionListState;
use crate::ui::session_search::SessionSearchState;
use crate::ui::subagents_view::{is_subagents_tool_name, SubagentsState};
use crate::ui::tabs_state::TabsState;
use crate::ui::theme::Theme;
use crate::ui::toast::{ToastKindLabel, ToastLevel, ToastQueue};
use crate::ui::todo_view::{is_todo_tool_name, TodoState};
use crate::ui::viewport::{Viewport, ViewportWidth};
use crate::ui::voice::{
    VoiceController, VoiceEvent, VoiceInputState, VOICE_DISABLED_MESSAGE, VOICE_ENABLE_COMMAND,
};
use crate::ui::workspace_history::WorkspaceHistory;

#[derive(Debug, Clone)]
pub enum Block {
    /// Local user echo. We render it eagerly; the sidecar later confirms
    /// via an event but we don't wait for that in the slice.
    User { text: String },
    /// Streaming assistant text. Accumulated deltas.
    Assistant {
        text: String,
        done: bool,
        provider: Option<String>,
        model: Option<String>,
    },
    /// A tool invocation: name, raw args, running state.
    ToolCall {
        call_id: String,
        name: String,
        args: Value,
        status: ToolStatus,
    },
    /// A tool result paired with the call above (matched by call_id).
    ToolResult {
        call_id: String,
        summary: String,
        ok: bool,
    },
    /// Anything else the sidecar emitted. Rendered as a single line for
    /// debuggability while we extend the typed catalog.
    RawEvent { type_: String, line: String },
    /// Diagnostics: sidecar stderr or local errors.
    Diag { kind: DiagKind, text: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolStatus {
    Pending,
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiagKind {
    Stderr,
    BridgeError,
    Info,
}

/// Index of a tool call by `call_id` so tool_result events can find their pair.
#[derive(Debug, Default, Clone)]
pub struct CallIndex {
    pub by_call_id: BTreeMap<String, usize>,
}

impl CallIndex {
    pub fn insert(&mut self, call_id: String, idx: usize) {
        self.by_call_id.insert(call_id, idx);
    }
    pub fn get(&self, call_id: &str) -> Option<usize> {
        self.by_call_id.get(call_id).copied()
    }
}

#[derive(Debug)]
pub struct App {
    pub cwd: String,
    pub workspace_root: PathBuf,
    pub workspace_history: WorkspaceHistory,
    pub config: PixConfig,
    pub theme_cache: Theme,
    pub session_id: Option<String>,
    pub session_file: Option<String>,
    pub session_name: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub message_count: Option<usize>,
    pub is_streaming: bool,
    pub last_token_count: Option<u64>,
    pub context_limit: Option<u64>,
    pub tool_use_count: u32,
    pub last_error: Option<String>,
    pub subagents_state: SubagentsState,
    pub todo_state: TodoState,
    pub voice: VoiceController,
    pub voice_partial_text: Option<String>,

    pub blocks: Vec<Block>,
    pub call_index: CallIndex,

    /// Multi-line input editor for the prompt area.
    pub input: InputEditor,
    pub autocomplete: AutocompleteState,

    /// Conversation viewport cache (per-width layouts + rendered lines).
    pub viewport: Viewport,
    /// Scroll state (follow-tail vs detached).
    pub scroll: ScrollView,

    /// Cached metrics from the most recent render. Used by the input
    /// handler to translate PageUp/PageDown/arrow keys without having to
    /// re-measure the conversation first.
    pub last_line_count: usize,
    pub last_body_height: usize,

    /// Clickable file hyperlinks from the most recent conversation render.
    pub link_click_targets: Vec<LinkClickTarget>,

    /// Bridge status string (last stderr line, "ready", exit code, ...).
    pub bridge_status: String,

    /// Transient diagnostics rendered as overlay toasts.
    pub toasts: ToastQueue,

    pub active_popup: Option<ActivePopup>,

    pub tabs: TabsState,

    /// Per-tab live-session snapshots. This is the first Rust-side step toward
    /// TS pix's multi-runtime tabs: conversation/session UI state is no longer
    /// owned only by the globally active `App`, and can be parked/restored when
    /// switching tabs. The current bridge is still single-active-runtime; the
    /// next layer can replace each snapshot with a live bridge runtime.
    pub tab_runtime_snapshots: BTreeMap<String, TabRuntimeSnapshot>,

    pub session_list: SessionListState,

    pub session_search: SessionSearchState,

    pub model_picker: ModelPickerState,

    pub quit: bool,
}

#[derive(Debug, Clone)]
pub struct TabRuntimeSnapshot {
    pub cwd: String,
    pub session_id: Option<String>,
    pub session_file: Option<String>,
    pub session_name: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub message_count: Option<usize>,
    pub is_streaming: bool,
    pub last_token_count: Option<u64>,
    pub context_limit: Option<u64>,
    pub tool_use_count: u32,
    pub last_error: Option<String>,
    pub blocks: Vec<Block>,
    pub call_index: CallIndex,
    pub subagents_state: SubagentsState,
    pub todo_state: TodoState,
    pub scroll: ScrollView,
    pub last_line_count: usize,
    pub last_body_height: usize,
}

impl TabRuntimeSnapshot {
    fn from_app(app: &App) -> Self {
        Self {
            cwd: app.cwd.clone(),
            session_id: app.session_id.clone(),
            session_file: app.session_file.clone(),
            session_name: app.session_name.clone(),
            provider: app.provider.clone(),
            model: app.model.clone(),
            message_count: app.message_count,
            is_streaming: app.is_streaming,
            last_token_count: app.last_token_count,
            context_limit: app.context_limit,
            tool_use_count: app.tool_use_count,
            last_error: app.last_error.clone(),
            blocks: app.blocks.clone(),
            call_index: app.call_index.clone(),
            subagents_state: app.subagents_state.clone(),
            todo_state: app.todo_state.clone(),
            scroll: app.scroll.clone(),
            last_line_count: app.last_line_count,
            last_body_height: app.last_body_height,
        }
    }
}

impl App {
    pub fn new(cwd: String) -> Self {
        let workspace_root = PathBuf::from(&cwd);
        Self::with_config(cwd, workspace_root, PixConfig::default())
    }

    pub fn with_config(cwd: String, workspace_root: PathBuf, mut config: PixConfig) -> Self {
        config.refresh_derived();
        let initial_model = (!config.model.trim().is_empty()).then(|| config.model.clone());
        let theme_cache = Theme::by_name(&config.theme_name);
        let voice = VoiceController::new(&config.dictation);
        Self {
            cwd,
            workspace_root,
            workspace_history: WorkspaceHistory::default(),
            config,
            theme_cache,
            session_id: None,
            session_file: None,
            session_name: None,
            provider: None,
            model: initial_model,
            message_count: None,
            is_streaming: false,
            last_token_count: None,
            context_limit: None,
            tool_use_count: 0,
            last_error: None,
            subagents_state: SubagentsState::default(),
            todo_state: TodoState::default(),
            voice,
            voice_partial_text: None,
            blocks: Vec::new(),
            call_index: CallIndex::default(),
            input: InputEditor::new(),
            autocomplete: AutocompleteState::default(),
            viewport: Viewport::new(),
            scroll: ScrollView::default(),
            last_line_count: 0,
            last_body_height: 0,
            link_click_targets: Vec::new(),
            bridge_status: "starting sidecar…".to_string(),
            toasts: ToastQueue::default(),
            active_popup: None,
            tabs: TabsState::default(),
            tab_runtime_snapshots: BTreeMap::new(),
            session_list: SessionListState::default(),
            session_search: SessionSearchState::default(),
            model_picker: ModelPickerState::default(),
            quit: false,
        }
    }

    pub fn load_config(cli_model_ref: Option<&str>) -> anyhow::Result<PixConfig> {
        Ok(crate::config::load_config_with_cli_model(cli_model_ref)?)
    }

    pub fn refresh_theme_cache(&mut self) {
        self.theme_cache = Theme::by_name(&self.config.theme_name);
    }

    pub fn tick_toasts(&mut self, now: Instant) -> bool {
        self.toasts.purge_expired(now)
    }

    pub fn open_popup(&mut self, kind: PopupKind) {
        self.active_popup = Some(ActivePopup::new(kind));
    }

    pub fn open_session_picker(&mut self) {
        self.session_list.open(self.session_file.as_deref());
        self.active_popup = Some(ActivePopup::new(PopupKind::SessionPicker));
    }

    pub fn close_popup(&mut self) {
        self.active_popup = None;
    }

    pub fn open_model_picker(&mut self) {
        self.model_picker.open();
        self.active_popup = Some(ActivePopup::new(PopupKind::ModelPicker));
    }

    pub fn open_session_search(&mut self, query: String) {
        let blocks = self.blocks.clone();
        self.session_search.open(query.clone(), &blocks);
        self.active_popup = Some(ActivePopup::new(PopupKind::Search { query }));
    }

    pub fn refresh_session_search(&mut self) {
        let blocks = self.blocks.clone();
        self.session_search.search_blocks(&blocks);
        if let Some(active) = self.active_popup.as_mut() {
            if matches!(active.kind, PopupKind::Search { .. }) {
                active.kind = PopupKind::Search {
                    query: self.session_search.query.clone(),
                };
            }
        }
    }

    pub fn search_query_push(&mut self, c: char) {
        let blocks = self.blocks.clone();
        self.session_search.push_query_char(c, &blocks);
        self.sync_search_popup_query();
    }

    pub fn search_query_pop(&mut self) -> bool {
        let blocks = self.blocks.clone();
        let changed = self.session_search.pop_query_char(&blocks);
        if changed {
            self.sync_search_popup_query();
        }
        changed
    }

    pub fn scroll_to_block_idx(&mut self, idx: usize, viewport_width: ViewportWidth) -> bool {
        if idx >= self.blocks.len() || self.last_body_height == 0 {
            return false;
        }

        let total = self.viewport.line_count(&self.blocks, viewport_width);
        let mut target = None;
        for offset in 0..total {
            if self.viewport.hit_test(&self.blocks, viewport_width, offset) == Some(idx) {
                target = Some(offset);
                break;
            }
        }
        let Some(target) = target else {
            return false;
        };

        let max_scroll = total.saturating_sub(self.last_body_height);
        let target = target.min(max_scroll);
        let from_bottom = total
            .saturating_sub(self.last_body_height)
            .saturating_sub(target);
        self.scroll.scroll_from_bottom = from_bottom;
        self.scroll.detached_start = (from_bottom != 0).then_some(target);
        true
    }

    fn sync_search_popup_query(&mut self) {
        if let Some(active) = self.active_popup.as_mut() {
            if matches!(active.kind, PopupKind::Search { .. }) {
                active.kind = PopupKind::Search {
                    query: self.session_search.query.clone(),
                };
            }
        }
    }

    pub fn refresh_autocomplete(&mut self, workspace_root: Option<&Path>) {
        self.autocomplete
            .refresh(self.input.text(), self.input.cursor(), workspace_root);
    }

    pub fn configure_workspace_history(&mut self, max_entries: usize) {
        self.workspace_history.set_max_entries(max_entries);
    }

    pub fn load_tabs_best_effort(&mut self) {
        if let Ok(tabs) = TabsState::load_for_workspace(&self.workspace_root) {
            self.tabs = tabs;
        }
    }

    pub fn persist_tabs_best_effort(&self) {
        let _ = self.tabs.save_for_workspace(&self.workspace_root);
    }

    pub fn sync_tabs_with_current_session(&mut self) {
        if self.tabs.sync_current_session(
            &self.workspace_root,
            self.session_file.as_deref(),
            self.session_id.as_deref(),
            self.session_name.as_deref(),
        ) {
            self.persist_tabs_best_effort();
        }
    }

    pub fn startup_restore_session_path(&self) -> Option<String> {
        self.tabs.startup_restore_path()
    }

    pub fn save_active_input_to_tabs(&mut self) {
        if self.tabs.save_active_draft(self.input.draft_state()) {
            self.persist_tabs_best_effort();
        }
    }

    pub fn save_active_runtime_state(&mut self) {
        let Some(key) = self.active_runtime_key() else {
            return;
        };
        self.tab_runtime_snapshots
            .insert(key, TabRuntimeSnapshot::from_app(self));
    }

    pub fn restore_active_runtime_state(&mut self) -> bool {
        let Some(key) = self.active_runtime_key() else {
            return false;
        };
        self.restore_runtime_state_for_key(&key)
    }

    pub fn restore_runtime_state_for_key(&mut self, key: &str) -> bool {
        let Some(snapshot) = self.tab_runtime_snapshots.get(key).cloned() else {
            return false;
        };

        self.cwd = snapshot.cwd;
        self.session_id = snapshot.session_id;
        self.session_file = snapshot.session_file;
        self.session_name = snapshot.session_name;
        self.provider = snapshot.provider;
        self.model = snapshot.model;
        self.message_count = snapshot.message_count;
        self.is_streaming = snapshot.is_streaming;
        self.last_token_count = snapshot.last_token_count;
        self.context_limit = snapshot.context_limit;
        self.tool_use_count = snapshot.tool_use_count;
        self.last_error = snapshot.last_error;
        self.blocks = snapshot.blocks;
        self.call_index = snapshot.call_index;
        self.subagents_state = snapshot.subagents_state;
        self.todo_state = snapshot.todo_state;
        self.scroll = snapshot.scroll;
        self.last_line_count = snapshot.last_line_count;
        self.last_body_height = snapshot.last_body_height;
        self.link_click_targets.clear();
        self.session_search.clear();
        self.viewport.invalidate();
        self.restore_input_from_active_tab();
        true
    }

    pub fn runtime_state_is_streaming(&self, key: &str) -> bool {
        self.tab_runtime_snapshots
            .get(key)
            .map(|snapshot| snapshot.is_streaming)
            .unwrap_or(false)
    }

    pub fn active_runtime_key(&self) -> Option<String> {
        self.session_file
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                self.session_id
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
            })
            .map(str::to_string)
    }

    pub fn restore_input_from_active_tab(&mut self) {
        let draft = self
            .tabs
            .active_draft()
            .cloned()
            .unwrap_or_else(InputDraftState::default);
        self.input.set_draft_state(draft);
        self.autocomplete.dismiss();
    }

    pub fn remove_tab_path(&mut self, session_path: &str) {
        self.tab_runtime_snapshots.remove(session_path);
        if self.tabs.remove_path(session_path) {
            self.persist_tabs_best_effort();
        }
    }

    pub fn switch_tab_relative(&mut self, delta: isize) -> Option<String> {
        let next = self.tabs.switch_relative(delta);
        if next.is_some() {
            self.persist_tabs_best_effort();
        }
        next
    }

    pub fn record_workspace_cwd(&mut self, cwd: impl Into<PathBuf>) {
        self.workspace_history.record_cwd(cwd.into());
    }

    pub fn undo_workspace_cwd(&mut self) -> Option<PathBuf> {
        match self.workspace_history.undo() {
            Some(path) => Some(path),
            None => {
                self.toasts.push(
                    ToastLevel::Info,
                    ToastKindLabel::Info,
                    "No earlier workspace",
                    4,
                );
                None
            }
        }
    }

    pub fn current_popup_kind(&self) -> Option<&PopupKind> {
        self.active_popup.as_ref().map(|p| &p.kind)
    }

    pub fn push_user_message(&mut self, text: &str) {
        self.blocks.push(Block::User {
            text: text.to_string(),
        });
        self.scroll_to_bottom();
    }

    pub fn push_diag(&mut self, kind: DiagKind, text: impl Into<String>) {
        self.blocks.push(Block::Diag {
            kind,
            text: text.into(),
        });
        self.scroll_to_bottom();
    }

    pub fn push_raw_event(&mut self, type_: String, line: String) {
        self.blocks.push(Block::RawEvent { type_, line });
        self.scroll_to_bottom();
    }

    pub fn reset_conversation(&mut self) {
        self.blocks.clear();
        self.call_index = CallIndex::default();
        self.input.clear();
        self.autocomplete.dismiss();
        self.viewport.invalidate();
        self.scroll.reset();
        self.is_streaming = false;
        self.last_token_count = None;
        self.tool_use_count = 0;
        self.last_error = None;
        self.todo_state.clear();
        self.subagents_state.clear();
        self.last_line_count = 0;
        self.link_click_targets.clear();
        self.session_search.clear();
    }

    pub fn apply_session_state(&mut self, state: &Value) {
        let previous_session_id = self.session_id.clone();
        let previous_session_file = self.session_file.clone();
        if let Some(s) =
            get_nonempty_str(state, "sessionId").or_else(|| get_nonempty_str(state, "session_id"))
        {
            self.session_id = Some(s.to_string());
        }
        if let Some(s) = get_nonempty_str(state, "sessionFile")
            .or_else(|| get_nonempty_str(state, "session_file"))
        {
            self.session_file = Some(s.to_string());
        }
        self.session_name = get_nonempty_str(state, "sessionName")
            .or_else(|| get_nonempty_str(state, "session_name"))
            .map(str::to_string);
        self.message_count = state
            .get("messageCount")
            .and_then(|value| value.as_u64())
            .and_then(|count| usize::try_from(count).ok())
            .or_else(|| {
                state
                    .get("message_count")
                    .and_then(|value| value.as_u64())
                    .and_then(|count| usize::try_from(count).ok())
            });
        if let Some(s) = get_nonempty_str(state, "cwd") {
            self.cwd = s.to_string();
        }
        if let Some(s) = get_nonempty_str(state, "provider") {
            self.provider = Some(s.to_string());
        }
        if let Some(model) = state.get("model") {
            self.apply_model_value(model);
        } else if let Some(s) = get_nonempty_str(state, "model") {
            self.apply_model_ref(s);
        }
        self.sync_config_model_from_status();
        self.sync_tabs_with_current_session();
        if self.session_id != previous_session_id || self.session_file != previous_session_file {
            self.restore_input_from_active_tab();
        }
    }

    pub fn apply_history_messages(&mut self, payload: &Value) -> usize {
        let Some(messages) = payload.get("messages").and_then(Value::as_array) else {
            return 0;
        };

        self.blocks.clear();
        self.call_index = CallIndex::default();
        for message in messages {
            let role = get_nonempty_str(message, "role").unwrap_or_default();
            match role {
                "user" => {
                    if let Some(text) = message_text(message) {
                        self.blocks.push(Block::User { text });
                    }
                }
                "assistant" => {
                    if let Some(text) = message_text(message) {
                        self.blocks.push(Block::Assistant {
                            text,
                            done: true,
                            provider: None,
                            model: None,
                        });
                    }
                }
                "custom" => {
                    if message
                        .get("display")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                    {
                        if let Some(text) = message_text(message) {
                            self.blocks.push(Block::Diag {
                                kind: DiagKind::Info,
                                text,
                            });
                        }
                    }
                }
                _ => {}
            }
        }

        self.viewport.invalidate();
        self.scroll.reset();
        self.last_line_count = 0;
        self.link_click_targets.clear();
        self.session_search.clear();
        self.blocks.len()
    }

    pub fn handle_event(&mut self, type_: &str, payload: &Value) {
        let kind = EventKind::from_type(type_);
        match kind {
            EventKind::AssistantMessagePart => self.handle_assistant_part(payload),
            EventKind::AssistantMessageEnd => self.handle_assistant_end(payload),
            EventKind::AssistantMessageStart => self.handle_assistant_start(payload),
            EventKind::ToolCallStart => self.handle_tool_call_start(payload),
            EventKind::ToolCallEnd => self.handle_tool_call_end(payload),
            EventKind::ToolResult => self.handle_tool_result(payload),
            EventKind::MessageStart
            | EventKind::MessageEnd
            | EventKind::StreamStart
            | EventKind::StreamEnd
            | EventKind::SessionStart => {
                self.apply_session_state(payload);
            }
            EventKind::ModelChange => self.handle_model_change(payload),
            EventKind::Error => {
                let msg = get_nonempty_str(payload, "error")
                    .or_else(|| get_nonempty_str(payload, "message"))
                    .unwrap_or("(unknown error)");
                self.push_diag(DiagKind::BridgeError, msg);
            }
            EventKind::Other => {
                let line = compact_json(payload);
                self.push_raw_event(type_.to_string(), line);
            }
        }
    }

    pub fn handle_voice_event(&mut self, ev: VoiceEvent) {
        match ev {
            VoiceEvent::StateChanged(VoiceInputState::Idle) => {
                self.voice_partial_text = None;
            }
            VoiceEvent::StateChanged(_) => {}
            VoiceEvent::Transcript(update) => {
                if let Some(partial) = update.partial {
                    self.voice_partial_text = Some(partial);
                }
                if let Some(text) = update.final_text {
                    let text = text.trim();
                    if !text.is_empty() {
                        self.input.insert(text);
                        self.input.insert_char(' ');
                        self.voice_partial_text = None;
                    }
                }
            }
            VoiceEvent::Error(message) => {
                self.voice_partial_text = None;
                let message = humanize_voice_error(&message);
                self.toasts
                    .push(ToastLevel::Warn, ToastKindLabel::Info, message, 0);
            }
            VoiceEvent::Progress(message) => {
                self.toasts
                    .push(ToastLevel::Info, ToastKindLabel::Info, message, 2);
            }
        }
    }

    fn handle_assistant_start(&mut self, payload: &Value) {
        let provider = get_nonempty_str(payload, "provider").map(String::from);
        let model = get_nonempty_str(payload, "model").map(String::from);
        if provider.is_some() {
            self.provider = provider.clone();
        }
        if model.is_some() {
            self.model = model.clone();
        }
        self.sync_config_model_from_status();
        self.blocks.push(Block::Assistant {
            text: String::new(),
            done: false,
            provider,
            model,
        });
        self.is_streaming = true;
        self.scroll_to_bottom();
    }

    fn handle_assistant_part(&mut self, payload: &Value) {
        let Some(delta) =
            get_nonempty_str(payload, "text").or_else(|| get_nonempty_str(payload, "delta"))
        else {
            return;
        };
        if !matches!(self.blocks.last(), Some(Block::Assistant { .. })) {
            self.blocks.push(Block::Assistant {
                text: String::new(),
                done: false,
                provider: None,
                model: None,
            });
        }
        if let Some(Block::Assistant { text, .. }) = self.blocks.last_mut() {
            text.push_str(delta);
        }
        self.scroll_to_bottom();
    }

    fn handle_assistant_end(&mut self, payload: &Value) {
        if let Some(Block::Assistant {
            done,
            provider,
            model,
            ..
        }) = self.blocks.last_mut()
        {
            *done = true;
            if let Some(p) = get_nonempty_str(payload, "provider") {
                *provider = Some(p.to_string());
                self.provider = Some(p.to_string());
            }
            if let Some(m) = get_nonempty_str(payload, "model") {
                *model = Some(m.to_string());
                self.model = Some(m.to_string());
            }
        }
        self.sync_config_model_from_status();
        if let Some(usage) = payload.get("usage") {
            let input = usage
                .get("input_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let output = usage
                .get("output_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            self.last_token_count = Some(input + output);
        }
        if let Some(limit) = payload.get("context_limit").and_then(Value::as_u64) {
            self.context_limit = Some(limit);
        }
        self.is_streaming = false;
    }

    fn handle_tool_call_start(&mut self, payload: &Value) {
        self.tool_use_count += 1;
        let name = get_nonempty_str(payload, "name")
            .unwrap_or("(tool)")
            .to_string();
        let call_id = get_nonempty_str(payload, "callId")
            .or_else(|| get_nonempty_str(payload, "id"))
            .unwrap_or("")
            .to_string();
        let mut args = payload.get("args").cloned().unwrap_or(Value::Null);
        self.update_subagents_from_tool_call(&name, &mut args);
        self.update_todo_from_tool_call(&name, &mut args);
        let idx = self.blocks.len();
        if !call_id.is_empty() {
            self.call_index.insert(call_id.clone(), idx);
        }
        self.blocks.push(Block::ToolCall {
            call_id,
            name,
            args,
            status: ToolStatus::Running,
        });
        self.scroll_to_bottom();
    }

    fn handle_tool_call_end(&mut self, payload: &Value) {
        let call_id = get_nonempty_str(payload, "callId")
            .or_else(|| get_nonempty_str(payload, "id"))
            .unwrap_or("");
        if let Some(idx) = self.call_index.get(call_id) {
            if let Some(Block::ToolCall { status, .. }) = self.blocks.get_mut(idx) {
                *status = ToolStatus::Completed;
            }
        }
    }

    fn handle_tool_result(&mut self, payload: &Value) {
        let call_id = get_nonempty_str(payload, "callId")
            .or_else(|| get_nonempty_str(payload, "id"))
            .unwrap_or("")
            .to_string();
        let ok = !matches!(get_str(payload, "status"), Some("error"));
        let summary = get_nonempty_str(payload, "summary")
            .or_else(|| get_nonempty_str(payload, "text"))
            .unwrap_or("(result)")
            .to_string();
        self.update_subagents_from_tool_result(&call_id, &summary, ok);
        self.update_todo_from_tool_result(&call_id, &summary, ok);
        self.blocks.push(Block::ToolResult {
            call_id,
            summary,
            ok,
        });
        self.scroll_to_bottom();
    }

    pub fn update_subagents_from_tool_call(&mut self, tool_name: &str, args: &mut Value) -> bool {
        self.subagents_state.record_tool_call(tool_name, args)
    }

    pub fn update_subagents_from_tool_result(
        &mut self,
        call_id: &str,
        summary: &str,
        ok: bool,
    ) -> bool {
        let Some(idx) = self.call_index.get(call_id) else {
            return false;
        };
        let Some(Block::ToolCall {
            name, args, status, ..
        }) = self.blocks.get_mut(idx)
        else {
            return false;
        };
        if !is_subagents_tool_name(name) {
            return false;
        }
        let updated = self
            .subagents_state
            .update_from_tool_result(name, args, summary, ok);
        if updated {
            *status = if ok {
                ToolStatus::Completed
            } else {
                ToolStatus::Failed
            };
        }
        updated
    }

    pub fn update_todo_from_tool_call(&mut self, tool_name: &str, args: &mut Value) -> bool {
        self.todo_state.record_tool_call(tool_name, args)
    }

    pub fn update_todo_from_tool_result(&mut self, call_id: &str, summary: &str, ok: bool) -> bool {
        let Some(idx) = self.call_index.get(call_id) else {
            return false;
        };
        let Some(Block::ToolCall {
            name, args, status, ..
        }) = self.blocks.get_mut(idx)
        else {
            return false;
        };
        if !is_todo_tool_name(name) {
            return false;
        }
        let updated = self
            .todo_state
            .update_from_tool_result(name, args, summary, ok);
        if updated {
            *status = if ok {
                ToolStatus::Completed
            } else {
                ToolStatus::Failed
            };
        }
        updated
    }

    /// Reset to follow-tail mode. Called after any conversation-mutating
    /// event so the view stays pinned to the new content.
    pub fn scroll_to_bottom(&mut self) {
        self.scroll.scroll_to_bottom();
    }

    /// Record the latest viewport metrics. Called by the renderer after
    /// each draw so the input handler can answer page-scroll keys without
    /// re-measuring.
    pub fn record_metrics(&mut self, line_count: usize, body_height: usize) {
        self.last_line_count = line_count;
        self.last_body_height = body_height;
    }

    pub fn input_insert(&mut self, c: char) {
        self.input.insert_char(c);
    }

    pub fn input_insert_str(&mut self, s: &str) {
        self.input.insert(s);
    }

    pub fn input_backspace(&mut self) {
        self.input.delete_backward();
    }

    pub fn set_model_status(&mut self, model: impl Into<String>) {
        self.apply_model_ref(&model.into());
        self.sync_config_model_from_status();
    }

    fn handle_model_change(&mut self, payload: &Value) {
        if let Some(model) = payload.get("model") {
            self.apply_model_value(model);
        } else if let Some(model_ref) = get_nonempty_str(payload, "ref") {
            self.apply_model_ref(model_ref);
        } else if let Some(model_id) = get_nonempty_str(payload, "modelId") {
            if let Some(provider) = get_nonempty_str(payload, "provider") {
                self.provider = Some(provider.to_string());
            }
            self.model = Some(model_id.to_string());
        }
        self.sync_config_model_from_status();
    }

    fn apply_model_value(&mut self, model: &Value) {
        if let Some(model_ref) = model.as_str() {
            self.apply_model_ref(model_ref);
            return;
        }
        if let Some(model_ref) = get_nonempty_str(model, "ref") {
            self.apply_model_ref(model_ref);
            return;
        }
        if let Some(provider) = get_nonempty_str(model, "provider") {
            self.provider = Some(provider.to_string());
        }
        if let Some(model_id) = get_nonempty_str(model, "id")
            .or_else(|| get_nonempty_str(model, "modelId"))
            .or_else(|| get_nonempty_str(model, "name"))
        {
            self.model = Some(model_id.to_string());
        }
    }

    fn apply_model_ref(&mut self, model_ref: &str) {
        let trimmed = model_ref.trim();
        if trimmed.is_empty() {
            return;
        }
        if let Some((provider, model)) = trimmed.split_once('/') {
            self.provider = Some(provider.to_string());
            self.model = Some(model.to_string());
        } else {
            self.model = Some(trimmed.to_string());
        }
    }

    fn sync_config_model_from_status(&mut self) {
        match (&self.provider, &self.model) {
            (Some(provider), Some(model)) if !provider.trim().is_empty() => {
                self.config.model = format!("{provider}/{model}");
            }
            (_, Some(model)) => {
                self.config.model = model.clone();
            }
            _ => {}
        }
    }
}

fn humanize_voice_error(message: &str) -> String {
    if message.contains(VOICE_DISABLED_MESSAGE) {
        return format!(
            "Voice input is unavailable in this build. Rebuild with: {VOICE_ENABLE_COMMAND}"
        );
    }
    if message.contains("no dictation languages are configured") {
        return "Voice input is not configured. Add dictation.languages entries or remove the custom dictation override to use defaults.".to_string();
    }
    if message.contains("dirName is required for voice input") {
        return format!("Voice input is not configured correctly: {message}");
    }
    if message.contains("no microphone detected") {
        return "Voice input could not find a microphone.".to_string();
    }
    if message.contains("16kHz input format") {
        return "Voice input needs a microphone that supports 16 kHz capture.".to_string();
    }
    format!("Voice input unavailable: {message}")
}

/// Free-function so other modules (the viewport) can read a block's
/// version without taking a reference to `App`. The viewport uses this
/// to decide whether its cached rendering of a block is stale.
///
/// The version is derived from the block's mutable state:
/// - `Assistant` changes when `text` grows or `done` flips.
/// - `ToolCall` changes when `status` or args change.
/// - Everything else is immutable once pushed: version is constant.
pub fn block_version(blocks: &[Block], idx: usize) -> u64 {
    match blocks.get(idx) {
        Some(Block::Assistant { text, done, .. }) => {
            let mut v: u64 = text.len() as u64;
            if *done {
                v |= 1u64 << 63;
            }
            v
        }
        Some(Block::ToolCall { status, args, .. }) => {
            let mut v: u64 = 1;
            v |= (*status as u64) << 8;
            if let Some(arr) = args.as_array() {
                v ^= arr.len() as u64;
            }
            if let Some(obj) = args.as_object() {
                v ^= obj.len() as u64;
            }
            v
        }
        Some(_) => 1,
        None => 0,
    }
}

fn compact_json(v: &Value) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| format!("{v}"))
}

fn message_text(message: &Value) -> Option<String> {
    if let Some(text) = get_nonempty_str(message, "content") {
        return Some(text.to_string());
    }

    if let Some(text) = message
        .get("content")
        .and_then(|content| content.get("text"))
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
    {
        return Some(text.to_string());
    }

    let parts = message.get("content")?.as_array()?;
    let text = parts
        .iter()
        .filter_map(|part| {
            part.get("text")
                .and_then(Value::as_str)
                .or_else(|| part.get("content").and_then(Value::as_str))
        })
        .filter(|text| !text.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    (!text.trim().is_empty()).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    use crate::ui::voice::VoiceTranscriptUpdate;

    #[test]
    fn apply_session_state_reads_nested_model_object() {
        let mut app = App::new("/tmp".to_string());
        app.apply_session_state(&json!({
            "model": {
                "provider": "openai-codex",
                "id": "gpt-5.5",
                "ref": "openai-codex/gpt-5.5"
            }
        }));

        assert_eq!(app.provider.as_deref(), Some("openai-codex"));
        assert_eq!(app.model.as_deref(), Some("gpt-5.5"));
        assert_eq!(app.config.model, "openai-codex/gpt-5.5");
    }

    #[test]
    fn handle_event_model_change_updates_status_without_raw_block() {
        let mut app = App::new("/tmp".to_string());
        app.handle_event(
            "model_change",
            &json!({ "provider": "anthropic", "modelId": "claude-sonnet" }),
        );

        assert_eq!(app.provider.as_deref(), Some("anthropic"));
        assert_eq!(app.model.as_deref(), Some("claude-sonnet"));
        assert!(app.blocks.is_empty());
    }

    #[test]
    fn voice_error_is_humanized_for_feature_disabled_builds() {
        let mut app = App::new("/tmp".to_string());

        app.handle_voice_event(VoiceEvent::Error(VOICE_DISABLED_MESSAGE.to_string()));

        let toast = app.toasts.latest().expect("voice toast");
        assert!(toast
            .message
            .contains("Voice input is unavailable in this build"));
        assert!(toast.message.contains(VOICE_ENABLE_COMMAND));
    }

    #[test]
    fn voice_transcript_final_text_appends_to_input_and_clears_partial() {
        let mut app = App::new("/tmp".to_string());
        app.voice_partial_text = Some("draft".to_string());

        app.handle_voice_event(VoiceEvent::Transcript(VoiceTranscriptUpdate {
            partial: None,
            final_text: Some("hello world".to_string()),
        }));

        assert_eq!(app.input.text(), "hello world ");
        assert!(app.voice_partial_text.is_none());
    }

    #[test]
    fn tab_runtime_snapshots_restore_conversation_state_by_session_file() {
        let mut app = App::new("/tmp/pix-tabs-test".to_string());

        app.apply_session_state(&json!({
            "sessionId": "session-a",
            "sessionFile": "/tmp/pix-tabs-test/a.jsonl",
            "cwd": "/tmp/pix-tabs-test",
            "model": "test/model-a"
        }));
        app.push_user_message("hello from a");
        app.handle_event(
            "assistant_message_start",
            &json!({ "provider": "test", "model": "model-a" }),
        );
        app.handle_event("assistant_message_part", &json!({ "text": "answer a" }));
        app.handle_event("assistant_message_end", &json!({}));
        app.tool_use_count = 7;
        app.save_active_runtime_state();

        app.reset_conversation();
        app.apply_session_state(&json!({
            "sessionId": "session-b",
            "sessionFile": "/tmp/pix-tabs-test/b.jsonl",
            "cwd": "/tmp/pix-tabs-test",
            "model": "test/model-b"
        }));
        app.push_user_message("hello from b");
        app.tool_use_count = 3;
        app.save_active_runtime_state();

        app.reset_conversation();
        app.apply_session_state(&json!({
            "sessionId": "session-a",
            "sessionFile": "/tmp/pix-tabs-test/a.jsonl",
            "cwd": "/tmp/pix-tabs-test"
        }));

        assert!(app.restore_active_runtime_state());
        assert_eq!(app.session_id.as_deref(), Some("session-a"));
        assert_eq!(app.tool_use_count, 7);
        assert!(matches!(app.blocks.first(), Some(Block::User { text }) if text == "hello from a"));
        assert!(
            matches!(app.blocks.get(1), Some(Block::Assistant { text, done: true, .. }) if text == "answer a")
        );

        app.reset_conversation();
        app.apply_session_state(&json!({
            "sessionId": "session-b",
            "sessionFile": "/tmp/pix-tabs-test/b.jsonl",
            "cwd": "/tmp/pix-tabs-test"
        }));

        assert!(app.restore_active_runtime_state());
        assert_eq!(app.session_id.as_deref(), Some("session-b"));
        assert_eq!(app.tool_use_count, 3);
        assert!(matches!(app.blocks.first(), Some(Block::User { text }) if text == "hello from b"));
    }

    #[test]
    fn apply_history_messages_hydrates_visible_user_and_assistant_blocks() {
        let mut app = App::new("/tmp".to_string());
        let count = app.apply_history_messages(&json!({
            "messages": [
                { "role": "user", "content": [{ "type": "text", "text": "hello" }] },
                { "role": "assistant", "content": "world" },
                { "role": "custom", "display": true, "content": "system note" }
            ]
        }));

        assert_eq!(count, 3);
        assert!(matches!(app.blocks.first(), Some(Block::User { text }) if text == "hello"));
        assert!(
            matches!(app.blocks.get(1), Some(Block::Assistant { text, done: true, .. }) if text == "world")
        );
        assert!(
            matches!(app.blocks.get(2), Some(Block::Diag { kind: DiagKind::Info, text }) if text == "system note")
        );
    }
}
