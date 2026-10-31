//! Supervised Git child processes for commands that can block on a remote or
//! walk a very large history. Each run is isolated in its own process group,
//! bounded by a deadline and optional cooperative cancellation, and has its
//! output capped. On exit, timeout or cancellation the whole group is killed
//! before reaping, so ssh/credential helpers cannot keep a pipe or a blocking
//! worker alive. Detached `git gc --auto` calls `setsid` and is unaffected.
use super::{
    git_command, git_command_error, native_process, read_bounded_process_stream, POLL_INTERVAL,
};
use std::{
    env,
    path::Path,
    process::{ChildStderr, ChildStdout, Command, ExitStatus, Output, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

/// Deadline for fetch/pull/push/update. Stalled transfers are normally caught
/// much earlier by the SSH keep-alive and HTTP low-speed guards below; this
/// bounds everything else (hung helpers, slow hooks, silent servers).
pub(crate) const GIT_NETWORK_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MAX_GIT_NETWORK_STDOUT_BYTES: usize = 1024 * 1024;
const MAX_GIT_NETWORK_STDERR_BYTES: usize = 256 * 1024;
const GIT_NETWORK_CONFIG_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_GIT_NETWORK_CONFIG_BYTES: usize = 64 * 1024;
/// Never prompt (there is no terminal), fail fast on unreachable hosts and
/// detect dead connections instead of waiting for TCP to give up.
const BATCH_SSH_COMMAND: &str =
    "ssh -o BatchMode=yes -o ConnectTimeout=30 -o ServerAliveInterval=15 -o ServerAliveCountMax=4";
const HTTP_LOW_SPEED_LIMIT_BYTES: &str = "1000";
const HTTP_LOW_SPEED_TIME_SECONDS: &str = "60";

#[derive(Debug)]
pub(crate) enum SupervisedError {
    Spawn(std::io::Error),
    Observe(std::io::Error),
    Reader,
    TimedOut,
    Cancelled,
}

impl std::fmt::Display for SupervisedError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Spawn(error) => write!(formatter, "could not start: {error}"),
            Self::Observe(error) => write!(formatter, "could not observe the process: {error}"),
            Self::Reader => formatter.write_str("output reader failed"),
            Self::TimedOut => formatter.write_str("timed out"),
            Self::Cancelled => formatter.write_str("cancelled"),
        }
    }
}

/// Run `command` with piped stdout/stderr consumed on reader threads. The
/// readers always finish because the process group is killed before joining.
pub(crate) fn supervise<O, E>(
    command: &mut Command,
    timeout: Duration,
    cancelled: Option<&AtomicBool>,
    read_stdout: impl FnOnce(ChildStdout) -> O + Send + 'static,
    read_stderr: impl FnOnce(ChildStderr) -> E + Send + 'static,
) -> Result<(ExitStatus, O, E), SupervisedError>
where
    O: Send + 'static,
    E: Send + 'static,
{
    if cancelled.is_some_and(|token| token.load(Ordering::Acquire)) {
        return Err(SupervisedError::Cancelled);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    native_process::isolate(command);
    let mut child = native_process::spawn(command).map_err(SupervisedError::Spawn)?;
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        let _ = native_process::force_stop(&mut child);
        let _ = child.wait();
        return Err(SupervisedError::Reader);
    };
    let stdout_thread = thread::spawn(move || read_stdout(stdout));
    let stderr_thread = thread::spawn(move || read_stderr(stderr));
    let deadline = Instant::now() + timeout;
    let outcome = loop {
        if cancelled.is_some_and(|token| token.load(Ordering::Acquire)) {
            break Err(SupervisedError::Cancelled);
        }
        match native_process::exited_before_reap(&child) {
            Ok(true) => {
                // Kill descendants that inherited the pipes before reaping the leader.
                let _ = native_process::force_stop(&mut child);
                break child.wait().map_err(SupervisedError::Observe);
            }
            Ok(false) => {}
            Err(error) => break Err(SupervisedError::Observe(error)),
        }
        #[cfg(not(unix))]
        match child.try_wait() {
            Ok(Some(status)) => {
                let _ = native_process::force_stop(&mut child);
                break Ok(status);
            }
            Ok(None) => {}
            Err(error) => break Err(SupervisedError::Observe(error)),
        }
        if Instant::now() >= deadline {
            break Err(SupervisedError::TimedOut);
        }
        thread::sleep(POLL_INTERVAL);
    };
    if outcome.is_err() {
        let _ = native_process::force_stop(&mut child);
        let _ = child.wait();
    }
    let stdout = stdout_thread.join();
    let stderr = stderr_thread.join();
    let status = outcome?;
    Ok((
        status,
        stdout.map_err(|_| SupervisedError::Reader)?,
        stderr.map_err(|_| SupervisedError::Reader)?,
    ))
}

pub(crate) struct BoundedOutput {
    pub output: Output,
    pub truncated: bool,
}

pub(crate) fn bounded_output(
    command: &mut Command,
    timeout: Duration,
    max_stdout: usize,
    max_stderr: usize,
    cancelled: Option<&AtomicBool>,
) -> Result<BoundedOutput, SupervisedError> {
    let (status, (stdout, stdout_truncated), (stderr, stderr_truncated)) = supervise(
        command,
        timeout,
        cancelled,
        move |stdout| read_bounded_process_stream(stdout, max_stdout),
        move |stderr| read_bounded_process_stream(stderr, max_stderr),
    )?;
    Ok(BoundedOutput {
        output: Output {
            status,
            stdout,
            stderr,
        },
        truncated: stdout_truncated || stderr_truncated,
    })
}

/// Run a Git command that talks to a remote. Returns the output only on
/// success, like `git_output`; failures and timeouts become user-facing errors.
/// `label` is a fixed operation name: never log arguments, paths or refs.
pub(crate) fn git_network_output(
    root: &Path,
    args: &[&str],
    label: &'static str,
) -> Result<Output, String> {
    git_network_output_with(root, args, label, GIT_NETWORK_TIMEOUT)
}

fn git_network_output_with(
    root: &Path,
    args: &[&str],
    label: &'static str,
    timeout: Duration,
) -> Result<Output, String> {
    let mut command = git_command(root, args);
    for (key, value) in network_overrides(&configured_network_keys(root), |key| {
        env::var_os(key).is_some()
    }) {
        command.env(key, value);
    }
    let output = match bounded_output(
        &mut command,
        timeout,
        MAX_GIT_NETWORK_STDOUT_BYTES,
        MAX_GIT_NETWORK_STDERR_BYTES,
        None,
    ) {
        Ok(output) => output.output,
        Err(SupervisedError::TimedOut) => {
            crate::logging::record(
                "warn",
                "git",
                "git:network-timeout",
                serde_json::json!({ "operation": label, "timeoutSeconds": timeout.as_secs() }),
                root.to_str(),
            );
            return Err(format!(
                "Git {label} timed out after {}; the remote or a credential helper did not respond. Check the network and credentials, then retry.",
                describe_duration(timeout)
            ));
        }
        Err(error) => return Err(format!("failed to run git {label}: {error}")),
    };
    if output.status.success() {
        Ok(output)
    } else {
        Err(git_command_error(&format!("git {label}"), &output))
    }
}

fn describe_duration(duration: Duration) -> String {
    let seconds = duration.as_secs();
    if seconds >= 60 && seconds % 60 == 0 {
        format!("{} minutes", seconds / 60)
    } else {
        format!("{seconds} seconds")
    }
}

/// Lower-cased config keys that the user configured for transports. An
/// unreadable config yields `None`, which leaves every transport setting alone.
fn configured_network_keys(root: &Path) -> Option<Vec<String>> {
    let mut command = git_command(
        root,
        &[
            "config",
            "--get-regexp",
            r"^(core\.sshcommand|ssh\.variant|http\..*lowspeed(limit|time))$",
        ],
    );
    let output = bounded_output(
        &mut command,
        GIT_NETWORK_CONFIG_TIMEOUT,
        MAX_GIT_NETWORK_CONFIG_BYTES,
        MAX_GIT_NETWORK_CONFIG_BYTES,
        None,
    )
    .ok()?;
    if output.truncated {
        return None;
    }
    match output.output.status.code() {
        Some(0) => Some(
            String::from_utf8_lossy(&output.output.stdout)
                .lines()
                .filter_map(|line| line.split_whitespace().next())
                .map(str::to_ascii_lowercase)
                .collect(),
        ),
        // `--get-regexp` exits 1 when nothing matches.
        Some(1) => Some(Vec::new()),
        _ => None,
    }
}

/// Environment overrides for non-interactive network Git. A user-provided SSH
/// command/variant or HTTP low-speed setting (environment or config) wins.
fn network_overrides(
    configured: &Option<Vec<String>>,
    env_is_set: impl Fn(&str) -> bool,
) -> Vec<(&'static str, &'static str)> {
    let Some(configured) = configured else {
        return Vec::new();
    };
    let has = |suffix: &str| configured.iter().any(|key| key.ends_with(suffix));
    let mut overrides = Vec::new();
    if !env_is_set("GIT_SSH_COMMAND")
        && !env_is_set("GIT_SSH")
        && !env_is_set("GIT_SSH_VARIANT")
        && !configured
            .iter()
            .any(|key| key == "core.sshcommand" || key == "ssh.variant")
    {
        overrides.push(("GIT_SSH_COMMAND", BATCH_SSH_COMMAND));
    }
    if !env_is_set("GIT_HTTP_LOW_SPEED_LIMIT") && !env_is_set("GIT_HTTP_LOW_SPEED_TIME") {
        if !has("lowspeedlimit") {
            overrides.push(("GIT_HTTP_LOW_SPEED_LIMIT", HTTP_LOW_SPEED_LIMIT_BYTES));
        }
        if !has("lowspeedtime") {
            overrides.push(("GIT_HTTP_LOW_SPEED_TIME", HTTP_LOW_SPEED_TIME_SECONDS));
        }
    }
    overrides
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_output;
    use std::{
        fs,
        path::PathBuf,
        sync::{atomic::AtomicU64, Arc},
    };

    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "pix-git-process-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn shell(script: &str) -> Command {
        let mut command = Command::new("sh");
        command.arg("-c").arg(script);
        command
    }

    #[test]
    fn timeout_kills_descendants_that_hold_the_output_pipes() {
        let started = Instant::now();
        // The background sleep inherits stdout; without a group kill the
        // reader thread (and this call) would block for the full 30 seconds.
        let result = bounded_output(
            &mut shell("sleep 30 & sleep 30"),
            Duration::from_millis(200),
            1024,
            1024,
            None,
        );
        assert!(matches!(result, Err(SupervisedError::TimedOut)));
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn exited_leader_does_not_wait_for_backgrounded_descendants() {
        let started = Instant::now();
        let output = bounded_output(
            &mut shell("sleep 30 & echo done"),
            Duration::from_secs(20),
            1024,
            1024,
            None,
        )
        .unwrap();
        assert!(output.output.status.success());
        assert_eq!(output.output.stdout, b"done\n");
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn cancellation_stops_a_running_command_and_precancelled_never_spawns() {
        let token = Arc::new(AtomicBool::new(false));
        let canceller = {
            let token = Arc::clone(&token);
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(150));
                token.store(true, Ordering::Release);
            })
        };
        let started = Instant::now();
        let result = bounded_output(
            &mut shell("sleep 30"),
            Duration::from_secs(20),
            1024,
            1024,
            Some(&token),
        );
        canceller.join().unwrap();
        assert!(matches!(result, Err(SupervisedError::Cancelled)));
        assert!(started.elapsed() < Duration::from_secs(10));

        let marker = TempDir::new();
        let file = marker.0.join("spawned");
        let result = bounded_output(
            &mut shell(&format!("touch '{}'", file.display())),
            Duration::from_secs(5),
            1024,
            1024,
            Some(&token),
        );
        assert!(matches!(result, Err(SupervisedError::Cancelled)));
        assert!(!file.exists());
    }

    #[test]
    fn output_is_capped_and_reported_as_truncated() {
        let output = bounded_output(
            &mut shell("head -c 100000 /dev/zero; head -c 10 /dev/zero >&2"),
            Duration::from_secs(10),
            1000,
            1000,
            None,
        )
        .unwrap();
        assert_eq!(output.output.stdout.len(), 1000);
        assert_eq!(output.output.stderr.len(), 10);
        assert!(output.truncated);
    }

    #[test]
    fn network_overrides_respect_user_transport_configuration() {
        let unset = |_: &str| false;
        let all = network_overrides(&Some(Vec::new()), unset);
        assert_eq!(
            all,
            vec![
                ("GIT_SSH_COMMAND", BATCH_SSH_COMMAND),
                ("GIT_HTTP_LOW_SPEED_LIMIT", HTTP_LOW_SPEED_LIMIT_BYTES),
                ("GIT_HTTP_LOW_SPEED_TIME", HTTP_LOW_SPEED_TIME_SECONDS),
            ]
        );
        // Unknown config: change nothing.
        assert!(network_overrides(&None, unset).is_empty());
        let configured = Some(vec![
            "core.sshcommand".to_owned(),
            "http.https://example.com.lowspeedtime".to_owned(),
        ]);
        assert_eq!(
            network_overrides(&configured, unset),
            vec![("GIT_HTTP_LOW_SPEED_LIMIT", HTTP_LOW_SPEED_LIMIT_BYTES)]
        );
        let from_env = network_overrides(&Some(Vec::new()), |key| {
            key == "GIT_SSH" || key == "GIT_HTTP_LOW_SPEED_LIMIT"
        });
        assert!(from_env.is_empty());
    }

    #[test]
    fn configured_network_keys_reads_repository_transport_settings() {
        let repo = TempDir::new();
        git_output(&repo.0, &["init", "-b", "main"]).unwrap();
        // Values may come from global config, so only assert the local keys.
        git_output(&repo.0, &["config", "core.sshCommand", "ssh -i key"]).unwrap();
        git_output(&repo.0, &["config", "http.lowSpeedLimit", "5"]).unwrap();
        let keys = configured_network_keys(&repo.0).unwrap();
        assert!(keys.contains(&"core.sshcommand".to_owned()));
        assert!(keys.contains(&"http.lowspeedlimit".to_owned()));
    }

    #[test]
    fn hung_ssh_transport_times_out_with_a_clear_error() {
        let repo = TempDir::new();
        git_output(&repo.0, &["init", "-b", "main"]).unwrap();
        // A transport that never answers, standing in for a hung remote. The
        // repository sshCommand also proves the user's choice is respected.
        git_output(
            &repo.0,
            &["config", "core.sshCommand", "sh -c 'sleep 30' --"],
        )
        .unwrap();
        git_output(
            &repo.0,
            &[
                "remote",
                "add",
                "origin",
                "ssh://git@example.invalid/repo.git",
            ],
        )
        .unwrap();
        let started = Instant::now();
        let error = git_network_output_with(
            &repo.0,
            &["fetch", "origin"],
            "fetch",
            Duration::from_millis(500),
        )
        .unwrap_err();
        assert!(error.contains("Git fetch timed out"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn network_failures_keep_git_error_details() {
        let repo = TempDir::new();
        git_output(&repo.0, &["init", "-b", "main"]).unwrap();
        let missing = repo.0.join("missing-remote");
        let error = git_network_output(&repo.0, &["fetch", missing.to_str().unwrap()], "fetch")
            .unwrap_err();
        assert!(error.starts_with("git fetch failed:"), "{error}");
    }
}
