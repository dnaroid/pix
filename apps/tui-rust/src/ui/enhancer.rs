//! Prompt enhancer bridge integration.
//!
//! The Rust TUI does not rewrite prompts itself. It sends the current input to
//! the sidecar via the assumed `enhance_prompt` command and applies the returned
//! `{ text }` payload when available. Older sidecars do not implement this
//! command yet, so unknown-command server errors are classified as
//! `NotSupported` for a warning-only UI fallback.

use std::error::Error;
use std::fmt;

use serde::Deserialize;
use serde_json::Value;

use crate::bridge::{BridgeClient, BridgeError, Command, EnhancePromptCommand};

#[derive(Debug)]
pub enum EnhancerError {
    NotSupported,
    Empty,
    Bridge(BridgeError),
    Other(String),
}

impl fmt::Display for EnhancerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotSupported => write!(f, "prompt enhancer not supported by sidecar"),
            Self::Empty => write!(f, "prompt is empty"),
            Self::Bridge(error) => write!(f, "{error}"),
            Self::Other(message) => write!(f, "{message}"),
        }
    }
}

impl Error for EnhancerError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Bridge(error) => Some(error),
            _ => None,
        }
    }
}

#[derive(Clone)]
pub struct Enhancer {
    client: BridgeClient,
    model: Option<String>,
}

impl Enhancer {
    pub fn new(client: BridgeClient, model: Option<String>) -> Self {
        Self {
            client,
            model: normalize_model(model),
        }
    }

    pub async fn enhance(&self, text: &str) -> Result<String, EnhancerError> {
        let text = normalize_input(text)?;
        let id = self.client.alloc_id().await;
        let command = Command::EnhancePrompt(EnhancePromptCommand::new(
            id,
            text.to_string(),
            self.model.clone(),
        ));

        let data = self
            .client
            .request(command)
            .await
            .map_err(classify_bridge_error_owned)?;

        parse_enhance_response(data)
    }
}

pub fn classify_bridge_error(error: &BridgeError) -> EnhancerError {
    if is_not_supported_bridge_error(error) {
        EnhancerError::NotSupported
    } else {
        EnhancerError::Other(error.to_string())
    }
}

fn classify_bridge_error_owned(error: BridgeError) -> EnhancerError {
    if is_not_supported_bridge_error(&error) {
        EnhancerError::NotSupported
    } else {
        EnhancerError::Bridge(error)
    }
}

fn is_not_supported_bridge_error(error: &BridgeError) -> bool {
    let BridgeError::ServerError { command, error } = error else {
        return false;
    };

    let normalized_command = command.trim().to_ascii_lowercase();
    let normalized_error = error.trim().to_ascii_lowercase();

    normalized_error.contains("unknown command")
        || normalized_error.contains("unknown sidecar command")
        || normalized_error.contains("unsupported command")
        || normalized_error.contains("unrecognized command")
        || (normalized_command == "enhance_prompt" && status_implies_unknown(&normalized_error))
}

fn status_implies_unknown(error: &str) -> bool {
    error.contains("unknown")
        || error.contains("unsupported")
        || error.contains("unrecognized")
        || error.contains("not implemented")
        || error.contains("no handler")
        || error.contains("not found")
}

fn normalize_input(text: &str) -> Result<&str, EnhancerError> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        Err(EnhancerError::Empty)
    } else {
        Ok(trimmed)
    }
}

fn normalize_model(model: Option<String>) -> Option<String> {
    model.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

fn parse_enhance_response(data: Value) -> Result<String, EnhancerError> {
    #[derive(Deserialize)]
    struct EnhancePromptResponse {
        text: String,
    }

    serde_json::from_value::<EnhancePromptResponse>(data)
        .map(|response| response.text)
        .map_err(|error| EnhancerError::Other(format!("invalid enhance_prompt response: {error}")))
}

#[cfg(test)]
mod tests {
    use std::process::Stdio;

    use tokio::process::Command as TokioCommand;

    use super::*;

    async fn enhancer_for_empty_tests() -> (Enhancer, tokio::process::Child) {
        let mut child = TokioCommand::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn cat test process");
        let stdin = child.stdin.take().expect("test child stdin");
        let client = BridgeClient::from_test_stdin(stdin);
        (Enhancer::new(client, None), child)
    }

    async fn stop_child(mut child: tokio::process::Child) {
        let _ = child.kill().await;
    }

    #[tokio::test]
    async fn enhance_empty_input_returns_empty() {
        let (enhancer, child) = enhancer_for_empty_tests().await;

        let result = enhancer.enhance("").await;

        assert!(matches!(result, Err(EnhancerError::Empty)));
        drop(enhancer);
        stop_child(child).await;
    }

    #[tokio::test]
    async fn enhance_whitespace_only_input_returns_empty() {
        let (enhancer, child) = enhancer_for_empty_tests().await;

        let result = enhancer.enhance("  \n\t  ").await;

        assert!(matches!(result, Err(EnhancerError::Empty)));
        drop(enhancer);
        stop_child(child).await;
    }

    #[test]
    fn not_supported_display_is_friendly() {
        assert_eq!(
            EnhancerError::NotSupported.to_string(),
            "prompt enhancer not supported by sidecar"
        );
    }

    #[test]
    fn other_display_uses_message() {
        assert_eq!(
            EnhancerError::Other("model returned an empty prompt".to_string()).to_string(),
            "model returned an empty prompt"
        );
    }

    #[test]
    fn classify_bridge_error_maps_unknown_command_to_not_supported() {
        let error = BridgeError::ServerError {
            command: "enhance_prompt".to_string(),
            error: "unknown command: enhance_prompt".to_string(),
        };

        assert!(matches!(
            classify_bridge_error(&error),
            EnhancerError::NotSupported
        ));
    }

    #[test]
    fn enhance_prompt_command_round_trips_through_serde() {
        let command = EnhancePromptCommand::new(
            "enhance-1",
            "how do i fix the bug",
            Some("zai/glm-5-turbo".to_string()),
        );

        let encoded = serde_json::to_string(&command).expect("serialize enhance command");
        let decoded: EnhancePromptCommand =
            serde_json::from_str(&encoded).expect("deserialize enhance command");

        assert_eq!(decoded, command);
        assert_eq!(decoded.type_, "enhance_prompt");
    }
}
