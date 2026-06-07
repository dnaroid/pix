//! CLI argument parser. Minimal hand-rolled parser, matches the TS pix
//! flags we actually consume in the vertical slice (`--cwd`, `--no-session`).

use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct CliOptions {
    pub cwd: Option<PathBuf>,
    pub no_session: bool,
    /// Print runtime diagnostics and exit.
    pub diagnostics: bool,
    /// Start a fresh in-memory session (TS pix: --new / -n).
    pub new: bool,
    /// Optional session file to resume (TS pix: --session <path>).
    pub session_path: Option<PathBuf>,
    /// Optional name to apply to the established session.
    pub name: Option<String>,
    /// Initial model ref like `anthropic/claude-3-7-sonnet:high`.
    pub model_ref: Option<String>,
    /// Maximum workspace cwd history entries to retain.
    pub cwd_history_max: usize,
}

impl Default for CliOptions {
    fn default() -> Self {
        Self {
            cwd: None,
            no_session: false,
            diagnostics: false,
            new: false,
            session_path: None,
            name: None,
            model_ref: None,
            cwd_history_max: 16,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CliError {
    #[error("unknown flag: {0}")]
    UnknownFlag(String),
    #[error("flag `{0}` requires a value")]
    MissingValue(String),
    #[error("{0}")]
    Other(String),
}

pub fn parse_args<I, S>(args: I) -> Result<CliOptions, CliError>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut opts = CliOptions::default();
    let mut it = args.into_iter().peekable();
    while let Some(arg) = it.next() {
        let arg: String = arg.into();
        match arg.as_str() {
            "-h" | "--help" => {
                print_usage();
                std::process::exit(0);
            }
            "-V" | "--version" => {
                println!("{}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            "--diagnostics" => opts.diagnostics = true,
            "--no-session" => opts.no_session = true,
            "-n" | "--new" => opts.new = true,
            "--cwd" => {
                let v = it
                    .next()
                    .ok_or_else(|| CliError::MissingValue(arg.clone()))?
                    .into();
                opts.cwd = Some(PathBuf::from(v));
            }
            s if let Some(rest) = s.strip_prefix("--cwd=") => {
                opts.cwd = Some(PathBuf::from(rest));
            }
            "--session" => {
                let v = it
                    .next()
                    .ok_or_else(|| CliError::MissingValue(arg.clone()))?
                    .into();
                opts.session_path = Some(PathBuf::from(v));
            }
            s if let Some(rest) = s.strip_prefix("--session=") => {
                opts.session_path = Some(PathBuf::from(rest));
            }
            "--name" => {
                let v = it
                    .next()
                    .ok_or_else(|| CliError::MissingValue(arg.clone()))?
                    .into();
                opts.name = Some(v);
            }
            s if let Some(rest) = s.strip_prefix("--name=") => {
                opts.name = Some(rest.to_string());
            }
            "--model" => {
                let v = it
                    .next()
                    .ok_or_else(|| CliError::MissingValue(arg.clone()))?
                    .into();
                opts.model_ref = Some(v);
            }
            s if let Some(rest) = s.strip_prefix("--model=") => {
                opts.model_ref = Some(rest.to_string());
            }
            "--cwd-history-max" => {
                let v: String = it
                    .next()
                    .ok_or_else(|| CliError::MissingValue(arg.clone()))?
                    .into();
                opts.cwd_history_max = parse_usize_flag(&arg, &v)?;
            }
            s if let Some(rest) = s.strip_prefix("--cwd-history-max=") => {
                opts.cwd_history_max = parse_usize_flag("--cwd-history-max", rest)?;
            }
            other => {
                return Err(CliError::UnknownFlag(other.to_string()));
            }
        }
    }
    Ok(opts)
}

fn parse_usize_flag(flag: &str, value: &str) -> Result<usize, CliError> {
    value
        .parse::<usize>()
        .map_err(|_| CliError::Other(format!("flag `{flag}` expects a non-negative integer")))
}

pub fn print_usage() {
    println!("{}", usage_text());
}

pub fn usage_text() -> String {
    format!(
        "pix-tui {version}\n\n\
         Experimental Rust terminal UI for the Pix / Pi sidecar bridge.\n\n\
         Usage: pix-tui [OPTIONS]\n\n\
         Options:\n  \
           --cwd <PATH>          Workspace to bind the agent to (default: current dir)\n  \
           --no-session          Run with an in-memory session (do not persist)\n  \
           -n, --new             Start a fresh in-memory session\n  \
           --session <PATH>      Resume the given session file\n  \
           --name <NAME>         Set the current session name after startup\n  \
           --model <REF>         Initial model ref (e.g. anthropic/claude-3-7-sonnet:high)\n  \
           --cwd-history-max <N> Max workspace cwd history entries (default: 16)\n  \
           --diagnostics         Print runtime diagnostics and exit\n  \
           -h, --help            Show this help message\n  \
           -V, --version         Show version\n\n\
         Examples:\n  \
           pix-tui --diagnostics\n  \
           pix-tui --cwd /path/to/workspace\n  \
           pix-tui --no-session --cwd /path/to/workspace\n\n\
         Troubleshooting:\n  \
           - Run `pix-tui --diagnostics` to confirm sidecar/config/crash-report paths.\n  \
           - Build the sidecar with `npm --prefix apps/desktop-tauri/sidecar run build`.\n  \
           - Set `PIX_SIDECAR_PATH=/abs/path/to/main.js` to use a custom sidecar build.\n  \
           - Set `RUST_BACKTRACE=1` for Rust panic backtraces.\n  \
           - Set `PIX_TUI_CRASH_DIR=/path` to override the crash-report directory.",
        version = env!("CARGO_PKG_VERSION")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_diagnostics_flag() {
        let opts = parse_args(["--diagnostics"]).expect("parse should succeed");
        assert!(opts.diagnostics);
    }

    #[test]
    fn usage_mentions_diagnostics() {
        let usage = usage_text();
        assert!(usage.contains("--diagnostics"));
        assert!(usage.contains("pix-tui --cwd /path/to/workspace"));
        assert!(usage.contains("npm --prefix apps/desktop-tauri/sidecar run build"));
        assert!(usage.contains("PIX_SIDECAR_PATH"));
        assert!(usage.contains("PIX_TUI_CRASH_DIR"));
    }
}
