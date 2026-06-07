//! Wire types for the pix-desktop-sidecar JSONL protocol.
//!
//! Mirrors `apps/desktop-tauri/sidecar/src/protocol.ts`. We model only the
//! pieces the TUI needs for the vertical slice; everything else stays as
//! `serde_json::Value` so we can extend without touching the parser.
//!
//! Framing: one JSON object per `\n`. No JSON-RPC 2.0 — the protocol uses a
//! flatter `{id?, type, ...}` shape.

use serde::{de, Deserialize, Deserializer, Serialize};
use serde_json::Value;

// ---------- Commands (TUI -> sidecar) -------------------------------------

/// Commands we send to the sidecar. The `type` field is what the dispatcher
/// switches on; `id` is optional but recommended so responses can be paired.
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum Command {
    Prompt(PromptCommand),
    EnhancePrompt(EnhancePromptCommand),
    Abort(AbortCommand),
    UndoLastTurn(UndoLastTurnCommand),
    Compact(CompactCommand),
    NewSession(NewSessionCommand),
    SwitchSession(SwitchSessionCommand),
    SetSessionName(SetSessionNameCommand),
    ListSessions(ListSessionsCommand),
    GetState(GetStateCommand),
    GetMessages(GetMessagesCommand),
    GetModels(GetModelsCommand),
    SetModel(SetModelCommand),
    Other(Value),
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct EnhancePromptCommand {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub type_: &'static str,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

impl EnhancePromptCommand {
    pub fn new(id: impl Into<String>, text: impl Into<String>, model: Option<String>) -> Self {
        Self {
            id: Some(id.into()),
            type_: "enhance_prompt",
            text: text.into(),
            model,
        }
    }
}

impl<'de> Deserialize<'de> for EnhancePromptCommand {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Wire {
            id: Option<String>,
            #[serde(rename = "type")]
            type_: String,
            text: String,
            model: Option<String>,
        }

        let wire = Wire::deserialize(deserializer)?;
        if wire.type_ != "enhance_prompt" {
            return Err(de::Error::custom(format!(
                "expected enhance_prompt command, got {}",
                wire.type_
            )));
        }
        Ok(Self {
            id: wire.id,
            type_: "enhance_prompt",
            text: wire.text,
            model: wire.model,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PromptCommand {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub type_: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub streaming_behavior: Option<&'static str>,
}

impl PromptCommand {
    pub fn new(id: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            id: Some(id.into()),
            type_: "prompt",
            message: message.into(),
            images: None,
            streaming_behavior: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AbortCommand {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub type_: &'static str,
}

impl AbortCommand {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: Some(id.into()),
            type_: "abort",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct UndoLastTurnCommand {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub type_: &'static str,
}

impl UndoLastTurnCommand {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: Some(id.into()),
            type_: "undo_last_turn",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct CompactCommand {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub type_: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

impl CompactCommand {
    pub fn new(id: impl Into<String>, summary: Option<String>) -> Self {
        Self {
            id: Some(id.into()),
            type_: "compact",
            summary,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct NewSessionCommand {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub type_: &'static str,
    #[serde(rename = "parentSession", skip_serializing_if = "Option::is_none")]
    pub parent_session: Option<String>,
}

impl NewSessionCommand {
    pub fn new(id: impl Into<String>, parent_session: Option<String>) -> Self {
        Self {
            id: Some(id.into()),
            type_: "new_session",
            parent_session,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SwitchSessionCommand {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub type_: &'static str,
    #[serde(rename = "sessionPath")]
    pub session_path: String,
}

impl SwitchSessionCommand {
    pub fn new(id: impl Into<String>, session_path: String) -> Self {
        Self {
            id: Some(id.into()),
            type_: "switch_session",
            session_path,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SetSessionNameCommand {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub type_: &'static str,
    pub name: String,
}

impl SetSessionNameCommand {
    pub fn new(id: impl Into<String>, name: String) -> Self {
        Self {
            id: Some(id.into()),
            type_: "set_session_name",
            name,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ListSessionsCommand {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub type_: &'static str,
}

impl ListSessionsCommand {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: Some(id.into()),
            type_: "pix:list_sessions",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct GetStateCommand {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub type_: &'static str,
}

impl GetStateCommand {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: Some(id.into()),
            type_: "get_state",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct GetMessagesCommand {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub type_: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_end: Option<bool>,
}

impl GetMessagesCommand {
    pub fn tail(id: impl Into<String>, limit: u32) -> Self {
        Self {
            id: Some(id.into()),
            type_: "get_messages",
            limit: Some(limit),
            offset: None,
            from_end: Some(true),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct GetModelsCommand {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub type_: &'static str,
}

impl GetModelsCommand {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: Some(id.into()),
            type_: "get_models",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SetModelCommand {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub type_: &'static str,
    #[serde(rename = "ref")]
    pub ref_: String,
}

impl SetModelCommand {
    pub fn new(id: impl Into<String>, ref_: impl Into<String>) -> Self {
        Self {
            id: Some(id.into()),
            type_: "set_model",
            ref_: ref_.into(),
        }
    }
}

// ---------- Responses (sidecar -> TUI) ------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    /// Reply to a previous command. `command` echoes the request's `type`.
    Response {
        id: Option<String>,
        command: String,
        success: bool,
        #[serde(default)]
        data: Option<Value>,
        #[serde(default)]
        error: Option<String>,
    },
    /// Anything else: streamed agent events (`assistant_message_start`,
    /// `tool_call_start`, `tool_result`, etc.). We carry the raw JSON so
    /// each renderer can pluck the fields it needs without us modelling
    /// the full event schema up-front.
    #[serde(other)]
    Event,
}

// ---------- Common event payload helpers ----------------------------------

/// Best-effort event discriminator. The sidecar forwards events from
/// `AgentSession.subscribe(...)` verbatim, and we only model the handful we
/// need for the slice. Everything else is still rendered as a generic block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventKind {
    AssistantMessageStart,
    AssistantMessagePart,
    AssistantMessageEnd,
    ModelChange,
    ToolCallStart,
    ToolCallEnd,
    ToolResult,
    MessageStart,
    MessageEnd,
    StreamStart,
    StreamEnd,
    Error,
    SessionStart,
    Other,
}

impl EventKind {
    pub fn from_type(type_str: &str) -> Self {
        match type_str {
            "assistant_message_start" => Self::AssistantMessageStart,
            "assistant_message_part" => Self::AssistantMessagePart,
            "assistant_message_end" => Self::AssistantMessageEnd,
            "model_change" => Self::ModelChange,
            "tool_call_start" => Self::ToolCallStart,
            "tool_call_end" => Self::ToolCallEnd,
            "tool_result" => Self::ToolResult,
            "message_start" => Self::MessageStart,
            "message_end" => Self::MessageEnd,
            "stream_start" => Self::StreamStart,
            "stream_end" => Self::StreamEnd,
            "error" => Self::Error,
            "session_start" => Self::SessionStart,
            _ => Self::Other,
        }
    }
}

/// Extract the string at `payload.key` if present.
pub fn get_str<'a>(payload: &'a Value, key: &str) -> Option<&'a str> {
    payload.get(key)?.as_str()
}

/// Extract a string but only if non-empty.
pub fn get_nonempty_str<'a>(payload: &'a Value, key: &str) -> Option<&'a str> {
    let s = get_str(payload, key)?;
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_get_models_command() {
        let json = serde_json::to_value(Command::GetModels(GetModelsCommand::new("req-1")))
            .expect("serialize get_models");
        assert_eq!(json.get("type").and_then(Value::as_str), Some("get_models"));
    }

    #[test]
    fn serializes_set_model_command_with_ref() {
        let json = serde_json::to_value(Command::SetModel(SetModelCommand::new(
            "req-2",
            "openai-codex/gpt-5.5",
        )))
        .expect("serialize set_model");
        assert_eq!(json.get("type").and_then(Value::as_str), Some("set_model"));
        assert_eq!(
            json.get("ref").and_then(Value::as_str),
            Some("openai-codex/gpt-5.5")
        );
    }
}
