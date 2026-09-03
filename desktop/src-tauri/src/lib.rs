use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::DateTime;
use serde::{Deserialize, Serialize};
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
const MAX_TASK_DOCUMENT_BYTES: u64 = 1024 * 1024;
const ATTACHMENT_CACHE_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
static ATTACHMENT_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static TASK_WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
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

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectTaskDocument {
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

#[tauri::command]
fn resolve_project_media(
    app: AppHandle,
    state: State<'_, AttachmentPathState>,
    workspace: String,
    path: String,
) -> Result<AttachmentFile, String> {
    let file = resolve_project_media_from(Path::new(&workspace), Path::new(&path))?;
    state.approve(&app, PathBuf::from(&file.path))?;
    Ok(file)
}

#[tauri::command]
fn resolve_local_media(
    app: AppHandle,
    state: State<'_, AttachmentPathState>,
    path: String,
) -> Result<AttachmentFile, String> {
    let file = resolve_local_media_from(Path::new(&path))?;
    state.approve(&app, PathBuf::from(&file.path))?;
    Ok(file)
}

#[tauri::command]
fn open_local_file(app: AppHandle, path: String) -> Result<(), String> {
    let file_path = resolve_local_file_path(Path::new(&path))?;
    app.opener()
        .open_path(file_path.to_string_lossy(), None::<&str>)
        .map_err(|error| format!("failed to open local file: {error}"))
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

fn read_project_file_from(
    workspace: &Path,
    relative_path: &Path,
    max_bytes: u64,
) -> Result<ProjectFilePreview, String> {
    let (root, file_path) = resolve_project_file_path(workspace, relative_path)?;

    let metadata = fs::metadata(&file_path)
        .map_err(|error| format!("failed to inspect {}: {error}", file_path.display()))?;
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
fn read_project_tasks(workspace: String) -> Result<ProjectTaskDocument, String> {
    read_project_tasks_from(Path::new(&workspace), MAX_TASK_DOCUMENT_BYTES)
}

#[tauri::command]
fn write_project_tasks(workspace: String, document: ProjectTaskDocument) -> Result<(), String> {
    write_project_tasks_to(Path::new(&workspace), &document)
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
    let path = directory.join("tasks.json");
    if !path.exists() {
        return Ok(empty_task_document());
    }
    let canonical = fs::canonicalize(&path)
        .map_err(|error| format!("failed to resolve {}: {error}", path.display()))?;
    if !canonical.starts_with(&root) {
        return Err(".pi/tasks.json resolves outside the workspace".to_owned());
    }
    let metadata = fs::metadata(&canonical)
        .map_err(|error| format!("failed to inspect {}: {error}", canonical.display()))?;
    if !metadata.is_file() {
        return Err(".pi/tasks.json is not a file".to_owned());
    }
    if metadata.len() > max_bytes {
        return Err(".pi/tasks.json is too large (maximum 1 MB)".to_owned());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    fs::File::open(&canonical)
        .map_err(|error| format!("failed to open .pi/tasks.json: {error}"))?
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read .pi/tasks.json: {error}"))?;
    if bytes.len() as u64 > max_bytes {
        return Err(".pi/tasks.json grew beyond the 1 MB limit".to_owned());
    }
    let document: ProjectTaskDocument = serde_json::from_slice(&bytes)
        .map_err(|error| format!("invalid .pi/tasks.json: {error}"))?;
    validate_task_document(&document)?;
    Ok(document)
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
    let target = directory.join("tasks.json");
    if target.exists() {
        let canonical = fs::canonicalize(&target)
            .map_err(|error| format!("failed to resolve {}: {error}", target.display()))?;
        if !canonical.starts_with(&root) {
            return Err(".pi/tasks.json resolves outside the workspace".to_owned());
        }
        if !fs::metadata(&canonical)
            .map_err(|error| format!("failed to inspect {}: {error}", canonical.display()))?
            .is_file()
        {
            return Err(".pi/tasks.json is not a file".to_owned());
        }
    }

    let mut serialized = serde_json::to_vec_pretty(document)
        .map_err(|error| format!("failed to encode .pi/tasks.json: {error}"))?;
    serialized.push(b'\n');
    if serialized.len() as u64 > MAX_TASK_DOCUMENT_BYTES {
        return Err(".pi/tasks.json is too large (maximum 1 MB)".to_owned());
    }

    let sequence = TASK_WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = directory.join(format!(
        ".tasks.json.{}.{}.tmp",
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
        version: 1,
        tasks: Vec::new(),
    }
}

fn validate_task_document(document: &ProjectTaskDocument) -> Result<(), String> {
    if document.version != 1 {
        return Err(format!(
            "unsupported .pi/tasks.json version {}",
            document.version
        ));
    }
    if document.tasks.len() > 10_000 {
        return Err(".pi/tasks.json contains too many tasks".to_owned());
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
        .map_err(|error| format!("failed to replace .pi/tasks.json: {error}"))
}

#[cfg(windows)]
fn replace_task_file(temporary: &Path, target: &Path) -> Result<(), String> {
    if !target.exists() {
        return fs::rename(temporary, target)
            .map_err(|error| format!("failed to install .pi/tasks.json: {error}"));
    }
    let backup = target.with_extension("json.bak");
    let _ = fs::remove_file(&backup);
    fs::rename(target, &backup)
        .map_err(|error| format!("failed to prepare .pi/tasks.json replacement: {error}"))?;
    if let Err(error) = fs::rename(temporary, target) {
        let _ = fs::rename(&backup, target);
        return Err(format!("failed to replace .pi/tasks.json: {error}"));
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
            open_local_file,
            read_project_file,
            resolve_project_media,
            resolve_local_media,
            read_project_tasks,
            write_project_tasks,
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
        let actual = read_project_tasks_from(&workspace, 1024 * 1024).expect("read tasks");
        assert_eq!(actual, expected);
        fs::remove_dir_all(workspace).expect("remove temporary workspace");
    }

    #[test]
    fn rejects_malformed_and_duplicate_task_documents() {
        let workspace = temporary_workspace("invalid-tasks");
        fs::create_dir(workspace.join(".pi")).expect("create .pi directory");
        fs::write(workspace.join(".pi/tasks.json"), b"{").expect("write malformed task document");
        assert!(read_project_tasks_from(&workspace, 1024).is_err());

        let mut duplicate = sample_task_document();
        duplicate.tasks.push(duplicate.tasks[0].clone());
        assert!(write_project_tasks_to(&workspace, &duplicate).is_err());
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
