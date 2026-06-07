//! pix configuration loading.
//!
//! Rust-side port of the TypeScript pix config shape. The loader is deliberately
//! forgiving: unknown fields are ignored and missing fields are filled from
//! `Default::default()`.

mod default;
mod loader;
mod types;

pub use loader::{load_config, load_config_with_cli_model, strip_jsonc_comments, ConfigError};
pub use types::*;
