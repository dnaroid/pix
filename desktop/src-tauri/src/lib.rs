use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::DateTime;
use serde::{
    de::{IgnoredAny, MapAccess, Visitor},
    Deserialize, Serialize,
};
use std::{
    collections::{HashMap, HashSet},
    env, fmt, fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Component, Path, PathBuf},
    process::{Child, ChildStdin, Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::StateFlags;

const POLL_INTERVAL: Duration = Duration::from_millis(40);
const GRACEFUL_STOP_TIMEOUT: Duration = Duration::from_secs(2);
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
const ACP_EVENT_BATCH_LATENCY: Duration = Duration::from_millis(4);
const ACP_EVENT_BATCH_MAX_LINES: usize = 64;
const MAX_ATTACHMENT_COUNT: usize = 10;
const MAX_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024;
const MAX_ATTACHMENT_CACHE_BYTES: u64 = 250 * 1024 * 1024;
const MAX_PROJECT_FILE_PREVIEW_BYTES: u64 = 2 * 1024 * 1024;
const MAX_PROJECT_MARKDOWN_BYTES: u64 = 2 * 1024 * 1024;
const MAX_TASK_DOCUMENT_BYTES: u64 = 1024 * 1024;
const MAX_GIT_CHANGES: usize = 5_000;
const MAX_GIT_DIFF_BYTES: usize = 512 * 1024;
const MAX_GIT_COMMIT_MESSAGE_BYTES: usize = 20 * 1024;
const PROJECT_TASKS_SCHEMA_URL: &str = "https://unpkg.com/pi-ui-extend/schemas/tasks.json";
const ATTACHMENT_CACHE_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
static ATTACHMENT_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static TASK_WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
type ExitSignal = Arc<(Mutex<bool>, Condvar)>;

#[derive(Default)]
struct AcpProcessState {
    slots: Mutex<HashMap<String, ProcessSlot>>,
    next_generation: AtomicU64,
    exiting: AtomicBool,
}

#[derive(Default)]
struct ProcessSlot {
    running: Option<RunningProcess>,
}

struct RunningProcess {
    generation: u64,
    stdin_tx: Option<mpsc::Sender<StdinCommand>>,
    stop_tx: mpsc::Sender<()>,
    exited: ExitSignal,
}

impl Drop for RunningProcess {
    fn drop(&mut self) {
        if let Some(stdin_tx) = self.stdin_tx.take() {
            let _ = stdin_tx.send(StdinCommand::Close);
        }
        let _ = self.stop_tx.send(());
    }
}

enum StdinCommand {
    Write {
        line: String,
        ack: mpsc::SyncSender<Result<(), String>>,
    },
    Close,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitPayload {
    window_label: String,
    generation: u64,
    code: Option<i32>,
    success: bool,
    requested: bool,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LinesPayload {
    window_label: String,
    generation: u64,
    lines: Vec<String>,
}

async fn run_blocking<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("background task failed: {error}"))?
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectDocumentsSnapshot {
    plans: Vec<String>,
    todo_exists: bool,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
enum ProjectTreeEntryKind {
    File,
    Directory,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectTreeEntry {
    name: String,
    path: String,
    kind: ProjectTreeEntryKind,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitFileChange {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    original_path: Option<String>,
    index_status: String,
    worktree_status: String,
    staged: bool,
    unstaged: bool,
    untracked: bool,
    conflicted: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitBranch {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    upstream: Option<String>,
    current: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitSnapshot {
    branch: String,
    detached: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    head: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    changes: Vec<GitFileChange>,
    branches: Vec<GitBranch>,
    remotes: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum GitDiffScope {
    Staged,
    Unstaged,
    All,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitDiff {
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    scope: GitDiffScope,
    content: String,
    truncated: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectTaskDocument {
    #[serde(rename = "$schema", skip_serializing_if = "Option::is_none")]
    schema: Option<String>,
    version: u8,
    tasks: Vec<ProjectTask>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectTask {
    id: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(rename = "type")]
    task_type: ProjectTaskType,
    status: ProjectTaskStatus,
    priority: ProjectTaskPriority,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ProjectTaskType {
    Bug,
    Feature,
    Improvement,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ProjectTaskStatus {
    Backlog,
    Todo,
    InProgress,
    Done,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ProjectTaskPriority {
    Low,
    Medium,
    High,
    Urgent,
}

struct AttachmentPathState {
    approved: Mutex<HashSet<PathBuf>>,
    cache_lock: Mutex<()>,
    registry_lock: Mutex<()>,
    registry_loaded: AtomicBool,
    registry_path: PathBuf,
}

impl AttachmentPathState {
    fn new(app: &AppHandle) -> Self {
        let cache_dir = app
            .path()
            .app_cache_dir()
            .unwrap_or_else(|_| env::temp_dir());
        Self {
            approved: Mutex::new(HashSet::new()),
            cache_lock: Mutex::new(()),
            registry_lock: Mutex::new(()),
            registry_loaded: AtomicBool::new(false),
            registry_path: cache_dir.join("approved-attachments.json"),
        }
    }

    fn ensure_registry_loaded(&self, app: &AppHandle) -> Result<(), String> {
        if self.registry_loaded.load(Ordering::Acquire) {
            return Ok(());
        }
        let _registry_guard = self
            .registry_lock
            .lock()
            .map_err(|_| "attachment registry state is poisoned".to_owned())?;
        if self.registry_loaded.load(Ordering::Relaxed) {
            return Ok(());
        }

        let mut restored = HashSet::new();
        if let Ok(raw) = fs::read_to_string(&self.registry_path) {
            if let Ok(paths) = serde_json::from_str::<Vec<String>>(&raw) {
                for path in paths {
                    if let Ok(canonical) = fs::canonicalize(path) {
                        let _ = app.asset_protocol_scope().allow_file(&canonical);
                        restored.insert(canonical);
                    }
                }
            }
        }
        self.approved
            .lock()
            .map_err(|_| "attachment path state is poisoned".to_owned())?
            .extend(restored);
        self.registry_loaded.store(true, Ordering::Release);
        Ok(())
    }

    fn approve_selected_batch(
        &self,
        app: &AppHandle,
        paths: &[String],
    ) -> Result<Vec<PathBuf>, String> {
        self.ensure_registry_loaded(app)?;
        let canonical = paths
            .iter()
            .map(|path| {
                fs::canonicalize(path).map_err(|error| format!("failed to resolve {path}: {error}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        {
            let approved = self
                .approved
                .lock()
                .map_err(|_| "attachment path state is poisoned".to_owned())?;
            for (source, path) in paths.iter().zip(&canonical) {
                if !approved.contains(path) && !app.asset_protocol_scope().is_allowed(path) {
                    return Err(format!("{source} was not selected by the user"));
                }
            }
        }
        self.approve_paths(app, canonical.iter().cloned())?;
        Ok(canonical)
    }

    fn approve_cached(&self, app: &AppHandle, path: &Path) -> Result<PathBuf, String> {
        let canonical = fs::canonicalize(path)
            .map_err(|error| format!("failed to resolve {}: {error}", path.display()))?;
        self.approve(app, canonical.clone())?;
        Ok(canonical)
    }

    fn approved_path(&self, app: &AppHandle, path: &Path) -> Result<PathBuf, String> {
        self.ensure_registry_loaded(app)?;
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
        self.approve_paths(app, std::iter::once(path))
    }

    fn approve_paths(
        &self,
        app: &AppHandle,
        paths: impl IntoIterator<Item = PathBuf>,
    ) -> Result<(), String> {
        self.ensure_registry_loaded(app)?;
        let paths = paths.into_iter().collect::<HashSet<_>>();
        for path in &paths {
            app.asset_protocol_scope()
                .allow_file(path)
                .map_err(|error| format!("failed to allow attachment preview: {error}"))?;
        }
        let _registry_guard = self
            .registry_lock
            .lock()
            .map_err(|_| "attachment registry state is poisoned".to_owned())?;
        let (new_paths, snapshot) = {
            let approved = self
                .approved
                .lock()
                .map_err(|_| "attachment path state is poisoned".to_owned())?;
            let new_paths = paths
                .into_iter()
                .filter(|path| !approved.contains(path))
                .collect::<Vec<_>>();
            if new_paths.is_empty() {
                return Ok(());
            }
            let snapshot = approved
                .iter()
                .chain(new_paths.iter())
                .map(|value| value.to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            (new_paths, snapshot)
        };
        if let Some(parent) = self.registry_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!("failed to create the attachment registry directory: {error}")
            })?;
        }
        let serialized = serde_json::to_vec(&snapshot)
            .map_err(|error| format!("failed to encode the attachment registry: {error}"))?;
        fs::write(&self.registry_path, serialized)
            .map_err(|error| format!("failed to save the attachment registry: {error}"))?;
        self.approved
            .lock()
            .map_err(|_| "attachment path state is poisoned".to_owned())?
            .extend(new_paths);
        Ok(())
    }
}

#[tauri::command]
async fn inspect_attachments(
    app: AppHandle,
    paths: Vec<String>,
) -> Result<Vec<AttachmentFile>, String> {
    if paths.len() > MAX_ATTACHMENT_COUNT {
        return Err(format!("select at most {MAX_ATTACHMENT_COUNT} attachments"));
    }
    run_blocking(move || {
        let state = app.state::<AttachmentPathState>();
        state
            .approve_selected_batch(&app, &paths)?
            .into_iter()
            .map(|canonical| attachment_file(&canonical))
            .collect()
    })
    .await
}

#[tauri::command]
async fn read_attachment_base64(app: AppHandle, path: String) -> Result<String, String> {
    run_blocking(move || {
        let state = app.state::<AttachmentPathState>();
        let approved = state.approved_path(&app, Path::new(&path))?;
        let file = attachment_file(&approved)?;
        if file.size > MAX_ATTACHMENT_BYTES {
            return Err(format!(
                "{} is too large to send as an image (maximum 25 MB)",
                file.name,
            ));
        }
        let bytes = fs::read(&file.path)
            .map_err(|error| format!("failed to read {}: {error}", file.name))?;
        if bytes.len() as u64 > MAX_ATTACHMENT_BYTES {
            return Err(format!("{} grew beyond the 25 MB image limit", file.name));
        }
        Ok(BASE64.encode(bytes))
    })
    .await
}

#[tauri::command]
async fn cache_attachment(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<AttachmentFile, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("pasted attachment body must be binary".to_owned());
    };
    if bytes.len() as u64 > MAX_ATTACHMENT_BYTES {
        return Err("pasted attachment is too large (maximum 25 MB)".to_owned());
    }
    let encoded_name = request
        .headers()
        .get("x-pix-attachment-name")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "missing pasted attachment name".to_owned())?;
    let name = String::from_utf8(
        BASE64
            .decode(encoded_name)
            .map_err(|error| format!("invalid pasted attachment name: {error}"))?,
    )
    .map_err(|_| "pasted attachment name is not valid UTF-8".to_owned())?;
    let bytes = bytes.clone();
    run_blocking(move || {
        let state = app.state::<AttachmentPathState>();
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
    })
    .await
}

#[tauri::command]
async fn cache_task_attachment(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<AttachmentFile, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("pasted task attachment body must be binary".to_owned());
    };
    if bytes.len() as u64 > MAX_ATTACHMENT_BYTES {
        return Err("pasted task attachment is too large (maximum 25 MB)".to_owned());
    }
    let encoded_name = request
        .headers()
        .get("x-pix-attachment-name")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "missing pasted task attachment name".to_owned())?;
    let encoded_workspace = request
        .headers()
        .get("x-pix-workspace")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "missing task attachment workspace".to_owned())?;
    let name = String::from_utf8(
        BASE64
            .decode(encoded_name)
            .map_err(|error| format!("invalid pasted task attachment name: {error}"))?,
    )
    .map_err(|_| "pasted task attachment name is not valid UTF-8".to_owned())?;
    let workspace = String::from_utf8(
        BASE64
            .decode(encoded_workspace)
            .map_err(|error| format!("invalid task attachment workspace: {error}"))?,
    )
    .map_err(|_| "task attachment workspace is not valid UTF-8".to_owned())?;
    let bytes = bytes.clone();
    run_blocking(move || {
        let root = canonical_workspace(Path::new(&workspace))?;
        let project_dir = root.join(".pi");
        if !project_dir.exists() {
            fs::create_dir(&project_dir)
                .map_err(|error| format!("failed to create {}: {error}", project_dir.display()))?;
        }
        let project_dir = canonical_project_directory(&root, &project_dir)?;
        let directory = project_dir.join("task-attachments");
        if !directory.exists() {
            fs::create_dir(&directory)
                .map_err(|error| format!("failed to create {}: {error}", directory.display()))?;
        }
        let directory = canonical_project_directory(&root, &directory)?;
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let sequence = ATTACHMENT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = directory.join(format!("{stamp}-{sequence}-{}", safe_file_name(&name)));
        fs::write(&path, bytes)
            .map_err(|error| format!("failed to persist task attachment {name}: {error}"))?;
        let state = app.state::<AttachmentPathState>();
        let canonical = state.approve_cached(&app, &path)?;
        attachment_file(&canonical)
    })
    .await
}

#[tauri::command]
async fn open_attachment(app: AppHandle, path: String) -> Result<(), String> {
    run_blocking(move || {
        let approved = app
            .state::<AttachmentPathState>()
            .approved_path(&app, Path::new(&path))?;
        app.opener()
            .open_path(approved.to_string_lossy(), None::<&str>)
            .map_err(|error| format!("failed to open attachment: {error}"))
    })
    .await
}

#[tauri::command]
async fn read_project_file(workspace: String, path: String) -> Result<ProjectFilePreview, String> {
    run_blocking(move || {
        read_project_file_from(
            Path::new(&workspace),
            Path::new(&path),
            MAX_PROJECT_FILE_PREVIEW_BYTES,
        )
    })
    .await
}

#[tauri::command]
async fn list_project_directory(
    workspace: String,
    path: Option<String>,
) -> Result<Vec<ProjectTreeEntry>, String> {
    run_blocking(move || {
        list_project_directory_from(Path::new(&workspace), path.as_deref().map(Path::new))
    })
    .await
}

#[tauri::command]
async fn open_in_external_editor(
    workspace: String,
    path: Option<String>,
    editor: String,
) -> Result<(), String> {
    run_blocking(move || {
        let target =
            resolve_external_editor_target(Path::new(&workspace), path.as_deref().map(Path::new))?;
        launch_external_editor(&editor, &target)
    })
    .await
}

#[tauri::command]
async fn git_status(workspace: String) -> Result<GitSnapshot, String> {
    run_blocking(move || git_status_from(Path::new(&workspace))).await
}

#[tauri::command]
async fn git_diff(
    workspace: String,
    path: Option<String>,
    scope: GitDiffScope,
) -> Result<GitDiff, String> {
    run_blocking(move || git_diff_from(Path::new(&workspace), path.as_deref(), scope)).await
}

#[tauri::command]
async fn git_stage(workspace: String, path: Option<String>) -> Result<(), String> {
    run_blocking(move || git_stage_from(Path::new(&workspace), path.as_deref())).await
}

#[tauri::command]
async fn git_unstage(workspace: String, path: Option<String>) -> Result<(), String> {
    run_blocking(move || git_unstage_from(Path::new(&workspace), path.as_deref())).await
}

#[tauri::command]
async fn git_commit(workspace: String, message: String) -> Result<(), String> {
    run_blocking(move || git_commit_from(Path::new(&workspace), &message)).await
}

#[tauri::command]
async fn git_push(workspace: String) -> Result<(), String> {
    run_blocking(move || git_push_from(Path::new(&workspace))).await
}

#[tauri::command]
async fn git_switch_branch(workspace: String, branch: String) -> Result<(), String> {
    run_blocking(move || git_switch_branch_from(Path::new(&workspace), &branch, false)).await
}

#[tauri::command]
async fn git_create_branch(workspace: String, branch: String) -> Result<(), String> {
    run_blocking(move || git_switch_branch_from(Path::new(&workspace), &branch, true)).await
}

#[tauri::command]
async fn list_project_documents(workspace: String) -> Result<ProjectDocumentsSnapshot, String> {
    run_blocking(move || list_project_documents_from(Path::new(&workspace))).await
}

#[tauri::command]
async fn write_project_markdown(
    workspace: String,
    path: String,
    content: String,
) -> Result<ProjectFilePreview, String> {
    run_blocking(move || {
        write_project_markdown_from(Path::new(&workspace), Path::new(&path), &content)
    })
    .await
}

#[tauri::command]
async fn read_home_file(app: AppHandle, path: String) -> Result<ProjectFilePreview, String> {
    run_blocking(move || {
        let home = app
            .path()
            .home_dir()
            .map_err(|error| format!("failed to resolve the home directory: {error}"))?;
        read_home_file_from(&home, Path::new(&path), MAX_PROJECT_FILE_PREVIEW_BYTES)
    })
    .await
}

#[tauri::command]
async fn resolve_project_media(
    app: AppHandle,
    workspace: String,
    path: String,
) -> Result<AttachmentFile, String> {
    run_blocking(move || {
        let file = resolve_project_media_from(Path::new(&workspace), Path::new(&path))?;
        app.state::<AttachmentPathState>()
            .approve(&app, PathBuf::from(&file.path))?;
        Ok(file)
    })
    .await
}

#[tauri::command]
async fn resolve_home_media(app: AppHandle, path: String) -> Result<AttachmentFile, String> {
    run_blocking(move || {
        let home = app
            .path()
            .home_dir()
            .map_err(|error| format!("failed to resolve the home directory: {error}"))?;
        let (_, file_path) = resolve_home_file_path(&home, Path::new(&path))?;
        if !is_supported_project_media(&file_path) {
            return Err(format!("{path} is not a supported image or video"));
        }
        let file = attachment_file(&file_path)?;
        app.state::<AttachmentPathState>()
            .approve(&app, file_path)?;
        Ok(file)
    })
    .await
}

#[tauri::command]
async fn resolve_local_media(app: AppHandle, path: String) -> Result<AttachmentFile, String> {
    run_blocking(move || {
        let file = resolve_local_media_from(Path::new(&path))?;
        app.state::<AttachmentPathState>()
            .approve(&app, PathBuf::from(&file.path))?;
        Ok(file)
    })
    .await
}

#[tauri::command]
async fn open_local_file(app: AppHandle, path: String) -> Result<(), String> {
    run_blocking(move || {
        let file_path = resolve_local_file_path(Path::new(&path))?;
        app.opener()
            .open_path(file_path.to_string_lossy(), None::<&str>)
            .map_err(|error| format!("failed to open local file: {error}"))
    })
    .await
}

fn resolve_project_media_from(
    workspace: &Path,
    relative_path: &Path,
) -> Result<AttachmentFile, String> {
    let (_, file_path) = resolve_project_file_path(workspace, relative_path)?;
    if !is_supported_project_media(&file_path) {
        return Err(format!(
            "{} is not a supported image or video",
            relative_path.display()
        ));
    }
    attachment_file(&file_path)
}

fn resolve_local_media_from(path: &Path) -> Result<AttachmentFile, String> {
    let file_path = resolve_local_file_path(path)?;
    if !is_supported_project_media(&file_path) {
        return Err(format!(
            "{} is not a supported image or video",
            path.display()
        ));
    }
    attachment_file(&file_path)
}

fn resolve_local_file_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("local file path must be absolute".to_owned());
    }
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("failed to resolve local file {}: {error}", path.display()))?;
    let metadata = fs::metadata(&canonical)
        .map_err(|error| format!("failed to inspect {}: {error}", canonical.display()))?;
    if !metadata.is_file() {
        return Err(format!("{} is not a file", canonical.display()));
    }
    Ok(canonical)
}

fn list_project_documents_from(workspace: &Path) -> Result<ProjectDocumentsSnapshot, String> {
    let root = canonical_workspace(workspace)?;
    let project_dir = root.join(".pi");
    if !project_dir.exists() {
        return Ok(ProjectDocumentsSnapshot {
            plans: Vec::new(),
            todo_exists: false,
        });
    }
    let project_dir = canonical_project_directory(&root, &project_dir)?;

    let todo_path = project_dir.join("TODO.md");
    let todo_exists = if todo_path.exists() {
        let canonical = fs::canonicalize(&todo_path)
            .map_err(|error| format!("failed to resolve {}: {error}", todo_path.display()))?;
        if !canonical.starts_with(&project_dir) {
            return Err(".pi/TODO.md resolves outside the workspace".to_owned());
        }
        fs::metadata(&canonical)
            .map_err(|error| format!("failed to inspect {}: {error}", canonical.display()))?
            .is_file()
    } else {
        false
    };

    let plans_dir = project_dir.join("plans");
    let mut plans = Vec::new();
    if plans_dir.exists() {
        let canonical_plans = fs::canonicalize(&plans_dir)
            .map_err(|error| format!("failed to resolve {}: {error}", plans_dir.display()))?;
        if !canonical_plans.starts_with(&project_dir) || !canonical_plans.is_dir() {
            return Err(".pi/plans must be a directory inside the workspace".to_owned());
        }
        collect_project_plan_files(&root, &canonical_plans, &mut plans)?;
        plans.sort();
    }

    Ok(ProjectDocumentsSnapshot { plans, todo_exists })
}

fn collect_project_plan_files(
    root: &Path,
    directory: &Path,
    output: &mut Vec<String>,
) -> Result<(), String> {
    if output.len() >= 500 {
        return Err(".pi/plans contains too many Markdown files (maximum 500)".to_owned());
    }
    let mut entries = fs::read_dir(directory)
        .map_err(|error| format!("failed to read {}: {error}", directory.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to inspect {}: {error}", directory.display()))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let file_type = entry
            .file_type()
            .map_err(|error| format!("failed to inspect {}: {error}", entry.path().display()))?;
        if file_type.is_symlink() {
            return Err(format!(
                "plan paths cannot contain symbolic links: {}",
                entry.path().display()
            ));
        }
        if file_type.is_dir() {
            collect_project_plan_files(root, &entry.path(), output)?;
            continue;
        }
        if !file_type.is_file()
            || !entry
                .path()
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
        {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(root)
            .map_err(|_| "plan path resolves outside the workspace".to_owned())?
            .to_string_lossy()
            .replace('\\', "/");
        output.push(relative);
        if output.len() >= 500 {
            return Err(".pi/plans contains too many Markdown files (maximum 500)".to_owned());
        }
    }
    Ok(())
}

fn write_project_markdown_from(
    workspace: &Path,
    relative_path: &Path,
    content: &str,
) -> Result<ProjectFilePreview, String> {
    if content.len() as u64 > MAX_PROJECT_MARKDOWN_BYTES {
        return Err("project Markdown is too large to save (maximum 2 MB)".to_owned());
    }
    if relative_path.as_os_str().is_empty()
        || relative_path.is_absolute()
        || relative_path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("editable project Markdown path must stay inside the workspace".to_owned());
    }
    let normalized = relative_path.to_string_lossy().replace('\\', "/");
    let editable = normalized == ".pi/TODO.md"
        || (normalized.starts_with(".pi/plans/")
            && normalized.to_ascii_lowercase().ends_with(".md"));
    if !editable {
        return Err(
            "only .pi/TODO.md and Markdown files under .pi/plans/ can be edited".to_owned(),
        );
    }

    let root = canonical_workspace(workspace)?;
    let project_dir_path = root.join(".pi");
    if !project_dir_path.exists() {
        fs::create_dir(&project_dir_path)
            .map_err(|error| format!("failed to create {}: {error}", project_dir_path.display()))?;
    }
    let project_dir = canonical_project_directory(&root, &project_dir_path)?;

    let target = if normalized == ".pi/TODO.md" {
        project_dir.join("TODO.md")
    } else {
        let plans_dir_path = project_dir.join("plans");
        if !plans_dir_path.exists() {
            fs::create_dir(&plans_dir_path).map_err(|error| {
                format!("failed to create {}: {error}", plans_dir_path.display())
            })?;
        }
        let plans_dir = fs::canonicalize(&plans_dir_path)
            .map_err(|error| format!("failed to resolve {}: {error}", plans_dir_path.display()))?;
        if !plans_dir.starts_with(&project_dir) || !plans_dir.is_dir() {
            return Err(".pi/plans must stay inside the workspace".to_owned());
        }
        let plan_relative = Path::new(&normalized)
            .strip_prefix(Path::new(".pi/plans"))
            .map_err(|_| "invalid plan path".to_owned())?;
        let target = plans_dir.join(plan_relative);
        let parent = target
            .parent()
            .ok_or_else(|| "plan path has no parent directory".to_owned())?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
        let canonical_parent = fs::canonicalize(parent)
            .map_err(|error| format!("failed to resolve {}: {error}", parent.display()))?;
        if !canonical_parent.starts_with(&plans_dir) {
            return Err("plan path resolves outside .pi/plans".to_owned());
        }
        canonical_parent.join(
            target
                .file_name()
                .ok_or_else(|| "plan path has no file name".to_owned())?,
        )
    };

    if target.exists() {
        if fs::symlink_metadata(&target)
            .map_err(|error| format!("failed to inspect {}: {error}", target.display()))?
            .file_type()
            .is_symlink()
        {
            return Err(format!("{} cannot be a symbolic link", normalized));
        }
        let canonical = fs::canonicalize(&target)
            .map_err(|error| format!("failed to resolve {}: {error}", target.display()))?;
        if !canonical.starts_with(&project_dir) {
            return Err("project Markdown resolves outside the workspace".to_owned());
        }
        if !fs::metadata(&canonical)
            .map_err(|error| format!("failed to inspect {}: {error}", canonical.display()))?
            .is_file()
        {
            return Err(format!("{} is not a file", normalized));
        }
    }

    fs::write(&target, content.as_bytes())
        .map_err(|error| format!("failed to save {normalized}: {error}"))?;
    read_project_file_from(&root, relative_path, MAX_PROJECT_MARKDOWN_BYTES)
}

fn read_project_file_from(
    workspace: &Path,
    relative_path: &Path,
    max_bytes: u64,
) -> Result<ProjectFilePreview, String> {
    let (root, file_path) = resolve_project_file_path(workspace, relative_path)?;
    let display_path = file_path
        .strip_prefix(&root)
        .unwrap_or(relative_path)
        .to_string_lossy()
        .replace('\\', "/");
    read_text_file_from(&file_path, display_path, max_bytes)
}

fn list_project_directory_from(
    workspace: &Path,
    relative_path: Option<&Path>,
) -> Result<Vec<ProjectTreeEntry>, String> {
    let (root, directory) = resolve_project_directory_path(workspace, relative_path)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(&directory)
        .map_err(|error| format!("failed to read {}: {error}", directory.display()))?
    {
        let entry =
            entry.map_err(|error| format!("failed to read project directory entry: {error}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" || name == ".DS_Store" {
            continue;
        }
        let file_type = entry
            .file_type()
            .map_err(|error| format!("failed to inspect {}: {error}", entry.path().display()))?;
        // Do not follow workspace symlinks from the renderer-facing explorer.
        // This keeps every listed target anchored to the canonical workspace.
        if file_type.is_symlink() {
            continue;
        }
        let kind = if file_type.is_dir() {
            ProjectTreeEntryKind::Directory
        } else if file_type.is_file() {
            ProjectTreeEntryKind::File
        } else {
            continue;
        };
        let path = entry
            .path()
            .strip_prefix(&root)
            .map_err(|_| "project tree entry resolves outside the workspace".to_owned())?
            .to_string_lossy()
            .replace('\\', "/");
        entries.push(ProjectTreeEntry { name, path, kind });
        if entries.len() > 2_000 {
            return Err(format!(
                "{} contains too many entries to display (maximum 2000)",
                directory.display()
            ));
        }
    }
    entries.sort_by(|left, right| {
        let left_dir = matches!(left.kind, ProjectTreeEntryKind::Directory);
        let right_dir = matches!(right.kind, ProjectTreeEntryKind::Directory);
        right_dir
            .cmp(&left_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(entries)
}

fn resolve_project_directory_path(
    workspace: &Path,
    relative_path: Option<&Path>,
) -> Result<(PathBuf, PathBuf), String> {
    let root = canonical_workspace(workspace)?;
    let Some(relative_path) = relative_path.filter(|path| !path.as_os_str().is_empty()) else {
        return Ok((root.clone(), root));
    };
    validate_workspace_relative_path(relative_path, "project directory")?;
    let unresolved = root.join(relative_path);
    if fs::symlink_metadata(&unresolved)
        .map_err(|error| format!("failed to inspect {}: {error}", unresolved.display()))?
        .file_type()
        .is_symlink()
    {
        return Err("project explorer does not follow symbolic links".to_owned());
    }
    let directory = fs::canonicalize(&unresolved)
        .map_err(|error| format!("failed to resolve {}: {error}", unresolved.display()))?;
    if !directory.starts_with(&root) {
        return Err("project directory resolves outside the workspace".to_owned());
    }
    if !directory.is_dir() {
        return Err(format!("{} is not a directory", relative_path.display()));
    }
    Ok((root, directory))
}

fn resolve_external_editor_target(
    workspace: &Path,
    relative_path: Option<&Path>,
) -> Result<PathBuf, String> {
    let root = canonical_workspace(workspace)?;
    let Some(relative_path) = relative_path.filter(|path| !path.as_os_str().is_empty()) else {
        return Ok(root);
    };
    validate_workspace_relative_path(relative_path, "external editor target")?;
    let unresolved = root.join(relative_path);
    if fs::symlink_metadata(&unresolved)
        .map_err(|error| format!("failed to inspect {}: {error}", unresolved.display()))?
        .file_type()
        .is_symlink()
    {
        return Err("external editor target cannot be a symbolic link".to_owned());
    }
    let target = fs::canonicalize(&unresolved)
        .map_err(|error| format!("failed to resolve {}: {error}", unresolved.display()))?;
    if !target.starts_with(&root) {
        return Err("external editor target resolves outside the workspace".to_owned());
    }
    Ok(target)
}

fn validate_workspace_relative_path(path: &Path, label: &str) -> Result<(), String> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(format!("{label} must stay relative to the workspace"));
    }
    Ok(())
}

fn git_repository_root(workspace: &Path) -> Result<PathBuf, String> {
    let root = canonical_workspace(workspace)?;
    let output = git_output_raw(&root, &["rev-parse", "--show-toplevel"])?;
    if !output.status.success() {
        return Err(git_command_error("Git repository", &output));
    }
    let reported = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if reported.is_empty() {
        return Err("Git did not report a repository root".to_owned());
    }
    let repository = fs::canonicalize(&reported)
        .map_err(|error| format!("failed to resolve Git repository root {reported}: {error}"))?;
    if repository != root {
        return Err(format!(
            "Git repository root is {}; open that directory as the Pix project to use Source Control",
            repository.display()
        ));
    }
    Ok(root)
}

fn git_output_raw(root: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(root)
        .arg("-c")
        .arg("color.ui=false")
        .arg("-c")
        .arg("core.quotepath=false")
        .arg("-c")
        .arg("core.pager=cat")
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .env("GIT_EDITOR", "true")
        .env("GIT_SEQUENCE_EDITOR", "true")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
        .output()
        .map_err(|error| format!("failed to run git {}: {error}", args.join(" ")))
}

fn git_output(root: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    let output = git_output_raw(root, args)?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(git_command_error(
            &format!("git {}", args.join(" ")),
            &output,
        ))
    }
}

fn git_command_error(label: &str, output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        output
            .status
            .code()
            .map(|code| format!("exit code {code}"))
            .unwrap_or_else(|| "terminated without an exit code".to_owned())
    };
    format!("{label} failed: {detail}")
}

fn git_status_from(workspace: &Path) -> Result<GitSnapshot, String> {
    let root = git_repository_root(workspace)?;
    let output = git_output(
        &root,
        &[
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--untracked-files=all",
        ],
    )?;
    let mut snapshot = parse_git_status_porcelain(&output.stdout)?;
    snapshot.branches = git_local_branches(&root, &snapshot.branch)?;
    snapshot.remotes = git_remotes(&root)?;
    Ok(snapshot)
}

fn parse_git_status_porcelain(bytes: &[u8]) -> Result<GitSnapshot, String> {
    let records = bytes.split(|byte| *byte == 0).collect::<Vec<_>>();
    let mut branch = "HEAD".to_owned();
    let mut detached = false;
    let mut head = None;
    let mut upstream = None;
    let mut ahead = 0u32;
    let mut behind = 0u32;
    let mut changes = Vec::new();
    let mut index = 0usize;

    while index < records.len() {
        let record = records[index];
        index += 1;
        if record.is_empty() {
            continue;
        }
        let text = String::from_utf8_lossy(record);
        if let Some(value) = text.strip_prefix("# branch.oid ") {
            if value != "(initial)" {
                head = Some(value.to_owned());
            }
            continue;
        }
        if let Some(value) = text.strip_prefix("# branch.head ") {
            detached = value == "(detached)";
            branch = if detached {
                "HEAD".to_owned()
            } else {
                value.to_owned()
            };
            continue;
        }
        if let Some(value) = text.strip_prefix("# branch.upstream ") {
            upstream = Some(value.to_owned());
            continue;
        }
        if let Some(value) = text.strip_prefix("# branch.ab ") {
            for part in value.split_whitespace() {
                if let Some(value) = part.strip_prefix('+') {
                    ahead = value.parse().unwrap_or(0);
                } else if let Some(value) = part.strip_prefix('-') {
                    behind = value.parse().unwrap_or(0);
                }
            }
            continue;
        }

        let change = if let Some(path) = text.strip_prefix("? ") {
            Some(GitFileChange {
                path: path.to_owned(),
                original_path: None,
                index_status: "?".to_owned(),
                worktree_status: "?".to_owned(),
                staged: false,
                unstaged: true,
                untracked: true,
                conflicted: false,
            })
        } else if text.starts_with("1 ") {
            parse_git_ordinary_change(&text)
        } else if text.starts_with("2 ") {
            let original = records.get(index).copied().unwrap_or_default();
            if index < records.len() {
                index += 1;
            }
            parse_git_renamed_change(&text, &String::from_utf8_lossy(original))
        } else if text.starts_with("u ") {
            parse_git_unmerged_change(&text)
        } else if text.starts_with("! ") {
            None
        } else {
            return Err(format!("unsupported Git status record: {text}"));
        };
        if let Some(change) = change {
            changes.push(change);
            if changes.len() > MAX_GIT_CHANGES {
                return Err(format!(
                    "Git repository has too many changed files to display (maximum {MAX_GIT_CHANGES})"
                ));
            }
        }
    }

    Ok(GitSnapshot {
        branch,
        detached,
        head,
        upstream,
        ahead,
        behind,
        changes,
        branches: Vec::new(),
        remotes: Vec::new(),
    })
}

fn parse_git_ordinary_change(record: &str) -> Option<GitFileChange> {
    let fields = record.splitn(9, ' ').collect::<Vec<_>>();
    git_change_from_fields(
        fields.get(1).copied()?,
        fields.get(8).copied()?,
        None,
        false,
    )
}

fn parse_git_renamed_change(record: &str, original_path: &str) -> Option<GitFileChange> {
    let fields = record.splitn(10, ' ').collect::<Vec<_>>();
    git_change_from_fields(
        fields.get(1).copied()?,
        fields.get(9).copied()?,
        (!original_path.is_empty()).then(|| original_path.to_owned()),
        false,
    )
}

fn parse_git_unmerged_change(record: &str) -> Option<GitFileChange> {
    let fields = record.splitn(11, ' ').collect::<Vec<_>>();
    git_change_from_fields(
        fields.get(1).copied()?,
        fields.get(10).copied()?,
        None,
        true,
    )
}

fn git_change_from_fields(
    xy: &str,
    path: &str,
    original_path: Option<String>,
    conflicted: bool,
) -> Option<GitFileChange> {
    let mut statuses = xy.chars();
    let index_status = statuses.next()?;
    let worktree_status = statuses.next()?;
    Some(GitFileChange {
        path: path.to_owned(),
        original_path,
        index_status: index_status.to_string(),
        worktree_status: worktree_status.to_string(),
        staged: index_status != '.',
        unstaged: worktree_status != '.',
        untracked: false,
        conflicted,
    })
}

fn git_local_branches(root: &Path, current_branch: &str) -> Result<Vec<GitBranch>, String> {
    let output = git_output(
        root,
        &[
            "for-each-ref",
            "--format=%(refname:short)%00%(upstream:short)",
            "refs/heads",
        ],
    )?;
    let text = String::from_utf8_lossy(&output.stdout);
    let mut branches = text
        .lines()
        .filter_map(|line| {
            let (name, upstream) = line.split_once('\0').unwrap_or((line, ""));
            let name = name.trim();
            if name.is_empty() {
                return None;
            }
            Some(GitBranch {
                name: name.to_owned(),
                upstream: (!upstream.trim().is_empty()).then(|| upstream.trim().to_owned()),
                current: name == current_branch,
            })
        })
        .collect::<Vec<_>>();
    if current_branch != "HEAD" && !branches.iter().any(|branch| branch.current) {
        branches.push(GitBranch {
            name: current_branch.to_owned(),
            upstream: None,
            current: true,
        });
    }
    branches.sort_by(|left, right| {
        right
            .current
            .cmp(&left.current)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(branches)
}

fn git_remotes(root: &Path) -> Result<Vec<String>, String> {
    let output = git_output(root, &["remote"])?;
    let mut remotes = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|remote| !remote.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    remotes.sort();
    remotes.dedup();
    Ok(remotes)
}

fn validate_git_relative_path(path: &str) -> Result<&str, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Git file path cannot be empty".to_owned());
    }
    validate_workspace_relative_path(Path::new(trimmed), "Git file path")?;
    Ok(trimmed)
}

fn git_diff_from(
    workspace: &Path,
    path: Option<&str>,
    scope: GitDiffScope,
) -> Result<GitDiff, String> {
    let root = git_repository_root(workspace)?;
    let path = path.map(validate_git_relative_path).transpose()?;
    let snapshot = git_status_from(&root)?;
    let mut content = String::new();

    match scope {
        GitDiffScope::Staged => {
            content.push_str(&git_tracked_diff(&root, path, true)?);
        }
        GitDiffScope::Unstaged => {
            content.push_str(&git_tracked_diff(&root, path, false)?);
            append_untracked_diffs(&root, &snapshot, path, &mut content)?;
        }
        GitDiffScope::All => {
            let staged = git_tracked_diff(&root, path, true)?;
            if !staged.trim().is_empty() {
                content.push_str("# Staged changes\n\n");
                content.push_str(&staged);
            }
            let unstaged = git_tracked_diff(&root, path, false)?;
            let before_unstaged = content.len();
            if !unstaged.trim().is_empty() {
                if !content.is_empty() {
                    content.push_str("\n\n");
                }
                content.push_str("# Working tree changes\n\n");
                content.push_str(&unstaged);
            }
            let before_untracked = content.len();
            append_untracked_diffs(&root, &snapshot, path, &mut content)?;
            if before_untracked == content.len()
                && before_unstaged == content.len()
                && content.is_empty()
            {
                content.clear();
            }
        }
    }

    let (content, truncated) = truncate_git_diff(content);
    Ok(GitDiff {
        path: path.map(str::to_owned),
        scope,
        content,
        truncated,
    })
}

fn git_tracked_diff(root: &Path, path: Option<&str>, staged: bool) -> Result<String, String> {
    let mut args = vec!["diff"];
    if staged {
        args.push("--cached");
    }
    args.extend(["--no-ext-diff", "--no-color", "--minimal"]);
    if let Some(path) = path {
        args.extend(["--", path]);
    }
    let output = git_output(root, &args)?;
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn append_untracked_diffs(
    root: &Path,
    snapshot: &GitSnapshot,
    requested_path: Option<&str>,
    content: &mut String,
) -> Result<(), String> {
    let untracked = snapshot
        .changes
        .iter()
        .filter(|change| change.untracked)
        .filter(|change| requested_path.is_none_or(|path| change.path == path))
        .take(100)
        .collect::<Vec<_>>();
    for change in untracked {
        let output = git_output_raw(
            root,
            &[
                "diff",
                "--no-index",
                "--no-ext-diff",
                "--no-color",
                "--",
                "/dev/null",
                &change.path,
            ],
        )?;
        let accepted = output.status.success() || output.status.code() == Some(1);
        if !accepted {
            return Err(git_command_error("git diff --no-index", &output));
        }
        // Git runs with the workspace as cwd and receives a workspace-relative
        // path, so its diff headers are already relative. Never post-process the
        // whole diff: doing so can corrupt hunk contents that happen to contain
        // the absolute workspace path.
        let diff = String::from_utf8_lossy(&output.stdout).into_owned();
        if !diff.trim().is_empty() {
            if !content.is_empty() {
                content.push_str("\n\n");
            }
            content.push_str(&diff);
        }
        if content.len() > MAX_GIT_DIFF_BYTES {
            break;
        }
    }
    Ok(())
}

fn truncate_git_diff(mut content: String) -> (String, bool) {
    if content.len() <= MAX_GIT_DIFF_BYTES {
        return (content, false);
    }
    let mut boundary = MAX_GIT_DIFF_BYTES;
    while !content.is_char_boundary(boundary) {
        boundary -= 1;
    }
    content.truncate(boundary);
    content.push_str("\n\n[Diff truncated by Pix Desktop]\n");
    (content, true)
}

fn git_stage_from(workspace: &Path, path: Option<&str>) -> Result<(), String> {
    let root = git_repository_root(workspace)?;
    let path = path.map(validate_git_relative_path).transpose()?;
    let target = path.unwrap_or(".");
    git_output(&root, &["add", "-A", "--", target]).map(|_| ())
}

fn git_has_head(root: &Path) -> Result<bool, String> {
    let output = git_output_raw(root, &["rev-parse", "--verify", "HEAD"])?;
    Ok(output.status.success())
}

fn git_unstage_from(workspace: &Path, path: Option<&str>) -> Result<(), String> {
    let root = git_repository_root(workspace)?;
    let path = path.map(validate_git_relative_path).transpose()?;
    let target = path.unwrap_or(".");
    if git_has_head(&root)? {
        git_output(&root, &["reset", "-q", "HEAD", "--", target]).map(|_| ())
    } else {
        git_output(
            &root,
            &["rm", "--cached", "-r", "--ignore-unmatch", "--", target],
        )
        .map(|_| ())
    }
}

fn git_commit_from(workspace: &Path, message: &str) -> Result<(), String> {
    let root = git_repository_root(workspace)?;
    let message = message.trim();
    if message.is_empty() {
        return Err("Commit message cannot be empty".to_owned());
    }
    if message.len() > MAX_GIT_COMMIT_MESSAGE_BYTES {
        return Err(format!(
            "Commit message is too large (maximum {MAX_GIT_COMMIT_MESSAGE_BYTES} bytes)"
        ));
    }
    git_output(&root, &["commit", "--no-gpg-sign", "-m", message]).map(|_| ())
}

fn git_push_from(workspace: &Path) -> Result<(), String> {
    let root = git_repository_root(workspace)?;
    let snapshot = git_status_from(&root)?;
    if snapshot.detached || snapshot.branch == "HEAD" {
        return Err("Cannot push while HEAD is detached".to_owned());
    }
    let upstream = git_output_raw(
        &root,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )?;
    if upstream.status.success() {
        return git_output(&root, &["push"]).map(|_| ());
    }
    let remote = if snapshot.remotes.iter().any(|remote| remote == "origin") {
        "origin".to_owned()
    } else if snapshot.remotes.len() == 1 {
        snapshot.remotes[0].clone()
    } else if snapshot.remotes.is_empty() {
        return Err("No Git remote is configured for this repository".to_owned());
    } else {
        return Err("This branch has no upstream; configure one before pushing".to_owned());
    };
    git_output(&root, &["push", "-u", &remote, &snapshot.branch]).map(|_| ())
}

fn git_switch_branch_from(workspace: &Path, branch: &str, create: bool) -> Result<(), String> {
    let root = git_repository_root(workspace)?;
    let branch = branch.trim();
    if branch.is_empty() {
        return Err("Branch name cannot be empty".to_owned());
    }
    git_output(&root, &["check-ref-format", "--branch", branch])?;
    if create {
        git_output(&root, &["switch", "-c", branch]).map(|_| ())
    } else {
        git_output(&root, &["switch", branch]).map(|_| ())
    }
}

fn launch_external_editor(editor: &str, target: &Path) -> Result<(), String> {
    let editor = editor.trim();
    if editor.is_empty() {
        return Err("external editor cannot be empty".to_owned());
    }

    #[cfg(target_os = "macos")]
    if let Some(app_name) = macos_editor_app_name(editor) {
        let status = Command::new("open")
            .arg("-a")
            .arg(app_name)
            .arg(target)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| {
                format!("failed to open {} in {app_name}: {error}", target.display())
            })?;
        return status
            .success()
            .then_some(())
            .ok_or_else(|| format!("{app_name} could not open {}", target.display()));
    }

    let executable = external_editor_executable(editor);
    Command::new(executable)
        .arg(target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("failed to open {} with {editor}: {error}", target.display()))
}

#[cfg(target_os = "macos")]
fn macos_editor_app_name(editor: &str) -> Option<&'static str> {
    match editor.to_ascii_lowercase().as_str() {
        "zed" => Some("Zed"),
        "code" | "vscode" | "visual studio code" => Some("Visual Studio Code"),
        "cursor" => Some("Cursor"),
        "subl" | "sublime" | "sublime text" => Some("Sublime Text"),
        "idea" | "intellij" | "intellij idea" => Some("IntelliJ IDEA"),
        "webstorm" => Some("WebStorm"),
        _ => None,
    }
}

fn external_editor_executable(editor: &str) -> &str {
    match editor.to_ascii_lowercase().as_str() {
        "vscode" | "visual studio code" => "code",
        "sublime" | "sublime text" => "subl",
        "intellij" | "intellij idea" => "idea",
        _ => editor,
    }
}

fn read_home_file_from(
    home: &Path,
    home_path: &Path,
    max_bytes: u64,
) -> Result<ProjectFilePreview, String> {
    let (root, file_path) = resolve_home_file_path(home, home_path)?;
    let relative = file_path
        .strip_prefix(&root)
        .map_err(|_| "home file path resolves outside the home directory".to_owned())?;
    let display_path = format!("~/{}", relative.to_string_lossy().replace('\\', "/"));
    read_text_file_from(&file_path, display_path, max_bytes)
}

fn read_text_file_from(
    file_path: &Path,
    display_path: String,
    max_bytes: u64,
) -> Result<ProjectFilePreview, String> {
    let metadata = fs::metadata(file_path)
        .map_err(|error| format!("failed to inspect {}: {error}", file_path.display()))?;
    if metadata.len() > max_bytes {
        return Err(format!(
            "{} is too large to preview (maximum {} MB)",
            display_path,
            max_bytes / 1024 / 1024,
        ));
    }

    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    fs::File::open(file_path)
        .map_err(|error| format!("failed to open {}: {error}", file_path.display()))?
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read {}: {error}", file_path.display()))?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!("{display_path} grew beyond the preview limit"));
    }
    let content =
        String::from_utf8(bytes).map_err(|_| format!("{display_path} is not a UTF-8 text file"))?;

    Ok(ProjectFilePreview {
        path: display_path,
        content,
    })
}

fn resolve_home_file_path(home: &Path, home_path: &Path) -> Result<(PathBuf, PathBuf), String> {
    let mut components = home_path.components();
    if !matches!(components.next(), Some(Component::Normal(value)) if value == "~") {
        return Err("home file path must start with ~/".to_owned());
    }

    let relative_path = components.as_path();
    if relative_path.as_os_str().is_empty()
        || relative_path.is_absolute()
        || relative_path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("home file path must stay inside the home directory".to_owned());
    }

    let root = fs::canonicalize(home).map_err(|error| {
        format!(
            "failed to resolve home directory {}: {error}",
            home.display()
        )
    })?;
    if !root.is_dir() {
        return Err(format!("{} is not a home directory", root.display()));
    }

    let file_path = fs::canonicalize(root.join(relative_path)).map_err(|error| {
        format!(
            "failed to resolve home file {}: {error}",
            home_path.display()
        )
    })?;
    if !file_path.starts_with(&root) {
        return Err("home file path resolves outside the home directory".to_owned());
    }

    let metadata = fs::metadata(&file_path)
        .map_err(|error| format!("failed to inspect {}: {error}", file_path.display()))?;
    if !metadata.is_file() {
        return Err(format!("{} is not a file", home_path.display()));
    }
    Ok((root, file_path))
}

fn resolve_project_file_path(
    workspace: &Path,
    relative_path: &Path,
) -> Result<(PathBuf, PathBuf), String> {
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
    Ok((root, file_path))
}

fn is_supported_project_media(path: &Path) -> bool {
    let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
        return false;
    };
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "avif"
            | "bmp"
            | "gif"
            | "jpeg"
            | "jpg"
            | "png"
            | "svg"
            | "webp"
            | "m4v"
            | "mov"
            | "mp4"
            | "ogv"
            | "webm"
    )
}

#[tauri::command]
async fn read_project_tasks(workspace: String) -> Result<ProjectTaskDocument, String> {
    run_blocking(move || read_project_tasks_from(Path::new(&workspace), MAX_TASK_DOCUMENT_BYTES))
        .await
}

#[tauri::command]
async fn write_project_tasks(
    workspace: String,
    document: ProjectTaskDocument,
) -> Result<(), String> {
    run_blocking(move || write_project_tasks_to(Path::new(&workspace), &document)).await
}

fn read_project_tasks_from(
    workspace: &Path,
    max_bytes: u64,
) -> Result<ProjectTaskDocument, String> {
    let root = canonical_workspace(workspace)?;
    let directory = root.join(".pi");
    if !directory.exists() {
        return Ok(empty_task_document());
    }
    let directory = canonical_project_directory(&root, &directory)?;
    let path = directory.join("tasks.jsonc");
    if path.exists() {
        return read_task_document_path(&root, &path, max_bytes, true);
    }

    // One-time migration from the original strict-JSON desktop task file.
    let legacy = directory.join("tasks.json");
    if legacy.exists() {
        let mut document = read_task_document_path(&root, &legacy, max_bytes, false)?;
        document.schema = Some(PROJECT_TASKS_SCHEMA_URL.to_owned());
        write_project_tasks_to(workspace, &document)?;
        fs::remove_file(&legacy)
            .map_err(|error| format!("failed to remove migrated .pi/tasks.json: {error}"))?;
        return Ok(document);
    }

    Ok(empty_task_document())
}

fn read_task_document_path(
    root: &Path,
    path: &Path,
    max_bytes: u64,
    jsonc: bool,
) -> Result<ProjectTaskDocument, String> {
    let canonical = fs::canonicalize(&path)
        .map_err(|error| format!("failed to resolve {}: {error}", path.display()))?;
    if !canonical.starts_with(&root) {
        return Err(format!(
            "{} resolves outside the workspace",
            task_file_label(jsonc)
        ));
    }
    let metadata = fs::metadata(&canonical)
        .map_err(|error| format!("failed to inspect {}: {error}", canonical.display()))?;
    if !metadata.is_file() {
        return Err(format!("{} is not a file", task_file_label(jsonc)));
    }
    if metadata.len() > max_bytes {
        return Err(format!(
            "{} is too large (maximum 1 MB)",
            task_file_label(jsonc)
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    fs::File::open(&canonical)
        .map_err(|error| format!("failed to open {}: {error}", task_file_label(jsonc)))?
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read {}: {error}", task_file_label(jsonc)))?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!(
            "{} grew beyond the 1 MB limit",
            task_file_label(jsonc)
        ));
    }
    let mut document: ProjectTaskDocument = if jsonc {
        let source = std::str::from_utf8(&bytes)
            .map_err(|error| format!("invalid .pi/tasks.jsonc UTF-8: {error}"))?;
        let normalized = normalize_jsonc(source)?;
        serde_json::from_str(&normalized)
            .map_err(|error| format!("invalid .pi/tasks.jsonc: {error}"))?
    } else {
        serde_json::from_slice(&bytes)
            .map_err(|error| format!("invalid .pi/tasks.json: {error}"))?
    };
    if document.schema.is_none() {
        document.schema = Some(PROJECT_TASKS_SCHEMA_URL.to_owned());
    }
    validate_task_document(&document)?;
    Ok(document)
}

fn task_file_label(jsonc: bool) -> &'static str {
    if jsonc {
        ".pi/tasks.jsonc"
    } else {
        ".pi/tasks.json"
    }
}

fn normalize_jsonc(source: &str) -> Result<String, String> {
    let bytes = source.as_bytes();
    let mut output = bytes.to_vec();
    let mut index = 0usize;
    let mut in_string = false;
    let mut escaped = false;

    // Replace comments with spaces while preserving line breaks and byte offsets.
    while index < bytes.len() {
        let byte = bytes[index];
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        if byte == b'"' {
            in_string = true;
            index += 1;
            continue;
        }
        if byte == b'/' && index + 1 < bytes.len() && bytes[index + 1] == b'/' {
            output[index] = b' ';
            output[index + 1] = b' ';
            index += 2;
            while index < bytes.len() && bytes[index] != b'\n' && bytes[index] != b'\r' {
                output[index] = b' ';
                index += 1;
            }
            continue;
        }
        if byte == b'/' && index + 1 < bytes.len() && bytes[index + 1] == b'*' {
            output[index] = b' ';
            output[index + 1] = b' ';
            index += 2;
            let mut closed = false;
            while index < bytes.len() {
                if index + 1 < bytes.len() && bytes[index] == b'*' && bytes[index + 1] == b'/' {
                    output[index] = b' ';
                    output[index + 1] = b' ';
                    index += 2;
                    closed = true;
                    break;
                }
                if bytes[index] != b'\n' && bytes[index] != b'\r' {
                    output[index] = b' ';
                }
                index += 1;
            }
            if !closed {
                return Err("invalid .pi/tasks.jsonc: unterminated block comment".to_owned());
            }
            continue;
        }
        index += 1;
    }

    // JSONC permits trailing commas; blank only commas followed by ] or }.
    index = 0;
    in_string = false;
    escaped = false;
    while index < output.len() {
        let byte = output[index];
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        if byte == b'"' {
            in_string = true;
            index += 1;
            continue;
        }
        if byte == b',' {
            let mut next = index + 1;
            while next < output.len() && output[next].is_ascii_whitespace() {
                next += 1;
            }
            if next < output.len() && (output[next] == b']' || output[next] == b'}') {
                output[index] = b' ';
            }
        }
        index += 1;
    }

    String::from_utf8(output).map_err(|error| format!("invalid .pi/tasks.jsonc UTF-8: {error}"))
}

fn write_project_tasks_to(workspace: &Path, document: &ProjectTaskDocument) -> Result<(), String> {
    validate_task_document(document)?;
    let root = canonical_workspace(workspace)?;
    let directory_path = root.join(".pi");
    if !directory_path.exists() {
        fs::create_dir(&directory_path)
            .map_err(|error| format!("failed to create {}: {error}", directory_path.display()))?;
    }
    let directory = canonical_project_directory(&root, &directory_path)?;
    let target = directory.join("tasks.jsonc");
    if target.exists() {
        let canonical = fs::canonicalize(&target)
            .map_err(|error| format!("failed to resolve {}: {error}", target.display()))?;
        if !canonical.starts_with(&root) {
            return Err(".pi/tasks.jsonc resolves outside the workspace".to_owned());
        }
        if !fs::metadata(&canonical)
            .map_err(|error| format!("failed to inspect {}: {error}", canonical.display()))?
            .is_file()
        {
            return Err(".pi/tasks.jsonc is not a file".to_owned());
        }
    }

    let mut document = document.clone();
    document.schema = Some(PROJECT_TASKS_SCHEMA_URL.to_owned());
    let mut serialized = serde_json::to_vec_pretty(&document)
        .map_err(|error| format!("failed to encode .pi/tasks.jsonc: {error}"))?;
    serialized.push(b'\n');
    if serialized.len() as u64 > MAX_TASK_DOCUMENT_BYTES {
        return Err(".pi/tasks.jsonc is too large (maximum 1 MB)".to_owned());
    }

    let sequence = TASK_WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = directory.join(format!(
        ".tasks.jsonc.{}.{}.tmp",
        std::process::id(),
        sequence,
    ));
    let write_result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("failed to create task document temporary file: {error}"))?;
        file.write_all(&serialized)
            .map_err(|error| format!("failed to write task document: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("failed to flush task document: {error}"))?;
        replace_task_file(&temporary, &target)?;
        sync_directory(&directory)?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

fn canonical_workspace(workspace: &Path) -> Result<PathBuf, String> {
    let root = fs::canonicalize(workspace).map_err(|error| {
        format!(
            "failed to resolve workspace {}: {error}",
            workspace.display()
        )
    })?;
    if root.is_dir() {
        Ok(root)
    } else {
        Err(format!("{} is not a workspace directory", root.display()))
    }
}

fn canonical_project_directory(root: &Path, directory: &Path) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(directory)
        .map_err(|error| format!("failed to resolve {}: {error}", directory.display()))?;
    if !canonical.starts_with(root) {
        return Err(".pi resolves outside the workspace".to_owned());
    }
    if !canonical.is_dir() {
        return Err(".pi is not a directory".to_owned());
    }
    Ok(canonical)
}

fn empty_task_document() -> ProjectTaskDocument {
    ProjectTaskDocument {
        schema: Some(PROJECT_TASKS_SCHEMA_URL.to_owned()),
        version: 1,
        tasks: Vec::new(),
    }
}

fn validate_task_document(document: &ProjectTaskDocument) -> Result<(), String> {
    if document.version != 1 {
        return Err(format!(
            "unsupported .pi/tasks.jsonc version {}",
            document.version
        ));
    }
    if document.tasks.len() > 10_000 {
        return Err(".pi/tasks.jsonc contains too many tasks".to_owned());
    }
    let mut ids = HashSet::new();
    for task in &document.tasks {
        if task.id.trim().is_empty() || task.id.chars().count() > 128 {
            return Err("task id must contain 1 to 128 characters".to_owned());
        }
        if !ids.insert(task.id.as_str()) {
            return Err(format!("duplicate task id: {}", task.id));
        }
        if task.title.trim().is_empty() || task.title.chars().count() > 200 {
            return Err(format!("task {} has an invalid title", task.id));
        }
        if task
            .description
            .as_ref()
            .is_some_and(|value| value.chars().count() > 10_000)
        {
            return Err(format!("task {} description is too long", task.id));
        }
        if task
            .session_id
            .as_ref()
            .is_some_and(|value| value.trim().is_empty() || value.chars().count() > 512)
        {
            return Err(format!("task {} has an invalid session id", task.id));
        }
        let created = DateTime::parse_from_rfc3339(&task.created_at)
            .map_err(|_| format!("task {} has an invalid createdAt", task.id))?;
        let updated = DateTime::parse_from_rfc3339(&task.updated_at)
            .map_err(|_| format!("task {} has an invalid updatedAt", task.id))?;
        if updated < created {
            return Err(format!("task {} updatedAt precedes createdAt", task.id));
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_task_file(temporary: &Path, target: &Path) -> Result<(), String> {
    fs::rename(temporary, target)
        .map_err(|error| format!("failed to replace .pi/tasks.jsonc: {error}"))
}

#[cfg(windows)]
fn replace_task_file(temporary: &Path, target: &Path) -> Result<(), String> {
    if !target.exists() {
        return fs::rename(temporary, target)
            .map_err(|error| format!("failed to install .pi/tasks.jsonc: {error}"));
    }
    let backup = target.with_extension("jsonc.bak");
    let _ = fs::remove_file(&backup);
    fs::rename(target, &backup)
        .map_err(|error| format!("failed to prepare .pi/tasks.jsonc replacement: {error}"))?;
    if let Err(error) = fs::rename(temporary, target) {
        let _ = fs::rename(&backup, target);
        return Err(format!("failed to replace .pi/tasks.jsonc: {error}"));
    }
    let _ = fs::remove_file(backup);
    Ok(())
}

#[cfg(unix)]
fn sync_directory(directory: &Path) -> Result<(), String> {
    fs::File::open(directory)
        .and_then(|file| file.sync_all())
        .map_err(|error| format!("failed to flush task document directory: {error}"))
}

#[cfg(not(unix))]
fn sync_directory(_directory: &Path) -> Result<(), String> {
    Ok(())
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
async fn acp_start(app: AppHandle, window_label: String) -> Result<u64, String> {
    run_blocking(move || start_process(app, window_label)).await
}

fn start_process(app: AppHandle, window_label: String) -> Result<u64, String> {
    let state = app.state::<AcpProcessState>();
    let mut slots = state
        .slots
        .lock()
        .map_err(|_| "ACP process state is poisoned".to_owned())?;
    let slot = slots.entry(window_label.clone()).or_default();
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

    let question_extension = env::var_os("PIX_ACP_QUESTION_EXTENSION")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../dist/bundled-extensions/question/index.js")
        });
    if !question_extension.is_file() {
        return Err(format!(
            "Pix question extension not found at {} (run `npm run build:pix` first or set PIX_ACP_QUESTION_EXTENSION)",
            question_extension.display()
        ));
    }

    let mut child = Command::new(&node)
        .arg(&entry)
        .env("PIX_ACP_QUESTION_EXTENSION", &question_extension)
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
    let (stdin_tx, stdin_rx) = mpsc::channel();
    forward_stdin(stdin, stdin_rx);

    let generation = state
        .next_generation
        .fetch_add(1, Ordering::AcqRel)
        .wrapping_add(1);
    let (stop_tx, stop_rx) = mpsc::channel();
    let exited = Arc::new((Mutex::new(false), Condvar::new()));
    slot.running = Some(RunningProcess {
        generation,
        stdin_tx: Some(stdin_tx),
        stop_tx,
        exited: exited.clone(),
    });
    drop(slots);

    forward_lines(
        stdout,
        app.clone(),
        window_label.clone(),
        "acp://stdout",
        generation,
    );
    forward_lines(
        stderr,
        app.clone(),
        window_label.clone(),
        "acp://stderr",
        generation,
    );
    thread::spawn(move || supervise_child(child, stop_rx, app, window_label, generation, exited));
    Ok(generation)
}

#[tauri::command]
async fn acp_send(
    app: AppHandle,
    window_label: String,
    generation: u64,
    line: String,
) -> Result<(), String> {
    if line.contains('\r') || line.contains('\n') {
        return Err("ACP payload must be one newline-free JSON object".to_owned());
    }
    let stdin_tx = {
        let state = app.state::<AcpProcessState>();
        let slots = state
            .slots
            .lock()
            .map_err(|_| "ACP process state is poisoned".to_owned())?;
        let slot = slots
            .get(&window_label)
            .ok_or_else(|| format!("pix-acp is not running for window {window_label}"))?;
        let running = slot
            .running
            .as_ref()
            .ok_or_else(|| "pix-acp is not running".to_owned())?;
        if running.generation != generation {
            return Err(format!(
                "stale pix-acp generation {generation}; current generation is {}",
                running.generation
            ));
        }
        running
            .stdin_tx
            .as_ref()
            .cloned()
            .ok_or_else(|| "pix-acp stdin is closed".to_owned())?
    };
    let (ack_tx, ack_rx) = mpsc::sync_channel(1);
    stdin_tx
        .send(StdinCommand::Write { line, ack: ack_tx })
        .map_err(|_| "pix-acp stdin writer is closed".to_owned())?;
    run_blocking(move || {
        ack_rx
            .recv()
            .map_err(|_| "pix-acp stdin writer stopped before acknowledging the write".to_owned())?
    })
    .await
}

fn validate_json_object(line: &str) -> Result<(), String> {
    struct ObjectVisitor;

    impl<'de> Visitor<'de> for ObjectVisitor {
        type Value = ();

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("a JSON object")
        }

        fn visit_map<M>(self, mut map: M) -> Result<Self::Value, M::Error>
        where
            M: MapAccess<'de>,
        {
            while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
            Ok(())
        }
    }

    let mut deserializer = serde_json::Deserializer::from_str(line);
    serde::de::Deserializer::deserialize_map(&mut deserializer, ObjectVisitor)
        .and_then(|()| deserializer.end())
        .map_err(|error| format!("ACP payload is not a valid JSON object: {error}"))
}

#[tauri::command]
async fn acp_stop(app: AppHandle, window_label: String, generation: u64) -> Result<(), String> {
    run_blocking(move || {
        let state = app.state::<AcpProcessState>();
        stop_process(&state, &window_label, Some(generation))
    })
    .await
}

fn stop_process(
    state: &AcpProcessState,
    window_label: &str,
    expected_generation: Option<u64>,
) -> Result<(), String> {
    let process = {
        let mut slots = state
            .slots
            .lock()
            .map_err(|_| "ACP process state is poisoned".to_owned())?;
        let Some(slot) = slots.get_mut(window_label) else {
            return Ok(());
        };
        slot.running.as_mut().and_then(|running| {
            if expected_generation.is_some_and(|expected| expected != running.generation) {
                return None;
            }
            // Closing stdin lets pix-acp finish its ACP connection and
            // dispose every nested pi RPC process before we use signals.
            Some((
                running.stdin_tx.take(),
                running.stop_tx.clone(),
                running.exited.clone(),
            ))
        })
    };
    let Some((stdin_tx, stop_tx, exited)) = process else {
        return Ok(());
    };

    if let Some(stdin_tx) = stdin_tx {
        let _ = stdin_tx.send(StdinCommand::Close);
    }
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

fn forward_stdin(mut stdin: ChildStdin, receiver: mpsc::Receiver<StdinCommand>) {
    thread::spawn(move || {
        for command in receiver {
            match command {
                StdinCommand::Write { line, ack } => {
                    let result = validate_json_object(&line).and_then(|()| {
                        stdin
                            .write_all(line.as_bytes())
                            .and_then(|_| stdin.write_all(b"\n"))
                            .and_then(|_| stdin.flush())
                            .map_err(|error| format!("failed to write to pix-acp: {error}"))
                    });
                    let failed = result.is_err();
                    let _ = ack.send(result);
                    if failed {
                        break;
                    }
                }
                StdinCommand::Close => break,
            }
        }
    });
}

fn forward_lines<R>(
    reader: R,
    app: AppHandle,
    window_label: String,
    event: &'static str,
    generation: u64,
) where
    R: Read + Send + 'static,
{
    let (line_tx, line_rx) = mpsc::channel();
    let error_app = app.clone();
    let error_window_label = window_label.clone();
    thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            match line {
                Ok(line) => {
                    if line_tx.send(line).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    let _ = error_app.emit_to(
                        &error_window_label,
                        "acp://stderr",
                        LinesPayload {
                            window_label: error_window_label.clone(),
                            generation,
                            lines: vec![format!("failed to read {event}: {error}")],
                        },
                    );
                    break;
                }
            }
        }
    });
    thread::spawn(move || batch_forwarded_lines(line_rx, app, window_label, event, generation));
}

fn batch_forwarded_lines(
    receiver: mpsc::Receiver<String>,
    app: AppHandle,
    window_label: String,
    event: &'static str,
    generation: u64,
) {
    while let Ok(first) = receiver.recv() {
        let mut lines = Vec::with_capacity(ACP_EVENT_BATCH_MAX_LINES);
        lines.push(first);
        let deadline = Instant::now() + ACP_EVENT_BATCH_LATENCY;
        let mut disconnected = false;
        while lines.len() < ACP_EVENT_BATCH_MAX_LINES {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match receiver.recv_timeout(remaining) {
                Ok(line) => lines.push(line),
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    disconnected = true;
                    break;
                }
            }
        }
        let _ = app.emit_to(
            &window_label,
            event,
            LinesPayload {
                window_label: window_label.clone(),
                generation,
                lines,
            },
        );
        if disconnected {
            break;
        }
    }
}

fn supervise_child(
    mut child: Child,
    stop_rx: mpsc::Receiver<()>,
    app: AppHandle,
    window_label: String,
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

    clear_generation(&app, &window_label, generation);
    let payload = exit_payload(window_label.clone(), generation, status, requested, error);
    let _ = app.emit_to(&window_label, "acp://exit", payload);
    let (lock, wake) = &*exited;
    if let Ok(mut exited) = lock.lock() {
        *exited = true;
        wake.notify_all();
    }
}

fn clear_generation(app: &AppHandle, window_label: &str, generation: u64) {
    let state = app.state::<AcpProcessState>();
    if let Ok(mut slots) = state.slots.lock() {
        if let Some(slot) = slots.get_mut(window_label) {
            if slot.running.as_ref().map(|process| process.generation) == Some(generation) {
                slot.running = None;
            }
        }
    };
}

fn remove_process_slot(state: &AcpProcessState, window_label: &str) {
    if let Ok(mut slots) = state.slots.lock() {
        slots.remove(window_label);
    }
}

fn exit_payload(
    window_label: String,
    generation: u64,
    status: Option<ExitStatus>,
    requested: bool,
    error: Option<String>,
) -> ExitPayload {
    ExitPayload {
        window_label,
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
            app.manage(AttachmentPathState::new(app.handle()));
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
            cache_task_attachment,
            open_attachment,
            open_local_file,
            read_project_file,
            list_project_directory,
            open_in_external_editor,
            git_status,
            git_diff,
            git_stage,
            git_unstage,
            git_commit,
            git_push,
            git_switch_branch,
            git_create_branch,
            list_project_documents,
            write_project_markdown,
            read_home_file,
            resolve_project_media,
            resolve_home_media,
            resolve_local_media,
            read_project_tasks,
            write_project_tasks,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Pix Desktop");
    app.run(|handle, event| {
        if let tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Destroyed,
            ..
        } = &event
        {
            let handle = handle.clone();
            let window_label = label.clone();
            thread::spawn(move || {
                let state = handle.state::<AcpProcessState>();
                if let Err(error) = stop_process(&state, &window_label, None) {
                    eprintln!("failed to stop pix-acp for closed window {window_label}: {error}");
                }
                remove_process_slot(&state, &window_label);
            });
        }
        if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
            let state = handle.state::<AcpProcessState>();
            if !state.exiting.swap(true, Ordering::AcqRel) {
                api.prevent_exit();
                let handle = handle.clone();
                thread::spawn(move || {
                    let state = handle.state::<AcpProcessState>();
                    let window_labels = state
                        .slots
                        .lock()
                        .map(|slots| slots.keys().cloned().collect::<Vec<_>>())
                        .unwrap_or_default();
                    for window_label in window_labels {
                        if let Err(error) = stop_process(&state, &window_label, None) {
                            eprintln!(
                                "failed to stop pix-acp for window {window_label} during exit: {error}"
                            );
                        }
                    }
                    handle.exit(code.unwrap_or(0));
                });
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_acp_payloads_without_materializing_the_json_object() {
        assert!(
            validate_json_object(r#"{"jsonrpc":"2.0","id":1,"params":{"blob":"abc"}}"#).is_ok()
        );
        assert!(validate_json_object("[]").is_err());
        assert!(validate_json_object("null").is_err());
        assert!(validate_json_object(r#"{"jsonrpc":"2.0"} trailing"#).is_err());
    }

    #[test]
    fn acp_event_payloads_include_the_owning_window_label() {
        let lines = serde_json::to_value(LinesPayload {
            window_label: "project-one".to_owned(),
            generation: 7,
            lines: vec!["message".to_owned()],
        })
        .expect("serialize lines payload");
        let exit =
            serde_json::to_value(exit_payload("project-two".to_owned(), 8, None, true, None))
                .expect("serialize exit payload");

        assert_eq!(lines["windowLabel"], "project-one");
        assert_eq!(lines["generation"], 7);
        assert_eq!(exit["windowLabel"], "project-two");
        assert_eq!(exit["generation"], 8);
    }

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
    fn lists_and_edits_project_markdown_documents() {
        let workspace = temporary_workspace("project-documents");
        fs::create_dir_all(workspace.join(".pi/plans/releases")).expect("create plans directory");
        fs::write(workspace.join(".pi/plans/alpha.md"), "# Alpha\n").expect("write plan");
        fs::write(workspace.join(".pi/plans/releases/v2.md"), "# V2\n").expect("write nested plan");
        fs::write(workspace.join(".pi/plans/notes.txt"), "ignore\n")
            .expect("write non-markdown plan");

        let before = list_project_documents_from(&workspace).expect("list project documents");
        assert_eq!(
            before.plans,
            vec![
                ".pi/plans/alpha.md".to_owned(),
                ".pi/plans/releases/v2.md".to_owned(),
            ]
        );
        assert!(!before.todo_exists);

        let todo = write_project_markdown_from(
            &workspace,
            Path::new(".pi/TODO.md"),
            "# TODO\n- [ ] Ship\n",
        )
        .expect("write TODO");
        assert_eq!(todo.path, ".pi/TODO.md");
        assert!(todo.content.contains("Ship"));

        let plan = write_project_markdown_from(
            &workspace,
            Path::new(".pi/plans/releases/v2.md"),
            "# V2\nUpdated\n",
        )
        .expect("update plan");
        assert!(plan.content.contains("Updated"));

        let after = list_project_documents_from(&workspace).expect("list project documents again");
        assert!(after.todo_exists);
        assert!(write_project_markdown_from(&workspace, Path::new("README.md"), "nope").is_err());
        assert!(write_project_markdown_from(
            &workspace,
            Path::new(".pi/plans/../secret.md"),
            "nope"
        )
        .is_err());
        fs::remove_dir_all(workspace).expect("remove temporary workspace");
    }

    #[test]
    fn lists_project_directories_lazily_with_directories_first() {
        let workspace = temporary_workspace("project-tree");
        fs::create_dir_all(workspace.join("src/components")).expect("create source directories");
        fs::write(workspace.join("README.md"), "# Demo\n").expect("write README");
        fs::write(workspace.join("src/main.ts"), "export {};\n").expect("write main source");
        fs::create_dir(workspace.join(".git")).expect("create git directory");

        let root = list_project_directory_from(&workspace, None).expect("list project root");
        assert_eq!(
            root.iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            vec!["src", "README.md"]
        );
        assert!(matches!(root[0].kind, ProjectTreeEntryKind::Directory));
        assert!(matches!(root[1].kind, ProjectTreeEntryKind::File));

        let src =
            list_project_directory_from(&workspace, Some(Path::new("src"))).expect("list src");
        assert_eq!(
            src.iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            vec!["src/components", "src/main.ts"]
        );
        assert!(list_project_directory_from(&workspace, Some(Path::new("../outside"))).is_err());
        fs::remove_dir_all(workspace).expect("remove temporary workspace");
    }

    #[test]
    fn resolves_external_editor_targets_only_inside_the_workspace() {
        let workspace = temporary_workspace("external-editor-target");
        fs::create_dir(workspace.join("src")).expect("create src directory");
        fs::write(workspace.join("src/main.ts"), "export {};\n").expect("write source");

        assert_eq!(
            resolve_external_editor_target(&workspace, None).expect("resolve root"),
            fs::canonicalize(&workspace).expect("canonical workspace"),
        );
        assert_eq!(
            resolve_external_editor_target(&workspace, Some(Path::new("src/main.ts")))
                .expect("resolve file"),
            fs::canonicalize(workspace.join("src/main.ts")).expect("canonical file"),
        );
        assert!(resolve_external_editor_target(&workspace, Some(Path::new("../outside"))).is_err());
        fs::remove_dir_all(workspace).expect("remove temporary workspace");
    }

    #[cfg(unix)]
    #[test]
    fn project_tree_skips_symbolic_links() {
        use std::os::unix::fs::symlink;

        let workspace = temporary_workspace("project-tree-symlink-workspace");
        let outside = temporary_workspace("project-tree-symlink-outside");
        fs::write(outside.join("secret.txt"), "secret\n").expect("write outside file");
        symlink(
            outside.join("secret.txt"),
            workspace.join("secret-link.txt"),
        )
        .expect("create file symlink");

        let entries = list_project_directory_from(&workspace, None).expect("list project root");
        assert!(entries.iter().all(|entry| entry.name != "secret-link.txt"));
        assert!(
            resolve_external_editor_target(&workspace, Some(Path::new("secret-link.txt"))).is_err()
        );
        fs::remove_dir_all(workspace).expect("remove temporary workspace");
        fs::remove_dir_all(outside).expect("remove outside workspace");
    }

    fn initialize_git_repository(workspace: &Path) {
        git_output_raw(workspace, &["init", "-b", "main"])
            .expect("run git init")
            .status
            .success()
            .then_some(())
            .expect("git init succeeds");
        git_output(
            workspace,
            &["config", "user.email", "pix-tests@example.invalid"],
        )
        .expect("configure git email");
        git_output(workspace, &["config", "user.name", "Pix Tests"]).expect("configure git name");
        fs::write(workspace.join("tracked.txt"), "before\n").expect("write tracked file");
        git_output(workspace, &["add", "tracked.txt"]).expect("stage initial file");
        git_output(workspace, &["commit", "--no-gpg-sign", "-m", "initial"])
            .expect("create initial commit");
    }

    #[test]
    fn git_status_diff_stage_and_unstage_are_workspace_scoped() {
        let workspace = temporary_workspace("git-source-control");
        initialize_git_repository(&workspace);
        fs::write(workspace.join("tracked.txt"), "after\n").expect("modify tracked file");
        fs::write(workspace.join("new.txt"), "new\n").expect("write untracked file");

        let before = git_status_from(&workspace).expect("read git status");
        assert_eq!(before.branch, "main");
        assert!(!before.detached);
        assert!(before
            .changes
            .iter()
            .any(|change| { change.path == "tracked.txt" && change.unstaged && !change.staged }));
        assert!(before
            .changes
            .iter()
            .any(|change| change.path == "new.txt" && change.untracked));

        let working = git_diff_from(&workspace, Some("tracked.txt"), GitDiffScope::Unstaged)
            .expect("read working diff");
        assert!(working.content.contains("-before"));
        assert!(working.content.contains("+after"));

        git_stage_from(&workspace, Some("tracked.txt")).expect("stage tracked file");
        let staged = git_status_from(&workspace).expect("read staged status");
        assert!(staged
            .changes
            .iter()
            .any(|change| { change.path == "tracked.txt" && change.staged && !change.unstaged }));
        let staged_diff = git_diff_from(&workspace, Some("tracked.txt"), GitDiffScope::Staged)
            .expect("read staged diff");
        assert!(staged_diff.content.contains("+after"));

        git_unstage_from(&workspace, Some("tracked.txt")).expect("unstage tracked file");
        let unstaged = git_status_from(&workspace).expect("read unstaged status");
        assert!(unstaged
            .changes
            .iter()
            .any(|change| { change.path == "tracked.txt" && !change.staged && change.unstaged }));
        assert!(git_stage_from(&workspace, Some("../outside")).is_err());

        fs::remove_dir_all(workspace).expect("remove temporary workspace");
    }

    #[test]
    fn untracked_git_diff_preserves_workspace_path_inside_file_content() {
        let workspace = temporary_workspace("git-untracked-diff-content");
        initialize_git_repository(&workspace);
        let workspace_text = workspace.to_string_lossy().into_owned();
        fs::write(
            workspace.join("new.txt"),
            format!("workspace marker: {workspace_text}\n"),
        )
        .expect("write untracked file with workspace path");

        let diff = git_diff_from(&workspace, Some("new.txt"), GitDiffScope::Unstaged)
            .expect("read untracked diff");

        assert!(diff
            .content
            .contains(&format!("+workspace marker: {workspace_text}")));
        for line in diff.content.lines().filter(|line| {
            line.starts_with("diff --git ") || line.starts_with("--- ") || line.starts_with("+++ ")
        }) {
            assert!(
                !line.contains(&workspace_text),
                "diff header unexpectedly contains the absolute workspace path: {line}"
            );
        }

        fs::remove_dir_all(workspace).expect("remove temporary workspace");
    }

    #[test]
    fn git_source_control_rejects_a_parent_repository() {
        let repository = temporary_workspace("git-parent-repository");
        initialize_git_repository(&repository);
        let nested = repository.join("nested-project");
        fs::create_dir(&nested).expect("create nested project");

        let error = git_status_from(&nested).expect_err("nested project must be rejected");
        assert!(error.contains("repository root"));

        fs::remove_dir_all(repository).expect("remove parent repository");
    }

    #[test]
    fn git_branch_commit_and_publish_use_noninteractive_git_commands() {
        let workspace = temporary_workspace("git-branch-commit-push");
        let remote = temporary_workspace("git-bare-remote");
        initialize_git_repository(&workspace);
        let init_bare =
            git_output_raw(&remote, &["init", "--bare"]).expect("initialize bare remote");
        assert!(init_bare.status.success());
        let remote_path = remote.to_string_lossy().into_owned();
        git_output(&workspace, &["remote", "add", "origin", &remote_path]).expect("add origin");

        git_switch_branch_from(&workspace, "feature/source-control", true)
            .expect("create feature branch");
        assert_eq!(
            git_status_from(&workspace).expect("feature status").branch,
            "feature/source-control"
        );

        fs::write(workspace.join("tracked.txt"), "committed from feature\n")
            .expect("modify tracked file");
        git_stage_from(&workspace, Some("tracked.txt")).expect("stage feature change");
        git_commit_from(&workspace, "Update tracked file").expect("commit feature change");
        assert!(git_status_from(&workspace)
            .expect("clean feature status")
            .changes
            .is_empty());

        git_switch_branch_from(&workspace, "main", false).expect("switch back to main");
        git_push_from(&workspace).expect("publish main branch");
        let published = git_status_from(&workspace).expect("published status");
        assert_eq!(published.upstream.as_deref(), Some("origin/main"));

        fs::remove_dir_all(workspace).expect("remove temporary workspace");
        fs::remove_dir_all(remote).expect("remove bare remote");
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

    #[test]
    fn reads_home_relative_files_without_treating_them_as_project_paths() {
        let home = temporary_workspace("home-preview");
        fs::create_dir_all(home.join(".config/pi")).expect("create config directory");
        fs::write(home.join(".config/pi/pix.jsonc"), "{\n  // Pix config\n}\n")
            .expect("write config");

        let preview = read_home_file_from(&home, Path::new("~/.config/pi/pix.jsonc"), 1024)
            .expect("read home file");

        assert_eq!(preview.path, "~/.config/pi/pix.jsonc");
        assert_eq!(preview.content, "{\n  // Pix config\n}\n");
        assert!(read_home_file_from(&home, Path::new("~/../secret.txt"), 1024).is_err());
        assert!(read_home_file_from(&home, Path::new(".config/pi/pix.jsonc"), 1024).is_err());
        fs::remove_dir_all(home).expect("remove temporary home");
    }

    #[test]
    fn resolves_supported_project_media_and_rejects_invalid_paths() {
        let workspace = temporary_workspace("project-media");
        fs::create_dir(workspace.join("artifacts")).expect("create artifacts directory");
        fs::write(
            workspace.join("artifacts/result.png"),
            [0x89, b'P', b'N', b'G'],
        )
        .expect("write image");
        fs::write(workspace.join("artifacts/result.bin"), [0xff, 0xfe])
            .expect("write unsupported file");

        let media = resolve_project_media_from(&workspace, Path::new("artifacts/result.png"))
            .expect("resolve project media");

        assert_eq!(media.name, "result.png");
        assert_eq!(
            PathBuf::from(media.path),
            fs::canonicalize(workspace.join("artifacts/result.png")).expect("canonical media path")
        );
        assert!(resolve_project_media_from(&workspace, Path::new("artifacts/result.bin")).is_err());
        assert!(resolve_project_media_from(&workspace, Path::new("../outside.png")).is_err());
        fs::remove_dir_all(workspace).expect("remove temporary workspace");
    }

    #[test]
    fn resolves_supported_absolute_media_and_rejects_relative_or_unsupported_files() {
        let directory = temporary_workspace("local-media");
        let image_path = directory.join("result.png");
        let unsupported_path = directory.join("result.bin");
        fs::write(&image_path, [0x89, b'P', b'N', b'G']).expect("write local image");
        fs::write(&unsupported_path, [0xff, 0xfe]).expect("write unsupported local file");

        let media = resolve_local_media_from(&image_path).expect("resolve local media");

        assert_eq!(media.name, "result.png");
        assert_eq!(
            PathBuf::from(media.path),
            fs::canonicalize(&image_path).expect("canonical local media path")
        );
        assert!(resolve_local_media_from(Path::new("relative.png")).is_err());
        assert!(resolve_local_media_from(&unsupported_path).is_err());
        assert!(resolve_local_media_from(&directory.join("missing.png")).is_err());
        fs::remove_dir_all(directory).expect("remove temporary workspace");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_project_media_symlinks_outside_the_workspace() {
        use std::os::unix::fs::symlink;

        let workspace = temporary_workspace("project-media-symlink-workspace");
        let outside = temporary_workspace("project-media-symlink-outside");
        fs::write(outside.join("outside.png"), [0x89, b'P', b'N', b'G'])
            .expect("write outside image");
        symlink(outside.join("outside.png"), workspace.join("outside.png"))
            .expect("create media symlink");

        assert!(resolve_project_media_from(&workspace, Path::new("outside.png")).is_err());
        fs::remove_dir_all(workspace).expect("remove temporary workspace");
        fs::remove_dir_all(outside).expect("remove outside directory");
    }

    fn sample_task_document() -> ProjectTaskDocument {
        ProjectTaskDocument {
            schema: Some(PROJECT_TASKS_SCHEMA_URL.to_owned()),
            version: 1,
            tasks: vec![ProjectTask {
                id: "task-1".to_owned(),
                title: "Repair reconnect".to_owned(),
                description: Some("Keep the active workspace selected.".to_owned()),
                task_type: ProjectTaskType::Bug,
                status: ProjectTaskStatus::Todo,
                priority: ProjectTaskPriority::High,
                session_id: None,
                created_at: "2026-09-03T12:00:00.000Z".to_owned(),
                updated_at: "2026-09-03T12:00:00.000Z".to_owned(),
            }],
        }
    }

    #[test]
    fn reads_missing_task_document_as_empty_version_one() {
        let workspace = temporary_workspace("missing-tasks");
        let document = read_project_tasks_from(&workspace, 1024).expect("read missing tasks");
        assert_eq!(document, empty_task_document());
        fs::remove_dir_all(workspace).expect("remove temporary workspace");
    }

    #[test]
    fn writes_and_reads_a_valid_task_document() {
        let workspace = temporary_workspace("task-roundtrip");
        let expected = sample_task_document();
        write_project_tasks_to(&workspace, &expected).expect("write tasks");
        assert!(workspace.join(".pi/tasks.jsonc").is_file());
        assert!(!workspace.join(".pi/tasks.json").exists());
        let actual = read_project_tasks_from(&workspace, 1024 * 1024).expect("read tasks");
        assert_eq!(actual, expected);
        fs::remove_dir_all(workspace).expect("remove temporary workspace");
    }

    #[test]
    fn rejects_malformed_and_duplicate_task_documents() {
        let workspace = temporary_workspace("invalid-tasks");
        fs::create_dir(workspace.join(".pi")).expect("create .pi directory");
        fs::write(workspace.join(".pi/tasks.jsonc"), b"{").expect("write malformed task document");
        assert!(read_project_tasks_from(&workspace, 1024).is_err());

        let mut duplicate = sample_task_document();
        duplicate.tasks.push(duplicate.tasks[0].clone());
        assert!(write_project_tasks_to(&workspace, &duplicate).is_err());
        fs::remove_dir_all(workspace).expect("remove temporary workspace");
    }

    #[test]
    fn reads_jsonc_comments_and_trailing_commas() {
        let workspace = temporary_workspace("jsonc-tasks");
        fs::create_dir(workspace.join(".pi")).expect("create .pi directory");
        let source = r#"{
          // Project tasks may be hand-edited.
          "version": 1,
          "tasks": [
            {
              "id": "task-1",
              "title": "Repair reconnect",
              "type": "bug",
              "status": "todo",
              "priority": "high",
              "createdAt": "2026-09-03T12:00:00.000Z",
              "updatedAt": "2026-09-03T12:00:00.000Z",
            },
          ],
        }"#;
        fs::write(workspace.join(".pi/tasks.jsonc"), source).expect("write jsonc task document");
        let document = read_project_tasks_from(&workspace, 1024 * 1024).expect("read jsonc tasks");
        assert_eq!(document.tasks.len(), 1);
        assert_eq!(document.schema.as_deref(), Some(PROJECT_TASKS_SCHEMA_URL));
        fs::remove_dir_all(workspace).expect("remove temporary workspace");
    }

    #[test]
    fn migrates_legacy_tasks_json_to_jsonc_once() {
        let workspace = temporary_workspace("legacy-task-migration");
        fs::create_dir(workspace.join(".pi")).expect("create .pi directory");
        let mut legacy = sample_task_document();
        legacy.schema = None;
        fs::write(
            workspace.join(".pi/tasks.json"),
            serde_json::to_vec_pretty(&legacy).expect("encode legacy task document"),
        )
        .expect("write legacy task document");

        let document = read_project_tasks_from(&workspace, 1024 * 1024).expect("migrate tasks");
        assert_eq!(document.tasks, legacy.tasks);
        assert_eq!(document.schema.as_deref(), Some(PROJECT_TASKS_SCHEMA_URL));
        assert!(!workspace.join(".pi/tasks.json").exists());
        let migrated = workspace.join(".pi/tasks.jsonc");
        assert!(migrated.is_file());
        let migrated_text = fs::read_to_string(migrated).expect("read migrated task document");
        assert!(migrated_text.contains(PROJECT_TASKS_SCHEMA_URL));
        fs::remove_dir_all(workspace).expect("remove temporary workspace");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_task_directory_symlinks_outside_the_workspace() {
        use std::os::unix::fs::symlink;

        let workspace = temporary_workspace("task-symlink-workspace");
        let outside = temporary_workspace("task-symlink-outside");
        symlink(&outside, workspace.join(".pi")).expect("create .pi symlink");
        assert!(read_project_tasks_from(&workspace, 1024).is_err());
        assert!(write_project_tasks_to(&workspace, &sample_task_document()).is_err());
        fs::remove_dir_all(workspace).expect("remove temporary workspace");
        fs::remove_dir_all(outside).expect("remove outside directory");
    }
}
