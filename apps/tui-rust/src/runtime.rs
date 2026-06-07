use std::backtrace::Backtrace;
use std::fmt::Write as _;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crossterm::cursor::Show;
use crossterm::event::DisableMouseCapture;
use crossterm::execute;
use crossterm::terminal::{disable_raw_mode, LeaveAlternateScreen};

use crate::bridge::sidecar::locate_sidecar_main;
use crate::cli::CliOptions;

pub const CRASH_REPORT_DIR_ENV: &str = "PIX_TUI_CRASH_DIR";

const DIAGNOSTIC_ENV_VARS: &[&str] = &[
    "PIX_SIDECAR_PATH",
    "PIX_SIDECAR_NODE",
    "PIX_SIDECAR_AGENT_DIR",
    "PIX_SIDECAR_SESSION_MODE",
    CRASH_REPORT_DIR_ENV,
    "RUST_BACKTRACE",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SidecarStatus {
    Found(PathBuf),
    Missing(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeDiagnostics {
    pub package_name: &'static str,
    pub version: &'static str,
    pub os: &'static str,
    pub arch: &'static str,
    pub pid: u32,
    pub args: Vec<String>,
    pub startup_cwd: Option<PathBuf>,
    pub workspace_cwd: PathBuf,
    pub current_exe: Option<PathBuf>,
    pub config_candidates: Vec<PathBuf>,
    pub crash_report_dir: PathBuf,
    pub sidecar: SidecarStatus,
    pub diagnostics_env: Vec<(String, Option<String>)>,
    pub voice_feature_enabled: bool,
    pub requested_model: Option<String>,
    pub session_path: Option<PathBuf>,
    pub session_name: Option<String>,
    pub no_session: bool,
    pub new_session: bool,
    pub cwd_history_max: usize,
}

impl RuntimeDiagnostics {
    pub fn collect(opts: &CliOptions) -> Self {
        let startup_cwd = std::env::current_dir().ok();
        let workspace_cwd = opts
            .cwd
            .clone()
            .or_else(|| startup_cwd.clone())
            .unwrap_or_else(|| PathBuf::from("."));

        Self {
            package_name: env!("CARGO_PKG_NAME"),
            version: env!("CARGO_PKG_VERSION"),
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            pid: std::process::id(),
            args: std::env::args().collect(),
            startup_cwd,
            workspace_cwd,
            current_exe: std::env::current_exe().ok(),
            config_candidates: config_candidates(),
            crash_report_dir: default_crash_report_dir(),
            sidecar: match locate_sidecar_main() {
                Ok(path) => SidecarStatus::Found(path),
                Err(error) => SidecarStatus::Missing(error.to_string()),
            },
            diagnostics_env: DIAGNOSTIC_ENV_VARS
                .iter()
                .map(|key| (key.to_string(), std::env::var(key).ok()))
                .collect(),
            voice_feature_enabled: cfg!(feature = "voice"),
            requested_model: opts.model_ref.clone(),
            session_path: opts.session_path.clone(),
            session_name: opts.name.clone(),
            no_session: opts.no_session,
            new_session: opts.new,
            cwd_history_max: opts.cwd_history_max,
        }
    }

    pub fn render(&self) -> String {
        let mut out = String::new();
        let _ = writeln!(
            out,
            "{} {} runtime diagnostics",
            self.package_name, self.version
        );
        let _ = writeln!(out);
        let _ = writeln!(out, "platform: {} {}", self.os, self.arch);
        let _ = writeln!(out, "pid: {}", self.pid);
        let _ = writeln!(out, "voice feature: {}", yes_no(self.voice_feature_enabled));
        let _ = writeln!(out, "session mode: {}", self.session_mode_label());
        let _ = writeln!(out, "cwd history max: {}", self.cwd_history_max);
        let _ = writeln!(
            out,
            "startup cwd: {}",
            display_opt_path(self.startup_cwd.as_deref())
        );
        let _ = writeln!(out, "workspace cwd: {}", self.workspace_cwd.display());
        let _ = writeln!(
            out,
            "executable: {}",
            display_opt_path(self.current_exe.as_deref())
        );
        let _ = writeln!(
            out,
            "requested model: {}",
            display_opt_string(self.requested_model.as_deref())
        );
        let _ = writeln!(
            out,
            "session file: {}",
            display_opt_path(self.session_path.as_deref())
        );
        let _ = writeln!(
            out,
            "session name: {}",
            display_opt_string(self.session_name.as_deref())
        );

        let _ = writeln!(out);
        let _ = writeln!(out, "sidecar:");
        match &self.sidecar {
            SidecarStatus::Found(path) => {
                let _ = writeln!(out, "  status: found");
                let _ = writeln!(out, "  path: {}", path.display());
            }
            SidecarStatus::Missing(error) => {
                let _ = writeln!(out, "  status: missing");
                let _ = writeln!(out, "  detail: {error}");
            }
        }

        let _ = writeln!(out);
        let _ = writeln!(out, "config candidates:");
        if self.config_candidates.is_empty() {
            let _ = writeln!(out, "  (dirs::config_dir unavailable)");
        } else {
            for path in &self.config_candidates {
                let _ = writeln!(
                    out,
                    "  - {} ({})",
                    path.display(),
                    if path.is_file() { "exists" } else { "missing" }
                );
            }
        }

        let _ = writeln!(out);
        let _ = writeln!(out, "crash reports:");
        let _ = writeln!(out, "  dir: {}", self.crash_report_dir.display());
        let _ = writeln!(out, "  source: {}", self.crash_report_dir_source());
        let _ = writeln!(out, "  override env: {CRASH_REPORT_DIR_ENV}");
        let _ = writeln!(out, "  backtrace tip: set RUST_BACKTRACE=1");

        if matches!(self.sidecar, SidecarStatus::Missing(_)) {
            let _ = writeln!(out);
            let _ = writeln!(out, "startup tips:");
            let _ = writeln!(
                out,
                "  - Build the Node sidecar: npm --prefix apps/desktop-tauri/sidecar run build"
            );
            let _ = writeln!(
                out,
                "  - Or point PIX_SIDECAR_PATH at a built sidecar main.js"
            );
        }

        let _ = writeln!(out);
        let _ = writeln!(out, "environment:");
        for (key, value) in &self.diagnostics_env {
            let _ = writeln!(out, "  {key}={}", value.as_deref().unwrap_or("<unset>"));
        }

        let _ = writeln!(out);
        let _ = writeln!(out, "argv:");
        if self.args.is_empty() {
            let _ = writeln!(out, "  <empty>");
        } else {
            for arg in &self.args {
                let _ = writeln!(out, "  - {arg}");
            }
        }

        out
    }

    fn session_mode_label(&self) -> String {
        let mut reasons = Vec::new();
        if self.no_session {
            reasons.push("--no-session");
        }
        if self.new_session {
            reasons.push("--new");
        }

        if reasons.is_empty() {
            "persistent (default)".to_string()
        } else {
            format!("in-memory ({})", reasons.join(", "))
        }
    }

    fn crash_report_dir_source(&self) -> &'static str {
        if self.env_var_is_set(CRASH_REPORT_DIR_ENV) {
            "env override"
        } else {
            "platform default"
        }
    }

    fn env_var_is_set(&self, key: &str) -> bool {
        self.diagnostics_env
            .iter()
            .any(|(name, value)| name == key && value.is_some())
    }
}

pub fn default_crash_report_dir() -> PathBuf {
    crash_report_dir_from(
        std::env::var_os(CRASH_REPORT_DIR_ENV)
            .map(PathBuf::from)
            .as_deref(),
    )
}

pub fn install_panic_hook(diagnostics: RuntimeDiagnostics) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        restore_terminal_best_effort();
        let report_path = write_panic_report(&diagnostics, panic_info).ok();
        match &report_path {
            Some(path) => eprintln!(
                "\npix-tui crashed. Wrote crash report to {}\nRun `pix-tui --diagnostics` for environment details.",
                path.display()
            ),
            None => eprintln!(
                "\npix-tui crashed and could not write a crash report.\nRun `pix-tui --diagnostics` for environment details."
            ),
        }
        previous(panic_info);
    }));
}

fn write_panic_report(
    diagnostics: &RuntimeDiagnostics,
    panic_info: &std::panic::PanicHookInfo<'_>,
) -> io::Result<PathBuf> {
    std::fs::create_dir_all(&diagnostics.crash_report_dir)?;
    let path = crash_report_file_path(&diagnostics.crash_report_dir, diagnostics.pid);
    std::fs::write(&path, format_panic_report(diagnostics, panic_info))?;
    Ok(path)
}

fn format_panic_report(
    diagnostics: &RuntimeDiagnostics,
    panic_info: &std::panic::PanicHookInfo<'_>,
) -> String {
    let mut out = String::new();
    let _ = writeln!(
        out,
        "{} {} crash report",
        diagnostics.package_name, diagnostics.version
    );
    let _ = writeln!(out, "timestamp_unix: {}", unix_timestamp_secs());
    let _ = writeln!(out, "panic: {}", panic_message(panic_info));
    let _ = writeln!(
        out,
        "location: {}",
        panic_info
            .location()
            .map(|location| format!(
                "{}:{}:{}",
                location.file(),
                location.line(),
                location.column()
            ))
            .unwrap_or_else(|| "<unknown>".to_string())
    );
    let _ = writeln!(out);
    let _ = write!(out, "{}", diagnostics.render());
    let _ = writeln!(out);
    let _ = writeln!(out, "backtrace:");
    let _ = writeln!(out, "{}", Backtrace::force_capture());
    out
}

fn panic_message(panic_info: &std::panic::PanicHookInfo<'_>) -> String {
    if let Some(message) = panic_info.payload().downcast_ref::<&str>() {
        (*message).to_string()
    } else if let Some(message) = panic_info.payload().downcast_ref::<String>() {
        message.clone()
    } else {
        "non-string panic payload".to_string()
    }
}

fn crash_report_file_path(dir: &Path, pid: u32) -> PathBuf {
    dir.join(format!("panic-{}-pid{pid}.log", unix_timestamp_secs()))
}

fn crash_report_dir_from(override_dir: Option<&Path>) -> PathBuf {
    if let Some(path) = override_dir {
        return path.to_path_buf();
    }
    if let Some(base) = dirs::data_local_dir() {
        return base.join("pix-tui").join("crash-reports");
    }
    if let Some(home) = dirs::home_dir() {
        return home.join(".pix-tui").join("crash-reports");
    }
    PathBuf::from(".pix-tui-crash-reports")
}

fn config_candidates() -> Vec<PathBuf> {
    let Some(config_dir) = dirs::config_dir() else {
        return Vec::new();
    };
    ["config.toml", "config.json", "config.jsonc"]
        .into_iter()
        .map(|name| config_dir.join("pix").join(name))
        .collect()
}

fn display_opt_path(path: Option<&Path>) -> String {
    path.map(|path| path.display().to_string())
        .unwrap_or_else(|| "<unknown>".to_string())
}

fn display_opt_string(value: Option<&str>) -> String {
    value.unwrap_or("<none>").to_string()
}

pub fn restore_terminal_best_effort() {
    let _ = disable_raw_mode();
    let mut stdout = io::stdout();
    let _ = execute!(stdout, Show, DisableMouseCapture, LeaveAlternateScreen);
}

fn unix_timestamp_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn yes_no(value: bool) -> &'static str {
    if value {
        "enabled"
    } else {
        "disabled"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crash_report_dir_prefers_override() {
        let path = crash_report_dir_from(Some(Path::new("/tmp/pix-tui-crash-test")));
        assert_eq!(path, PathBuf::from("/tmp/pix-tui-crash-test"));
    }

    #[test]
    fn render_mentions_crash_dir_and_sidecar() {
        let diagnostics = RuntimeDiagnostics {
            package_name: "pix-tui",
            version: "0.1.0",
            os: "test-os",
            arch: "test-arch",
            pid: 42,
            args: vec!["pix-tui".to_string(), "--diagnostics".to_string()],
            startup_cwd: Some(PathBuf::from("/repo")),
            workspace_cwd: PathBuf::from("/repo/workspace"),
            current_exe: Some(PathBuf::from("/repo/target/debug/pix-tui")),
            config_candidates: vec![PathBuf::from("/config/pix/config.toml")],
            crash_report_dir: PathBuf::from("/tmp/pix-tui-crash-reports"),
            sidecar: SidecarStatus::Missing("not built".to_string()),
            diagnostics_env: vec![("RUST_BACKTRACE".to_string(), Some("1".to_string()))],
            voice_feature_enabled: false,
            requested_model: Some("anthropic/test".to_string()),
            session_path: None,
            session_name: Some("demo".to_string()),
            no_session: true,
            new_session: false,
            cwd_history_max: 16,
        };

        let text = diagnostics.render();
        assert!(text.contains("runtime diagnostics"));
        assert!(text.contains("status: missing"));
        assert!(text.contains("session mode: in-memory (--no-session)"));
        assert!(text.contains("/tmp/pix-tui-crash-reports"));
        assert!(text.contains("source: platform default"));
        assert!(text.contains("config.toml (missing)"));
        assert!(text.contains("RUST_BACKTRACE=1"));
        assert!(text.contains("npm --prefix apps/desktop-tauri/sidecar run build"));
        assert!(text.contains("PIX_SIDECAR_PATH"));
    }
}
