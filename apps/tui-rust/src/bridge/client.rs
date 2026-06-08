//! JSONL client for the pix-desktop-sidecar subprocess.
//!
//! Spawns the compiled Node sidecar, owns its stdio, and provides:
//!
//! - `BridgeHandle` for lifecycle (graceful kill + await tasks).
//! - `BridgeClient` for sending commands and awaiting responses.
//! - `mpsc::Receiver<BridgeEvent>` for streamed agent events and
//!   unsolicited sidecar messages (extension_ui_request, etc.).
//!
//! Framing matches `apps/desktop-tauri/sidecar/src/framing.ts`: one JSON
//! object per `\n`. We deliberately do NOT split on U+2028 / U+2029 (the
//! Node side uses the same strict-LF semantics).

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use anyhow::{Context, Result};
use serde_json::Value;
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::task::JoinHandle;
use tracing::{debug, warn};

use super::protocol::{Command, ServerMessage};
use super::sidecar::locate_sidecar_main;

/// What kind of sidecar message we forward to the UI.
#[derive(Debug, Clone)]
pub enum BridgeEvent {
    /// A streamed agent / extension event, exactly as emitted by the
    /// sidecar (`{type, ...}` minus the response envelope). The TUI is
    /// free to interpret the `type` discriminator and pull whatever
    /// fields it needs.
    Event { type_: String, payload: Value },
    /// Sidecar wrote something to stderr. Useful for diagnostics and
    /// surfacing "sidecar ready" / "switched workspace" breadcrumbs.
    Stderr(String),
    /// Sidecar reported readiness on stderr (`line.contains("sidecar ready")`).
    /// Emitted in addition to the original `Stderr` event so existing callers
    /// can still observe the raw line.
    Ready,
    /// Child process exited. Always emitted before the channel closes.
    Exit(Option<i32>),
}

/// Errors returned by `BridgeClient::request`.
#[derive(Debug, Error)]
pub enum BridgeError {
    #[error("sidecar returned failure for `{command}`: {error}")]
    ServerError { command: String, error: String },
    #[error("bridge closed before response to `{command}` arrived")]
    Closed { command: String },
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("serialize: {0}")]
    Serialize(#[from] serde_json::Error),
}

/// A live sidecar process plus the channels to drive it.
pub struct Bridge {
    pub client: BridgeClient,
    pub events: mpsc::Receiver<BridgeEvent>,
    pub handle: BridgeHandle,
}

/// Lifecycle handle for the sidecar child.
pub struct BridgeHandle {
    /// Send a value to ask the child watcher task to kill the child and
    /// await its exit. Taken by `shutdown`.
    kill_tx: Option<oneshot::Sender<()>>,
    child_task: Option<JoinHandle<()>>,
    reader_task: Option<JoinHandle<()>>,
    stderr_task: Option<JoinHandle<()>>,
}

impl BridgeHandle {
    /// Politely kill the sidecar and wait for all bridge tasks to finish.
    pub async fn shutdown(mut self) -> Result<()> {
        if let Some(tx) = self.kill_tx.take() {
            // Receiver drop is fine too; sending wakes the select arm.
            let _ = tx.send(());
        }
        if let Some(t) = self.child_task.take() {
            let _ = t.await;
        }
        if let Some(t) = self.reader_task.take() {
            let _ = t.await;
        }
        if let Some(t) = self.stderr_task.take() {
            let _ = t.await;
        }
        Ok(())
    }
}

/// Cloneable handle used by UI tasks to send commands. Each call returns a
/// future that resolves with the parsed response data.
#[derive(Clone)]
pub struct BridgeClient {
    inner: Arc<ClientInner>,
}

type PendingResponseTx = oneshot::Sender<Result<Value, BridgeError>>;
type PendingResponses = Arc<Mutex<HashMap<String, PendingResponseTx>>>;
type CommandLabels = Arc<Mutex<HashMap<String, String>>>;

struct ClientInner {
    next_id: Mutex<u64>,
    stdin: Mutex<ChildStdin>,
    pending: PendingResponses,
    command_for: CommandLabels,
    last_stderr_lines: Arc<Mutex<VecDeque<String>>>,
}

impl BridgeClient {
    /// Send a command and await its response.
    pub async fn request(&self, command: Command) -> Result<Value, BridgeError> {
        let (id_str, label) = match &command {
            Command::Prompt(c) => (c.id.clone().unwrap_or_default(), "prompt".to_string()),
            Command::EnhancePrompt(c) => (
                c.id.clone().unwrap_or_default(),
                "enhance_prompt".to_string(),
            ),
            Command::Abort(c) => (c.id.clone().unwrap_or_default(), "abort".to_string()),
            Command::UndoLastTurn(c) => (
                c.id.clone().unwrap_or_default(),
                "undo_last_turn".to_string(),
            ),
            Command::Compact(c) => (c.id.clone().unwrap_or_default(), "compact".to_string()),
            Command::NewSession(c) => (c.id.clone().unwrap_or_default(), "new_session".to_string()),
            Command::SwitchSession(c) => (
                c.id.clone().unwrap_or_default(),
                "switch_session".to_string(),
            ),
            Command::SetSessionName(c) => (
                c.id.clone().unwrap_or_default(),
                "set_session_name".to_string(),
            ),
            Command::ListSessions(c) => (
                c.id.clone().unwrap_or_default(),
                "pix:list_sessions".to_string(),
            ),
            Command::GetState(c) => (c.id.clone().unwrap_or_default(), "get_state".to_string()),
            Command::GetMessages(c) => {
                (c.id.clone().unwrap_or_default(), "get_messages".to_string())
            }
            Command::GetModels(c) => (c.id.clone().unwrap_or_default(), "get_models".to_string()),
            Command::SetModel(c) => (c.id.clone().unwrap_or_default(), "set_model".to_string()),
            Command::SetThinkingLevel(c) => (
                c.id.clone().unwrap_or_default(),
                "set_thinking_level".to_string(),
            ),
            Command::Other(value) => {
                let id = value
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let label = value
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string();
                (id, label)
            }
        };

        let (tx, rx) = oneshot::channel();
        if id_str.is_empty() {
            return Err(BridgeError::Closed { command: label });
        }
        {
            let mut pending = self.inner.pending.lock().await;
            pending.insert(id_str.clone(), tx);
            let mut cf = self.inner.command_for.lock().await;
            cf.insert(id_str.clone(), label.clone());
        }

        let bytes = serde_json::to_vec(&command)?;
        {
            let mut stdin = self.inner.stdin.lock().await;
            stdin.write_all(&bytes).await?;
            stdin.write_all(b"\n").await?;
            stdin.flush().await?;
        }

        match rx.await {
            Ok(result) => result,
            Err(_) => Err(BridgeError::Closed { command: label }),
        }
    }

    pub(crate) async fn alloc_id(&self) -> String {
        let mut g = self.inner.next_id.lock().await;
        *g += 1;
        format!("tui-{}", *g)
    }

    /// Helper: build and send a prompt.
    pub async fn prompt(&self, message: String) -> Result<Value, BridgeError> {
        let id = self.alloc_id().await;
        self.request(Command::Prompt(super::protocol::PromptCommand::new(
            id, message,
        )))
        .await
    }

    /// Helper: build and send a prompt with image attachments.
    pub async fn prompt_with_images(
        &self,
        message: String,
        images: Vec<Value>,
    ) -> Result<Value, BridgeError> {
        if images.is_empty() {
            return self.prompt(message).await;
        }
        let id = self.alloc_id().await;
        let mut command = super::protocol::PromptCommand::new(id, message);
        command.images = Some(images);
        self.request(Command::Prompt(command)).await
    }

    /// Helper: enhance/rewrite a draft prompt.
    pub async fn enhance_prompt(
        &self,
        text: String,
        model: Option<String>,
    ) -> Result<Value, BridgeError> {
        let id = self.alloc_id().await;
        self.request(Command::EnhancePrompt(
            super::protocol::EnhancePromptCommand::new(id, text, model),
        ))
        .await
    }

    /// Helper: abort current run.
    pub async fn abort(&self) -> Result<Value, BridgeError> {
        let id = self.alloc_id().await;
        self.request(Command::Abort(super::protocol::AbortCommand::new(id)))
            .await
    }

    /// Helper: undo the latest user turn.
    pub async fn undo_last_turn(&self) -> Result<Value, BridgeError> {
        let id = self.alloc_id().await;
        self.request(Command::UndoLastTurn(
            super::protocol::UndoLastTurnCommand::new(id),
        ))
        .await
    }

    /// Helper: compact the current conversation.
    pub async fn compact(&self, summary: Option<String>) -> Result<Value, BridgeError> {
        let id = self.alloc_id().await;
        self.request(Command::Compact(super::protocol::CompactCommand::new(
            id, summary,
        )))
        .await
    }

    /// Helper: start a new session.
    pub async fn new_session(&self, parent: Option<String>) -> Result<Value, BridgeError> {
        let id = self.alloc_id().await;
        self.request(Command::NewSession(
            super::protocol::NewSessionCommand::new(id, parent),
        ))
        .await
    }

    /// Helper: switch to an existing session file.
    pub async fn switch_session(&self, session_path: String) -> Result<Value, BridgeError> {
        let id = self.alloc_id().await;
        self.request(Command::SwitchSession(
            super::protocol::SwitchSessionCommand::new(id, session_path),
        ))
        .await
    }

    /// Helper: set current session name.
    pub async fn set_session_name(&self, name: String) -> Result<Value, BridgeError> {
        let id = self.alloc_id().await;
        self.request(Command::SetSessionName(
            super::protocol::SetSessionNameCommand::new(id, name),
        ))
        .await
    }

    /// Helper: list persisted sessions.
    pub async fn list_sessions(&self) -> Result<Value, BridgeError> {
        let id = self.alloc_id().await;
        self.request(Command::ListSessions(
            super::protocol::ListSessionsCommand::new(id),
        ))
        .await
    }

    /// Helper: get session state.
    pub async fn get_state(&self) -> Result<Value, BridgeError> {
        let id = self.alloc_id().await;
        self.request(Command::GetState(super::protocol::GetStateCommand::new(id)))
            .await
    }

    /// Helper: tail messages.
    pub async fn get_messages_tail(&self, limit: u32) -> Result<Value, BridgeError> {
        let id = self.alloc_id().await;
        self.request(Command::GetMessages(
            super::protocol::GetMessagesCommand::tail(id, limit),
        ))
        .await
    }

    /// Helper: lazily fetch older persisted messages before the current tail.
    pub async fn get_messages_older(&self, limit: u32) -> Result<Value, BridgeError> {
        let id = self.alloc_id().await;
        self.request(Command::GetMessages(
            super::protocol::GetMessagesCommand::older(id, limit),
        ))
        .await
    }

    /// Helper: fetch available models.
    pub async fn get_models(&self) -> Result<Value, BridgeError> {
        let id = self.alloc_id().await;
        self.request(Command::GetModels(super::protocol::GetModelsCommand::new(
            id,
        )))
        .await
    }

    /// Helper: switch the active model by full ref.
    pub async fn set_model_ref(&self, model_ref: String) -> Result<Value, BridgeError> {
        let id = self.alloc_id().await;
        self.request(Command::SetModel(super::protocol::SetModelCommand::new(
            id, model_ref,
        )))
        .await
    }

    /// Helper: switch the active thinking level.
    pub async fn set_thinking_level(&self, level: String) -> Result<Value, BridgeError> {
        let id = self.alloc_id().await;
        self.request(Command::SetThinkingLevel(
            super::protocol::SetThinkingLevelCommand::new(id, level),
        ))
        .await
    }

    /// Return the most recent sidecar stderr lines (oldest to newest).
    pub async fn recent_stderr(&self) -> Vec<String> {
        self.inner
            .last_stderr_lines
            .lock()
            .await
            .iter()
            .cloned()
            .collect()
    }

    #[cfg(test)]
    pub(crate) fn from_test_stdin(stdin: ChildStdin) -> Self {
        Self {
            inner: Arc::new(ClientInner {
                next_id: Mutex::new(0),
                stdin: Mutex::new(stdin),
                pending: Arc::new(Mutex::new(HashMap::new())),
                command_for: Arc::new(Mutex::new(HashMap::new())),
                last_stderr_lines: Arc::new(Mutex::new(VecDeque::new())),
            }),
        }
    }
}

/// Spawn the sidecar and wire up the reader / stderr / lifecycle tasks.
pub async fn spawn_bridge(cwd: Option<PathBuf>) -> Result<Bridge> {
    spawn_bridge_with_session_mode(cwd, None).await
}

/// Spawn the sidecar with an optional explicit session mode.
pub async fn spawn_bridge_with_session_mode(
    cwd: Option<PathBuf>,
    session_mode: Option<&str>,
) -> Result<Bridge> {
    let main_js = locate_sidecar_main().context("failed to locate pix-desktop-sidecar")?;
    debug!(?main_js, "spawning sidecar");

    let node = std::env::var("PIX_SIDECAR_NODE").unwrap_or_else(|_| "node".to_string());

    let mut cmd = tokio::process::Command::new(&node);
    cmd.arg(&main_js);
    if let Some(cwd) = cwd.as_deref() {
        cmd.current_dir(cwd);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    if let Ok(val) = std::env::var("PIX_SIDECAR_AGENT_DIR") {
        cmd.env("PIX_SIDECAR_AGENT_DIR", val);
    }
    if let Some(val) = session_mode {
        cmd.env("PIX_SIDECAR_SESSION_MODE", val);
    } else if let Ok(val) = std::env::var("PIX_SIDECAR_SESSION_MODE") {
        cmd.env("PIX_SIDECAR_SESSION_MODE", val);
    }

    let mut child = cmd.spawn().context("failed to spawn sidecar")?;
    let stdin = child.stdin.take().context("no stdin")?;
    let stdout = child.stdout.take().context("no stdout")?;
    let stderr = child.stderr.take().context("no stderr")?;

    let (event_tx, event_rx) = mpsc::channel(256);
    let last_stderr_lines: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));

    // ---- stderr pump ---------------------------------------------------
    let stderr_task: JoinHandle<()> = {
        let event_tx = event_tx.clone();
        let last_stderr_lines = last_stderr_lines.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut buf = Vec::<u8>::with_capacity(1024);
            loop {
                buf.clear();
                match read_until_newline(&mut reader, &mut buf).await {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(e) => {
                        warn!(?e, "sidecar stderr read failed");
                        break;
                    }
                }
                let line = String::from_utf8_lossy(&buf).trim_end().to_string();
                if !line.is_empty() {
                    {
                        let mut lines = last_stderr_lines.lock().await;
                        while lines.len() >= 50 {
                            lines.pop_front();
                        }
                        lines.push_back(line.clone());
                    }
                    if line.contains("sidecar ready")
                        && event_tx.send(BridgeEvent::Ready).await.is_err()
                    {
                        break;
                    }
                    if event_tx.send(BridgeEvent::Stderr(line)).await.is_err() {
                        break;
                    }
                }
            }
        })
    };

    // ---- pending response table ---------------------------------------
    let pending: PendingResponses = Arc::new(Mutex::new(HashMap::new()));
    let command_for: CommandLabels = Arc::new(Mutex::new(HashMap::new()));

    // ---- stdout pump ---------------------------------------------------
    let reader_task: JoinHandle<()> = {
        let pending_clone = pending.clone();
        let command_for_clone = command_for.clone();
        let event_tx = event_tx.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut buf = Vec::<u8>::with_capacity(8 * 1024);
            loop {
                buf.clear();
                match read_until_newline(&mut reader, &mut buf).await {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(e) => {
                        warn!(?e, "sidecar stdout read failed");
                        break;
                    }
                }
                let value: Value = match serde_json::from_slice(&buf) {
                    Ok(v) => v,
                    Err(e) => {
                        warn!(?e, payload = ?String::from_utf8_lossy(&buf), "sidecar sent invalid JSON");
                        continue;
                    }
                };
                let type_ = value
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if type_ == "response" {
                    handle_response(value, &pending_clone, &command_for_clone).await;
                } else {
                    let _ = event_tx
                        .send(BridgeEvent::Event {
                            type_,
                            payload: value,
                        })
                        .await;
                }
            }
            // Flush pending requests so callers don't hang.
            let mut p = pending_clone.lock().await;
            for (id, tx) in p.drain() {
                let cmd = command_for_clone
                    .lock()
                    .await
                    .remove(&id)
                    .unwrap_or_default();
                let _ = tx.send(Err(BridgeError::Closed { command: cmd }));
            }
        })
    };

    // ---- child watcher: emits Exit on natural exit OR kills via oneshot.
    let (kill_tx, kill_rx) = oneshot::channel::<()>();
    let child_task: JoinHandle<()> = tokio::spawn(async move {
        let mut child = child;
        let code = tokio::select! {
            status = child.wait() => status.ok().and_then(|s| s.code()),
            _ = kill_rx => {
                let _ = child.start_kill();
                child.wait().await.ok().and_then(|s| s.code())
            }
        };
        let _ = event_tx.send(BridgeEvent::Exit(code)).await;
    });

    let handle = BridgeHandle {
        kill_tx: Some(kill_tx),
        child_task: Some(child_task),
        reader_task: Some(reader_task),
        stderr_task: Some(stderr_task),
    };

    let client = BridgeClient {
        inner: Arc::new(ClientInner {
            next_id: Mutex::new(0),
            stdin: Mutex::new(stdin),
            pending,
            command_for,
            last_stderr_lines,
        }),
    };

    Ok(Bridge {
        client,
        events: event_rx,
        handle,
    })
}

async fn handle_response(
    value: Value,
    pending: &Mutex<HashMap<String, oneshot::Sender<Result<Value, BridgeError>>>>,
    command_for: &Mutex<HashMap<String, String>>,
) {
    let parsed: ServerMessage = match serde_json::from_value(value) {
        Ok(m) => m,
        Err(e) => {
            warn!(?e, "failed to decode response envelope");
            return;
        }
    };
    let ServerMessage::Response {
        id,
        command,
        success,
        data,
        error,
    } = parsed
    else {
        return;
    };
    let Some(id) = id else { return };
    let mut p = pending.lock().await;
    let Some(tx) = p.remove(&id) else {
        debug!(%id, %command, "response for unknown id (late or duplicate)");
        return;
    };
    drop(p);
    let _ = command_for.lock().await.remove(&id);

    let result = if success {
        Ok(data.unwrap_or(Value::Null))
    } else {
        let msg = error.unwrap_or_else(|| "unknown sidecar error".to_string());
        Err(BridgeError::ServerError {
            command,
            error: msg,
        })
    };
    if tx.send(result).is_err() {
        debug!(%id, "response dropped: caller went away");
    }
}

/// Read bytes from `reader` into `buf` until `\n` (inclusive) or EOF.
/// Returns the number of bytes appended (0 = EOF).
async fn read_until_newline<R>(reader: &mut R, buf: &mut Vec<u8>) -> std::io::Result<usize>
where
    R: AsyncReadExt + Unpin,
{
    let mut total = 0;
    let mut byte = [0u8; 1];
    loop {
        let n = reader.read(&mut byte).await?;
        if n == 0 {
            return Ok(total);
        }
        total += 1;
        buf.push(byte[0]);
        if byte[0] == b'\n' {
            // Strip the trailing newline so the JSON parser is happy.
            buf.pop();
            return Ok(total);
        }
    }
}
