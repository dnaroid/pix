//! Session-independent transport. Retrieval, schema and ranking live in the suite.
use serde::Deserialize;
use std::{
    collections::HashMap,
    io::Write,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State};

/// Cancellation tokens by request id. Each records its owning window so
/// window close and app exit cancel native search/indexing children even when
/// the webview can no longer send `native_project_search_cancel`.
#[derive(Default)]
pub(crate) struct SearchState {
    requests: Mutex<HashMap<String, SearchToken>>,
    /// Set on app exit: requests registered afterwards start cancelled.
    exiting: AtomicBool,
}

struct SearchToken {
    created: Instant,
    cancelled: Arc<AtomicBool>,
    window_label: String,
}

impl SearchState {
    pub(crate) fn cancel_window(&self, window_label: &str) {
        let Ok(mut requests) = self.requests.lock() else {
            return;
        };
        requests.retain(|_, request| {
            if request.window_label == window_label {
                request.cancelled.store(true, Ordering::Release);
                false
            } else {
                true
            }
        });
    }

    pub(crate) fn cancel_all(&self) {
        self.exiting.store(true, Ordering::Release);
        let Ok(mut requests) = self.requests.lock() else {
            return;
        };
        for request in requests.values() {
            request.cancelled.store(true, Ordering::Release);
        }
        requests.clear();
    }

    fn token(&self, id: &str, window_label: &str) -> Result<Arc<AtomicBool>, String> {
        if id.is_empty()
            || id.len() > 80
            || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            return Err("Invalid search request identity".into());
        }
        let mut requests = self
            .requests
            .lock()
            .map_err(|_| "Search state unavailable")?;
        // Active requests can outlive the tombstone TTL while indexing.
        requests.retain(|_, request| {
            Arc::strong_count(&request.cancelled) > 1
                || request.created.elapsed() < Duration::from_secs(60)
        });
        if requests.len() >= 128 && !requests.contains_key(id) {
            return Err("Too many native search requests".into());
        }
        let exiting = self.exiting.load(Ordering::Acquire);
        // Retain a pre-start cancellation: Tauri commands may be scheduled out of order.
        Ok(requests
            .entry(id.to_owned())
            .or_insert_with(|| SearchToken {
                created: Instant::now(),
                cancelled: Arc::new(AtomicBool::new(exiting)),
                window_label: window_label.to_owned(),
            })
            .cancelled
            .clone())
    }
    fn finish(&self, id: &str) {
        if let Ok(mut requests) = self.requests.lock() {
            requests.remove(id);
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SearchRequest {
    workspace: String,
    request_id: String,
    query: serde_json::Value,
}

#[tauri::command]
pub(crate) fn native_project_search_cancel(
    window: tauri::WebviewWindow,
    request_id: String,
    state: State<'_, SearchState>,
) -> Result<(), String> {
    state
        .token(&request_id, window.label())?
        .store(true, Ordering::Release);
    Ok(())
}

#[tauri::command]
pub(crate) async fn native_project_search(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, SearchState>,
    request: SearchRequest,
) -> Result<serde_json::Value, String> {
    let window_label = window.label().to_owned();
    let cancelled = state.token(&request.request_id, &window_label)?;
    let index_source = native_index_source(&request.query);
    let workspace = index_source.map(|_| request.workspace.clone());
    let cancel_flag = cancelled.clone();
    let started = Instant::now();
    let id = request.request_id.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || run(&app, &window_label, request, cancelled))
            .await
            .map_err(|_| "Native search worker failed".to_owned())
            .and_then(|result| result);
    state.finish(&id);
    if let Some(source) = index_source {
        let aborted = cancel_flag.load(Ordering::Acquire);
        let complete = result
            .as_ref()
            .ok()
            .and_then(|value| value.get("complete"))
            .and_then(|value| value.as_bool());
        let indexed = result
            .as_ref()
            .ok()
            .and_then(|value| value.get("indexed"))
            .and_then(|value| value.as_u64());
        let level =
            if aborted || (result.is_ok() && complete == Some(true) && indexed.unwrap_or(0) == 0) {
                "debug"
            } else if result.is_err() || complete == Some(false) {
                "warn"
            } else {
                "info"
            };
        crate::logging::record(
            level,
            "search.index",
            if aborted {
                "search:index-cancelled"
            } else if result.is_err() {
                "search:index-native-failed"
            } else if complete == Some(false) {
                "search:index-native-incomplete"
            } else {
                "search:index-native-completed"
            },
            serde_json::json!({ "source": source, "complete": complete, "indexed": indexed,
                "durationMs": started.elapsed().as_millis() }),
            workspace.as_deref(),
        );
    }
    result
}

fn native_index_source(query: &serde_json::Value) -> Option<&'static str> {
    if query.get("operation")?.as_str()? != "index" {
        return None;
    }
    match query.get("source")?.as_str()? {
        "code" => Some("code"),
        "knowledge" => Some("knowledge"),
        _ => None,
    }
}

fn run(
    app: &AppHandle,
    window_label: &str,
    request: SearchRequest,
    cancelled: Arc<AtomicBool>,
) -> Result<serde_json::Value, String> {
    if cancelled.load(Ordering::Acquire) {
        return Err("Native search cancelled".into());
    }
    let root =
        std::fs::canonicalize(&request.workspace).map_err(|_| "Search workspace is unavailable")?;
    if !root.is_dir() {
        return Err("Search workspace is not a directory".into());
    }
    let input = serde_json::to_vec(&request.query).map_err(|_| "Invalid search request")?;
    if input.len() > request_input_limit(&request.query) {
        return Err("Search request too large".into());
    }
    let resources = app
        .path()
        .resource_dir()
        .map_err(|_| "Pix resources unavailable")?;
    let runtime = crate::backend_runtime::BackendRuntime::resolve(&resources)?;
    let mut command = runtime.native_search_command()?;
    command
        .arg(&root)
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    // Destroyed cancels registered tokens; a request that registered after it
    // (commands can be scheduled late) must not start a child for a closed window.
    if cancelled.load(Ordering::Acquire) || app.get_webview_window(window_label).is_none() {
        return Err("Native search cancelled".into());
    }
    let mut child =
        crate::native_process::spawn(&mut command).map_err(|_| "Native search could not start")?;
    let pid = child.id();
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let out = thread::spawn(move || crate::read_bounded_process_stream(stdout, 2 * 1024 * 1024));
    let err = thread::spawn(move || crate::read_bounded_process_stream(stderr, 8192));
    // Up to 4 MB of rerank input: write it off-thread so cancellation and the
    // deadline apply while the child is still reading. Killing the child below
    // unblocks a stalled write with EPIPE.
    let writer = spawn_input_writer(child.stdin.take().expect("piped stdin"), input);
    let deadline = request_deadline(&request.query);
    let mut failed = false;
    loop {
        if cancelled.load(Ordering::Acquire) || deadline.is_some_and(|time| Instant::now() >= time)
        {
            failed = true;
        }
        if failed {
            break;
        }
        #[cfg(unix)]
        match crate::native_process::exited_before_reap(&child) {
            Ok(true) => break,
            Ok(false) => {}
            Err(_) => {
                failed = true;
                break;
            }
        }
        #[cfg(not(unix))]
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(_) => {
                failed = true;
                break;
            }
        }
        thread::sleep(Duration::from_millis(15));
    }
    // Kill the process group before reaping, including any outstanding git enumerator.
    crate::force_kill_process_group(pid, &mut child);
    let status = child.wait();
    let wrote = writer.join().unwrap_or(false);
    let output = out.join();
    let _ = err.join();
    if failed || !wrote || !status.map(|s| s.success()).unwrap_or(false) {
        return Err("Native search cancelled, unavailable or timed out".into());
    }
    let (bytes, truncated) = output.map_err(|_| "Native search output unavailable")?;
    if truncated {
        return Err("Native search output exceeded its bound".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "Invalid native search response".into())
}

/// Writes the request and closes stdin (by dropping it) on its own thread.
fn spawn_input_writer<W: Write + Send + 'static>(
    mut stdin: W,
    input: Vec<u8>,
) -> thread::JoinHandle<bool> {
    thread::spawn(move || stdin.write_all(&input).and_then(|()| stdin.flush()).is_ok())
}

fn request_deadline(query: &serde_json::Value) -> Option<Instant> {
    (query.get("operation").and_then(|value| value.as_str()) != Some("index"))
        .then(|| Instant::now() + Duration::from_secs(45))
}

fn request_input_limit(query: &serde_json::Value) -> usize {
    if query.get("operation").and_then(|value| value.as_str()) == Some("rerank") {
        // Bounded documents can require three UTF-8 bytes per JS character.
        4 * 1024 * 1024
    } else {
        16 * 1024
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    impl SearchState {
        fn token_for_test(&self, id: &str) -> Result<Arc<AtomicBool>, String> {
            self.token(id, "window")
        }
    }
    #[test]
    fn window_close_cancels_only_that_windows_requests() {
        let state = SearchState::default();
        let one = state.token("index-1", "window-a").unwrap();
        let two = state.token("index-2", "window-b").unwrap();
        state.cancel_window("window-a");
        assert!(one.load(Ordering::Acquire));
        assert!(!two.load(Ordering::Acquire));
        assert!(!state.requests.lock().unwrap().contains_key("index-1"));
        assert!(state.requests.lock().unwrap().contains_key("index-2"));
    }
    #[test]
    fn app_exit_cancels_running_and_late_requests() {
        let state = SearchState::default();
        let running = state.token("index-1", "window-a").unwrap();
        state.cancel_all();
        assert!(running.load(Ordering::Acquire));
        assert!(state.requests.lock().unwrap().is_empty());
        // A command scheduled after exit began must not start a child.
        assert!(state
            .token("late", "window-b")
            .unwrap()
            .load(Ordering::Acquire));
    }
    #[test]
    fn input_write_runs_off_the_cancellation_loop_thread() {
        struct Blocked(std::sync::mpsc::Receiver<()>);
        impl Write for Blocked {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                let _ = self.0.recv();
                Err(std::io::ErrorKind::BrokenPipe.into())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let (release, blocked) = std::sync::mpsc::channel();
        // Returns while the write is still blocked, so the caller reaches its
        // cancel/deadline loop immediately; a failed write is reported on join.
        let writer = spawn_input_writer(Blocked(blocked), vec![0; 4 * 1024 * 1024]);
        assert!(!writer.is_finished());
        drop(release);
        assert!(!writer.join().unwrap());
        assert!(spawn_input_writer(Vec::new(), b"{}".to_vec())
            .join()
            .unwrap());
    }
    #[test]
    fn only_explicit_code_and_knowledge_index_calls_are_logged() {
        assert_eq!(
            native_index_source(&serde_json::json!({"operation":"index","source":"code"})),
            Some("code")
        );
        assert_eq!(
            native_index_source(&serde_json::json!({"operation":"index","source":"knowledge"})),
            Some("knowledge")
        );
        assert_eq!(
            native_index_source(&serde_json::json!({"operation":"index","source":"sessions"})),
            None
        );
        assert_eq!(
            native_index_source(&serde_json::json!({"operation":"search","source":"code"})),
            None
        );
    }
    #[test]
    fn cancellation_before_start_and_finish_are_owned() {
        let state = SearchState::default();
        state
            .token_for_test("a-1")
            .unwrap()
            .store(true, Ordering::Release);
        assert!(state.token_for_test("a-1").unwrap().load(Ordering::Acquire));
        state.finish("a-1");
        assert!(!state.token_for_test("a-1").unwrap().load(Ordering::Acquire));
        assert!(state.token_for_test("../unsafe").is_err());
    }
    #[test]
    fn cancellation_tombstones_are_bounded() {
        let state = SearchState::default();
        for n in 0..128 {
            state.token_for_test(&n.to_string()).unwrap();
        }
        assert!(state.token_for_test("overflow").is_err());
        state.finish("0");
        assert!(state.token_for_test("new").is_ok());
    }
    #[test]
    fn long_indexing_keeps_its_cancellation_token() {
        let state = SearchState::default();
        let active = state.token_for_test("long-index").unwrap();
        state.token_for_test("expired-tombstone").unwrap();
        for request in state.requests.lock().unwrap().values_mut() {
            request.created = Instant::now() - Duration::from_secs(120);
        }
        state.token_for_test("other").unwrap();
        assert!(!state
            .requests
            .lock()
            .unwrap()
            .contains_key("expired-tombstone"));
        state
            .token_for_test("long-index")
            .unwrap()
            .store(true, Ordering::Release);
        assert!(active.load(Ordering::Acquire));
    }
    #[test]
    fn only_indexing_is_exempt_from_the_overall_deadline() {
        assert!(request_deadline(&serde_json::json!({"operation":"index"})).is_none());
        let deadline = request_deadline(&serde_json::json!({"query":"needle"})).unwrap();
        assert!(deadline > Instant::now() + Duration::from_secs(40));
        assert!(deadline <= Instant::now() + Duration::from_secs(45));
    }
    #[test]
    fn only_federated_rerank_allows_bounded_utf8_documents() {
        assert_eq!(
            request_input_limit(&serde_json::json!({"operation":"rerank"})),
            4 * 1024 * 1024
        );
        for query in [
            serde_json::json!({"operation":"rerank-prepare"}),
            serde_json::json!({"operation":"index"}),
            serde_json::json!({"query":"needle"}),
        ] {
            assert_eq!(request_input_limit(&query), 16 * 1024);
        }
    }
}
