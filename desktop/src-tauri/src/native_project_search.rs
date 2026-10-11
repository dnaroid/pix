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

#[derive(Default)]
pub(crate) struct SearchState(Mutex<HashMap<String, (Instant, Arc<AtomicBool>)>>);
impl SearchState {
    fn token(&self, id: &str) -> Result<Arc<AtomicBool>, String> {
        if id.is_empty()
            || id.len() > 80
            || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            return Err("Invalid search request identity".into());
        }
        let mut requests = self.0.lock().map_err(|_| "Search state unavailable")?;
        requests.retain(|_, (time, _)| time.elapsed() < Duration::from_secs(60));
        if requests.len() >= 128 && !requests.contains_key(id) {
            return Err("Too many native search requests".into());
        }
        // Retain a pre-start cancellation: Tauri commands may be scheduled out of order.
        Ok(requests
            .entry(id.to_owned())
            .or_insert_with(|| (Instant::now(), Arc::new(AtomicBool::new(false))))
            .1
            .clone())
    }
    fn finish(&self, id: &str) {
        if let Ok(mut requests) = self.0.lock() {
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
    request_id: String,
    state: State<'_, SearchState>,
) -> Result<(), String> {
    state.token(&request_id)?.store(true, Ordering::Release);
    Ok(())
}

#[tauri::command]
pub(crate) async fn native_project_search(
    app: AppHandle,
    state: State<'_, SearchState>,
    request: SearchRequest,
) -> Result<serde_json::Value, String> {
    let cancelled = state.token(&request.request_id)?;
    let id = request.request_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || run(&app, request, cancelled))
        .await
        .map_err(|_| "Native search worker failed".to_owned())
        .and_then(|result| result);
    state.finish(&id);
    result
}

fn run(
    app: &AppHandle,
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
    if input.len() > 16 * 1024 {
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
    let mut child =
        crate::native_process::spawn(&mut command).map_err(|_| "Native search could not start")?;
    let pid = child.id();
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let out = thread::spawn(move || crate::read_bounded_process_stream(stdout, 2 * 1024 * 1024));
    let err = thread::spawn(move || crate::read_bounded_process_stream(stderr, 8192));
    let wrote = child
        .stdin
        .take()
        .expect("piped stdin")
        .write_all(&input)
        .is_ok();
    let deadline = Instant::now() + Duration::from_secs(45);
    let mut failed = !wrote;
    loop {
        if cancelled.load(Ordering::Acquire) || Instant::now() >= deadline {
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
    let output = out.join();
    let _ = err.join();
    if failed || !status.map(|s| s.success()).unwrap_or(false) {
        return Err("Native search cancelled, unavailable or timed out".into());
    }
    let (bytes, truncated) = output.map_err(|_| "Native search output unavailable")?;
    if truncated {
        return Err("Native search output exceeded its bound".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "Invalid native search response".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_before_start_and_finish_are_owned() {
        let state = SearchState::default();
        state.token("a-1").unwrap().store(true, Ordering::Release);
        assert!(state.token("a-1").unwrap().load(Ordering::Acquire));
        state.finish("a-1");
        assert!(!state.token("a-1").unwrap().load(Ordering::Acquire));
        assert!(state.token("../unsafe").is_err());
    }
    #[test]
    fn cancellation_tombstones_are_bounded() {
        let state = SearchState::default();
        for n in 0..128 {
            state.token(&n.to_string()).unwrap();
        }
        assert!(state.token("overflow").is_err());
        state.finish("0");
        assert!(state.token("new").is_ok());
    }
}
