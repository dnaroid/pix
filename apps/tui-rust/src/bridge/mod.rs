//! Bridge to the pix-desktop-sidecar subprocess.
//!
//! See `README.md` for the protocol overview. The Rust side only knows
//! enough of the wire format to drive the vertical slice; everything else
//! flows through as raw JSON.

pub mod client;
pub mod protocol;
pub mod sidecar;

pub use client::{
    spawn_bridge, spawn_bridge_with_session_mode, Bridge, BridgeClient, BridgeError, BridgeEvent,
    BridgeHandle,
};
pub use protocol::{
    AbortCommand, Command, EnhancePromptCommand, EventKind, GetMessagesCommand, GetModelsCommand,
    GetStateCommand, ListSessionsCommand, NewSessionCommand, PromptCommand, SetModelCommand,
    SetSessionNameCommand, SwitchSessionCommand,
};
