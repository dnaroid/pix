use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::ipc::Channel;

#[derive(Default)]
pub struct PtyRegistry {
    sessions: HashMap<String, PtySession>,
    next_id: u64,
}

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
}

#[derive(Debug, Deserialize)]
pub struct PtyStartOptions {
    pub cwd: String,
    pub command: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

#[derive(Debug, Serialize)]
pub struct PtyStartResult {
    pub id: String,
}

fn send_event(channel: &Channel<Value>, id: &str, event: &str, payload: Value) {
    let mut value = json!({
        "id": id,
        "event": event,
    });
    if let (Some(obj), Some(payload_obj)) = (value.as_object_mut(), payload.as_object()) {
        for (key, value) in payload_obj {
            obj.insert(key.clone(), value.clone());
        }
    }
    let _ = channel.send(value);
}

pub fn start(
    registry: &Arc<Mutex<PtyRegistry>>,
    opts: PtyStartOptions,
    on_event: Channel<Value>,
) -> Result<PtyStartResult, String> {
    let canonical = std::fs::canonicalize(PathBuf::from(&opts.cwd))
        .map_err(|e| format!("pty cwd not accessible: {e}"))?;
    if !canonical.is_dir() {
        return Err(format!("pty cwd is not a directory: {}", canonical.display()));
    }

    let cols = opts.cols.unwrap_or(100).clamp(20, 400);
    let rows = opts.rows.unwrap_or(28).clamp(8, 120);
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("open pty failed: {e}"))?;

    let shell = if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    };
    let mut cmd = CommandBuilder::new(shell);
    cmd.cwd(canonical);
    if let Some(command) = opts.command.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if cfg!(windows) {
            cmd.arg("/C");
            cmd.arg(command);
        } else {
            cmd.arg("-lc");
            cmd.arg(command);
        }
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn pty command failed: {e}"))?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone pty reader failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take pty writer failed: {e}"))?;

    let (id, writer) = {
        let mut guard = registry.lock().map_err(|_| "pty registry poisoned".to_string())?;
        guard.next_id += 1;
        let id = format!("pty-{}", guard.next_id);
        let writer = Arc::new(Mutex::new(writer));
        let child = Arc::new(Mutex::new(child));
        guard.sessions.insert(
            id.clone(),
            PtySession {
                master: pair.master,
                writer: writer.clone(),
                child: child.clone(),
            },
        );
        (id, writer)
    };

    let reader_id = id.clone();
    let reader_channel = on_event.clone();
    let reader_registry = registry.clone();
    thread::spawn(move || {
        let mut buf = [0_u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => send_event(
                    &reader_channel,
                    &reader_id,
                    "output",
                    json!({ "data": String::from_utf8_lossy(&buf[..n]).into_owned() }),
                ),
                Err(e) => {
                    send_event(&reader_channel, &reader_id, "error", json!({ "error": e.to_string() }));
                    break;
                }
            }
        }
        if let Ok(mut guard) = reader_registry.lock() {
            guard.sessions.remove(&reader_id);
        }
        send_event(&reader_channel, &reader_id, "exit", json!({}));
    });

    // Keep the writer Arc considered live by the compiler until after threads are spawned.
    drop(writer);
    Ok(PtyStartResult { id })
}

pub fn write(registry: &Arc<Mutex<PtyRegistry>>, id: String, data: String) -> Result<(), String> {
    let writer = {
        let guard = registry.lock().map_err(|_| "pty registry poisoned".to_string())?;
        guard
            .sessions
            .get(&id)
            .map(|session| session.writer.clone())
            .ok_or_else(|| format!("unknown pty session: {id}"))?
    };
    let mut writer = writer.lock().map_err(|_| "pty writer poisoned".to_string())?;
    writer.write_all(data.as_bytes()).map_err(|e| format!("pty write failed: {e}"))?;
    writer.flush().map_err(|e| format!("pty flush failed: {e}"))
}

pub fn resize(registry: &Arc<Mutex<PtyRegistry>>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let guard = registry.lock().map_err(|_| "pty registry poisoned".to_string())?;
    let session = guard
        .sessions
        .get(&id)
        .ok_or_else(|| format!("unknown pty session: {id}"))?;
    session
        .master
        .resize(PtySize {
            rows: rows.clamp(8, 120),
            cols: cols.clamp(20, 400),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("pty resize failed: {e}"))
}

pub fn kill(registry: &Arc<Mutex<PtyRegistry>>, id: String) -> Result<(), String> {
    let child = {
        let guard = registry.lock().map_err(|_| "pty registry poisoned".to_string())?;
        guard
            .sessions
            .get(&id)
            .map(|session| session.child.clone())
            .ok_or_else(|| format!("unknown pty session: {id}"))?
    };
    let mut child = child.lock().map_err(|_| "pty child poisoned".to_string())?;
    child.kill().map_err(|e| format!("pty kill failed: {e}"))
}
