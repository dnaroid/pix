use serde::Serialize;
use serde_json::Value;
use std::{
    env,
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, ExitStatus, Stdio},
    sync::{mpsc, Arc, Condvar, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};

const POLL_INTERVAL: Duration = Duration::from_millis(40);
const GRACEFUL_STOP_TIMEOUT: Duration = Duration::from_secs(2);
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
type ExitSignal = Arc<(Mutex<bool>, Condvar)>;

#[derive(Default)]
struct AcpProcessState {
    slot: Mutex<ProcessSlot>,
}

#[derive(Default)]
struct ProcessSlot {
    next_generation: u64,
    running: Option<RunningProcess>,
}

struct RunningProcess {
    generation: u64,
    stdin: Option<ChildStdin>,
    stop_tx: mpsc::Sender<()>,
    exited: ExitSignal,
}

impl Drop for RunningProcess {
    fn drop(&mut self) {
        let _ = self.stop_tx.send(());
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitPayload {
    generation: u64,
    code: Option<i32>,
    success: bool,
    requested: bool,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LinePayload {
    generation: u64,
    line: String,
}

#[tauri::command]
fn acp_start(app: AppHandle, state: State<'_, AcpProcessState>) -> Result<u64, String> {
    let mut slot = state
        .slot
        .lock()
        .map_err(|_| "ACP process state is poisoned".to_owned())?;
    if let Some(running) = &slot.running {
        return Ok(running.generation);
    }

    let node = env::var_os("PIX_ACP_NODE_BINARY").unwrap_or_else(|| "node".into());
    let entry = env::var_os("PIX_ACP_ENTRY")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../acp/dist/main.js")
        });
    if !entry.is_file() {
        return Err(format!(
            "pix-acp entry not found at {} (run `npm run build:acp` first or set PIX_ACP_ENTRY)",
            entry.display()
        ));
    }

    let mut child = Command::new(&node)
        .arg(&entry)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to start {:?}: {error}", node))?;

    let pipes = (child.stdin.take(), child.stdout.take(), child.stderr.take());
    let (Some(stdin), Some(stdout), Some(stderr)) = pipes else {
        let _ = child.kill();
        let _ = child.wait();
        return Err("pix-acp did not expose all stdio pipes".to_owned());
    };

    slot.next_generation = slot.next_generation.wrapping_add(1);
    let generation = slot.next_generation;
    let (stop_tx, stop_rx) = mpsc::channel();
    let exited = Arc::new((Mutex::new(false), Condvar::new()));
    slot.running = Some(RunningProcess {
        generation,
        stdin: Some(stdin),
        stop_tx,
        exited: exited.clone(),
    });
    drop(slot);

    forward_lines(stdout, app.clone(), "acp://stdout", generation);
    forward_lines(stderr, app.clone(), "acp://stderr", generation);
    thread::spawn(move || supervise_child(child, stop_rx, app, generation, exited));
    Ok(generation)
}

#[tauri::command]
fn acp_send(
    generation: u64,
    line: String,
    state: State<'_, AcpProcessState>,
) -> Result<(), String> {
    if line.contains('\r') || line.contains('\n') {
        return Err("ACP payload must be one newline-free JSON object".to_owned());
    }
    let value: Value = serde_json::from_str(&line)
        .map_err(|error| format!("ACP payload is not valid JSON: {error}"))?;
    if !value.is_object() {
        return Err("ACP payload must be a JSON object".to_owned());
    }

    let mut slot = state
        .slot
        .lock()
        .map_err(|_| "ACP process state is poisoned".to_owned())?;
    let running = slot
        .running
        .as_mut()
        .ok_or_else(|| "pix-acp is not running".to_owned())?;
    if running.generation != generation {
        return Err(format!(
            "stale pix-acp generation {generation}; current generation is {}",
            running.generation
        ));
    }
    let stdin = running
        .stdin
        .as_mut()
        .ok_or_else(|| "pix-acp stdin is closed".to_owned())?;
    stdin
        .write_all(format!("{line}\n").as_bytes())
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("failed to write to pix-acp: {error}"))
}

#[tauri::command]
fn acp_stop(generation: u64, state: State<'_, AcpProcessState>) -> Result<(), String> {
    stop_process(&state, Some(generation))
}

fn stop_process(state: &AcpProcessState, expected_generation: Option<u64>) -> Result<(), String> {
    let process = {
        let mut slot = state
            .slot
            .lock()
            .map_err(|_| "ACP process state is poisoned".to_owned())?;
        slot.running.as_mut().and_then(|running| {
            if expected_generation.is_some_and(|expected| expected != running.generation) {
                return None;
            }
            // Closing stdin lets pix-acp finish its ACP connection and
            // dispose every nested pi RPC process before we use signals.
            running.stdin.take();
            Some((running.stop_tx.clone(), running.exited.clone()))
        })
    };
    let Some((stop_tx, exited)) = process else {
        return Ok(());
    };

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

fn forward_lines<R>(reader: R, app: AppHandle, event: &'static str, generation: u64)
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            match line {
                Ok(line) => {
                    let _ = app.emit(event, LinePayload { generation, line });
                }
                Err(error) => {
                    let _ = app.emit(
                        "acp://stderr",
                        LinePayload {
                            generation,
                            line: format!("failed to read {event}: {error}"),
                        },
                    );
                    break;
                }
            }
        }
    });
}

fn supervise_child(
    mut child: Child,
    stop_rx: mpsc::Receiver<()>,
    app: AppHandle,
    generation: u64,
    exited: ExitSignal,
) {
    let mut requested = false;
    let mut force_stop_at = None;
    let mut stop_error = None;
    let (status, error) = loop {
        if !requested && stop_rx.try_recv().is_ok() {
            requested = true;
            force_stop_at = Some(Instant::now() + GRACEFUL_STOP_TIMEOUT);
        }
        if force_stop_at.is_some_and(|deadline| Instant::now() >= deadline) {
            force_stop_at = None;
            if let Err(error) = child.kill() {
                // The process may have exited between the stop request and
                // kill. Keep polling so it is always reaped with try_wait.
                stop_error = Some(format!("failed to stop pix-acp: {error}"));
            }
        }

        match child.try_wait() {
            Ok(Some(status)) => break (Some(status), stop_error),
            Ok(None) => thread::sleep(POLL_INTERVAL),
            Err(error) => break (None, Some(format!("failed to wait for pix-acp: {error}"))),
        }
    };

    clear_generation(&app, generation);
    let payload = exit_payload(generation, status, requested, error);
    let _ = app.emit("acp://exit", payload);
    let (lock, wake) = &*exited;
    if let Ok(mut exited) = lock.lock() {
        *exited = true;
        wake.notify_all();
    }
}

fn clear_generation(app: &AppHandle, generation: u64) {
    let state = app.state::<AcpProcessState>();
    if let Ok(mut slot) = state.slot.lock() {
        if slot.running.as_ref().map(|process| process.generation) == Some(generation) {
            slot.running = None;
        }
    };
}

fn exit_payload(
    generation: u64,
    status: Option<ExitStatus>,
    requested: bool,
    error: Option<String>,
) -> ExitPayload {
    ExitPayload {
        generation,
        code: status.as_ref().and_then(ExitStatus::code),
        success: status.as_ref().is_some_and(ExitStatus::success),
        requested,
        error,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(AcpProcessState::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![acp_start, acp_send, acp_stop])
        .build(tauri::generate_context!())
        .expect("failed to build Pix Desktop");
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            let state = handle.state::<AcpProcessState>();
            if let Err(error) = stop_process(&state, None) {
                eprintln!("failed to stop pix-acp during exit: {error}");
            }
        }
    });
}
