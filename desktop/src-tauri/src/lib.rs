use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashSet,
    env, fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Component, Path, PathBuf},
    process::{Child, ChildStdin, Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::StateFlags;

const POLL_INTERVAL: Duration = Duration::from_millis(40);
const GRACEFUL_STOP_TIMEOUT: Duration = Duration::from_secs(2);
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_ATTACHMENT_COUNT: usize = 10;
const MAX_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024;
const MAX_ATTACHMENT_CACHE_BYTES: u64 = 250 * 1024 * 1024;
const MAX_PROJECT_FILE_PREVIEW_BYTES: u64 = 2 * 1024 * 1024;
const ATTACHMENT_CACHE_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
static ATTACHMENT_SEQUENCE: AtomicU64 = AtomicU64::new(0);
type ExitSignal = Arc<(Mutex<bool>, Condvar)>;

#[derive(Default)]
struct AcpProcessState {
    slot: Mutex<ProcessSlot>,
}

#[derive(Default)]
struct ProcessSlot {
    next_generation: u64,
    running: Option<RunningProcess>,
}

struct RunningProcess {
    generation: u64,
    stdin: Option<ChildStdin>,
    stop_tx: mpsc::Sender<()>,
    exited: ExitSignal,
}

impl Drop for RunningProcess {
    fn drop(&mut self) {
        let _ = self.stop_tx.send(());
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitPayload {
    generation: u64,
    code: Option<i32>,
    success: bool,
    requested: bool,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LinePayload {
    generation: u64,
    line: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentFile {
    path: String,
    name: String,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectFilePreview {
    path: String,
    content: String,
}

struct AttachmentPathState {
    approved: Mutex<HashSet<PathBuf>>,
    cache_lock: Mutex<()>,
    registry_path: PathBuf,
}

impl AttachmentPathState {
    fn load(app: &AppHandle) -> Self {
        let cache_dir = app
            .path()
            .app_cache_dir()
            .unwrap_or_else(|_| env::temp_dir());
        let registry_path = cache_dir.join("approved-attachments.json");
        let mut approved = HashSet::new();
        if let Ok(raw) = fs::read_to_string(&registry_path) {
            if let Ok(paths) = serde_json::from_str::<Vec<String>>(&raw) {
                for path in paths {
                    if let Ok(canonical) = fs::canonicalize(path) {
                        let _ = app.asset_protocol_scope().allow_file(&canonical);
                        approved.insert(canonical);
                    }
                }
            }
        }
        Self {
            approved: Mutex::new(approved),
            cache_lock: Mutex::new(()),
            registry_path,
        }
    }

    fn approve_selected(&self, app: &AppHandle, path: &Path) -> Result<PathBuf, String> {
        let canonical = fs::canonicalize(path)
            .map_err(|error| format!("failed to resolve {}: {error}", path.display()))?;
        let already_approved = self
            .approved
            .lock()
            .map_err(|_| "attachment path state is poisoned".to_owned())?
            .contains(&canonical);
        if !already_approved && !app.asset_protocol_scope().is_allowed(&canonical) {
            return Err(format!("{} was not selected by the user", path.display()));
        }
        self.approve(app, canonical.clone())?;
        Ok(canonical)
    }

    fn approve_cached(&self, app: &AppHandle, path: &Path) -> Result<PathBuf, String> {
        let canonical = fs::canonicalize(path)
            .map_err(|error| format!("failed to resolve {}: {error}", path.display()))?;
        self.approve(app, canonical.clone())?;
        Ok(canonical)
    }

    fn approved_path(&self, path: &Path) -> Result<PathBuf, String> {
        let canonical = fs::canonicalize(path)
            .map_err(|error| format!("failed to resolve {}: {error}", path.display()))?;
        let approved = self
            .approved
            .lock()
            .map_err(|_| "attachment path state is poisoned".to_owned())?;
        if approved.contains(&canonical) {
            Ok(canonical)
        } else {
            Err(format!("{} is not an approved attachment", path.display()))
        }
    }

    fn approve(&self, app: &AppHandle, path: PathBuf) -> Result<(), String> {
        app.asset_protocol_scope()
            .allow_file(&path)
            .map_err(|error| format!("failed to allow attachment preview: {error}"))?;
        let mut approved = self
            .approved
            .lock()
            .map_err(|_| "attachment path state is poisoned".to_owned())?;
        if approved.contains(&path) {
            return Ok(());
        }
        let snapshot = approved
            .iter()
            .map(|value| value.to_string_lossy().into_owned())
            .chain(std::iter::once(path.to_string_lossy().into_owned()))
            .collect::<Vec<_>>();
        if let Some(parent) = self.registry_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!("failed to create the attachment registry directory: {error}")
            })?;
        }
        let serialized = serde_json::to_vec(&snapshot)
            .map_err(|error| format!("failed to encode the attachment registry: {error}"))?;
        fs::write(&self.registry_path, serialized)
            .map_err(|error| format!("failed to save the attachment registry: {error}"))?;
        approved.insert(path);
        Ok(())
    }
}

#[tauri::command]
fn inspect_attachments(
    app: AppHandle,
    state: State<'_, AttachmentPathState>,
    paths: Vec<String>,
) -> Result<Vec<AttachmentFile>, String> {
    if paths.len() > MAX_ATTACHMENT_COUNT {
        return Err(format!("select at most {MAX_ATTACHMENT_COUNT} attachments"));
    }

    paths
        .into_iter()
        .map(|path| {
            let canonical = state.approve_selected(&app, Path::new(&path))?;
            attachment_file(&canonical)
        })
        .collect()
}

#[tauri::command]
fn read_attachment_base64(
    state: State<'_, AttachmentPathState>,
    path: String,
) -> Result<String, String> {
    let approved = state.approved_path(Path::new(&path))?;
    let file = attachment_file(&approved)?;
    if file.size > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "{} is too large to send as an image (maximum 25 MB)",
            file.name,
        ));
    }
    let bytes =
        fs::read(&file.path).map_err(|error| format!("failed to read {}: {error}", file.name))?;
    if bytes.len() as u64 > MAX_ATTACHMENT_BYTES {
        return Err(format!("{} grew beyond the 25 MB image limit", file.name));
    }
    Ok(BASE64.encode(bytes))
}

#[tauri::command]
fn cache_attachment(
    app: AppHandle,
    state: State<'_, AttachmentPathState>,
    name: String,
    data: String,
) -> Result<AttachmentFile, String> {
    if data.len() as u64 > (MAX_ATTACHMENT_BYTES * 4 / 3) + 8 {
        return Err("pasted attachment is too large (maximum 25 MB)".to_owned());
    }
    let bytes = BASE64
        .decode(data)
        .map_err(|error| format!("invalid pasted attachment data: {error}"))?;
    if bytes.len() as u64 > MAX_ATTACHMENT_BYTES {
        return Err("pasted attachment is too large (maximum 25 MB)".to_owned());
    }
    let _cache_guard = state
        .cache_lock
        .lock()
        .map_err(|_| "attachment cache state is poisoned".to_owned())?;

    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("failed to resolve the Pix cache directory: {error}"))?
        .join("attachments");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("failed to create the attachment cache: {error}"))?;
    prune_attachment_cache(&directory, bytes.len() as u64)?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = ATTACHMENT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let path = directory.join(format!("{stamp}-{sequence}-{}", safe_file_name(&name)));
    fs::write(&path, bytes).map_err(|error| format!("failed to cache {name}: {error}"))?;
    let canonical = state.approve_cached(&app, &path)?;
    attachment_file(&canonical)
}

#[tauri::command]
fn open_attachment(
    app: AppHandle,
    state: State<'_, AttachmentPathState>,
    path: String,
) -> Result<(), String> {
    let approved = state.approved_path(Path::new(&path))?;
    app.opener()
        .open_path(approved.to_string_lossy(), None::<&str>)
        .map_err(|error| format!("failed to open attachment: {error}"))
}

#[tauri::command]
fn read_project_file(workspace: String, path: String) -> Result<ProjectFilePreview, String> {
    read_project_file_from(
        Path::new(&workspace),
        Path::new(&path),
        MAX_PROJECT_FILE_PREVIEW_BYTES,
    )
}

fn read_project_file_from(
    workspace: &Path,
    relative_path: &Path,
    max_bytes: u64,
) -> Result<ProjectFilePreview, String> {
    if relative_path.as_os_str().is_empty()
        || relative_path.is_absolute()
        || relative_path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("project file path must stay relative to the workspace".to_owned());
    }

    let root = fs::canonicalize(workspace).map_err(|error| {
        format!(
            "failed to resolve workspace {}: {error}",
            workspace.display()
        )
    })?;
    if !root.is_dir() {
        return Err(format!("{} is not a workspace directory", root.display()));
    }

    let file_path = fs::canonicalize(root.join(relative_path)).map_err(|error| {
        format!(
            "failed to resolve project file {}: {error}",
            relative_path.display()
        )
    })?;
    if !file_path.starts_with(&root) {
        return Err("project file path resolves outside the workspace".to_owned());
    }

    let metadata = fs::metadata(&file_path)
        .map_err(|error| format!("failed to inspect {}: {error}", file_path.display()))?;
    if !metadata.is_file() {
        return Err(format!("{} is not a file", relative_path.display()));
    }
    if metadata.len() > max_bytes {
        return Err(format!(
            "{} is too large to preview (maximum {} MB)",
            relative_path.display(),
            max_bytes / 1024 / 1024,
        ));
    }

    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    fs::File::open(&file_path)
        .map_err(|error| format!("failed to open {}: {error}", file_path.display()))?
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read {}: {error}", file_path.display()))?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!(
            "{} grew beyond the preview limit",
            relative_path.display()
        ));
    }
    let content = String::from_utf8(bytes)
        .map_err(|_| format!("{} is not a UTF-8 text file", relative_path.display()))?;
    let display_path = file_path
        .strip_prefix(&root)
        .unwrap_or(relative_path)
        .to_string_lossy()
        .replace('\\', "/");

    Ok(ProjectFilePreview {
        path: display_path,
        content,
    })
}

fn attachment_file(path: &Path) -> Result<AttachmentFile, String> {
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("failed to resolve {}: {error}", path.display()))?;
    let metadata = fs::metadata(&canonical)
        .map_err(|error| format!("failed to inspect {}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("{} is not a file", path.display()));
    }
    let name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{} has no valid file name", path.display()))?;
    Ok(AttachmentFile {
        path: canonical.to_string_lossy().into_owned(),
        name: name.to_owned(),
        size: metadata.len(),
    })
}

fn prune_attachment_cache(directory: &Path, incoming_bytes: u64) -> Result<(), String> {
    let now = SystemTime::now();
    let mut total = 0_u64;
    for entry in fs::read_dir(directory)
        .map_err(|error| format!("failed to inspect the attachment cache: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("failed to inspect a cached attachment: {error}"))?;
        let metadata = entry
            .metadata()
            .map_err(|error| format!("failed to inspect {}: {error}", entry.path().display()))?;
        if !metadata.is_file() {
            continue;
        }
        let expired = metadata
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > ATTACHMENT_CACHE_MAX_AGE);
        if expired {
            let _ = fs::remove_file(entry.path());
        } else {
            total = total.saturating_add(metadata.len());
        }
    }
    if total.saturating_add(incoming_bytes) > MAX_ATTACHMENT_CACHE_BYTES {
        Err(
            "the 250 MB attachment cache is full; remove old cached attachments and try again"
                .to_owned(),
        )
    } else {
        Ok(())
    }
}

fn safe_file_name(name: &str) -> String {
    let sanitized: String = name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect();
    let sanitized = sanitized.trim_matches('.');
    if sanitized.is_empty() {
        "attachment".to_owned()
    } else {
        sanitized.to_owned()
    }
}

#[tauri::command]
fn acp_start(app: AppHandle, state: State<'_, AcpProcessState>) -> Result<u64, String> {
    let mut slot = state
        .slot
        .lock()
        .map_err(|_| "ACP process state is poisoned".to_owned())?;
    if let Some(running) = &slot.running {
        return Ok(running.generation);
    }

    let node = env::var_os("PIX_ACP_NODE_BINARY").unwrap_or_else(|| "node".into());
    let entry = env::var_os("PIX_ACP_ENTRY")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../acp/dist/main.js")
        });
    if !entry.is_file() {
        return Err(format!(
            "pix-acp entry not found at {} (run `npm run build:acp` first or set PIX_ACP_ENTRY)",
            entry.display()
        ));
    }

    let mut child = Command::new(&node)
        .arg(&entry)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to start {:?}: {error}", node))?;

    let pipes = (child.stdin.take(), child.stdout.take(), child.stderr.take());
    let (Some(stdin), Some(stdout), Some(stderr)) = pipes else {
        let _ = child.kill();
        let _ = child.wait();
        return Err("pix-acp did not expose all stdio pipes".to_owned());
    };

    slot.next_generation = slot.next_generation.wrapping_add(1);
    let generation = slot.next_generation;
    let (stop_tx, stop_rx) = mpsc::channel();
    let exited = Arc::new((Mutex::new(false), Condvar::new()));
    slot.running = Some(RunningProcess {
        generation,
        stdin: Some(stdin),
        stop_tx,
        exited: exited.clone(),
    });
    drop(slot);

    forward_lines(stdout, app.clone(), "acp://stdout", generation);
    forward_lines(stderr, app.clone(), "acp://stderr", generation);
    thread::spawn(move || supervise_child(child, stop_rx, app, generation, exited));
    Ok(generation)
}

#[tauri::command]
fn acp_send(
    generation: u64,
    line: String,
    state: State<'_, AcpProcessState>,
) -> Result<(), String> {
    if line.contains('\r') || line.contains('\n') {
        return Err("ACP payload must be one newline-free JSON object".to_owned());
    }
    let value: Value = serde_json::from_str(&line)
        .map_err(|error| format!("ACP payload is not valid JSON: {error}"))?;
    if !value.is_object() {
        return Err("ACP payload must be a JSON object".to_owned());
    }

    let mut slot = state
        .slot
        .lock()
        .map_err(|_| "ACP process state is poisoned".to_owned())?;
    let running = slot
        .running
        .as_mut()
        .ok_or_else(|| "pix-acp is not running".to_owned())?;
    if running.generation != generation {
        return Err(format!(
            "stale pix-acp generation {generation}; current generation is {}",
            running.generation
        ));
    }
    let stdin = running
        .stdin
        .as_mut()
        .ok_or_else(|| "pix-acp stdin is closed".to_owned())?;
    stdin
        .write_all(format!("{line}\n").as_bytes())
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("failed to write to pix-acp: {error}"))
}

#[tauri::command]
fn acp_stop(generation: u64, state: State<'_, AcpProcessState>) -> Result<(), String> {
    stop_process(&state, Some(generation))
}

fn stop_process(state: &AcpProcessState, expected_generation: Option<u64>) -> Result<(), String> {
    let process = {
        let mut slot = state
            .slot
            .lock()
            .map_err(|_| "ACP process state is poisoned".to_owned())?;
        slot.running.as_mut().and_then(|running| {
            if expected_generation.is_some_and(|expected| expected != running.generation) {
                return None;
            }
            // Closing stdin lets pix-acp finish its ACP connection and
            // dispose every nested pi RPC process before we use signals.
            running.stdin.take();
            Some((running.stop_tx.clone(), running.exited.clone()))
        })
    };
    let Some((stop_tx, exited)) = process else {
        return Ok(());
    };

    let _ = stop_tx.send(());
    let (lock, wake) = &*exited;
    let exited = lock
        .lock()
        .map_err(|_| "ACP exit signal is poisoned".to_owned())?;
    let (_guard, timeout) = wake
        .wait_timeout_while(exited, STOP_TIMEOUT, |exited| !*exited)
        .map_err(|_| "ACP exit signal is poisoned".to_owned())?;
    if timeout.timed_out() {
        return Err("timed out waiting for pix-acp to stop".to_owned());
    }
    Ok(())
}

fn forward_lines<R>(reader: R, app: AppHandle, event: &'static str, generation: u64)
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            match line {
                Ok(line) => {
                    let _ = app.emit(event, LinePayload { generation, line });
                }
                Err(error) => {
                    let _ = app.emit(
                        "acp://stderr",
                        LinePayload {
                            generation,
                            line: format!("failed to read {event}: {error}"),
                        },
                    );
                    break;
                }
            }
        }
    });
}

fn supervise_child(
    mut child: Child,
    stop_rx: mpsc::Receiver<()>,
    app: AppHandle,
    generation: u64,
    exited: ExitSignal,
) {
    let mut requested = false;
    let mut force_stop_at = None;
    let mut stop_error = None;
    let (status, error) = loop {
        if !requested && stop_rx.try_recv().is_ok() {
            requested = true;
            force_stop_at = Some(Instant::now() + GRACEFUL_STOP_TIMEOUT);
        }
        if force_stop_at.is_some_and(|deadline| Instant::now() >= deadline) {
            force_stop_at = None;
            if let Err(error) = child.kill() {
                // The process may have exited between the stop request and
                // kill. Keep polling so it is always reaped with try_wait.
                stop_error = Some(format!("failed to stop pix-acp: {error}"));
            }
        }

        match child.try_wait() {
            Ok(Some(status)) => break (Some(status), stop_error),
            Ok(None) => thread::sleep(POLL_INTERVAL),
            Err(error) => break (None, Some(format!("failed to wait for pix-acp: {error}"))),
        }
    };

    clear_generation(&app, generation);
    let payload = exit_payload(generation, status, requested, error);
    let _ = app.emit("acp://exit", payload);
    let (lock, wake) = &*exited;
    if let Ok(mut exited) = lock.lock() {
        *exited = true;
        wake.notify_all();
    }
}

fn clear_generation(app: &AppHandle, generation: u64) {
    let state = app.state::<AcpProcessState>();
    if let Ok(mut slot) = state.slot.lock() {
        if slot.running.as_ref().map(|process| process.generation) == Some(generation) {
            slot.running = None;
        }
    };
}

fn exit_payload(
    generation: u64,
    status: Option<ExitStatus>,
    requested: bool,
    error: Option<String>,
) -> ExitPayload {
    ExitPayload {
        generation,
        code: status.as_ref().and_then(ExitStatus::code),
        success: status.as_ref().is_some_and(ExitStatus::success),
        requested,
        error,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(AcpProcessState::default())
        .setup(|app| {
            app.manage(AttachmentPathState::load(app.handle()));
            Ok(())
        })
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            acp_start,
            acp_send,
            acp_stop,
            inspect_attachments,
            read_attachment_base64,
            cache_attachment,
            open_attachment,
            read_project_file,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Pix Desktop");
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            let state = handle.state::<AcpProcessState>();
            if let Err(error) = stop_process(&state, None) {
                eprintln!("failed to stop pix-acp during exit: {error}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_workspace(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path =
            env::temp_dir().join(format!("pix-desktop-{name}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&path).expect("create temporary workspace");
        path
    }

    #[test]
    fn reads_utf8_files_inside_the_workspace() {
        let workspace = temporary_workspace("project-preview");
        fs::create_dir(workspace.join("src")).expect("create src directory");
        fs::write(workspace.join("src/main.ts"), "const ready = true;\n").expect("write source");

        let preview = read_project_file_from(&workspace, Path::new("src/main.ts"), 1024)
            .expect("read project file");

        assert_eq!(preview.path, "src/main.ts");
        assert_eq!(preview.content, "const ready = true;\n");
        fs::remove_dir_all(workspace).expect("remove temporary workspace");
    }

    #[test]
    fn rejects_parent_traversal_large_files_and_non_utf8_content() {
        let workspace = temporary_workspace("project-preview-errors");
        fs::write(workspace.join("large.txt"), "12345").expect("write large file");
        fs::write(workspace.join("binary.bin"), [0xff, 0xfe]).expect("write binary file");

        assert!(read_project_file_from(&workspace, Path::new("../secret.txt"), 1024).is_err());
        assert!(read_project_file_from(&workspace, Path::new("large.txt"), 4).is_err());
        assert!(read_project_file_from(&workspace, Path::new("binary.bin"), 1024).is_err());
        fs::remove_dir_all(workspace).expect("remove temporary workspace");
    }
}
