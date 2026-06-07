//! OSC 52 clipboard support.
//!
//! OSC 52 escape sequences must be written directly to stdout. Sending them
//! through ratatui would buffer the bytes as part of a rendered frame.

use std::io::{self, Write};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::Value;

use crate::ui::app::{App, Block};

const OSC52_CHUNK_BASE64_BYTES: usize = 4096;

/// A high-level copy request that can be resolved against the current app state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClipboardRequest {
    LastAssistantText,
    LastToolCallArgs(String),
    Raw(String),
}

impl ClipboardRequest {
    pub fn resolve(&self, app: &App) -> Option<String> {
        match self {
            Self::LastAssistantText => app.blocks.iter().rev().find_map(|block| match block {
                Block::Assistant { text, .. } => Some(text.clone()),
                _ => None,
            }),
            Self::LastToolCallArgs(call_id) => resolve_tool_call_args(app, call_id),
            Self::Raw(text) => Some(text.clone()),
        }
    }
}

/// Copy text to the terminal clipboard via OSC 52.
pub fn copy_to_clipboard(text: &str) -> io::Result<()> {
    let mut stdout = io::stdout().lock();
    for sequence in osc52_clipboard_sequences(text) {
        stdout.write_all(sequence.as_bytes())?;
    }
    stdout.flush()
}

fn resolve_tool_call_args(app: &App, call_id: &str) -> Option<String> {
    let idx = app.call_index.get(call_id)?;
    let Some(Block::ToolCall { args, .. }) = app.blocks.get(idx) else {
        return None;
    };
    Some(format_json(args))
}

fn format_json(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

fn encode_text_base64(text: &str) -> String {
    STANDARD.encode(text.as_bytes())
}

fn osc52_clipboard_sequences(text: &str) -> Vec<String> {
    chunk_base64_payload(&encode_text_base64(text))
        .into_iter()
        .map(osc52_sequence_from_base64)
        .collect()
}

fn chunk_base64_payload(encoded: &str) -> Vec<&str> {
    if encoded.is_empty() {
        return vec![""];
    }
    encoded
        .as_bytes()
        .chunks(OSC52_CHUNK_BASE64_BYTES)
        .map(|chunk| std::str::from_utf8(chunk).expect("base64 is valid utf8"))
        .collect()
}

fn osc52_sequence_from_base64(encoded: &str) -> String {
    format!("\x1b]52;c;{encoded}\x07")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(sequence: &str) -> &str {
        sequence
            .strip_prefix("\x1b]52;c;")
            .and_then(|s| s.strip_suffix('\x07'))
            .expect("valid OSC 52 sequence")
    }

    #[test]
    fn empty_string_encodes_correctly() {
        assert_eq!(encode_text_base64(""), "");
        assert_eq!(osc52_clipboard_sequences(""), vec!["\x1b]52;c;\x07"]);
    }

    #[test]
    fn short_string_encodes_correctly() {
        assert_eq!(encode_text_base64("hello"), "aGVsbG8=");
    }

    #[test]
    fn long_string_chunks_into_multiple_sequences() {
        let text = "x".repeat(4097);
        let encoded = encode_text_base64(&text);
        let sequences = osc52_clipboard_sequences(&text);

        assert_eq!(sequences.len(), 2);
        assert!(sequences
            .iter()
            .all(|sequence| payload(sequence).len() <= 4096));

        let rejoined_payload: String = sequences.iter().map(|sequence| payload(sequence)).collect();
        assert_eq!(rejoined_payload, encoded);
    }

    #[test]
    fn osc52_envelope_format_matches_spec() {
        assert_eq!(
            osc52_sequence_from_base64("aGVsbG8="),
            "\x1b]52;c;aGVsbG8=\x07"
        );
    }
}
