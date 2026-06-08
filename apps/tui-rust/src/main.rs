//! pix-tui entrypoint.
//!
//! Boot order:
//! 1. Parse CLI flags.
//! 2. Install tracing + crossterm terminal mode.
//! 3. Spawn the pix-desktop-sidecar subprocess.
//! 4. Drive the unified event loop (terminal events + bridge events) on the
//!    Tokio runtime, calling into `ui::render` whenever state changes.
//! 5. Tear down: sidecar shutdown + terminal restore.

use anyhow::{anyhow, Context, Result};
use crossterm::cursor::{Hide, Show};
use crossterm::event::{
    DisableMouseCapture, EnableMouseCapture, Event as TermEvent, EventStream, KeyCode, KeyEvent,
    KeyModifiers, MouseEvent,
};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use futures::StreamExt;
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::Terminal;
use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};
use tracing_subscriber::EnvFilter;

use pix_tui::bridge::{self, spawn_bridge_with_session_mode, BridgeEvent};
use pix_tui::bridge_event::AppEvent;
use pix_tui::cli;
use pix_tui::runtime;
use pix_tui::ui;
use pix_tui::ui::app::DiagKind;
use pix_tui::ui::enhancer::EnhancerError;
use pix_tui::ui::file_link_opener::{open_file_link, OpenTarget};
use pix_tui::ui::popup::PopupKind;
use pix_tui::ui::render::{INPUT_CONT_PREFIX, INPUT_FIRST_PREFIX};
use pix_tui::ui::toast::{ToastKindLabel, ToastLevel};

struct TabRuntime {
    client: bridge::BridgeClient,
    handle: bridge::BridgeHandle,
    session_key: Option<String>,
}

struct TabRuntimeManager {
    cwd: Option<PathBuf>,
    session_mode: Option<String>,
    tx: mpsc::Sender<AppEvent>,
    next_id: u64,
    active_runtime_id: String,
    runtimes: HashMap<String, TabRuntime>,
    runtime_by_session_key: HashMap<String, String>,
}

impl TabRuntimeManager {
    async fn new(
        cwd: Option<PathBuf>,
        session_mode: Option<String>,
        tx: mpsc::Sender<AppEvent>,
        startup_session_path: Option<String>,
        startup_name: Option<String>,
    ) -> Result<(Self, serde_json::Value)> {
        let mut manager = Self {
            cwd,
            session_mode,
            tx,
            next_id: 0,
            active_runtime_id: String::new(),
            runtimes: HashMap::new(),
            runtime_by_session_key: HashMap::new(),
        };
        let runtime_id = manager.alloc_runtime_id();
        let state = manager
            .spawn_runtime(runtime_id.clone(), startup_session_path, startup_name)
            .await?;
        manager.active_runtime_id = runtime_id;
        Ok((manager, state))
    }

    fn active_client(&self) -> Option<bridge::BridgeClient> {
        self.runtimes
            .get(&self.active_runtime_id)
            .map(|runtime| runtime.client.clone())
    }

    fn client_for_runtime(&self, runtime_id: &str) -> Option<bridge::BridgeClient> {
        self.runtimes
            .get(runtime_id)
            .map(|runtime| runtime.client.clone())
    }

    fn active_runtime_id(&self) -> &str {
        &self.active_runtime_id
    }

    fn set_active_runtime(&mut self, runtime_id: String) {
        self.active_runtime_id = runtime_id;
    }

    fn runtime_id_for_session_key(&self, key: &str) -> Option<String> {
        let key = self.normalize_session_key(key);
        self.runtime_by_session_key.get(&key).cloned()
    }

    fn register_runtime_state(&mut self, runtime_id: &str, state: &serde_json::Value) {
        let Some(key) = runtime_session_key(state).map(|key| self.normalize_session_key(&key))
        else {
            return;
        };
        if let Some(runtime) = self.runtimes.get_mut(runtime_id) {
            if let Some(old_key) = runtime.session_key.replace(key.clone()) {
                if old_key != key {
                    self.runtime_by_session_key.remove(&old_key);
                }
            }
        }
        self.runtime_by_session_key
            .insert(key, runtime_id.to_string());
    }

    async fn activate_or_spawn_for_session(
        &mut self,
        session_path: String,
    ) -> Result<(String, serde_json::Value)> {
        if let Some(runtime_id) = self.runtime_id_for_session_key(&session_path) {
            let client = self
                .runtimes
                .get(&runtime_id)
                .map(|runtime| runtime.client.clone())
                .context("runtime missing for session")?;
            let state = client
                .get_state()
                .await
                .context("get_state for existing tab runtime")?;
            self.set_active_runtime(runtime_id.clone());
            self.register_runtime_state(&runtime_id, &state);
            return Ok((runtime_id, state));
        }

        let runtime_id = self.alloc_runtime_id();
        let state = self
            .spawn_runtime(runtime_id.clone(), Some(session_path), None)
            .await?;
        self.set_active_runtime(runtime_id.clone());
        Ok((runtime_id, state))
    }

    async fn spawn_new_session_runtime(&mut self) -> Result<(String, serde_json::Value)> {
        let runtime_id = self.alloc_runtime_id();
        let _ = self.spawn_runtime(runtime_id.clone(), None, None).await?;
        let client = self
            .runtimes
            .get(&runtime_id)
            .map(|runtime| runtime.client.clone())
            .context("new tab runtime missing after spawn")?;
        let state = client
            .new_session(None)
            .await
            .context("new_session for tab runtime")?;
        let state = ensure_session_state(&client, state)
            .await
            .context("new_session get_state for tab runtime")?;
        self.register_runtime_state(&runtime_id, &state);
        self.set_active_runtime(runtime_id.clone());
        Ok((runtime_id, state))
    }

    async fn close_runtime_for_path(&mut self, closed_path: &str) {
        let closed_key = self.normalize_session_key(closed_path);
        let Some(runtime_id) = self.runtime_by_session_key.remove(&closed_key) else {
            return;
        };
        if self.active_runtime_id == runtime_id {
            return;
        }
        if let Some(runtime) = self.runtimes.remove(&runtime_id) {
            if let Err(e) = runtime.handle.shutdown().await {
                warn!(?e, "tab runtime shutdown error");
            }
        }
    }

    async fn shutdown_all(mut self) {
        for (_, runtime) in self.runtimes.drain() {
            if let Err(e) = runtime.handle.shutdown().await {
                warn!(?e, "tab runtime shutdown error");
            }
        }
    }

    fn alloc_runtime_id(&mut self) -> String {
        self.next_id += 1;
        format!("tab-runtime-{}", self.next_id)
    }

    fn normalize_session_key(&self, key: &str) -> String {
        normalize_session_key(self.cwd.as_deref(), key)
    }

    async fn spawn_runtime(
        &mut self,
        runtime_id: String,
        session_path: Option<String>,
        name: Option<String>,
    ) -> Result<serde_json::Value> {
        let bridge = spawn_bridge_with_session_mode(self.cwd.clone(), self.session_mode.as_deref())
            .await
            .context("failed to start sidecar bridge")?;
        let client = bridge.client.clone();
        let mut events = bridge.events;

        while let Some(ev) = events.recv().await {
            match ev {
                BridgeEvent::Ready => break,
                BridgeEvent::Stderr(line) if line.contains("sidecar ready") => break,
                BridgeEvent::Stderr(line) => {
                    let _ = self
                        .tx
                        .send(AppEvent::TabBridge {
                            runtime_id: runtime_id.clone(),
                            event: BridgeEvent::Stderr(line),
                        })
                        .await;
                }
                other => {
                    let _ = self
                        .tx
                        .send(AppEvent::TabBridge {
                            runtime_id: runtime_id.clone(),
                            event: other,
                        })
                        .await;
                }
            }
        }

        let state = establish_session_direct(&client, session_path, name).await?;
        let tx = self.tx.clone();
        let pump_runtime_id = runtime_id.clone();
        tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                if tx
                    .send(AppEvent::TabBridge {
                        runtime_id: pump_runtime_id.clone(),
                        event,
                    })
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });

        self.runtimes.insert(
            runtime_id.clone(),
            TabRuntime {
                client,
                handle: bridge.handle,
                session_key: None,
            },
        );
        self.register_runtime_state(&runtime_id, &state);
        Ok(state)
    }
}

fn runtime_session_key(state: &serde_json::Value) -> Option<String> {
    state
        .get("sessionFile")
        .or_else(|| state.get("session_file"))
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            state
                .get("sessionId")
                .or_else(|| state.get("session_id"))
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty())
        })
        .map(str::to_string)
}

fn normalize_session_key(cwd: Option<&Path>, key: &str) -> String {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let path = PathBuf::from(trimmed);
    if path.is_absolute() {
        return path.display().to_string();
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.ends_with(".jsonl") {
        if let Some(cwd) = cwd {
            return cwd.join(path).display().to_string();
        }
    }
    trimmed.to_string()
}

struct TerminalGuard {
    active: bool,
}

impl TerminalGuard {
    fn new() -> Self {
        Self { active: false }
    }

    fn arm(&mut self) {
        self.active = true;
    }

    fn disarm(&mut self) {
        self.active = false;
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        if self.active {
            runtime::restore_terminal_best_effort();
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let opts = cli::parse_args(std::env::args().skip(1)).map_err(|e| anyhow!("cli error: {e}"))?;
    init_tracing();
    let diagnostics = runtime::RuntimeDiagnostics::collect(&opts);
    if opts.diagnostics {
        println!("{}", diagnostics.render());
        return Ok(());
    }
    runtime::install_panic_hook(diagnostics);
    info!(?opts, "starting pix-tui");

    let workspace_root = opts
        .cwd
        .clone()
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let cwd_display = workspace_root.display().to_string();

    // -- Terminal setup ----------------------------------------------------
    let mut terminal_guard = TerminalGuard::new();
    enable_raw_mode().context("enable_raw_mode")?;
    terminal_guard.arm();
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture, Hide).context("enter alt screen")?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend).context("terminal::new")?;
    terminal.clear().context("terminal clear")?;

    // -- App state ---------------------------------------------------------
    let app_config = ui::App::load_config(opts.model_ref.as_deref()).context("load pix config")?;
    let mut app = ui::App::with_config(cwd_display.clone(), workspace_root.clone(), app_config);
    app.load_tabs_best_effort();
    app.configure_workspace_history(opts.cwd_history_max);
    app.record_workspace_cwd(std::path::PathBuf::from(cwd_display.clone()));

    let startup_session_path = if opts.session_path.is_some() || opts.no_session || opts.new {
        opts.session_path.clone().map(|p| p.display().to_string())
    } else {
        app.startup_restore_session_path()
            .or_else(|| opts.session_path.clone().map(|p| p.display().to_string()))
    };

    // -- Event loop --------------------------------------------------------
    let (tx, mut rx) = mpsc::channel::<AppEvent>(256);
    let (voice_tx, mut voice_rx) = mpsc::channel::<ui::voice::VoiceEvent>(64);

    // -- Spawn initial live tab runtime -----------------------------------
    let session_mode = if opts.no_session || opts.new {
        Some("in-memory".to_string())
    } else {
        None
    };
    let (mut runtimes, startup_state) = TabRuntimeManager::new(
        opts.cwd.clone(),
        session_mode,
        tx.clone(),
        startup_session_path,
        opts.name.clone(),
    )
    .await
    .context(
        "failed to start initial tab runtime (run `pix-tui --diagnostics` for setup details)",
    )?;
    app.apply_session_state(&startup_state);
    app.save_active_runtime_state();
    if let Some(client) = runtimes.active_client() {
        spawn_runtime_history_load(
            runtimes.active_runtime_id().to_string(),
            client,
            &tx,
        );
    }

    // Terminal events pump.
    let term_tx = tx.clone();
    tokio::spawn(async move {
        let mut events = EventStream::new();
        loop {
            match events.next().await {
                Some(Ok(ev)) => {
                    if term_tx.send(AppEvent::Term(ev)).await.is_err() {
                        break;
                    }
                }
                Some(Err(e)) => {
                    warn!(?e, "terminal event error");
                    break;
                }
                None => break,
            }
        }
    });

    // Periodic UI tick for expiring transient overlays.
    let tick_tx = tx.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(250));
        loop {
            interval.tick().await;
            if tick_tx.send(AppEvent::Tick).await.is_err() {
                break;
            }
        }
    });

    // Voice events pump.
    let voice_app_tx = tx.clone();
    tokio::spawn(async move {
        while let Some(ev) = voice_rx.recv().await {
            if voice_app_tx.send(AppEvent::VoiceEvent(ev)).await.is_err() {
                break;
            }
        }
    });

    // Initial draw.
    render(&mut terminal, &mut app)?;

    let exit_result = run_loop(
        &mut terminal,
        &mut app,
        &mut rx,
        &mut runtimes,
        tx.clone(),
        voice_tx.clone(),
    )
    .await;

    app.save_active_input_to_tabs();

    // -- Tear down ---------------------------------------------------------
    if let Err(e) = restore_terminal(&mut terminal) {
        error!(?e, "failed to restore terminal");
    } else {
        terminal_guard.disarm();
    }
    runtimes.shutdown_all().await;

    exit_result
}

async fn run_loop(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    app: &mut ui::App,
    rx: &mut mpsc::Receiver<AppEvent>,
    runtimes: &mut TabRuntimeManager,
    tx: mpsc::Sender<AppEvent>,
    voice_tx: mpsc::Sender<ui::voice::VoiceEvent>,
) -> Result<()> {
    let mut needs_redraw = true;
    let mut events_since_draw = 0usize;
    loop {
        if needs_redraw {
            match rx.try_recv() {
                Ok(ev) if events_since_draw < 64 => {
                    events_since_draw += 1;
                    handle_app_event(
                        ev,
                        terminal,
                        app,
                        rx,
                        runtimes,
                        tx.clone(),
                        voice_tx.clone(),
                    )
                    .await?;
                    if app.quit {
                        return Ok(());
                    }
                    continue;
                }
                Ok(ev) => {
                    render(terminal, app)?;
                    needs_redraw = false;
                    events_since_draw = 0;
                    if handle_app_event(
                        ev,
                        terminal,
                        app,
                        rx,
                        runtimes,
                        tx.clone(),
                        voice_tx.clone(),
                    )
                    .await?
                    {
                        needs_redraw = true;
                    }
                    if app.quit {
                        return Ok(());
                    }
                    continue;
                }
                Err(mpsc::error::TryRecvError::Empty) => {
                    render(terminal, app)?;
                    needs_redraw = false;
                    events_since_draw = 0;
                }
                Err(mpsc::error::TryRecvError::Disconnected) => {
                    return Err(anyhow!("event loop closed"));
                }
            }
        }
        let ev = rx
            .recv()
            .await
            .ok_or_else(|| anyhow!("event loop closed"))?;
        if handle_app_event(
            ev,
            terminal,
            app,
            rx,
            runtimes,
            tx.clone(),
            voice_tx.clone(),
        )
        .await?
        {
            needs_redraw = true;
            events_since_draw = events_since_draw.saturating_add(1);
        }
        if app.quit {
            return Ok(());
        }
    }
}

async fn handle_app_event(
    ev: AppEvent,
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    app: &mut ui::App,
    _rx: &mut mpsc::Receiver<AppEvent>,
    runtimes: &mut TabRuntimeManager,
    tx: mpsc::Sender<AppEvent>,
    voice_tx: mpsc::Sender<ui::voice::VoiceEvent>,
) -> Result<bool> {
    let mut needs_redraw = false;
    match ev {
        AppEvent::Term(term_ev) => {
            let Some(client) = runtimes.active_client() else {
                app.push_diag(DiagKind::BridgeError, "no active tab runtime");
                return Ok(true);
            };
            if handle_term(
                terminal,
                app,
                term_ev,
                &client,
                runtimes,
                tx.clone(),
                voice_tx.clone(),
            )
            .await?
            {
                needs_redraw = true;
            }
            if app.quit {
                return Ok(true);
            }
        }
        AppEvent::Bridge(bridge_ev) => {
            handle_bridge(app, bridge_ev);
            needs_redraw = true;
        }
        AppEvent::TabBridge { runtime_id, event } => {
            handle_tab_bridge(app, runtimes, &runtime_id, event);
            needs_redraw = runtime_id == runtimes.active_runtime_id();
        }
        AppEvent::Tick => {
            if app.tick_toasts(Instant::now()) {
                needs_redraw = true;
            }
        }
        AppEvent::Diag(kind, text) => {
            app.push_diag(kind, text);
            needs_redraw = true;
        }
        AppEvent::SessionState(state) => {
            let previous_cwd = app.cwd.clone();
            let next_cwd = state
                .get("cwd")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            app.apply_session_state(&state);
            if let Some(cwd) = next_cwd {
                if cwd != previous_cwd {
                    app.toasts.push(
                        ToastLevel::Info,
                        ToastKindLabel::Info,
                        format!("Switched workspace to {cwd}"),
                        4,
                    );
                    refresh_autocomplete_for_cwd(app);
                }
            }
            needs_redraw = true;
        }
        AppEvent::TabSessionState { runtime_id, state } => {
            runtimes.register_runtime_state(&runtime_id, &state);
            if runtime_id == runtimes.active_runtime_id() {
                let previous_cwd = app.cwd.clone();
                let next_cwd = state
                    .get("cwd")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                app.apply_session_state(&state);
                app.save_active_runtime_state();
                if let Some(cwd) = next_cwd {
                    if cwd != previous_cwd {
                        app.toasts.push(
                            ToastLevel::Info,
                            ToastKindLabel::Info,
                            format!("Switched workspace to {cwd}"),
                            4,
                        );
                        refresh_autocomplete_for_cwd(app);
                    }
                }
                needs_redraw = true;
            }
        }
        AppEvent::SwitchedSessionState(state) => {
            let previous_cwd = app.cwd.clone();
            let next_cwd = state
                .get("cwd")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            app.save_active_runtime_state();
            app.reset_conversation();
            app.apply_session_state(&state);
            app.restore_active_runtime_state();
            if let Some(cwd) = next_cwd {
                if cwd != previous_cwd {
                    app.toasts.push(
                        ToastLevel::Info,
                        ToastKindLabel::Info,
                        format!("Switched workspace to {cwd}"),
                        4,
                    );
                    refresh_autocomplete_for_cwd(app);
                }
            }
            needs_redraw = true;
        }
        AppEvent::ActivatedTabState { runtime_id, state } => {
            app.save_active_runtime_state();
            activate_tab_runtime_state(app, runtimes, runtime_id, state);
            needs_redraw = true;
        }
        AppEvent::RuntimeHistoryLoaded { runtime_id, result } => {
            apply_runtime_history_loaded(app, runtimes, &runtime_id, result);
            needs_redraw = true;
        }
        AppEvent::NewSessionState(state) => {
            app.save_active_runtime_state();
            app.reset_conversation();
            app.apply_session_state(&state);
            let id = app.session_id.as_deref().unwrap_or("(unknown)");
            app.push_diag(DiagKind::Info, format!("started session {id}"));
            needs_redraw = true;
        }
        AppEvent::NewTabRuntimeState { runtime_id, state } => {
            app.save_active_runtime_state();
            activate_tab_runtime_state(app, runtimes, runtime_id, state);
            let id = app.session_id.as_deref().unwrap_or("(unknown)");
            app.push_diag(DiagKind::Info, format!("started session {id}"));
            app.save_active_runtime_state();
            needs_redraw = true;
        }
        AppEvent::ClosedTabState { state, closed_path } => {
            let previous_cwd = app.cwd.clone();
            let next_cwd = state
                .get("cwd")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            app.save_active_runtime_state();
            app.reset_conversation();
            app.apply_session_state(&state);
            app.restore_active_runtime_state();
            app.remove_tab_path(&closed_path);
            if let Some(cwd) = next_cwd {
                if cwd != previous_cwd {
                    app.toasts.push(
                        ToastLevel::Info,
                        ToastKindLabel::Info,
                        format!("Switched workspace to {cwd}"),
                        4,
                    );
                    refresh_autocomplete_for_cwd(app);
                }
            }
            needs_redraw = true;
        }
        AppEvent::ClosedTabRuntimeState {
            runtime_id,
            state,
            closed_path,
        } => {
            app.save_active_runtime_state();
            activate_tab_runtime_state(app, runtimes, runtime_id, state);
            app.remove_tab_path(&closed_path);
            runtimes.close_runtime_for_path(&closed_path).await;
            needs_redraw = true;
        }
        AppEvent::SessionList(result) => {
            match result {
                Ok(sessions) => app
                    .session_list
                    .set_sessions(sessions, app.session_file.as_deref()),
                Err(error) => app.session_list.set_error(error),
            }
            needs_redraw = true;
        }
        AppEvent::EnhancerResult(result) => {
            match result {
                Ok(text) => {
                    app.input.set_text(text);
                    // TODO(autocomplete): refresh suggestions after programmatic edits.
                    app.toasts
                        .push(ToastLevel::Info, ToastKindLabel::Info, "Prompt enhanced", 2);
                }
                Err(error) => {
                    let message = match error {
                        EnhancerError::NotSupported => {
                            "prompt enhancer not supported by sidecar".to_string()
                        }
                        EnhancerError::Empty => "nothing to enhance".to_string(),
                        other => other.to_string(),
                    };
                    app.toasts
                        .push(ToastLevel::Warn, ToastKindLabel::Info, message, 0);
                }
            }
            needs_redraw = true;
        }
        AppEvent::ModelPickerLoaded(result) => {
            match result {
                Ok(models) => app.model_picker.set_models(models),
                Err(error) => app.model_picker.set_error(error),
            }
            needs_redraw = true;
        }
        AppEvent::ModelSwitchResult(result) => {
            match result {
                Ok(label) => app.toasts.push(
                    ToastLevel::Info,
                    ToastKindLabel::Info,
                    format!("Switched model to {label}"),
                    4,
                ),
                Err(error) => app
                    .toasts
                    .push(ToastLevel::Warn, ToastKindLabel::Info, error, 6),
            }
            needs_redraw = true;
        }
        AppEvent::VoiceEvent(ev) => {
            app.handle_voice_event(ev);
            needs_redraw = true;
        }
    }
    Ok(needs_redraw)
}

async fn establish_session_direct(
    client: &bridge::BridgeClient,
    session_path: Option<String>,
    name: Option<String>,
) -> Result<serde_json::Value> {
    let mut state = client.get_state().await.context("initial get_state")?;

    if let Some(path) = session_path {
        state = client
            .switch_session(path)
            .await
            .context("switch_session")?;
        state = ensure_session_state(client, state)
            .await
            .context("switch_session get_state")?;
    }

    if let Some(name) = name {
        client
            .set_session_name(name)
            .await
            .context("set_session_name")?;
        state = client
            .get_state()
            .await
            .context("set_session_name get_state")?;
    }

    debug!(?state, "tab runtime session established");
    Ok(state)
}

async fn ensure_session_state(
    client: &bridge::BridgeClient,
    state: serde_json::Value,
) -> Result<serde_json::Value> {
    if state.get("sessionId").and_then(|v| v.as_str()).is_some()
        || state.get("session_id").and_then(|v| v.as_str()).is_some()
    {
        Ok(state)
    } else {
        client
            .get_state()
            .await
            .context("get_state after session change")
    }
}

fn spawn_runtime_history_load(
    runtime_id: String,
    client: bridge::BridgeClient,
    tx: &mpsc::Sender<AppEvent>,
) {
    let tx = tx.clone();
    tokio::spawn(async move {
        let result = client
            .get_messages_tail(HISTORY_PAGE_SIZE)
            .await
            .map_err(|error| format!("load session history failed: {error}"));
        let _ = tx
            .send(AppEvent::RuntimeHistoryLoaded { runtime_id, result })
            .await;
    });
}

const HISTORY_PAGE_SIZE: u32 = 200;

fn current_conversation_geometry(
    app: &mut ui::App,
) -> Result<(ui::viewport::ViewportWidth, usize)> {
    let (cols, rows) = crossterm::terminal::size().context("terminal size")?;
    let size = Rect::new(0, 0, cols, rows);
    let input_inner_width = size.width.saturating_sub(2) as usize;
    let max_input_rows = ((size.height as usize) / 2).clamp(3, 10);
    let rendered_input = app.input.render(
        input_inner_width,
        max_input_rows,
        INPUT_FIRST_PREFIX,
        INPUT_CONT_PREFIX,
    );
    let input_content_rows = rendered_input.visual_lines.len().max(1).min(max_input_rows);
    let input_total_height = (input_content_rows + 2) as u16;
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(2),
            Constraint::Min(3),
            Constraint::Length(input_total_height),
            Constraint::Length(1),
        ])
        .split(size);
    Ok((
        ui::viewport::ViewportWidth(chunks[1].width as usize),
        chunks[1].height as usize,
    ))
}

async fn maybe_load_older_history(
    app: &mut ui::App,
    client: &bridge::BridgeClient,
    viewport_width: ui::viewport::ViewportWidth,
    body_height: usize,
) -> bool {
    if !app.history_has_older || body_height == 0 {
        return false;
    }
    let old_total = app
        .viewport
        .line_count_with_config(&app.blocks, viewport_width, &app.config);
    let old_metrics = app.scroll.metrics(old_total, body_height);
    if old_metrics.start != 0 {
        return false;
    }

    match client.get_messages_older(HISTORY_PAGE_SIZE).await {
        Ok(messages) => {
            let added_blocks = app.prepend_history_messages(&messages);
            if added_blocks == 0 {
                app.save_active_runtime_state();
                return false;
            }
            let new_total =
                app.viewport
                    .line_count_with_config(&app.blocks, viewport_width, &app.config);
            let added_lines = new_total.saturating_sub(old_total);
            let anchored_start = old_metrics.start.saturating_add(added_lines);
            app.scroll.detached_start = Some(anchored_start);
            app.scroll.scroll_from_bottom = new_total
                .saturating_sub(body_height)
                .saturating_sub(anchored_start);
            app.save_active_runtime_state();
            true
        }
        Err(error) => {
            app.toasts.push(
                ToastLevel::Warn,
                ToastKindLabel::Bridge,
                format!("load older history failed: {error}"),
                6,
            );
            true
        }
    }
}

async fn maybe_load_older_history_for_current_geometry(
    app: &mut ui::App,
    client: &bridge::BridgeClient,
) -> Result<bool> {
    let (viewport_width, body_height) = current_conversation_geometry(app)?;
    Ok(maybe_load_older_history(app, client, viewport_width, body_height).await)
}

fn activate_tab_runtime_state(
    app: &mut ui::App,
    runtimes: &mut TabRuntimeManager,
    runtime_id: String,
    state: serde_json::Value,
) {
    let client = runtimes.client_for_runtime(&runtime_id);
    let loading_key = runtime_session_key(&state).map(|key| runtimes.normalize_session_key(&key));
    runtimes.set_active_runtime(runtime_id.clone());
    runtimes.register_runtime_state(&runtime_id, &state);
    app.set_pending_new_tab(false);
    app.reset_conversation();
    app.apply_session_state(&state);
    if !app.restore_active_runtime_state() {
        if let Some(client) = client {
            app.save_active_runtime_state();
            app.set_loading_runtime_key(loading_key);
            spawn_runtime_history_load(runtime_id, client, &runtimes.tx);
        } else {
            app.save_active_runtime_state();
            app.set_loading_runtime_key(None);
        }
    } else {
        app.set_loading_runtime_key(None);
    }
}

fn apply_runtime_history_loaded(
    app: &mut ui::App,
    runtimes: &TabRuntimeManager,
    runtime_id: &str,
    result: Result<serde_json::Value, String>,
) {
    let session_key = runtimes
        .runtimes
        .get(runtime_id)
        .and_then(|runtime| runtime.session_key.clone());

    let Some(session_key) = session_key else {
        if let Err(error) = result {
            app.push_diag(DiagKind::BridgeError, error);
        }
        return;
    };

    if runtime_id == runtimes.active_runtime_id() {
        match result {
            Ok(messages) => {
                app.apply_history_messages(&messages);
                app.save_active_runtime_state();
                app.clear_loading_runtime_key(Some(&session_key));
            }
            Err(error) => {
                app.clear_loading_runtime_key(Some(&session_key));
                app.push_diag(DiagKind::BridgeError, error)
            }
        }
        return;
    }

    let active_key = app.active_runtime_key();
    app.save_active_runtime_state();

    if !app.restore_runtime_state_for_key(&session_key) {
        if let Err(error) = result {
            app.push_diag(DiagKind::BridgeError, error);
        }
        if let Some(active_key) = active_key {
            let _ = app.restore_runtime_state_for_key(&active_key);
        }
        return;
    }

    match result {
        Ok(messages) => {
            app.apply_history_messages(&messages);
            app.save_active_runtime_state();
            app.clear_loading_runtime_key(Some(&session_key));
        }
        Err(error) => {
            app.clear_loading_runtime_key(Some(&session_key));
            app.push_diag(DiagKind::BridgeError, error)
        }
    }

    if let Some(active_key) = active_key {
        let _ = app.restore_runtime_state_for_key(&active_key);
    }
}

fn open_model_picker(
    app: &mut ui::App,
    client: &bridge::BridgeClient,
    tx: &mpsc::Sender<AppEvent>,
) {
    app.open_model_picker();
    let c = client.clone();
    let tx = tx.clone();
    tokio::spawn(async move {
        let result = c
            .get_models()
            .await
            .map(|value| ui::model_picker::parse_models_response(&value))
            .map_err(|e| format!("get_models failed: {e}"));
        let _ = tx.send(AppEvent::ModelPickerLoaded(result)).await;
    });
}

fn open_session_picker(
    app: &mut ui::App,
    client: &bridge::BridgeClient,
    tx: &mpsc::Sender<AppEvent>,
) {
    app.open_session_picker();
    refresh_session_picker(app, client, tx);
}

fn refresh_session_picker(
    app: &mut ui::App,
    client: &bridge::BridgeClient,
    tx: &mpsc::Sender<AppEvent>,
) {
    app.session_list.begin_refresh();
    let c = client.clone();
    let tx = tx.clone();
    tokio::spawn(async move {
        let result = match c.list_sessions().await {
            Ok(value) => ui::session_list::parse_session_list_response(value),
            Err(e) => Err(format!("list_sessions failed: {e}")),
        };
        let _ = tx.send(AppEvent::SessionList(result)).await;
    });
}

fn request_model_switch(
    app: &mut ui::App,
    client: &bridge::BridgeClient,
    tx: &mpsc::Sender<AppEvent>,
    model_ref: String,
) {
    let requested = model_ref.trim().to_string();
    if requested.is_empty() {
        app.toasts.push(
            ToastLevel::Warn,
            ToastKindLabel::Info,
            "Choose a model to switch",
            4,
        );
        return;
    }

    app.toasts.push(
        ToastLevel::Info,
        ToastKindLabel::Info,
        format!("Switching model to {requested}…"),
        2,
    );

    let c = client.clone();
    let tx = tx.clone();
    tokio::spawn(async move {
        match c.set_model_ref(requested.clone()).await {
            Ok(value) => {
                if let Some(model) = value.get("model").cloned() {
                    let _ = tx
                        .send(AppEvent::SessionState(
                            serde_json::json!({ "model": model }),
                        ))
                        .await;
                }
                let label = value
                    .get("model")
                    .and_then(ui::model_picker::parse_model_summary)
                    .map(|model| model.ref_)
                    .unwrap_or(requested);
                let _ = tx.send(AppEvent::ModelSwitchResult(Ok(label))).await;
            }
            Err(e) => {
                let _ = tx
                    .send(AppEvent::ModelSwitchResult(Err(format!(
                        "set_model failed: {e}"
                    ))))
                    .await;
            }
        }
    });
}

fn prepare_tab_switch(app: &mut ui::App, path: &str) {
    app.set_pending_new_tab(false);
    app.tabs.active_path = Some(path.to_string());
    app.persist_tabs_best_effort();

    if app.restore_runtime_state_for_key(path) {
        app.set_loading_runtime_key(None);
    } else {
        show_loading_tab_placeholder(app, path);
    }
}

fn save_before_tab_switch(app: &mut ui::App) {
    app.save_active_input_to_tabs();
    app.save_active_runtime_state();
}

async fn finish_switch_tab_to_path(
    app: &mut ui::App,
    runtimes: &mut TabRuntimeManager,
    path: String,
) {
    match runtimes.activate_or_spawn_for_session(path).await {
        Ok((runtime_id, state)) => {
            activate_tab_runtime_state(app, runtimes, runtime_id, state);
        }
        Err(e) => app.toasts.push(
            ToastLevel::Warn,
            ToastKindLabel::Bridge,
            format!("tab switch failed: {e}"),
            6,
        ),
    }
}

fn show_loading_tab_placeholder(app: &mut ui::App, path: &str) {
    app.set_pending_new_tab(false);
    app.reset_conversation();
    app.session_file = Some(path.to_string());
    app.session_name = app
        .tabs
        .tabs
        .iter()
        .find(|tab| tab.path == path)
        .and_then(|tab| tab.name.clone());
    app.session_id = app
        .tabs
        .tabs
        .iter()
        .find(|tab| tab.path == path)
        .and_then(|tab| tab.session_id.clone());
    app.set_loading_runtime_key(Some(path.to_string()));
    app.restore_input_from_active_tab();
}

fn show_loading_new_tab_placeholder(app: &mut ui::App) {
    app.reset_conversation();
    app.session_id = None;
    app.session_file = None;
    app.session_name = Some("new".to_string());
    app.set_loading_runtime_key(None);
    app.set_pending_new_tab(true);
}

async fn close_active_tab(app: &mut ui::App, runtimes: &mut TabRuntimeManager) {
    if app.is_streaming {
        app.toasts.push(
            ToastLevel::Warn,
            ToastKindLabel::Info,
            "Cannot close tabs while streaming",
            4,
        );
        return;
    }

    let Some(closed_path) = app.session_file.clone() else {
        return;
    };

    if app.tabs.tabs.len() <= 1 {
        app.save_active_input_to_tabs();
        app.save_active_runtime_state();
        match runtimes.spawn_new_session_runtime().await {
            Ok((runtime_id, state)) => {
                activate_tab_runtime_state(app, runtimes, runtime_id, state);
                app.remove_tab_path(&closed_path);
                runtimes.close_runtime_for_path(&closed_path).await;
            }
            Err(e) => app.toasts.push(
                ToastLevel::Warn,
                ToastKindLabel::Bridge,
                format!("close_tab new_session failed: {e}"),
                6,
            ),
        }
        return;
    }

    let Some(next_path) = app.tabs.next_path_after_closing_active() else {
        return;
    };
    app.save_active_input_to_tabs();
    app.save_active_runtime_state();
    match runtimes.activate_or_spawn_for_session(next_path).await {
        Ok((runtime_id, state)) => {
            activate_tab_runtime_state(app, runtimes, runtime_id, state);
            app.remove_tab_path(&closed_path);
            runtimes.close_runtime_for_path(&closed_path).await;
        }
        Err(e) => app.toasts.push(
            ToastLevel::Warn,
            ToastKindLabel::Bridge,
            format!("close_tab switch failed: {e}"),
            6,
        ),
    }
}

async fn close_tab_path(app: &mut ui::App, runtimes: &mut TabRuntimeManager, path: String) {
    if app.session_file.as_deref() == Some(path.as_str()) {
        close_active_tab(app, runtimes).await;
        return;
    }
    if app.runtime_state_is_streaming(&path) {
        app.toasts.push(
            ToastLevel::Warn,
            ToastKindLabel::Info,
            "Cannot close streaming tab",
            4,
        );
        return;
    }
    app.remove_tab_path(&path);
    runtimes.close_runtime_for_path(&path).await;
}

async fn open_new_tab(
    app: &mut ui::App,
    runtimes: &mut TabRuntimeManager,
    previous_runtime_key: Option<String>,
) {
    match runtimes.spawn_new_session_runtime().await {
        Ok((runtime_id, state)) => {
            activate_tab_runtime_state(app, runtimes, runtime_id, state);
            let id = app.session_id.as_deref().unwrap_or("(unknown)");
            app.push_diag(DiagKind::Info, format!("started session {id}"));
            app.save_active_runtime_state();
        }
        Err(e) => {
            app.set_pending_new_tab(false);
            app.set_loading_runtime_key(None);
            if let Some(previous_runtime_key) = previous_runtime_key {
                let _ = app.restore_runtime_state_for_key(&previous_runtime_key);
            } else {
                app.reset_conversation();
                app.session_id = None;
                app.session_file = None;
                app.session_name = None;
            }
            app.toasts.push(
                ToastLevel::Warn,
                ToastKindLabel::Bridge,
                format!("new tab runtime failed: {e}"),
                6,
            );
        }
    }
}

async fn handle_term(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    app: &mut ui::App,
    ev: TermEvent,
    client: &bridge::BridgeClient,
    runtimes: &mut TabRuntimeManager,
    tx: mpsc::Sender<AppEvent>,
    voice_tx: mpsc::Sender<ui::voice::VoiceEvent>,
) -> Result<bool> {
    // ---- Mouse ----------------------------------------------------------
    if let TermEvent::Mouse(MouseEvent {
        kind, column, row, ..
    }) = ev
    {
        let (cols, rows) = crossterm::terminal::size().context("terminal size")?;
        let size = Rect::new(0, 0, cols, rows);

        let input_inner_width = size.width.saturating_sub(2) as usize;
        let max_input_rows = ((size.height as usize) / 2).clamp(3, 10);
        let rendered_input = app.input.render(
            input_inner_width,
            max_input_rows,
            INPUT_FIRST_PREFIX,
            INPUT_CONT_PREFIX,
        );
        let input_content_rows = rendered_input.visual_lines.len().max(1).min(max_input_rows);
        let input_total_height = (input_content_rows + 2) as u16;

        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(2),
                Constraint::Min(3),
                Constraint::Length(input_total_height),
                Constraint::Length(1),
            ])
            .split(size);

        let tabs_area = chunks[0];
        let conversation_area = chunks[1];
        let input_area = chunks[2];
        let tab_layout = ui::tabs_state::tabs_layout(
            &app.tabs,
            &app.theme_cache,
            tabs_area.width as usize,
            app.session_file.as_deref(),
            app.session_id.as_deref(),
            app.session_name.as_deref(),
            app.loading_runtime_key.as_deref(),
            app.pending_new_tab.then_some("new"),
        );
        let body_height = conversation_area.height as usize;
        let viewport_width = ui::viewport::ViewportWidth(conversation_area.width as usize);
        let total = app
            .viewport
            .line_count_with_config(&app.blocks, viewport_width, &app.config);
        let metrics = app.scroll.metrics(total, body_height);
        app.record_metrics(total, body_height);

        let action = ui::mouse::resolve_mouse_event(
            kind,
            column,
            row,
            conversation_area,
            input_area,
            tabs_area,
            &tab_layout.targets,
            metrics.start,
            &app.viewport,
            &app.blocks,
            viewport_width,
            &app.link_click_targets,
        );

        return match action {
            ui::mouse::MouseAction::TabClick { path } => {
                if app.tabs.active_path.as_deref() == Some(path.as_str())
                    && app.session_file.as_deref() == Some(path.as_str())
                    && !app.is_runtime_loading(Some(path.as_str()))
                {
                    Ok(true)
                } else {
                    save_before_tab_switch(app);
                    prepare_tab_switch(app, &path);
                    render(terminal, app)?;
                    finish_switch_tab_to_path(app, runtimes, path).await;
                    Ok(true)
                }
            }
            ui::mouse::MouseAction::TabClose { path } => {
                close_tab_path(app, runtimes, path).await;
                Ok(true)
            }
            ui::mouse::MouseAction::TabNew => {
                app.save_active_input_to_tabs();
                app.save_active_runtime_state();
                let previous_runtime_key = app.active_runtime_key();
                show_loading_new_tab_placeholder(app);
                app.push_diag(DiagKind::Info, "starting new tab runtime…");
                render(terminal, app)?;
                open_new_tab(app, runtimes, previous_runtime_key).await;
                Ok(true)
            }
            ui::mouse::MouseAction::ConversationLinkClick { url } => {
                match open_file_link(&url) {
                    Ok(result) => {
                        let message = match result.target {
                            OpenTarget::Editor => format!("Opened in {}", result.label),
                            OpenTarget::System => format!("Opened via {}", result.label),
                        };
                        app.toasts.push(ToastLevel::Info, ToastKindLabel::Link, message, 4);
                    }
                    Err(error) => {
                        app.toasts.push(ToastLevel::Warn, ToastKindLabel::Link, error, 6);
                    }
                }
                Ok(true)
            }
            ui::mouse::MouseAction::ConversationClick { block_idx } => {
                if app.toggle_tool_expanded(block_idx) {
                    Ok(true)
                } else {
                    app.toasts.push(
                        ToastLevel::Info,
                        ToastKindLabel::Info,
                        format!("clicked block {block_idx}"),
                        2,
                    );
                    Ok(true)
                }
            }
            ui::mouse::MouseAction::InputClick {
                visual_row,
                visual_col,
                width,
            } => Ok(app.input.click_at_visual_position(
                visual_row,
                visual_col,
                INPUT_FIRST_PREFIX,
                INPUT_CONT_PREFIX,
                width,
            )),
            ui::mouse::MouseAction::ConversationScroll { lines } => {
                let changed = app.scroll.scroll_by_lines(lines, total, body_height);
                let loaded = if changed {
                    maybe_load_older_history(app, client, viewport_width, body_height).await
                } else {
                    false
                };
                Ok(changed || loaded)
            }
            ui::mouse::MouseAction::Unhandled => Ok(false),
        };
    }

    if let TermEvent::Paste(text) = ev {
        app.input.attach_pasted_text(text);
        refresh_autocomplete_for_cwd(app);
        return Ok(true);
    }

    let TermEvent::Key(key) = ev else {
        return Ok(false);
    };
    if matches!(
        key,
        KeyEvent {
            code: KeyCode::Char('c'),
            modifiers: KeyModifiers::CONTROL,
            ..
        }
    ) {
        app.quit = true;
        return Ok(true);
    }
    if matches!(key, KeyEvent { code: KeyCode::Char('m'), modifiers, .. } if modifiers.contains(KeyModifiers::CONTROL))
    {
        let mut voice = app.voice.clone();
        let voice_events = voice_tx.clone();
        let is_idle = matches!(app.voice.state(), ui::voice::VoiceInputState::Idle);
        tokio::spawn(async move {
            if is_idle {
                if let Err(e) = voice.start_recording(voice_events.clone()).await {
                    let _ = voice_events
                        .send(ui::voice::VoiceEvent::Error(e.to_string()))
                        .await;
                }
            } else {
                if let Err(e) = voice.stop_recording().await {
                    let _ = voice_events
                        .send(ui::voice::VoiceEvent::Error(e.to_string()))
                        .await;
                } else {
                    let _ = voice_events
                        .send(ui::voice::VoiceEvent::Progress(
                            "Voice input off".to_string(),
                        ))
                        .await;
                    let _ = voice_events
                        .send(ui::voice::VoiceEvent::StateChanged(
                            ui::voice::VoiceInputState::Idle,
                        ))
                        .await;
                }
            }
        });
        return Ok(true);
    }
    if matches!(
        key,
        KeyEvent {
            code: KeyCode::Char('h'),
            modifiers,
            ..
        } if modifiers.contains(KeyModifiers::CONTROL)
    ) {
        app.open_popup(PopupKind::Help);
        return Ok(true);
    }
    if matches!(
        key,
        KeyEvent {
            code: KeyCode::Char('f'),
            modifiers,
            ..
        } if modifiers.contains(KeyModifiers::CONTROL)
    ) && app.active_popup.is_none()
    {
        app.open_session_search(String::new());
        return Ok(true);
    }
    if matches!(key, KeyEvent { code: KeyCode::Char('t'), modifiers, .. } if modifiers.contains(KeyModifiers::CONTROL))
        && app.active_popup.is_none()
    {
        open_session_picker(app, client, &tx);
        return Ok(true);
    }
    if matches!(key, KeyEvent { code: KeyCode::Char('w'), modifiers, .. } if modifiers.contains(KeyModifiers::CONTROL))
        && app.active_popup.is_none()
    {
        close_active_tab(app, runtimes).await;
        return Ok(true);
    }
    if matches!(key, KeyEvent { code: KeyCode::Left, modifiers, .. } if modifiers.contains(KeyModifiers::ALT))
        && app.active_popup.is_none()
    {
        save_before_tab_switch(app);
        if let Some(path) = app.switch_tab_relative(-1) {
            if app.restore_runtime_state_for_key(&path) {
                app.set_loading_runtime_key(None);
            } else {
                show_loading_tab_placeholder(app, &path);
            }
            render(terminal, app)?;
            finish_switch_tab_to_path(app, runtimes, path).await;
        }
        return Ok(true);
    }
    if matches!(key, KeyEvent { code: KeyCode::Right, modifiers, .. } if modifiers.contains(KeyModifiers::ALT))
        && app.active_popup.is_none()
    {
        save_before_tab_switch(app);
        if let Some(path) = app.switch_tab_relative(1) {
            if app.restore_runtime_state_for_key(&path) {
                app.set_loading_runtime_key(None);
            } else {
                show_loading_tab_placeholder(app, &path);
            }
            render(terminal, app)?;
            finish_switch_tab_to_path(app, runtimes, path).await;
        }
        return Ok(true);
    }
    if matches!(key, KeyEvent { code: KeyCode::Char('\\'), modifiers, .. } if modifiers.contains(KeyModifiers::CONTROL))
    {
        if app.is_streaming {
            app.toasts.push(
                ToastLevel::Warn,
                ToastKindLabel::Info,
                "Cannot switch workspace while streaming",
                4,
            );
            return Ok(true);
        }

        if let Some(path) = app.undo_workspace_cwd() {
            let c = client.clone();
            let tx = tx.clone();
            tokio::spawn(async move {
                match ui::workspace_history::WorkspaceHistory::request_cwd_switch(&c, &path).await {
                    Ok(()) => {
                        let state = serde_json::json!({ "cwd": path.display().to_string() });
                        let _ = tx.send(AppEvent::SessionState(state)).await;
                    }
                    Err(e) => {
                        let _ = tx
                            .send(AppEvent::Diag(
                                DiagKind::BridgeError,
                                format!("set_cwd failed: {e}"),
                            ))
                            .await;
                    }
                }
            });
        }
        return Ok(true);
    }
    if matches!(
        key,
        KeyEvent {
            code: KeyCode::Esc,
            ..
        }
    ) && app.autocomplete.is_active()
    {
        app.autocomplete.dismiss();
        return Ok(true);
    }
    // ---- Popup navigation ----------------------------------------------
    if matches!(app.current_popup_kind(), Some(PopupKind::ModelPicker)) {
        return handle_model_picker_key(app, key, client, &tx);
    }
    if matches!(app.current_popup_kind(), Some(PopupKind::SessionPicker)) {
        return handle_session_picker_key(terminal, app, key, client, runtimes, &tx).await;
    }
    if matches!(app.current_popup_kind(), Some(PopupKind::Search { .. })) {
        return handle_search_popup_key(app, key);
    }
    if app.active_popup.is_some() {
        match key.code {
            KeyCode::Esc | KeyCode::Enter => {
                app.close_popup();
                return Ok(true);
            }
            KeyCode::Up => {
                if let Some(active) = app.active_popup.as_mut() {
                    active.focus = active.focus.saturating_sub(1);
                    if active.focus < active.scroll {
                        active.scroll = active.focus;
                    }
                }
                return Ok(true);
            }
            KeyCode::Down => {
                if let Some(active) = app.active_popup.as_mut() {
                    let max_focus = active.items.len().saturating_sub(1);
                    active.focus = active.focus.saturating_add(1).min(max_focus);
                    if active.focus >= active.scroll.saturating_add(6) {
                        active.scroll = active.focus.saturating_sub(5);
                    }
                }
                return Ok(true);
            }
            KeyCode::PageUp => {
                if let Some(active) = app.active_popup.as_mut() {
                    active.focus = active.focus.saturating_sub(5);
                    active.scroll = active.scroll.saturating_sub(5).min(active.focus);
                }
                return Ok(true);
            }
            KeyCode::PageDown => {
                if let Some(active) = app.active_popup.as_mut() {
                    let max_focus = active.items.len().saturating_sub(1);
                    active.focus = active.focus.saturating_add(5).min(max_focus);
                    active.scroll = active.scroll.saturating_add(5).min(active.focus);
                }
                return Ok(true);
            }
            _ => return Ok(true),
        }
    }
    if matches!(key, KeyEvent { code: KeyCode::Char('y'), modifiers, .. } if modifiers.contains(KeyModifiers::CONTROL))
    {
        let request = ui::clipboard::ClipboardRequest::LastAssistantText;
        match request.resolve(app) {
            Some(text) => match ui::clipboard::copy_to_clipboard(&text) {
                Ok(()) => app.push_diag(DiagKind::Info, "copied last assistant text to clipboard"),
                Err(e) => {
                    app.push_diag(DiagKind::BridgeError, format!("clipboard copy failed: {e}"))
                }
            },
            None => app.push_diag(DiagKind::Info, "no assistant text to copy"),
        }
        return Ok(true);
    }
    if matches!(
        key,
        KeyEvent {
            code: KeyCode::Esc,
            ..
        }
    ) {
        if app.is_streaming {
            // Best-effort abort; ignore errors.
            let _ = client.abort().await;
            app.push_diag(DiagKind::Info, "abort sent");
        }
        return Ok(true);
    }

    if matches!(key, KeyEvent { code: KeyCode::Char('z'), modifiers, .. } if modifiers.contains(KeyModifiers::CONTROL))
    {
        if !app.is_streaming {
            let c = client.clone();
            let tx = tx.clone();
            tokio::spawn(async move {
                let (kind, text) = match c.undo_last_turn().await {
                    Ok(_) => (DiagKind::Info, "undo_last_turn complete".to_string()),
                    Err(e) => (DiagKind::BridgeError, format!("undo_last_turn failed: {e}")),
                };
                let _ = tx.send(AppEvent::Diag(kind, text)).await;
            });
            app.push_diag(DiagKind::Info, "undo_last_turn sent");
        }
        return Ok(true);
    }

    if matches!(key, KeyEvent { code: KeyCode::Char('r'), modifiers, .. } if modifiers.contains(KeyModifiers::CONTROL))
    {
        if !app.is_streaming {
            let c = client.clone();
            tokio::spawn(async move {
                let (kind, text) = match c.compact(None).await {
                    Ok(_) => (DiagKind::Info, "compact complete".to_string()),
                    Err(e) => (DiagKind::BridgeError, format!("compact failed: {e}")),
                };
                let _ = tx.send(AppEvent::Diag(kind, text)).await;
            });
            app.push_diag(DiagKind::Info, "compacting session…");
        }
        return Ok(true);
    }

    if matches!(key, KeyEvent { code: KeyCode::Char('n'), modifiers, .. } if modifiers.contains(KeyModifiers::CONTROL))
    {
        app.save_active_input_to_tabs();
        app.save_active_runtime_state();
        let previous_runtime_key = app.active_runtime_key();
        show_loading_new_tab_placeholder(app);
        app.push_diag(DiagKind::Info, "starting new tab runtime…");
        render(terminal, app)?;
        open_new_tab(app, runtimes, previous_runtime_key).await;
        return Ok(true);
    }

    if app.is_streaming {
        // When streaming, lock input except for navigation.
        return match key.code {
            KeyCode::PageUp => {
                let changed = app.scroll.scroll_by_page(
                    ui::scroll::PageDirection::Up,
                    app.last_body_height.saturating_sub(2).max(1),
                    app.last_line_count,
                    app.last_body_height,
                );
                if changed {
                    let _ = maybe_load_older_history_for_current_geometry(app, client).await?;
                }
                Ok(true)
            }
            KeyCode::PageDown => {
                let _ = app.scroll.scroll_by_page(
                    ui::scroll::PageDirection::Down,
                    app.last_body_height.saturating_sub(2).max(1),
                    app.last_line_count,
                    app.last_body_height,
                );
                Ok(true)
            }
            KeyCode::Up => {
                let changed =
                    app.scroll
                        .scroll_by_lines(1, app.last_line_count, app.last_body_height);
                if changed {
                    let _ = maybe_load_older_history_for_current_geometry(app, client).await?;
                }
                Ok(true)
            }
            KeyCode::Down => {
                let _ = app
                    .scroll
                    .scroll_by_lines(-1, app.last_line_count, app.last_body_height);
                Ok(true)
            }
            _ => Ok(true),
        };
    }

    if matches!(key, KeyEvent { code: KeyCode::Char('V' | 'v'), modifiers, .. } if modifiers.contains(KeyModifiers::CONTROL) && modifiers.contains(KeyModifiers::SHIFT))
        || matches!(key, KeyEvent { code: KeyCode::Char('@'), modifiers, .. } if modifiers.contains(KeyModifiers::CONTROL))
    {
        attach_file_from_input_at_cursor(app);
        refresh_autocomplete_for_cwd(app);
        return Ok(true);
    }

    if matches!(key, KeyEvent { code: KeyCode::Char('v'), modifiers, .. } if modifiers.contains(KeyModifiers::CONTROL))
    {
        match tokio::task::spawn_blocking(ui::clipboard_image::read_clipboard_image).await {
            Ok(Ok(Some(image))) => {
                let message = format_clipboard_image_toast(&image);
                app.input.attach_image(image.data, image.mime_type);
                app.toasts
                    .push(ToastLevel::Info, ToastKindLabel::Info, message, 3);
            }
            Ok(Ok(None)) => match read_clipboard_text() {
                Ok(Some(text)) => app.input.attach_pasted_text(text),
                Ok(None) => app.toasts.push(
                    ToastLevel::Info,
                    ToastKindLabel::Info,
                    "Clipboard is empty",
                    2,
                ),
                Err(e) => app.toasts.push(
                    ToastLevel::Warn,
                    ToastKindLabel::Info,
                    format!("clipboard paste failed: {e}"),
                    4,
                ),
            },
            Ok(Err(e)) => app.toasts.push(
                ToastLevel::Warn,
                ToastKindLabel::Info,
                format!("clipboard image failed: {e}"),
                4,
            ),
            Err(e) => app.toasts.push(
                ToastLevel::Warn,
                ToastKindLabel::Info,
                format!("clipboard task failed: {e}"),
                4,
            ),
        }
        refresh_autocomplete_for_cwd(app);
        return Ok(true);
    }

    // Multiline input handling: match pix behavior with Shift+Enter,
    // and keep Alt+Enter as an accepted fallback.
    if key.modifiers.contains(KeyModifiers::SHIFT) || key.modifiers.contains(KeyModifiers::ALT) {
        if let KeyCode::Enter = key.code {
            app.input.insert_newline();
            refresh_autocomplete_for_cwd(app);
            return Ok(true);
        }
    }

    match key.code {
        KeyCode::Tab => {
            if app.autocomplete.is_active() {
                app.autocomplete.next();
                return Ok(true);
            }
            Ok(false)
        }
        KeyCode::BackTab => {
            if app.autocomplete.is_active() {
                app.autocomplete.prev();
                return Ok(true);
            }
            Ok(false)
        }
        KeyCode::Enter => {
            if app.autocomplete.is_active()
                && !app.autocomplete.suggestions.is_empty()
                && app.autocomplete.accept(&mut app.input)
            {
                app.autocomplete.dismiss();
                refresh_autocomplete_for_cwd(app);
                return Ok(true);
            }
            let raw_text = app.input.text().to_string();
            let text = app.input.text_for_submit();
            if text.trim().is_empty() {
                return Ok(true);
            }
            if let Some(slash) = ui::slash::parse_slash(&raw_text) {
                match slash {
                    ui::slash::SlashCommand::Model { ref_ } if ref_.trim().is_empty() => {
                        open_model_picker(app, client, &tx);
                    }
                    ui::slash::SlashCommand::Sessions => {
                        open_session_picker(app, client, &tx);
                    }
                    ui::slash::SlashCommand::Model { ref_ } => {
                        request_model_switch(app, client, &tx, ref_);
                    }
                    other => {
                        if ui::slash::dispatch(other, app, client, &tx)
                            == ui::slash::DispatchResult::Quit
                        {
                            return Ok(true);
                        }
                    }
                }
                app.input.clear();
                refresh_autocomplete_for_cwd(app);
            } else {
                let images = app.input.images_for_prompt();
                app.input.clear();
                refresh_autocomplete_for_cwd(app);
                app.push_user_message(&text);
                // Fire prompt. The reply streams back as Bridge events.
                let c = client.clone();
                tokio::spawn(async move {
                    if let Err(e) = send_prompt(c, text, images).await {
                        error!(?e, "prompt failed");
                    }
                });
            }
            Ok(true)
        }
        KeyCode::Backspace => {
            app.input.delete_backward();
            refresh_autocomplete_for_cwd(app);
            Ok(true)
        }
        KeyCode::Delete => {
            app.input.delete_forward();
            refresh_autocomplete_for_cwd(app);
            Ok(true)
        }
        KeyCode::Left => {
            if key.modifiers.contains(KeyModifiers::CONTROL) {
                app.input.move_word_left();
            } else {
                app.input.move_left();
            }
            Ok(true)
        }
        KeyCode::Right => {
            if key.modifiers.contains(KeyModifiers::CONTROL) {
                app.input.move_word_right();
            } else {
                app.input.move_right();
            }
            Ok(true)
        }
        KeyCode::Up => {
            // Up/Down navigates inside the input when it's multi-line,
            // otherwise scrolls the conversation.
            if app.input.is_multiline() {
                app.input.move_up();
            } else {
                let changed =
                    app.scroll
                        .scroll_by_lines(1, app.last_line_count, app.last_body_height);
                if changed {
                    let _ = maybe_load_older_history_for_current_geometry(app, client).await?;
                }
            }
            Ok(true)
        }
        KeyCode::Down => {
            if app.input.is_multiline() {
                app.input.move_down();
            } else {
                let _ = app
                    .scroll
                    .scroll_by_lines(-1, app.last_line_count, app.last_body_height);
            }
            Ok(true)
        }
        KeyCode::Home => {
            if key.modifiers.contains(KeyModifiers::CONTROL) {
                app.input.move_to_start();
            } else {
                app.input.move_to_line_start();
            }
            Ok(true)
        }
        KeyCode::End => {
            if key.modifiers.contains(KeyModifiers::CONTROL) {
                app.input.move_to_end();
            } else {
                app.input.move_to_line_end();
            }
            Ok(true)
        }
        KeyCode::PageUp => {
            let changed = app.scroll.scroll_by_page(
                ui::scroll::PageDirection::Up,
                app.last_body_height.saturating_sub(2).max(1),
                app.last_line_count,
                app.last_body_height,
            );
            if changed {
                let _ = maybe_load_older_history_for_current_geometry(app, client).await?;
            }
            Ok(true)
        }
        KeyCode::PageDown => {
            let _ = app.scroll.scroll_by_page(
                ui::scroll::PageDirection::Down,
                app.last_body_height.saturating_sub(2).max(1),
                app.last_line_count,
                app.last_body_height,
            );
            Ok(true)
        }
        KeyCode::Char('a') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            // Terminal convention: Ctrl-A = line start.
            app.input.move_to_line_start();
            Ok(true)
        }
        KeyCode::Char('e') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            // Ctrl-E = enhance prompt.
            if !app.input.is_empty() {
                let text = app.input.text().to_string();
                let model = Some(app.config.prompt_enhancer.model_ref.clone());
                let enhancer = ui::Enhancer::new(client.clone(), model);
                let tx = tx.clone();
                app.toasts
                    .push(ToastLevel::Info, ToastKindLabel::Info, "enhancing…", 2);
                tokio::spawn(async move {
                    let result = enhancer.enhance(&text).await;
                    let _ = tx.send(AppEvent::EnhancerResult(result)).await;
                });
            }
            Ok(true)
        }
        KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            // Ctrl-U = delete to line start (or join with previous).
            app.input.delete_to_line_start_or_previous_line_end();
            refresh_autocomplete_for_cwd(app);
            Ok(true)
        }
        KeyCode::Char('w') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            // Ctrl-W = delete previous word.
            app.input.delete_word_backward();
            refresh_autocomplete_for_cwd(app);
            Ok(true)
        }
        KeyCode::Char('l') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            // Ctrl-L = scroll conversation to bottom.
            app.scroll_to_bottom();
            Ok(true)
        }
        KeyCode::Char(c) => {
            app.input.insert_char(c);
            refresh_autocomplete_for_cwd(app);
            Ok(true)
        }
        _ => Ok(false),
    }
}

fn handle_search_popup_key(app: &mut ui::App, key: KeyEvent) -> Result<bool> {
    match key.code {
        KeyCode::Esc => {
            app.close_popup();
            Ok(true)
        }
        KeyCode::Enter => {
            let selected_block = app.session_search.selected_hit().map(|hit| hit.block_index);
            app.close_popup();
            if let Some(block_idx) = selected_block {
                let (cols, _) = crossterm::terminal::size().context("terminal size")?;
                let viewport_width = ui::viewport::ViewportWidth(cols.saturating_sub(2) as usize);
                let _ = app.scroll_to_block_idx(block_idx, viewport_width);
            }
            Ok(true)
        }
        KeyCode::Up => {
            let _ = app.session_search.move_cursor_up();
            Ok(true)
        }
        KeyCode::Down => {
            let _ = app.session_search.move_cursor_down();
            Ok(true)
        }
        KeyCode::PageUp => {
            let page = app.last_body_height.saturating_sub(3).max(1);
            let _ = app.session_search.page_up(page);
            Ok(true)
        }
        KeyCode::PageDown => {
            let page = app.last_body_height.saturating_sub(3).max(1);
            let _ = app.session_search.page_down(page);
            Ok(true)
        }
        KeyCode::Home => {
            let _ = app.session_search.move_home();
            Ok(true)
        }
        KeyCode::End => {
            let _ = app.session_search.move_end();
            Ok(true)
        }
        KeyCode::Backspace | KeyCode::Delete => {
            let _ = app.search_query_pop();
            Ok(true)
        }
        KeyCode::Char(c) if key.modifiers.is_empty() || key.modifiers == KeyModifiers::SHIFT => {
            app.search_query_push(c);
            Ok(true)
        }
        _ => Ok(true),
    }
}

fn handle_model_picker_key(
    app: &mut ui::App,
    key: KeyEvent,
    client: &bridge::BridgeClient,
    tx: &mpsc::Sender<AppEvent>,
) -> Result<bool> {
    match key.code {
        KeyCode::Esc => {
            app.close_popup();
            Ok(true)
        }
        KeyCode::Enter => {
            let selected = app.model_picker.selected().map(|model| model.ref_.clone());
            app.close_popup();
            if let Some(model_ref) = selected {
                request_model_switch(app, client, tx, model_ref);
            }
            Ok(true)
        }
        KeyCode::Up => Ok(app.model_picker.move_up()),
        KeyCode::Down => Ok(app.model_picker.move_down()),
        KeyCode::PageUp => Ok(app
            .model_picker
            .page_up(app.last_body_height.saturating_sub(3).max(1))),
        KeyCode::PageDown => Ok(app
            .model_picker
            .page_down(app.last_body_height.saturating_sub(3).max(1))),
        KeyCode::Home => Ok(app.model_picker.move_home()),
        KeyCode::End => Ok(app.model_picker.move_end()),
        KeyCode::Backspace | KeyCode::Delete => Ok(app.model_picker.pop_query_char()),
        KeyCode::Char(c) if key.modifiers.is_empty() || key.modifiers == KeyModifiers::SHIFT => {
            app.model_picker.push_query_char(c);
            Ok(true)
        }
        _ => Ok(true),
    }
}

async fn handle_session_picker_key(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    app: &mut ui::App,
    key: KeyEvent,
    client: &bridge::BridgeClient,
    runtimes: &mut TabRuntimeManager,
    tx: &mpsc::Sender<AppEvent>,
) -> Result<bool> {
    match key.code {
        KeyCode::Esc => {
            app.close_popup();
            Ok(true)
        }
        KeyCode::Enter => {
            let selected = app
                .session_list
                .selected_session()
                .map(|session| session.path.clone());
            app.close_popup();
            if let Some(path) = selected {
                if app.session_file.as_deref() == Some(path.as_str()) {
                    return Ok(true);
                }
                save_before_tab_switch(app);
                prepare_tab_switch(app, &path);
                render(terminal, app)?;
                finish_switch_tab_to_path(app, runtimes, path).await;
            }
            Ok(true)
        }
        KeyCode::Up => Ok(app.session_list.move_focus_up()),
        KeyCode::Down => Ok(app.session_list.move_focus_down()),
        KeyCode::PageUp => Ok(app
            .session_list
            .page_up(app.last_body_height.saturating_sub(3).max(1))),
        KeyCode::PageDown => Ok(app
            .session_list
            .page_down(app.last_body_height.saturating_sub(3).max(1))),
        KeyCode::Char('r') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            refresh_session_picker(app, client, tx);
            Ok(true)
        }
        KeyCode::Home => Ok(app.session_list.move_focus_home()),
        KeyCode::End => Ok(app.session_list.move_focus_end()),
        KeyCode::Backspace | KeyCode::Delete => {
            Ok(app.session_list.pop_query_char(app.session_file.as_deref()))
        }
        KeyCode::Char(c) if key.modifiers.is_empty() || key.modifiers == KeyModifiers::SHIFT => {
            app.session_list
                .push_query_char(c, app.session_file.as_deref());
            Ok(true)
        }
        _ => Ok(true),
    }
}

fn handle_bridge(app: &mut ui::App, ev: BridgeEvent) {
    match ev {
        BridgeEvent::Event { type_, payload } => {
            // Snapshot a few high-signal fields into the status line.
            match type_.as_str() {
                "session_start" => {
                    app.apply_session_state(&payload);
                    app.bridge_status = "ready".to_string();
                }
                "model_change" => {
                    if let Some(m) = payload.get("model").and_then(|v| v.as_str()) {
                        app.set_model_status(m);
                    }
                }
                _ => {}
            }
            app.handle_event(&type_, &payload);
        }
        BridgeEvent::Stderr(line) => {
            // Surface stderr lines as transient toasts (and as a rolling status),
            // not persistent conversation blocks.
            let stripped = line.trim().to_string();
            if stripped.contains("ready") || stripped.contains("switched") {
                app.bridge_status = stripped.clone();
            }
            if !stripped.is_empty() {
                if stripped.contains("sidecar ready") {
                    app.toasts
                        .push(ToastLevel::Info, ToastKindLabel::Info, stripped, 2);
                } else {
                    app.toasts
                        .push(ToastLevel::Warn, ToastKindLabel::Stderr, stripped, 6);
                }
            }
        }
        BridgeEvent::Ready => {
            app.bridge_status = "sidecar ready".to_string();
        }
        BridgeEvent::Exit(code) => {
            if code.unwrap_or(1) != 0 {
                let message = match code {
                    Some(code) => format!("sidecar exited (code {code})"),
                    None => "sidecar exited (signal/unknown)".to_string(),
                };
                app.toasts
                    .push(ToastLevel::Error, ToastKindLabel::Bridge, message, 10);
            }
            app.push_diag(
                DiagKind::BridgeError,
                format!("sidecar exited (code={:?})", code),
            );
            app.bridge_status = format!("exited {:?}", code);
        }
    }
}

fn handle_tab_bridge(
    app: &mut ui::App,
    runtimes: &mut TabRuntimeManager,
    runtime_id: &str,
    ev: BridgeEvent,
) {
    if let BridgeEvent::Event { payload, .. } = &ev {
        runtimes.register_runtime_state(runtime_id, payload);
    }

    if runtime_id == runtimes.active_runtime_id() {
        handle_bridge(app, ev);
        app.save_active_runtime_state();
        return;
    }

    let active_key = app.active_runtime_key();
    app.save_active_runtime_state();

    let inactive_key = runtimes
        .runtimes
        .get(runtime_id)
        .and_then(|runtime| runtime.session_key.clone());
    let Some(inactive_key) = inactive_key else {
        return;
    };
    if !app.restore_runtime_state_for_key(&inactive_key) {
        return;
    }
    handle_bridge(app, ev);
    app.save_active_runtime_state();

    if let Some(active_key) = active_key {
        let _ = app.restore_runtime_state_for_key(&active_key);
    }
}

fn refresh_autocomplete_for_cwd(app: &mut ui::App) {
    let cwd = PathBuf::from(app.cwd.clone());
    app.refresh_autocomplete(Some(cwd.as_path()));
}

async fn send_prompt(
    client: bridge::BridgeClient,
    text: String,
    images: Vec<serde_json::Value>,
) -> std::result::Result<serde_json::Value, bridge::BridgeError> {
    client.prompt_with_images(text, images).await
}

fn read_clipboard_text() -> Result<Option<String>> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| {
        anyhow!("could not access system clipboard ({e}); is a desktop display server available?")
    })?;
    match clipboard.get_text() {
        Ok(text) if !text.is_empty() => Ok(Some(text)),
        Ok(_) => Ok(None),
        Err(arboard::Error::ContentNotAvailable) => Ok(None),
        Err(e) => Err(anyhow!("could not read text from clipboard: {e}")),
    }
}

fn attach_file_from_input_at_cursor(app: &mut ui::App) {
    let Some((start, end, raw_path)) =
        file_reference_at_cursor(app.input.text(), app.input.cursor())
    else {
        app.toasts.push(
            ToastLevel::Info,
            ToastKindLabel::Info,
            "Type @path, then press Ctrl+Shift+V to attach it",
            4,
        );
        return;
    };

    let path = resolve_attachment_path(&app.cwd, &raw_path);
    let file_label = attachment_file_label(&path);
    let kind_label = if ui::attachments::is_image_path(&path) {
        "image"
    } else {
        "file"
    };
    match app
        .input
        .replace_range_with_file_attachment(start, end, &path)
    {
        Ok(()) => app.toasts.push(
            ToastLevel::Info,
            ToastKindLabel::Info,
            format!("Attached {kind_label}: {file_label}"),
            3,
        ),
        Err(e) => app.toasts.push(
            ToastLevel::Warn,
            ToastKindLabel::Info,
            format!("attach failed: {e}"),
            5,
        ),
    }
}

fn file_reference_at_cursor(text: &str, cursor: usize) -> Option<(usize, usize, String)> {
    if cursor <= text.len() && text.is_char_boundary(cursor) {
        let line_start = text[..cursor].rfind('\n').map(|idx| idx + 1).unwrap_or(0);
        let line_end = text[cursor..]
            .find('\n')
            .map(|idx| cursor + idx)
            .unwrap_or(text.len());

        if let Some((start, end, path)) =
            file_reference_in_line(&text[line_start..line_end], line_start, cursor)
        {
            return Some((start, end, path));
        }
    }

    let trimmed_start = text.len() - text.trim_start().len();
    let trimmed = text.trim();
    normalize_file_reference(trimmed)
        .map(|path| (trimmed_start, trimmed_start + trimmed.len(), path))
}

fn file_reference_in_line(
    line: &str,
    line_offset: usize,
    cursor: usize,
) -> Option<(usize, usize, String)> {
    let mut idx = 0usize;
    while idx < line.len() {
        let ch = line[idx..].chars().next()?;
        if ch != '@' {
            idx += ch.len_utf8();
            continue;
        }

        let start = idx;
        let mut end = idx + ch.len_utf8();
        let mut valid = false;

        if end < line.len() {
            let next = line[end..].chars().next()?;
            if matches!(next, '"' | '\'') {
                let quote = next;
                end += next.len_utf8();
                while end < line.len() {
                    let current = line[end..].chars().next()?;
                    end += current.len_utf8();
                    if current == quote {
                        valid = true;
                        break;
                    }
                }
            } else {
                while end < line.len() {
                    let current = line[end..].chars().next()?;
                    if current.is_whitespace() {
                        break;
                    }
                    end += current.len_utf8();
                }
                valid = end > start + 1;
            }
        }

        if valid {
            let absolute_start = line_offset + start;
            let absolute_end = line_offset + end;
            if cursor >= absolute_start && cursor <= absolute_end {
                let raw = &line[start..end];
                if let Some(path) = normalize_file_reference(raw) {
                    return Some((absolute_start, absolute_end, path));
                }
            }
        }

        idx = end.max(start + 1);
    }

    None
}

fn normalize_file_reference(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let without_at = trimmed.strip_prefix('@')?.trim();
    let unquoted = without_at
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .or_else(|| {
            without_at
                .strip_prefix('\'')
                .and_then(|rest| rest.strip_suffix('\''))
        })
        .unwrap_or(without_at)
        .trim();
    (!unquoted.is_empty()).then(|| unquoted.to_string())
}

fn resolve_attachment_path(cwd: &str, raw_path: &str) -> PathBuf {
    let expanded = if raw_path == "~" {
        dirs::home_dir().unwrap_or_else(|| PathBuf::from(raw_path))
    } else if let Some(rest) = raw_path.strip_prefix("~/") {
        dirs::home_dir()
            .map(|home| home.join(rest))
            .unwrap_or_else(|| PathBuf::from(raw_path))
    } else {
        PathBuf::from(raw_path)
    };
    if expanded.is_absolute() {
        expanded
    } else {
        Path::new(cwd).join(expanded)
    }
}

fn format_clipboard_image_toast(image: &ui::clipboard_image::ClipboardImage) -> String {
    let mut message = format!("Attached image ({}×{})", image.width, image.height);
    if image.resized {
        message.push_str(" · resized to fit");
    }
    message
}

fn attachment_file_label(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_reference_at_cursor_supports_plain_paths() {
        let text = "see @assets/cat.png please";
        let cursor = text.find("cat").expect("cursor");

        let found = file_reference_at_cursor(text, cursor).expect("path");

        assert_eq!(found.2, "assets/cat.png");
        assert_eq!(&text[found.0..found.1], "@assets/cat.png");
    }

    #[test]
    fn file_reference_at_cursor_supports_quoted_paths_with_spaces() {
        let text = "attach @\"screenshots/error state.png\" now";
        let cursor = text.find("state").expect("cursor");

        let found = file_reference_at_cursor(text, cursor).expect("path");

        assert_eq!(found.2, "screenshots/error state.png");
        assert_eq!(&text[found.0..found.1], "@\"screenshots/error state.png\"");
    }

    #[test]
    fn normalize_file_reference_trims_quotes() {
        assert_eq!(
            normalize_file_reference("@'folder/my file.txt'"),
            Some("folder/my file.txt".to_string())
        );
    }

    #[test]
    fn format_clipboard_image_toast_mentions_resize() {
        let image = ui::clipboard_image::ClipboardImage {
            data: "abc".to_string(),
            mime_type: "image/png".to_string(),
            width: 2000,
            height: 1500,
            resized: true,
        };

        let toast = format_clipboard_image_toast(&image);

        assert!(toast.contains("2000×1500"));
        assert!(toast.contains("resized"));
    }

    #[test]
    fn normalize_session_key_resolves_relative_session_files() {
        let cwd = Path::new("/tmp/workspace");

        assert_eq!(
            normalize_session_key(Some(cwd), "sessions/abc.jsonl"),
            "/tmp/workspace/sessions/abc.jsonl"
        );
        assert_eq!(
            normalize_session_key(Some(cwd), "/tmp/other.jsonl"),
            "/tmp/other.jsonl"
        );
        assert_eq!(normalize_session_key(Some(cwd), "session-id"), "session-id");
    }
}

fn render(terminal: &mut Terminal<CrosstermBackend<io::Stdout>>, app: &mut ui::App) -> Result<()> {
    terminal.draw(|f| ui::render::render(f, app))?;
    Ok(())
}

fn restore_terminal(terminal: &mut Terminal<CrosstermBackend<io::Stdout>>) -> Result<()> {
    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        Show,
        DisableMouseCapture,
        LeaveAlternateScreen
    )?;
    Ok(())
}

fn init_tracing() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("warn,pix_tui=info")),
        )
        .with_writer(io::stderr)
        .try_init();
}
