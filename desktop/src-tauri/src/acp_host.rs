//! Per-window native ACP host: process ownership, stdin admission and event forwarding.
//! Window/PTY coordination stays in the parent and shares this slot registry.

use super::{
    acp_diagnostics, acp_queue, backend_runtime, native_process, run_blocking, ExitSignal,
    POLL_INTERVAL,
};
use serde::{
    de::{IgnoredAny, MapAccess, Visitor},
    Serialize,
};
use std::{
    collections::HashMap,
    fmt,
    io::{BufRead, BufReader, Read, Write},
    process::{ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

const GRACEFUL_STOP_TIMEOUT: Duration = Duration::from_secs(2);
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
const ACP_EVENT_BATCH_LATENCY: Duration = Duration::from_millis(4);
const ACP_EVENT_BATCH_MAX_LINES: usize = 64;
/// Upper bound for draining stdout/stderr forwarders after the child is reaped,
/// so the final protocol lines are emitted before `acp://exit`.
const FORWARDER_DRAIN_TIMEOUT: Duration = Duration::from_secs(1);
/// Lines admitted by one `acp_send` batch (the webview coalesces its outbox).
const MAX_SEND_BATCH_LINES: usize = 256;

#[derive(Default)]
pub(super) struct AcpProcessState {
    pub(super) slots: Mutex<HashMap<String, Arc<ProcessSlot>>>,
    next_generation: AtomicU64,
    pub(super) exiting: AtomicBool,
}

pub(super) struct ProcessSlot {
    // Startup serialization is separate: send/stop only briefly lock running.
    startup: Mutex<()>,
    running: Mutex<Option<RunningProcess>>,
    pub(super) cancelled: AtomicBool,
}

impl Default for ProcessSlot {
    fn default() -> Self {
        Self {
            startup: Mutex::new(()),
            running: Mutex::new(None),
            cancelled: AtomicBool::new(false),
        }
    }
}

struct RunningProcess {
    generation: u64,
    stdin_tx: Option<Arc<acp_queue::Queue<StdinCommand>>>,
    stop_tx: mpsc::Sender<()>,
    exited: ExitSignal,
}

impl Drop for RunningProcess {
    fn drop(&mut self) {
        if let Some(queue) = self.stdin_tx.take() {
            queue.close();
        }
        let _ = self.stop_tx.send(());
    }
}

enum StdinCommand {
    Write {
        lines: Vec<String>,
        ack: tokio::sync::oneshot::Sender<Result<(), String>>,
    },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitPayload {
    window_label: String,
    generation: u64,
    code: Option<i32>,
    success: bool,
    requested: bool,
    error: Option<String>,
    stderr: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LinesPayload {
    window_label: String,
    generation: u64,
    lines: Vec<String>,
}

#[tauri::command]
pub(super) async fn acp_start(app: AppHandle, window_label: String) -> Result<u64, String> {
    run_blocking(move || start_process(app, window_label)).await
}

fn start_process(app: AppHandle, window_label: String) -> Result<u64, String> {
    let state = app.state::<AcpProcessState>();
    let slot = reserve_process_slot(&state, &window_label, || {
        app.get_webview_window(&window_label).is_some()
    })?;
    let _startup = slot
        .startup
        .lock()
        .map_err(|_| "ACP process state is poisoned".to_owned())?;
    let running_slot = slot
        .running
        .lock()
        .map_err(|_| "ACP process state is poisoned".to_owned())?;
    if slot.cancelled.load(Ordering::Acquire) || state.exiting.load(Ordering::Acquire) {
        return Err("ACP window is closed".to_owned());
    }
    if app.get_webview_window(&window_label).is_none() {
        return Err("ACP window is closed".to_owned());
    }
    if let Some(running) = &*running_slot {
        return Ok(running.generation);
    }
    drop(running_slot);

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    let runtime = backend_runtime::BackendRuntime::resolve(&resource_dir)?;
    let mut command = runtime.command()?;
    command.env("PIX_CONFIG_PROFILE", "desktop");
    native_process::isolate(&mut command);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = native_process::spawn(&mut command)
        .map_err(|error| format!("failed to start Pix backend: {error}"))?;

    let pipes = (child.stdin.take(), child.stdout.take(), child.stderr.take());
    let (Some(stdin), Some(stdout), Some(stderr)) = pipes else {
        let _ = native_process::force_stop(&mut child);
        let _ = child.wait();
        return Err("pix-acp did not expose all stdio pipes".to_owned());
    };
    // Destroyed is recorded synchronously, even if the blocking startup is
    // currently resolving the runtime or spawning a child.
    if slot.cancelled.load(Ordering::Acquire)
        || state.exiting.load(Ordering::Acquire)
        || app.get_webview_window(&window_label).is_none()
    {
        let _ = native_process::force_stop(&mut child);
        let _ = child.wait();
        return Err("ACP window closed during startup".to_owned());
    }
    let stdin_tx = Arc::new(acp_queue::Queue::new(8 * 1024 * 1024, 16));
    forward_stdin(stdin, stdin_tx.clone());

    let generation = state
        .next_generation
        .fetch_add(1, Ordering::AcqRel)
        .wrapping_add(1);
    let (stop_tx, stop_rx) = mpsc::channel();
    let exited = Arc::new((Mutex::new(false), Condvar::new()));
    // The cancellation guard above checked before publication; a close can
    // happen after that guard. Recheck while publishing under the short lock.
    let publish = publish_process(
        &slot,
        &state,
        app.get_webview_window(&window_label).is_some(),
        RunningProcess {
            generation,
            stdin_tx: Some(stdin_tx),
            stop_tx,
            exited: exited.clone(),
        },
    );
    if let Err(error) = publish {
        let _ = native_process::force_stop(&mut child);
        let _ = child.wait();
        return Err(error);
    }

    let (forwarders_tx, forwarders_rx) = mpsc::channel();
    forward_lines(
        stdout,
        app.clone(),
        window_label.clone(),
        "acp://stdout",
        generation,
        forwarders_tx.clone(),
    );
    let diagnostics = acp_diagnostics::Capture::default();
    forward_lines(
        diagnostics.reader(stderr),
        app.clone(),
        window_label.clone(),
        "acp://stderr",
        generation,
        forwarders_tx,
    );
    thread::spawn(move || {
        supervise_child(
            child,
            stop_rx,
            app,
            window_label,
            generation,
            exited,
            diagnostics,
            Forwarders {
                done: forwarders_rx,
                count: 2,
            },
        )
    });
    Ok(generation)
}

fn publish_process(
    slot: &ProcessSlot,
    state: &AcpProcessState,
    window_available: bool,
    running: RunningProcess,
) -> Result<(), String> {
    let mut guard = slot
        .running
        .lock()
        .map_err(|_| "ACP process state is poisoned".to_owned())?;
    if slot.cancelled.load(Ordering::Acquire)
        || state.exiting.load(Ordering::Acquire)
        || !window_available
    {
        return Err("ACP window closed during startup".to_owned());
    }
    *guard = Some(running);
    Ok(())
}

#[tauri::command]
pub(super) async fn acp_send(
    app: AppHandle,
    window_label: String,
    generation: u64,
    lines: Vec<String>,
) -> Result<(), String> {
    validate_send_batch(&lines)?;
    let stdin_tx = {
        let state = app.state::<AcpProcessState>();
        let slot = state
            .slots
            .lock()
            .map_err(|_| "ACP process state is poisoned".to_owned())?
            .get(&window_label)
            .cloned()
            .ok_or_else(|| format!("pix-acp is not running for window {window_label}"))?;
        let running_slot = slot
            .running
            .lock()
            .map_err(|_| "ACP process state is poisoned".to_owned())?;
        let running = running_slot
            .as_ref()
            .ok_or_else(|| "pix-acp is not running".to_owned())?;
        if running.generation != generation {
            return Err(format!(
                "stale pix-acp generation {generation}; current generation is {}",
                running.generation
            ));
        }
        running
            .stdin_tx
            .as_ref()
            .cloned()
            .ok_or_else(|| "pix-acp stdin is closed".to_owned())?
    };
    let ack_rx = admit_stdin(&stdin_tx, lines)?;
    ack_rx
        .await
        .map_err(|_| "pix-acp stdin writer stopped before acknowledging the write".to_owned())?
}

fn validate_send_batch(lines: &[String]) -> Result<(), String> {
    if lines.is_empty() || lines.len() > MAX_SEND_BATCH_LINES {
        return Err(format!(
            "ACP send batch must contain 1..={MAX_SEND_BATCH_LINES} lines"
        ));
    }
    if lines
        .iter()
        .any(|line| line.contains('\r') || line.contains('\n'))
    {
        return Err("ACP payload must be one newline-free JSON object".to_owned());
    }
    Ok(())
}

/// One webview batch is one queue item: it is written and flushed atomically
/// in order, so batching never reorders or interleaves protocol lines.
fn admit_stdin(
    stdin_tx: &acp_queue::Queue<StdinCommand>,
    lines: Vec<String>,
) -> Result<tokio::sync::oneshot::Receiver<Result<(), String>>, String> {
    let (ack_tx, ack_rx) = tokio::sync::oneshot::channel();
    let bytes = lines.iter().map(|line| line.len() + 1).sum();
    stdin_tx
        .try_push(StdinCommand::Write { lines, ack: ack_tx }, bytes)
        .map_err(str::to_owned)?;
    Ok(ack_rx)
}

fn validate_json_object(line: &str) -> Result<(), String> {
    struct ObjectVisitor;

    impl<'de> Visitor<'de> for ObjectVisitor {
        type Value = ();

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("a JSON object")
        }

        fn visit_map<M>(self, mut map: M) -> Result<Self::Value, M::Error>
        where
            M: MapAccess<'de>,
        {
            while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
            Ok(())
        }
    }

    let mut deserializer = serde_json::Deserializer::from_str(line);
    serde::de::Deserializer::deserialize_map(&mut deserializer, ObjectVisitor)
        .and_then(|()| deserializer.end())
        .map_err(|error| format!("ACP payload is not a valid JSON object: {error}"))
}

#[tauri::command]
pub(super) async fn acp_stop(
    app: AppHandle,
    window_label: String,
    generation: u64,
) -> Result<(), String> {
    run_blocking(move || {
        let state = app.state::<AcpProcessState>();
        stop_process(&state, &window_label, Some(generation))
    })
    .await
}

pub(super) fn stop_process(
    state: &AcpProcessState,
    window_label: &str,
    expected_generation: Option<u64>,
) -> Result<(), String> {
    let slot = {
        let slots = state
            .slots
            .lock()
            .map_err(|_| "ACP process state is poisoned".to_owned())?;
        slots.get(window_label).cloned()
    };
    let Some(slot) = slot else {
        return Ok(());
    };
    stop_process_slot(&slot, expected_generation)
}

pub(super) fn stop_process_slot(
    slot: &ProcessSlot,
    expected_generation: Option<u64>,
) -> Result<(), String> {
    let process = {
        let mut running_slot = slot
            .running
            .lock()
            .map_err(|_| "ACP process state is poisoned".to_owned())?;
        running_slot.as_mut().and_then(|running| {
            if expected_generation.is_some_and(|expected| expected != running.generation) {
                return None;
            }
            // Closing stdin lets pix-acp finish its ACP connection and
            // dispose every nested pi RPC process before we use signals.
            Some((
                running.stdin_tx.take(),
                running.stop_tx.clone(),
                running.exited.clone(),
            ))
        })
    };
    let Some((stdin_tx, stop_tx, exited)) = process else {
        return Ok(());
    };

    if let Some(queue) = stdin_tx {
        queue.close();
    }
    let _ = stop_tx.send(());
    let (lock, wake) = &*exited;
    let exited = lock
        .lock()
        .map_err(|_| "ACP exit signal is poisoned".to_owned())?;
    let (_guard, timeout) = wake
        .wait_timeout_while(exited, STOP_TIMEOUT, |exited| !*exited)
        .map_err(|_| "ACP exit signal is poisoned".to_owned())?;
    if timeout.timed_out() {
        return Err("timed out waiting for pix-acp to stop".to_owned());
    }
    Ok(())
}

fn forward_stdin<W: Write + Send + 'static>(
    stdin: W,
    receiver: Arc<acp_queue::Queue<StdinCommand>>,
) {
    thread::spawn(move || {
        // Buffer a whole batch and flush once instead of one syscall per write.
        let mut stdin = std::io::BufWriter::with_capacity(64 * 1024, stdin);
        while let Some(command) = receiver.pop(None) {
            match command {
                StdinCommand::Write { lines, ack } => {
                    // Validate the whole batch before writing any of it, so an
                    // invalid entry never leaves a partially written batch.
                    if let Err(error) = lines.iter().try_for_each(|line| validate_json_object(line)) {
                        let _ = ack.send(Err(error));
                        continue;
                    }
                    let result = (|| {
                        for line in &lines {
                            stdin.write_all(line.as_bytes())?;
                            stdin.write_all(b"\n")?;
                        }
                        stdin.flush()
                    })()
                    .map_err(|error| format!("failed to write to pix-acp: {error}"));
                    let failed = result.is_err();
                    let _ = ack.send(result);
                    if failed {
                        for pending in receiver.close_and_drain() {
                            let StdinCommand::Write { ack, .. } = pending;
                            let _ = ack.send(Err(
                                "pix-acp stdin writer stopped after a write error".to_owned(),
                            ));
                        }
                        break;
                    }
                }
            }
        }
    });
}

fn forward_lines<R>(
    reader: R,
    app: AppHandle,
    window_label: String,
    event: &'static str,
    generation: u64,
    done: mpsc::Sender<()>,
) where
    R: Read + Send + 'static,
{
    // Reader backpressure is byte-bounded; oversized protocol lines occupy
    // the queue exclusively rather than being truncated.
    let lines = Arc::new(acp_queue::Queue::new(8 * 1024 * 1024, 32));
    let line_tx = lines.clone();
    let error_app = app.clone();
    let error_window_label = window_label.clone();
    thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            match line {
                Ok(line) => {
                    let bytes = line.len();
                    if line_tx.push(line, bytes).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    let _ = error_app.emit_to(
                        &error_window_label,
                        "acp://stderr",
                        LinesPayload {
                            window_label: error_window_label.clone(),
                            generation,
                            lines: vec![format!("failed to read {event}: {error}")],
                        },
                    );
                    break;
                }
            }
        }
        line_tx.close();
    });
    thread::spawn(move || {
        batch_forwarded_lines(lines, app, window_label, event, generation);
        let _ = done.send(());
    });
}

/// Completion signals of the stdout/stderr forwarders for one generation.
struct Forwarders {
    done: mpsc::Receiver<()>,
    count: usize,
}

impl Forwarders {
    /// Wait (bounded) until every forwarder emitted its final batch. Pipes
    /// reach EOF once the process group is gone; a descendant that escaped the
    /// group can hold them open, so the deadline keeps exit delivery bounded.
    fn drain(self, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        for _ in 0..self.count {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if self.done.recv_timeout(remaining).is_err() {
                break;
            }
        }
    }
}

fn batch_forwarded_lines(
    receiver: Arc<acp_queue::Queue<String>>,
    app: AppHandle,
    window_label: String,
    event: &'static str,
    generation: u64,
) {
    while let Some(first) = receiver.pop(None) {
        let mut lines = Vec::with_capacity(ACP_EVENT_BATCH_MAX_LINES);
        let mut bytes = first.len();
        lines.push(first);
        let deadline = Instant::now() + ACP_EVENT_BATCH_LATENCY;
        let mut disconnected = false;
        while lines.len() < ACP_EVENT_BATCH_MAX_LINES && bytes < 1024 * 1024 {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match receiver.pop(Some(remaining)) {
                Some(line) => {
                    bytes += line.len();
                    lines.push(line);
                }
                None => {
                    disconnected = receiver.is_closed();
                    break;
                }
            }
        }
        let _ = app.emit_to(
            &window_label,
            event,
            LinesPayload {
                window_label: window_label.clone(),
                generation,
                lines,
            },
        );
        if disconnected {
            break;
        }
    }
}

fn supervise_child(
    mut child: native_process::OwnedChild,
    stop_rx: mpsc::Receiver<()>,
    app: AppHandle,
    window_label: String,
    generation: u64,
    exited: ExitSignal,
    diagnostics: acp_diagnostics::Capture,
    forwarders: Forwarders,
) {
    let mut requested = false;
    let mut force_stop_at = None;
    let mut forced = false;
    let mut stop_error = None;
    let (status, error) = loop {
        if !requested && stop_rx.try_recv().is_ok() {
            requested = true;
            force_stop_at = Some(Instant::now() + GRACEFUL_STOP_TIMEOUT);
        }
        if force_stop_at.is_some_and(|deadline| Instant::now() >= deadline) {
            force_stop_at = None;
            match native_process::force_stop(&mut child) {
                Ok(()) => forced = true,
                Err(error) => {
                    // Still reap the leader, retry group cleanup on observed
                    // exit if the first signal failed.
                    stop_error = Some(format!("failed to stop pix-acp: {error}"));
                }
            }
        }

        // Check without reaping on Unix; kill any descendants while the
        // original leader still pins the isolated process-group ID.
        #[cfg(unix)]
        match native_process::exited_before_reap(&child) {
            Ok(true) => {
                if !forced {
                    if let Err(error) = native_process::force_stop(&mut child) {
                        stop_error =
                            Some(format!("failed to clean up pix-acp descendants: {error}"));
                    }
                }
                break match child.wait() {
                    Ok(status) => (Some(status), stop_error),
                    Err(error) => (None, Some(format!("failed to reap pix-acp: {error}"))),
                };
            }
            Ok(false) => thread::sleep(POLL_INTERVAL),
            Err(error) => break (None, Some(format!("failed to wait for pix-acp: {error}"))),
        }
        #[cfg(not(unix))]
        match child.try_wait() {
            Ok(Some(status)) => break (Some(status), stop_error),
            Ok(None) => thread::sleep(POLL_INTERVAL),
            Err(error) => break (None, Some(format!("failed to wait for pix-acp: {error}"))),
        }
    };

    // Job ownership survives leader exit. Terminate descendants even on
    // natural exit, and close the job before notifying waiting callers.
    #[cfg(windows)]
    let error = if forced {
        error
    } else {
        native_process::force_stop(&mut child)
            .err()
            .map(|e| format!("failed to clean up pix-acp descendants: {e}"))
            .or(error)
    };
    #[cfg(not(any(unix, windows)))]
    if requested && !forced {
        let _ = native_process::force_stop(&mut child);
    }
    drop(child);
    // Final stdout lines (e.g. the last JSON-RPC responses) must reach the
    // webview before exit rejects every pending request.
    forwarders.drain(FORWARDER_DRAIN_TIMEOUT);
    clear_generation(&app, &window_label, generation);
    let mut payload = exit_payload(window_label.clone(), generation, status, requested, error);
    payload.stderr = diagnostics.tail();
    let _ = app.emit_to(&window_label, "acp://exit", payload);
    let (lock, wake) = &*exited;
    if let Ok(mut exited) = lock.lock() {
        *exited = true;
        wake.notify_all();
    }
}

fn clear_generation(app: &AppHandle, window_label: &str, generation: u64) {
    let state = app.state::<AcpProcessState>();
    let slot = state
        .slots
        .lock()
        .ok()
        .and_then(|slots| slots.get(window_label).cloned());
    if let Some(slot) = slot {
        if let Ok(mut running) = slot.running.lock() {
            if running.as_ref().map(|process| process.generation) == Some(generation) {
                *running = None;
            }
        }
    }
}

pub(super) fn reserve_process_slot(
    state: &AcpProcessState,
    window_label: &str,
    window_available: impl FnOnce() -> bool,
) -> Result<Arc<ProcessSlot>, String> {
    let mut slots = state
        .slots
        .lock()
        .map_err(|_| "ACP process state is poisoned".to_owned())?;
    // Check while holding the same registry lock as destruction: checking
    // before locking could insert a closed-window slot after cleanup removed it.
    if state.exiting.load(Ordering::Acquire) || !window_available() {
        return Err("ACP window is closed".to_owned());
    }
    Ok(slots
        .entry(window_label.to_owned())
        .or_insert_with(|| Arc::new(ProcessSlot::default()))
        .clone())
}

#[cfg(test)]
fn remove_process_slot(state: &AcpProcessState, window_label: &str) -> Option<Arc<ProcessSlot>> {
    if let Ok(mut slots) = state.slots.lock() {
        return remove_process_slot_locked(&mut slots, window_label);
    }
    None
}

pub(super) fn remove_process_slot_locked(
    slots: &mut HashMap<String, Arc<ProcessSlot>>,
    window_label: &str,
) -> Option<Arc<ProcessSlot>> {
    let slot = slots.remove(window_label)?;
    slot.cancelled.store(true, Ordering::Release);
    Some(slot)
}

fn exit_payload(
    window_label: String,
    generation: u64,
    status: Option<ExitStatus>,
    requested: bool,
    error: Option<String>,
) -> ExitPayload {
    ExitPayload {
        window_label,
        generation,
        code: status.as_ref().and_then(ExitStatus::code),
        success: status.as_ref().is_some_and(ExitStatus::success),
        requested,
        error,
        stderr: String::new(),
    }
}

#[cfg(test)]
mod tests;
