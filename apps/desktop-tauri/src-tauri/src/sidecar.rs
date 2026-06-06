//! JSON-line bridge to the Node sidecar.
//!
//! The Tauri Rust host spawns the Node sidecar (running `runRpcMode` from the
//! SDK) and proxies the SDK's RPC protocol between the React frontend and the
//! sidecar:
//!
//!   Frontend ──invoke()──▶ Rust ──stdin JSON-line──▶ Node sidecar (runRpcMode)
//!                 ▲                     │
//!                 │                     └─stdout JSON-line──┐
//!                 └──Tauri Channel──────┴─ Rust reader ──────┘
//!
//! Wire format (SDK RPC mode, see docs/rpc.md):
//! - Commands (stdin):  `{"id":"req-1","type":"prompt","message":"hi"}`
//! - Responses (stdout): `{"id":"req-1","type":"response","command":"prompt","success":true,...}`
//! - Events (stdout):    `{"type":"agent_start" | "message_update" | ...}`  (no id)
//! - Extension UI reqs:  `{"type":"extension_ui_request","id":"<ext-id>","method":"select",...}`
//!   These are forwarded to subscribers; React will respond via a separate
//!   command in a later phase.
//!
//! The reader task matches responses by `id` against pending oneshots and
//! broadcasts events (and extension-ui requests) to all subscribers.

use anyhow::{anyhow, Context, Result};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::{oneshot, Mutex};

/// Live RPC handle to the sidecar process.
///
/// Cloneable via `Arc`; keep the original alive to keep the child process
/// running (the `Child` is held inside an internal Mutex and is dropped when
/// all clones are dropped, killing the process thanks to `kill_on_drop`).
#[derive(Clone)]
pub struct SidecarHandle {
    inner: Arc<Inner>,
}

struct Inner {
    writer: Mutex<BufWriter<ChildStdin>>,
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    subscribers: Mutex<Vec<Channel<Value>>>,
    next_id: AtomicU64,
    _child: Mutex<Child>,
}

/// Spawn the sidecar with default discovery.
///
/// Resolution order:
/// 1. `PIX_SIDECAR_CMD` + `PIX_SIDECAR_ARGS` (full override).
/// 2. `PIX_SIDECAR_PATH` → `node --import tsx <path>`.
/// 3. Look for `sidecar/src/main.ts` in known relative paths from `src-tauri/`,
///    the repo root, etc., then launch as `node --import tsx <path>`.
pub async fn spawn_default() -> Result<SidecarHandle> {
    let (program, args, sidecar_dir) = resolve_command()?;
    tracing::info!(program = %program, args = ?args, "spawning pix sidecar");
    spawn_with(&program, &args, sidecar_dir.as_deref()).await
}

fn resolve_command() -> Result<(String, Vec<String>, Option<PathBuf>)> {
    if let (Ok(cmd), Ok(args_str)) = (
        std::env::var("PIX_SIDECAR_CMD"),
        std::env::var("PIX_SIDECAR_ARGS"),
    ) {
        let args = args_str
            .split_whitespace()
            .map(String::from)
            .collect::<Vec<_>>();
        // PIX_SIDECAR_CMD/ARGS is a full override — caller manages cwd.
        return Ok((cmd, args, None));
    }

    let sidecar_path = resolve_sidecar_path()?;
    let program = std::env::var("PIX_SIDECAR_CMD").unwrap_or_else(|_| "node".to_string());
    let args = vec![
        "--import".to_string(),
        "tsx".to_string(),
        sidecar_path.to_string_lossy().to_string(),
    ];
    // Spawn the sidecar from its own package directory so Node module
    // resolution finds `tsx` and the SDK regardless of Tauri's cwd.
    // The user's workspace cwd is supplied later via the `pix:set_cwd` RPC
    // command (originating from the native folder picker).
    let sidecar_pkg_dir = sidecar_path
        .parent()
        .and_then(|p| p.parent())
        .map(|p| canonicalize(p))
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    Ok((program, args, Some(sidecar_pkg_dir)))
}

fn resolve_sidecar_path() -> Result<PathBuf> {
    if let Ok(p) = std::env::var("PIX_SIDECAR_PATH") {
        let candidate = PathBuf::from(&p);
        if candidate.exists() {
            return Ok(canonicalize(&candidate));
        }
        tracing::warn!(path = %p, "PIX_SIDECAR_PATH set but file does not exist");
    }

    // 1. Search relative to the Tauri binary's location. This is essential
    //    when the binary is launched from a foreign cwd (e.g. via the
    //    `pix-desktop` CLI launcher from a project folder). For dev builds
    //    the binary sits in `apps/desktop-tauri/src-tauri/target/{debug,release}/`
    //    so the sidecar entry is at `../../../sidecar/src/main.ts` relative
    //    to the binary.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let near_candidates = [
                exe_dir.join("../../../sidecar/src/main.ts"),
                exe_dir.join("../../sidecar/src/main.ts"),
                exe_dir.join("../sidecar/src/main.ts"),
                exe_dir.join("sidecar/src/main.ts"),
            ];
            for c in near_candidates {
                if c.exists() {
                    tracing::debug!(path = %c.display(), "found sidecar entry (near binary)");
                    return Ok(canonicalize(&c));
                }
            }

            // 2. Walk up from the binary looking for `apps/desktop-tauri/sidecar/...`
            //    or a sibling `sidecar/src/main.ts`. Stops at ~10 levels.
            let mut current = exe_dir.to_path_buf();
            for _ in 0..10 {
                let candidate = current.join("apps/desktop-tauri/sidecar/src/main.ts");
                if candidate.exists() {
                    tracing::debug!(path = %candidate.display(), "found sidecar entry (workspace walk)");
                    return Ok(canonicalize(&candidate));
                }
                let candidate = current.join("sidecar/src/main.ts");
                if candidate.exists() {
                    tracing::debug!(path = %candidate.display(), "found sidecar entry (workspace walk)");
                    return Ok(canonicalize(&candidate));
                }
                let Some(parent) = current.parent() else { break };
                current = parent.to_path_buf();
            }
        }
    }

    // 3. Fallback: paths relative to the current working directory. This is
    //    the original Phase 0 behavior and still works when launched via
    //    `tauri dev` from `src-tauri/`.
    let cwd = std::env::current_dir().context("no cwd")?;
    let candidates: [PathBuf; 4] = [
        cwd.join("../sidecar/src/main.ts"),
        cwd.join("../../sidecar/src/main.ts"),
        cwd.join("sidecar/src/main.ts"),
        cwd.join("apps/desktop-tauri/sidecar/src/main.ts"),
    ];
    for c in candidates {
        if c.exists() {
            tracing::debug!(path = %c.display(), "found sidecar entry (cwd-relative)");
            return Ok(canonicalize(&c));
        }
    }
    Err(anyhow!(
        "could not locate sidecar/src/main.ts; set PIX_SIDECAR_PATH or run via `tauri dev` from src-tauri/"
    ))
}

fn canonicalize(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

async fn spawn_with(
    program: &str,
    args: &[String],
    sidecar_dir: Option<&Path>,
) -> Result<SidecarHandle> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);

    if let Some(dir) = sidecar_dir {
        cmd.current_dir(dir);
        tracing::debug!(spawn_cwd = %dir.display(), "sidecar spawn cwd");
    }

    let mut child = cmd
        .spawn()
        .with_context(|| format!("failed to spawn sidecar: {program}"))?;

    let stdin = child.stdin.take().context("sidecar stdin missing")?;
    let stdout = child.stdout.take().context("sidecar stdout missing")?;

    let inner = Arc::new(Inner {
        writer: Mutex::new(BufWriter::new(stdin)),
        pending: Mutex::new(HashMap::new()),
        subscribers: Mutex::new(Vec::new()),
        next_id: AtomicU64::new(1),
        _child: Mutex::new(child),
    });

    let reader_inner = inner.clone();
    tokio::spawn(async move {
        run_reader(stdout, reader_inner).await;
    });

    Ok(SidecarHandle { inner })
}

async fn run_reader(stdout: ChildStdout, inner: Arc<Inner>) {
    let mut lines = BufReader::new(stdout).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) if line.is_empty() => continue,
            Ok(Some(line)) => handle_line(&line, &inner).await,
            Ok(None) => {
                tracing::info!("sidecar stdout closed");
                break;
            }
            Err(e) => {
                tracing::error!(error = %e, "sidecar read error");
                break;
            }
        }
    }
    // Sidecar exited: fail all pending callers so they don't hang forever.
    let mut map = inner.pending.lock().await;
    for (_, tx) in map.drain() {
        let _ = tx.send(serde_json::json!({
            "type": "response",
            "command": "internal",
            "success": false,
            "error": "sidecar exited"
        }));
    }
}

async fn handle_line(line: &str, inner: &Arc<Inner>) {
    let value: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(
                error = %e,
                line = %line.chars().take(200).collect::<String>(),
                "non-JSON line from sidecar"
            );
            return;
        }
    };

    let ty = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let has_id = value.get("id").is_some();

    match (ty, has_id) {
        ("response", true) => {
            // Response to a request we sent; resolve by id.
            let id = value.get("id").cloned().unwrap_or(Value::Null);
            let id_key = match &id {
                Value::String(s) => s.clone(),
                Value::Number(n) => n.to_string(),
                _ => {
                    tracing::warn!(?id, "response with non-string id");
                    return;
                }
            };
            let mut map = inner.pending.lock().await;
            match map.remove(&id_key) {
                Some(tx) => {
                    if let Err(resp) = tx.send(value) {
                        tracing::warn!(id = %id_key, "dropped sidecar response: receiver gone");
                        let _ = resp;
                    }
                }
                None => tracing::warn!(id = %id_key, "orphan sidecar response (no pending request)"),
            }
        }
        _ => {
            // Event or extension_ui_request: broadcast to all subscribers.
            broadcast(&value, inner).await;
        }
    }
}

async fn broadcast(value: &Value, inner: &Arc<Inner>) {
    let mut subs = inner.subscribers.lock().await;
    if subs.is_empty() {
        return;
    }
    let mut dead = Vec::new();
    for (i, ch) in subs.iter().enumerate() {
        if let Err(e) = ch.send(value.clone()) {
            tracing::debug!(error = %e, idx = i, "subscriber dropped, removing");
            dead.push(i);
        }
    }
    // Remove dead subscribers in reverse to keep indices stable.
    for i in dead.into_iter().rev() {
        subs.swap_remove(i);
    }
}

impl SidecarHandle {
    /// Send an RPC command and await the matching response.
    ///
    /// `cmd` must be a valid RPC command object (e.g. `{"type":"prompt","message":"hi"}`).
    /// If `cmd` does not have an `id`, one is assigned automatically. Returns
    /// the full response object (including `success`, `data`, and `error`).
    pub async fn call(&self, mut cmd: Value) -> Result<Value> {
        let id = match cmd.get("id") {
            Some(_) => None, // caller-supplied; trust it.
            None => {
                let n = self.inner.next_id.fetch_add(1, Ordering::SeqCst);
                let id = format!("rpc-{n}");
                if let Some(obj) = cmd.as_object_mut() {
                    obj.insert("id".to_string(), Value::String(id.clone()));
                    Some(id)
                } else {
                    return Err(anyhow!("rpc cmd must be a JSON object"));
                }
            }
        };

        let id_key = match cmd.get("id") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Number(n)) => n.to_string(),
            _ => return Err(anyhow!("rpc cmd missing id")),
        };

        let (tx, rx) = oneshot::channel::<Value>();
        {
            let mut map = self.inner.pending.lock().await;
            map.insert(id_key.clone(), tx);
        }

        let line = serde_json::to_string(&cmd).context("encode sidecar request")?;
        {
            let mut w = self.inner.writer.lock().await;
            w.write_all(line.as_bytes()).await.context("write request")?;
            w.write_all(b"\n").await.context("write newline")?;
            w.flush().await.context("flush sidecar stdin")?;
        }

        let _ = id; // already embedded in cmd
        let response = rx.await.context("sidecar dropped response channel")?;
        Ok(response)
    }

    /// Register a channel that receives every event emitted by the sidecar.
    /// Events include `agent_start`, `message_update`, `tool_execution_*`,
    /// `extension_ui_request`, etc. Responses are NOT forwarded (they are
    /// returned from `call`).
    pub async fn subscribe(&self, channel: Channel<Value>) {
        let mut subs = self.inner.subscribers.lock().await;
        subs.push(channel);
    }
}
