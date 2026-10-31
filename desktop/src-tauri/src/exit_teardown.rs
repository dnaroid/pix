//! App-exit teardown of per-window native processes.
//!
//! Every ACP slot and package terminal is stopped concurrently under one
//! overall deadline, so quitting with N windows costs one stop timeout rather
//! than N sequential ones. Stragglers past the deadline keep running on their
//! detached threads; the process exit that follows ends them.

use super::{logging, stop_package_terminal, stop_process, AcpProcessState, PackageTerminalState};
use std::{
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

/// One bound for the whole teardown: ACP's own stop wait (5 s) plus margin.
/// Package terminals are force-stopped on exit (kill + at most 4 s).
const EXIT_TEARDOWN_DEADLINE: Duration = Duration::from_secs(6);

type TeardownTask = Box<dyn FnOnce() + Send + 'static>;

/// Stop every ACP process and package terminal in parallel. Blocks the caller
/// (the exit worker thread, never the event loop) for at most the deadline.
pub(crate) fn stop_all_native_processes(app: &AppHandle) {
    let mut tasks: Vec<TeardownTask> = Vec::new();

    let window_labels = app
        .state::<AcpProcessState>()
        .slots
        .lock()
        .map(|slots| slots.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    for window_label in window_labels {
        let app = app.clone();
        tasks.push(Box::new(move || {
            let state = app.state::<AcpProcessState>();
            if let Err(error) = stop_process(&state, &window_label, None) {
                logging::error(
                    module_path!(),
                    format!(
                        "failed to stop pix-acp for window {window_label} during exit: {error}"
                    ),
                );
            }
        }));
    }

    let terminals = app
        .state::<PackageTerminalState>()
        .sessions
        .lock()
        .map(|sessions| {
            sessions
                .iter()
                .map(|(id, session)| {
                    (
                        id.clone(),
                        session.window_label.clone(),
                        session.running.is_some(),
                    )
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for (id, window_label, running) in &terminals {
        if !running {
            continue;
        }
        let app = app.clone();
        let (id, window_label) = (id.clone(), window_label.clone());
        tasks.push(Box::new(move || {
            if let Err(error) = stop_package_terminal(&app, &window_label, &id, true) {
                logging::error(
                    module_path!(),
                    format!("failed to stop package terminal {id} during exit: {error}"),
                );
            }
        }));
    }

    let unfinished = run_with_deadline(tasks, EXIT_TEARDOWN_DEADLINE);
    if unfinished > 0 {
        logging::record(
            "warn",
            module_path!(),
            "desktop:exit-teardown-timeout",
            serde_json::json!({ "unfinished": unfinished }),
            None,
        );
    }
    if let Ok(mut sessions) = app.state::<PackageTerminalState>().sessions.lock() {
        for (id, _, _) in &terminals {
            sessions.remove(id);
        }
    }
}

/// Signals completion even if the task panics.
struct DoneOnDrop(mpsc::Sender<()>);

impl Drop for DoneOnDrop {
    fn drop(&mut self) {
        let _ = self.0.send(());
    }
}

/// Run all tasks concurrently and wait for them until `timeout` elapses.
/// Returns how many tasks were still running at the deadline.
fn run_with_deadline(tasks: Vec<TeardownTask>, timeout: Duration) -> usize {
    let deadline = Instant::now() + timeout;
    let (done_tx, done_rx) = mpsc::channel();
    let mut pending = 0;
    for task in tasks {
        let done = DoneOnDrop(done_tx.clone());
        let spawned = thread::Builder::new()
            .name("pix-exit-teardown".to_owned())
            .spawn(move || {
                let _done = done;
                task();
            });
        if spawned.is_ok() {
            pending += 1;
        }
    }
    drop(done_tx);
    while pending > 0 {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if done_rx.recv_timeout(remaining).is_err() {
            break;
        }
        pending -= 1;
    }
    pending
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    #[test]
    fn teardown_tasks_run_concurrently() {
        // Each task waits for all others: sequential execution would never
        // complete, so finishing proves the stops overlap.
        let barrier = Arc::new(Barrier::new(4));
        let tasks = (0..4)
            .map(|_| {
                let barrier = barrier.clone();
                Box::new(move || {
                    barrier.wait();
                }) as TeardownTask
            })
            .collect();
        assert_eq!(run_with_deadline(tasks, Duration::from_secs(30)), 0);
    }

    #[test]
    fn teardown_is_bounded_by_one_overall_deadline() {
        let (_release, blocked) = mpsc::channel::<()>();
        let blocked = Arc::new(std::sync::Mutex::new(blocked));
        let tasks = (0..3)
            .map(|_| {
                let blocked = blocked.clone();
                Box::new(move || {
                    let _ = blocked.lock().map(|rx| rx.recv());
                }) as TeardownTask
            })
            .chain(std::iter::once(Box::new(|| {}) as TeardownTask))
            .collect();
        let started = Instant::now();
        assert_eq!(run_with_deadline(tasks, Duration::from_millis(50)), 3);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_panicking_task_still_counts_as_finished() {
        let tasks = vec![Box::new(|| panic!("stop failed")) as TeardownTask];
        assert_eq!(run_with_deadline(tasks, Duration::from_secs(30)), 0);
    }
}
