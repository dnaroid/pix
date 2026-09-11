use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::DateTime;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{
    de::{IgnoredAny, MapAccess, Visitor},
    Deserialize, Serialize,
};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    env, fmt, fs,
    hash::{Hash, Hasher},
    io::{BufRead, BufReader, Read, Write},
    path::{Component, Path, PathBuf},
    process::{Child, ChildStdin, Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Condvar, Mutex, RwLock,
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
const MAX_WORKSPACE_CONFIG_BYTES: u64 = 64 * 1024;
const MAX_TASK_DOCUMENT_BYTES: u64 = 1024 * 1024;
const MAX_GIT_CHANGES: usize = 5_000;
const MAX_GIT_DIFF_BYTES: usize = 512 * 1024;
const MAX_GIT_COMMIT_MESSAGE_BYTES: usize = 20 * 1024;
const MAX_GIT_UNTRACKED_STAT_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_GIT_UNTRACKED_STAT_TOTAL_BYTES: u64 = 8 * 1024 * 1024;
const MAX_SIDEBAR_GIT_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const SIDEBAR_GIT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_SIDEBAR_REGISTRY_PROVENANCE_BYTES: u64 = 512 * 1024;
const MAX_SIDEBAR_REGISTRY_ENTRIES: usize = 4_096;
const MAX_SIDEBAR_REGISTRY_HASH_BYTES: u64 = 16 * 1024 * 1024;
const MAX_USER_CONFIG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_IDX_OUTPUT_BYTES: usize = 512 * 1024;
const MAX_IDX_LOG_BYTES: usize = 256 * 1024;
const IDX_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const IDX_QUERY_TIMEOUT: Duration = Duration::from_secs(180);
const IDX_OPERATION_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const IDX_STOP_GRACE: Duration = Duration::from_secs(2);
const MAX_IDX_MAX_FILES: u32 = 1_000;
const MAX_IDX_LIMIT: u32 = 1_000;
const MAX_IDX_OPERATIONS_PER_WINDOW: usize = 12;
const MAX_PACKAGE_JSON_BYTES: u64 = 2 * 1024 * 1024;
const MAX_PACKAGE_TERMINAL_OUTPUT_BYTES: usize = 512 * 1024;
const MAX_PACKAGE_TERMINAL_INPUT_BYTES: usize = 64 * 1024;
const MAX_PACKAGE_TERMINALS_PER_WINDOW: usize = 12;
const MAX_RUNNING_PACKAGE_TERMINALS_PER_WINDOW: usize = 6;
const PACKAGE_TERMINAL_STOP_GRACE: Duration = Duration::from_millis(900);
const PACKAGE_TERMINAL_STOP_TIMEOUT: Duration = Duration::from_secs(4);
const PROJECT_TASKS_SCHEMA_URL: &str = "https://unpkg.com/pi-ui-extend/schemas/tasks.json";
const PIX_CONFIG_SCHEMA_URL: &str = "https://unpkg.com/pi-ui-extend/schemas/pix.json";
const PI_TOOLS_SUITE_SCHEMA_URL: &str =
    "https://unpkg.com/pi-ui-extend/schemas/pi-tools-suite.json";
const ATTACHMENT_CACHE_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
static ATTACHMENT_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static TASK_WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static WORKSPACE_CONFIG_WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
type ExitSignal = Arc<(Mutex<bool>, Condvar)>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeepgramTokenResponse {
    access_token: String,
    expires_in: f64,
    model: String,
    language: String,
}

#[derive(Deserialize)]
struct DeepgramGrantResponse {
    access_token: String,
    expires_in: f64,
}

struct DeepgramRuntimeConfig {
    api_key: String,
    model: String,
    language: String,
}

#[derive(Default)]
struct AcpProcessState {
    slots: Mutex<HashMap<String, ProcessSlot>>,
    next_generation: AtomicU64,
    exiting: AtomicBool,
}

#[derive(Default)]
struct PackageTerminalState {
    sessions: Mutex<HashMap<String, PackageTerminalSession>>,
    next_id: AtomicU64,
}

#[derive(Default)]
struct UserConfigState {
    lock: RwLock<()>,
}

#[derive(Default)]
struct WorkspaceConfigState {
    lock: RwLock<()>,
}

#[derive(Default)]
struct SidebarIndicatorState {
    registry_cache: Mutex<HashMap<PathBuf, SidebarRegistryWorkspaceCache>>,
}

#[derive(Clone, Debug, Default)]
struct SidebarRegistryWorkspaceCache {
    entries: HashMap<String, SidebarRegistryCacheEntry>,
}

#[derive(Clone, Debug)]
struct SidebarRegistryCacheEntry {
    expected_hash: String,
    fingerprint: u64,
    changed: bool,
}

struct PackageTerminalSession {
    window_label: String,
    workspace: PathBuf,
    kind: PackageTerminalKind,
    script: String,
    command: String,
    started_at_ms: u64,
    status: PackageTerminalStatus,
    exit_code: Option<u32>,
    signal: Option<String>,
    stop_requested: bool,
    output: Vec<u8>,
    running: Option<PackageTerminalRunning>,
}

struct PackageTerminalRunning {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
    exited: ExitSignal,
    process_id: Option<u32>,
    process_group_leader: Option<i32>,
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

#[derive(Default)]
struct IdxOperationState {
    operations: Mutex<HashMap<String, IdxOperationRecord>>,
    next_id: AtomicU64,
}

struct IdxOperationRecord {
    window_label: String,
    workspace: PathBuf,
    kind: IdxMaintenanceKind,
    command: String,
    status: IdxOperationStatus,
    output: String,
    started_at_ms: u64,
    finished_at_ms: Option<u64>,
    exit_code: Option<i32>,
    stop_tx: Option<mpsc::Sender<()>>,
    exited: ExitSignal,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum IdxMaintenanceKind {
    Init,
    Index,
    FullIndex,
    DryRun,
    Doctor,
    WikiAudit,
    WikiDiscover,
    WikiCatalog,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum IdxOperationStatus {
    Running,
    Succeeded,
    Failed,
    Cancelled,
    TimedOut,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IdxOperationSnapshot {
    id: String,
    window_label: String,
    workspace: String,
    kind: IdxMaintenanceKind,
    command: String,
    status: IdxOperationStatus,
    output: String,
    started_at_ms: u64,
    finished_at_ms: Option<u64>,
    exit_code: Option<i32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IdxOperationOutputEvent {
    operation_id: String,
    stream: String,
    chunk: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IdxOperationExitEvent {
    operation_id: String,
    status: IdxOperationStatus,
    exit_code: Option<i32>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdxQueryRequest {
    workspace: String,
    query: IdxQuery,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
enum IdxQuery {
    Code {
        query: String,
        mode: IdxSearchMode,
        max_files: u32,
        path_prefix: Option<String>,
        #[serde(default)]
        include_content: bool,
    },
    Knowledge {
        query: String,
        limit: u32,
        include_secondary: bool,
        path_prefix: Option<String>,
    },
    Context {
        query: String,
        budget: u32,
        max_specs: u32,
        max_code: u32,
        max_tests: u32,
        include_secondary: bool,
        path_prefix: Option<String>,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum IdxSearchMode {
    Hybrid,
    Semantic,
    Lexical,
    Symbol,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdxInspectRequest {
    workspace: String,
    command: IdxInspectCommand,
    target: Option<String>,
    path_prefix: Option<String>,
    depth: Option<u32>,
    max_files: Option<u32>,
    include_body: Option<bool>,
    show_edges: Option<bool>,
    tests: Option<bool>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum IdxInspectCommand {
    Architecture,
    Structure,
    Ast,
    Explain,
    Deps,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IdxCommandResult {
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    truncated: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IdxParsedStatus {
    state: Option<String>,
    fields: BTreeMap<String, String>,
    raw: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IdxOverview {
    available: bool,
    executable: Option<String>,
    version: Option<String>,
    initialized: bool,
    index_status: Option<IdxParsedStatus>,
    wiki_status: Option<IdxParsedStatus>,
    raw_status: String,
    errors: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdxOperationRequest {
    window_label: String,
    workspace: String,
    kind: IdxMaintenanceKind,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdxKnowledgeRequest {
    workspace: String,
    action: IdxKnowledgeAction,
    path: Option<String>,
    classification: Option<String>,
    behavior_type: Option<String>,
    lifecycle: Option<String>,
    confidence: Option<String>,
    summary: Option<String>,
    topics: Option<Vec<String>>,
    target_paths: Option<Vec<String>>,
    relation_kind: Option<String>,
    relation_action: Option<String>,
    source_reviewed: Option<bool>,
    evidence_reviewed: Option<bool>,
    metadata_only_confirmed: Option<bool>,
    paths: Option<Vec<String>>,
    base: Option<String>,
    semantic: Option<bool>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum IdxKnowledgeAction {
    Show,
    Record,
    Verify,
    Relate,
    Remove,
    Impact,
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

#[tauri::command]
async fn deepgram_token(app: AppHandle) -> Result<DeepgramTokenResponse, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("failed to resolve the home directory: {error}"))?;
    let env_api_key = env::var("DEEPGRAM_API_KEY")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());

    run_blocking(move || {
        let config = resolve_deepgram_runtime_config(&home, env_api_key)?;

        let client = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|error| format!("failed to create the Deepgram HTTP client: {error}"))?;
        let response = client
            .post("https://api.deepgram.com/v1/auth/grant")
            .header("Authorization", format!("Token {}", config.api_key))
            .json(&serde_json::json!({ "ttl_seconds": 60 }))
            .send()
            .map_err(|error| format!("failed to request a Deepgram token: {error}"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!(
                "Deepgram token request failed with HTTP {}",
                status.as_u16()
            ));
        }
        let grant = response
            .json::<DeepgramGrantResponse>()
            .map_err(|error| format!("failed to decode the Deepgram token response: {error}"))?;
        if grant.access_token.trim().is_empty() {
            return Err("Deepgram returned an empty access token".to_owned());
        }
        Ok(DeepgramTokenResponse {
            access_token: grant.access_token,
            expires_in: grant.expires_in,
            model: config.model,
            language: config.language,
        })
    })
    .await
}

fn resolve_deepgram_api_key(home: &Path, env_api_key: Option<String>) -> Result<String, String> {
    resolve_deepgram_runtime_config(home, env_api_key).map(|config| config.api_key)
}

fn resolve_deepgram_runtime_config(
    home: &Path,
    env_api_key: Option<String>,
) -> Result<DeepgramRuntimeConfig, String> {
    let parsed = match deepgram_user_pix_config(home) {
        Ok(parsed) => parsed,
        Err(_error) if env_api_key.is_some() => None,
        Err(error) => return Err(error),
    };
    let dictation = parsed
        .as_ref()
        .and_then(|config| config.get("dictation"))
        .and_then(serde_json::Value::as_object);
    let api_key = dictation
        .and_then(|value| value.get("apiKey").or_else(|| value.get("deepgramApiKey")))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .or(env_api_key)
        .ok_or_else(|| {
            "Deepgram API key is not configured; set dictation.apiKey in ~/.config/pi/pix.jsonc or DEEPGRAM_API_KEY"
                .to_owned()
        })?;
    let model = dictation
        .and_then(|value| value.get("model").or_else(|| value.get("deepgramModel")))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("nova-3")
        .to_owned();
    let selected_language = dictation
        .and_then(|value| {
            value
                .get("language")
                .or_else(|| value.get("selectedLanguage"))
                .or_else(|| value.get("currentLanguage"))
        })
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("en")
        .to_lowercase();
    let language = dictation
        .and_then(|value| value.get("languages"))
        .and_then(serde_json::Value::as_object)
        .and_then(|languages| languages.get(&selected_language))
        .and_then(serde_json::Value::as_object)
        .and_then(|language| {
            language
                .get("deepgramLanguage")
                .or_else(|| language.get("language"))
        })
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&selected_language)
        .to_owned();

    Ok(DeepgramRuntimeConfig {
        api_key,
        model,
        language,
    })
}

fn deepgram_user_pix_config(home: &Path) -> Result<Option<serde_json::Value>, String> {
    let document = read_user_config_from(home, UserConfigKind::Pix)?;
    if !document.exists {
        return Ok(None);
    }
    let normalized = normalize_jsonc(&document.content)
        .map_err(|_| format!("failed to parse {} as JSONC", document.path))?;
    let parsed: serde_json::Value = serde_json::from_str(&normalized)
        .map_err(|error| format!("failed to parse {}: {error}", document.path))?;
    Ok(Some(parsed))
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
struct ConditionalWorkspaceConfigWrite {
    written: bool,
    document: Option<ProjectFilePreview>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    staged_additions: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    staged_deletions: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    unstaged_additions: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    unstaged_deletions: Option<u64>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct GitLineStats {
    additions: Option<u64>,
    deletions: Option<u64>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum UserConfigKind {
    Pix,
    PiToolsSuite,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UserConfigDocument {
    path: String,
    content: String,
    exists: bool,
    schema: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConditionalUserConfigWrite {
    written: bool,
    document: UserConfigDocument,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum PackageManagerKind {
    Npm,
    Pnpm,
    Yarn,
    Bun,
}

impl PackageManagerKind {
    fn executable(self) -> &'static str {
        match self {
            Self::Npm => "npm",
            Self::Pnpm => "pnpm",
            Self::Yarn => "yarn",
            Self::Bun => "bun",
        }
    }
}

struct PackageManagerLauncher {
    executable: PathBuf,
    prefix_args: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PackageScript {
    name: String,
    command: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PackageScriptsSnapshot {
    package_path: String,
    exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    package_name: Option<String>,
    package_manager: PackageManagerKind,
    scripts: Vec<PackageScript>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum PackageTerminalStatus {
    Running,
    Exited,
    Stopped,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum PackageTerminalKind {
    Script,
    Shell,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PackageTerminalSnapshot {
    id: String,
    kind: PackageTerminalKind,
    script: String,
    command: String,
    status: PackageTerminalStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    signal: Option<String>,
    output_base64: String,
    started_at_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PackageTerminalOutputEvent {
    terminal_id: String,
    data_base64: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PackageTerminalExitEvent {
    terminal_id: String,
    status: PackageTerminalStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    signal: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct SidebarProjectIndicatorState {
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct SidebarGitIndicatorState {
    available: bool,
    dirty: bool,
    conflicted: bool,
    detached: bool,
    ahead: u32,
    behind: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct SidebarRuntimeIndicatorState {
    running_ids: Vec<String>,
    failed_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct SidebarRegistryIndicatorState {
    local_changes: bool,
    stable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidebarRegistryProvenance {
    version: u32,
    #[serde(default)]
    resources: HashMap<String, SidebarRegistryProvenanceEntry>,
    #[serde(default)]
    project_resources: HashMap<String, SidebarRegistryProjectProvenanceEntry>,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct SidebarRegistryProvenanceEntry {
    #[serde(rename = "type", default)]
    resource_type: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    hash: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct SidebarRegistryProjectProvenanceEntry {
    #[serde(default)]
    hash: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct SidebarFileStamp {
    len: u64,
    modified_ns: u128,
}

enum SidebarStableFileRead {
    Missing,
    Changed,
    Stable(Vec<u8>, SidebarFileStamp),
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct SidebarSettingsIndicatorState {
    errors: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSidebarIndicatorPoll {
    project: SidebarProjectIndicatorState,
    git: SidebarGitIndicatorState,
    registry: SidebarRegistryIndicatorState,
    scripts: SidebarRuntimeIndicatorState,
    idx: SidebarRuntimeIndicatorState,
    settings: SidebarSettingsIndicatorState,
    checked_at_ms: u64,
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
async fn write_project_workspace_config_if_unchanged(
    app: AppHandle,
    workspace: String,
    expected_content: Option<String>,
    content: String,
) -> Result<ConditionalWorkspaceConfigWrite, String> {
    run_blocking(move || {
        let state = app.state::<WorkspaceConfigState>();
        let _guard = state
            .lock
            .write()
            .map_err(|_| "workspace config state is poisoned".to_owned())?;
        write_project_workspace_config_if_unchanged_from(
            Path::new(&workspace),
            expected_content.as_deref(),
            &content,
        )
    })
    .await
}

#[tauri::command]
async fn project_file_exists(workspace: String, path: String) -> Result<bool, String> {
    run_blocking(move || {
        Ok(project_file_exists_from(
            Path::new(&workspace),
            Path::new(&path),
        ))
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
async fn home_file_exists(app: AppHandle, path: String) -> Result<bool, String> {
    run_blocking(move || {
        let home = app
            .path()
            .home_dir()
            .map_err(|error| format!("failed to resolve the home directory: {error}"))?;
        Ok(home_file_exists_from(&home, Path::new(&path)))
    })
    .await
}

#[tauri::command]
async fn read_user_config(
    app: AppHandle,
    kind: UserConfigKind,
) -> Result<UserConfigDocument, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("failed to resolve the home directory: {error}"))?;
    run_blocking(move || {
        let state = app.state::<UserConfigState>();
        let _guard = state
            .lock
            .read()
            .map_err(|_| "user config state is poisoned".to_owned())?;
        read_user_config_from(&home, kind)
    })
    .await
}

#[tauri::command]
async fn write_user_config(
    app: AppHandle,
    kind: UserConfigKind,
    content: String,
) -> Result<UserConfigDocument, String> {
    if content.len() as u64 > MAX_USER_CONFIG_BYTES {
        return Err(format!(
            "config is too large to save (maximum {} MB)",
            MAX_USER_CONFIG_BYTES / (1024 * 1024)
        ));
    }
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("failed to resolve the home directory: {error}"))?;
    run_blocking(move || {
        let state = app.state::<UserConfigState>();
        let _guard = state
            .lock
            .write()
            .map_err(|_| "user config state is poisoned".to_owned())?;
        write_user_config_from(&home, kind, &content)
    })
    .await
}

#[tauri::command]
async fn write_user_config_if_unchanged(
    app: AppHandle,
    kind: UserConfigKind,
    expected_content: String,
    content: String,
) -> Result<ConditionalUserConfigWrite, String> {
    if content.len() as u64 > MAX_USER_CONFIG_BYTES {
        return Err(format!(
            "config is too large to save (maximum {} MB)",
            MAX_USER_CONFIG_BYTES / (1024 * 1024)
        ));
    }
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("failed to resolve the home directory: {error}"))?;
    run_blocking(move || {
        let state = app.state::<UserConfigState>();
        let _guard = state
            .lock
            .write()
            .map_err(|_| "user config state is poisoned".to_owned())?;
        write_user_config_if_unchanged_from(&home, kind, &expected_content, &content)
    })
    .await
}

#[tauri::command]
async fn workspace_sidebar_indicator_poll(
    app: AppHandle,
    window_label: String,
    workspace: String,
) -> Result<WorkspaceSidebarIndicatorPoll, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("failed to resolve the home directory: {error}"))?;
    run_blocking(move || {
        workspace_sidebar_indicator_poll_from(
            &app,
            &window_label,
            Path::new(&workspace),
            &home,
        )
    })
    .await
}

#[tauri::command]
async fn idx_overview(workspace: String) -> Result<IdxOverview, String> {
    run_blocking(move || idx_overview_from(Path::new(&workspace))).await
}

#[tauri::command]
async fn idx_query(request: IdxQueryRequest) -> Result<IdxCommandResult, String> {
    run_blocking(move || {
        let root = canonical_workspace(Path::new(&request.workspace))?;
        let executable = idx_executable()?;
        let args = idx_query_args(&request.query)?;
        run_idx_command(&executable, &root, &args, IDX_QUERY_TIMEOUT, MAX_IDX_OUTPUT_BYTES)
    })
    .await
}

#[tauri::command]
async fn idx_inspect(request: IdxInspectRequest) -> Result<IdxCommandResult, String> {
    run_blocking(move || {
        let root = canonical_workspace(Path::new(&request.workspace))?;
        if !root.join(".indexer-cli").is_dir() {
            return Err("this project is not indexed yet; initialize IDX first".to_owned());
        }
        let executable = idx_executable()?;
        let args = idx_inspect_args(&request)?;
        run_idx_command(&executable, &root, &args, IDX_QUERY_TIMEOUT, MAX_IDX_OUTPUT_BYTES)
    })
    .await
}

#[tauri::command]
async fn idx_knowledge(request: IdxKnowledgeRequest) -> Result<IdxCommandResult, String> {
    run_blocking(move || {
        let root = canonical_workspace(Path::new(&request.workspace))?;
        if !root.join(".indexer-cli").is_dir() {
            return Err("this project is not indexed yet; initialize IDX first".to_owned());
        }
        let executable = idx_executable()?;
        let args = idx_knowledge_args(&request)?;
        run_idx_command(&executable, &root, &args, IDX_QUERY_TIMEOUT, MAX_IDX_OUTPUT_BYTES)
    })
    .await
}

#[tauri::command]
async fn idx_operation_list(
    app: AppHandle,
    window_label: String,
    workspace: String,
) -> Result<Vec<IdxOperationSnapshot>, String> {
    run_blocking(move || {
        let root = canonical_workspace(Path::new(&workspace))?;
        idx_operation_snapshots(&app, &window_label, &root)
    })
    .await
}

#[tauri::command]
async fn idx_operation_start(
    app: AppHandle,
    request: IdxOperationRequest,
) -> Result<IdxOperationSnapshot, String> {
    run_blocking(move || start_idx_operation(app, request)).await
}

#[tauri::command]
async fn idx_operation_stop(
    app: AppHandle,
    window_label: String,
    operation_id: String,
) -> Result<(), String> {
    run_blocking(move || stop_idx_operation(&app, &window_label, &operation_id)).await
}

#[tauri::command]
async fn idx_operation_stop_workspace(
    app: AppHandle,
    window_label: String,
    workspace: String,
) -> Result<(), String> {
    run_blocking(move || {
        let root = canonical_workspace(Path::new(&workspace))?;
        stop_idx_operations_for_workspace(&app, &window_label, &root)
    })
    .await
}

#[tauri::command]
async fn package_scripts(workspace: String) -> Result<PackageScriptsSnapshot, String> {
    run_blocking(move || package_scripts_from(Path::new(&workspace))).await
}

#[tauri::command]
async fn package_terminal_list(
    app: AppHandle,
    window_label: String,
    workspace: String,
) -> Result<Vec<PackageTerminalSnapshot>, String> {
    run_blocking(move || {
        let root = canonical_workspace(Path::new(&workspace))?;
        package_terminal_snapshots(&app, &window_label, &root)
    })
    .await
}

#[tauri::command]
async fn package_terminal_start(
    app: AppHandle,
    window_label: String,
    workspace: String,
    script: String,
    cols: u16,
    rows: u16,
) -> Result<PackageTerminalSnapshot, String> {
    run_blocking(move || {
        start_package_terminal(
            app,
            window_label,
            PathBuf::from(workspace),
            script,
            cols,
            rows,
        )
    })
    .await
}

#[tauri::command]
async fn package_terminal_start_shell(
    app: AppHandle,
    window_label: String,
    workspace: String,
    cols: u16,
    rows: u16,
) -> Result<PackageTerminalSnapshot, String> {
    run_blocking(move || {
        start_shell_terminal(app, window_label, PathBuf::from(workspace), cols, rows)
    })
    .await
}

#[tauri::command]
async fn package_terminal_write(
    app: AppHandle,
    window_label: String,
    terminal_id: String,
    data: String,
) -> Result<(), String> {
    if data.len() > MAX_PACKAGE_TERMINAL_INPUT_BYTES {
        return Err(format!(
            "terminal input is too large (maximum {} KB per write)",
            MAX_PACKAGE_TERMINAL_INPUT_BYTES / 1024
        ));
    }
    run_blocking(move || write_package_terminal(&app, &window_label, &terminal_id, data.as_bytes()))
        .await
}

#[tauri::command]
async fn package_terminal_resize(
    app: AppHandle,
    window_label: String,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    run_blocking(move || resize_package_terminal(&app, &window_label, &terminal_id, cols, rows))
        .await
}

#[tauri::command]
async fn package_terminal_stop(
    app: AppHandle,
    window_label: String,
    terminal_id: String,
) -> Result<(), String> {
    run_blocking(move || stop_package_terminal(&app, &window_label, &terminal_id, false)).await
}

#[tauri::command]
async fn package_terminal_forget(
    app: AppHandle,
    window_label: String,
    terminal_id: String,
) -> Result<(), String> {
    run_blocking(move || forget_package_terminal(&app, &window_label, &terminal_id)).await
}

#[tauri::command]
async fn package_terminal_stop_workspace(
    app: AppHandle,
    window_label: String,
    workspace: String,
) -> Result<(), String> {
    run_blocking(move || {
        let root = canonical_workspace(Path::new(&workspace))?;
        stop_package_terminals_for_workspace(&app, &window_label, &root, true)
    })
    .await
}

#[tauri::command]
async fn local_file_exists(path: String) -> Result<bool, String> {
    run_blocking(move || Ok(resolve_local_file_path(Path::new(&path)).is_ok())).await
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

fn write_project_workspace_config_from(
    workspace: &Path,
    content: &str,
) -> Result<ProjectFilePreview, String> {
    if content.len() as u64 > MAX_WORKSPACE_CONFIG_BYTES {
        return Err(".pi/workspace.jsonc is too large (maximum 64 KB)".to_owned());
    }
    let root = canonical_workspace(workspace)?;
    let project_dir_path = root.join(".pi");
    if !project_dir_path.exists() {
        fs::create_dir(&project_dir_path)
            .map_err(|error| format!("failed to create {}: {error}", project_dir_path.display()))?;
    }
    let project_dir = canonical_project_directory(&root, &project_dir_path)?;
    let target = project_dir.join("workspace.jsonc");
    if target.exists() {
        if fs::symlink_metadata(&target)
            .map_err(|error| format!("failed to inspect {}: {error}", target.display()))?
            .file_type()
            .is_symlink()
        {
            return Err(".pi/workspace.jsonc cannot be a symbolic link".to_owned());
        }
        let canonical = fs::canonicalize(&target)
            .map_err(|error| format!("failed to resolve {}: {error}", target.display()))?;
        if !canonical.starts_with(&project_dir) {
            return Err(".pi/workspace.jsonc resolves outside the workspace".to_owned());
        }
        if !fs::metadata(&canonical)
            .map_err(|error| format!("failed to inspect {}: {error}", canonical.display()))?
            .is_file()
        {
            return Err(".pi/workspace.jsonc is not a file".to_owned());
        }
    }

    let sequence = WORKSPACE_CONFIG_WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = project_dir.join(format!(
        ".workspace.jsonc.{}.{}.tmp",
        std::process::id(),
        sequence,
    ));
    let write_result: Result<(), String> = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("failed to create workspace config temporary file: {error}"))?;
        file.write_all(content.as_bytes())
            .map_err(|error| format!("failed to write .pi/workspace.jsonc: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("failed to flush .pi/workspace.jsonc: {error}"))?;
        replace_workspace_config_file(&temporary, &target)?;
        sync_directory(&project_dir)?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result?;
    read_project_file_from(&root, Path::new(".pi/workspace.jsonc"), MAX_WORKSPACE_CONFIG_BYTES)
}

fn write_project_workspace_config_if_unchanged_from(
    workspace: &Path,
    expected_content: Option<&str>,
    content: &str,
) -> Result<ConditionalWorkspaceConfigWrite, String> {
    let config_path = Path::new(".pi/workspace.jsonc");
    let current = if project_file_exists_from(workspace, config_path) {
        Some(read_project_file_from(
            workspace,
            config_path,
            MAX_WORKSPACE_CONFIG_BYTES,
        )?)
    } else {
        None
    };
    if current.as_ref().map(|document| document.content.as_str()) != expected_content {
        return Ok(ConditionalWorkspaceConfigWrite {
            written: false,
            document: current,
        });
    }
    Ok(ConditionalWorkspaceConfigWrite {
        written: true,
        document: Some(write_project_workspace_config_from(workspace, content)?),
    })
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
    populate_git_line_stats(&root, &mut snapshot);
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
                staged_additions: None,
                staged_deletions: None,
                unstaged_additions: None,
                unstaged_deletions: None,
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
        staged_additions: None,
        staged_deletions: None,
        unstaged_additions: None,
        unstaged_deletions: None,
    })
}

fn populate_git_line_stats(root: &Path, snapshot: &mut GitSnapshot) {
    // Line counts are presentation metadata. A race with the working tree or a
    // path Git cannot numstat must never make the whole Source Control panel
    // unavailable, so failures here degrade to omitted counts.
    let staged = git_diff_numstat(root, true).unwrap_or_default();
    let unstaged = git_diff_numstat(root, false).unwrap_or_default();
    let mut untracked_budget = MAX_GIT_UNTRACKED_STAT_TOTAL_BYTES;

    for change in &mut snapshot.changes {
        if let Some(stats) = git_line_stats_for_change(&staged, change) {
            change.staged_additions = stats.additions;
            change.staged_deletions = stats.deletions;
        }

        let unstaged_stats = if change.untracked {
            git_untracked_line_stats(root, &change.path, &mut untracked_budget)
        } else {
            git_line_stats_for_change(&unstaged, change)
        };
        if let Some(stats) = unstaged_stats {
            change.unstaged_additions = stats.additions;
            change.unstaged_deletions = stats.deletions;
        }
    }
}

fn git_diff_numstat(root: &Path, staged: bool) -> Result<HashMap<String, GitLineStats>, String> {
    let mut args = vec!["diff"];
    if staged {
        args.push("--cached");
    }
    args.extend(["--numstat", "--no-renames", "-z", "--no-ext-diff"]);
    let output = git_output(root, &args)?;
    parse_git_numstat(&output.stdout)
}

fn parse_git_numstat(bytes: &[u8]) -> Result<HashMap<String, GitLineStats>, String> {
    let mut stats = HashMap::new();
    for record in bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        let mut fields = record.splitn(3, |byte| *byte == b'\t');
        let additions = fields.next().unwrap_or_default();
        let deletions = fields.next().unwrap_or_default();
        let path = fields.next().unwrap_or_default();
        if path.is_empty() {
            return Err("git diff --numstat returned a malformed record".to_owned());
        }
        let path = String::from_utf8_lossy(path).into_owned();
        let next = GitLineStats {
            additions: parse_git_numstat_count(additions)?,
            deletions: parse_git_numstat_count(deletions)?,
        };
        stats
            .entry(path)
            .and_modify(|current| *current = merge_git_line_stats(*current, next))
            .or_insert(next);
    }
    Ok(stats)
}

fn parse_git_numstat_count(value: &[u8]) -> Result<Option<u64>, String> {
    if value == b"-" {
        return Ok(None);
    }
    String::from_utf8_lossy(value)
        .parse::<u64>()
        .map(Some)
        .map_err(|_| "git diff --numstat returned an invalid line count".to_owned())
}

fn merge_git_line_stats(left: GitLineStats, right: GitLineStats) -> GitLineStats {
    GitLineStats {
        additions: merge_git_line_count(left.additions, right.additions),
        deletions: merge_git_line_count(left.deletions, right.deletions),
    }
}

fn merge_git_line_count(left: Option<u64>, right: Option<u64>) -> Option<u64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.saturating_add(right)),
        _ => None,
    }
}

fn git_line_stats_for_change(
    stats: &HashMap<String, GitLineStats>,
    change: &GitFileChange,
) -> Option<GitLineStats> {
    let mut combined = stats.get(&change.path).copied();
    if let Some(original_path) = change
        .original_path
        .as_deref()
        .filter(|path| *path != change.path)
    {
        if let Some(original) = stats.get(original_path).copied() {
            combined = Some(match combined {
                Some(current) => merge_git_line_stats(current, original),
                None => original,
            });
        }
    }
    combined
}

fn git_untracked_line_stats(
    root: &Path,
    path: &str,
    remaining_budget: &mut u64,
) -> Option<GitLineStats> {
    if *remaining_budget == 0 {
        return None;
    }
    if validate_workspace_relative_path(Path::new(path), "Git file path").is_err() {
        return None;
    }
    let target = root.join(path);
    let metadata = fs::symlink_metadata(&target).ok()?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return None;
    }
    let size = metadata.len();
    if size > MAX_GIT_UNTRACKED_STAT_FILE_BYTES || size > *remaining_budget {
        return None;
    }
    let bytes = fs::read(&target).ok()?;
    *remaining_budget = remaining_budget.saturating_sub(size);
    if bytes.contains(&0) {
        return Some(GitLineStats {
            additions: None,
            deletions: None,
        });
    }
    let newlines = bytes.iter().filter(|byte| **byte == b'\n').count() as u64;
    let additions = if bytes.is_empty() {
        0
    } else if bytes.last() == Some(&b'\n') {
        newlines
    } else {
        newlines.saturating_add(1)
    };
    Some(GitLineStats {
        additions: Some(additions),
        deletions: Some(0),
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

fn home_file_exists_from(home: &Path, home_path: &Path) -> bool {
    resolve_home_file_path(home, home_path).is_ok()
}

fn user_config_path(home: &Path, kind: UserConfigKind) -> PathBuf {
    let file_name = match kind {
        UserConfigKind::Pix => "pix.jsonc",
        UserConfigKind::PiToolsSuite => "pi-tools-suite.jsonc",
    };
    home.join(".config").join("pi").join(file_name)
}

fn user_config_schema(kind: UserConfigKind) -> &'static str {
    match kind {
        UserConfigKind::Pix => include_str!("../../../schemas/pix.json"),
        UserConfigKind::PiToolsSuite => include_str!("../../../schemas/pi-tools-suite.json"),
    }
}

fn user_config_schema_url(kind: UserConfigKind) -> &'static str {
    match kind {
        UserConfigKind::Pix => PIX_CONFIG_SCHEMA_URL,
        UserConfigKind::PiToolsSuite => PI_TOOLS_SUITE_SCHEMA_URL,
    }
}

fn empty_user_config(kind: UserConfigKind) -> String {
    format!(
        "{{\n  \"$schema\": \"{}\"\n}}\n",
        user_config_schema_url(kind)
    )
}

fn read_user_config_from(home: &Path, kind: UserConfigKind) -> Result<UserConfigDocument, String> {
    let path = user_config_path(home, kind);
    let exists = path.exists();
    let content = if exists {
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("failed to inspect {}: {error}", path.display()))?;
        if !metadata.is_file() {
            return Err(format!("{} is not a file", path.display()));
        }
        if metadata.len() > MAX_USER_CONFIG_BYTES {
            return Err(format!(
                "{} is too large to edit (maximum {} MB)",
                path.display(),
                MAX_USER_CONFIG_BYTES / (1024 * 1024)
            ));
        }
        fs::read_to_string(&path)
            .map_err(|error| format!("failed to read {}: {error}", path.display()))?
    } else {
        empty_user_config(kind)
    };

    Ok(UserConfigDocument {
        path: path.to_string_lossy().into_owned(),
        content,
        exists,
        schema: user_config_schema(kind).to_owned(),
    })
}

fn write_user_config_from(
    home: &Path,
    kind: UserConfigKind,
    content: &str,
) -> Result<UserConfigDocument, String> {
    let normalized = if content.ends_with('\n') {
        content.to_owned()
    } else {
        format!("{content}\n")
    };
    if normalized.len() as u64 > MAX_USER_CONFIG_BYTES {
        return Err(format!(
            "config is too large to save (maximum {} MB)",
            MAX_USER_CONFIG_BYTES / (1024 * 1024)
        ));
    }
    let path = user_config_path(home, kind);
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    if path.exists() {
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("failed to inspect {}: {error}", path.display()))?;
        if !metadata.is_file() {
            return Err(format!("{} is not a file", path.display()));
        }
    }
    fs::write(&path, normalized)
        .map_err(|error| format!("failed to write {}: {error}", path.display()))?;
    read_user_config_from(home, kind)
}

fn write_user_config_if_unchanged_from(
    home: &Path,
    kind: UserConfigKind,
    expected_content: &str,
    content: &str,
) -> Result<ConditionalUserConfigWrite, String> {
    let current = read_user_config_from(home, kind)?;
    if current.content != expected_content {
        return Ok(ConditionalUserConfigWrite {
            written: false,
            document: current,
        });
    }
    Ok(ConditionalUserConfigWrite {
        written: true,
        document: write_user_config_from(home, kind, content)?,
    })
}

fn workspace_sidebar_indicator_poll_from(
    app: &AppHandle,
    window_label: &str,
    workspace: &Path,
    home: &Path,
) -> Result<WorkspaceSidebarIndicatorPoll, String> {
    let settings = {
        let state = app.state::<UserConfigState>();
        let result = match state.lock.read() {
            Ok(_guard) => sidebar_settings_indicator_state(home),
            Err(_) => SidebarSettingsIndicatorState {
                errors: vec!["user config state is unavailable".to_owned()],
            },
        };
        result
    };
    let root = match canonical_workspace(workspace) {
        Ok(root) => root,
        Err(error) => {
            return Ok(WorkspaceSidebarIndicatorPoll {
                project: SidebarProjectIndicatorState { error: Some(error) },
                git: SidebarGitIndicatorState::default(),
                registry: SidebarRegistryIndicatorState { stable: true, ..SidebarRegistryIndicatorState::default() },
                scripts: SidebarRuntimeIndicatorState::default(),
                idx: SidebarRuntimeIndicatorState::default(),
                settings,
                checked_at_ms: idx_now_ms(),
            });
        }
    };

    let project = SidebarProjectIndicatorState {
        error: fs::read_dir(&root)
            .err()
            .map(|error| format!("failed to read project directory: {error}")),
    };
    let registry = sidebar_registry_indicator_state(
        app.state::<SidebarIndicatorState>().inner(),
        &root,
        home,
    );

    Ok(WorkspaceSidebarIndicatorPoll {
        project,
        git: sidebar_git_indicator_state(&root),
        registry,
        scripts: sidebar_scripts_indicator_state(app, window_label, &root),
        idx: sidebar_idx_runtime_indicator_state(app, window_label, &root),
        settings,
        checked_at_ms: idx_now_ms(),
    })
}

fn sidebar_registry_indicator_state(
    state: &SidebarIndicatorState,
    root: &Path,
    home: &Path,
) -> SidebarRegistryIndicatorState {
    match sidebar_registry_indicator_state_inner(state, root, home) {
        Ok(result) => result,
        Err(error) => SidebarRegistryIndicatorState {
            local_changes: false,
            stable: true,
            error: Some(error),
        },
    }
}

fn sidebar_registry_indicator_state_inner(
    state: &SidebarIndicatorState,
    root: &Path,
    home: &Path,
) -> Result<SidebarRegistryIndicatorState, String> {
    let configured_before = match sidebar_registry_configured(home, root)? {
        Some(configured) => configured,
        None => return Ok(SidebarRegistryIndicatorState::default()),
    };
    let pi_dir = root.join(".pi");
    let surface_before = sidebar_registry_surface_stamp(&pi_dir)?;
    let provenance_path = pi_dir.join("registry.json");
    let (provenance, provenance_stamp) = match sidebar_read_stable_file(
        &provenance_path,
        MAX_SIDEBAR_REGISTRY_PROVENANCE_BYTES,
    )? {
        SidebarStableFileRead::Missing => (SidebarRegistryProvenance::default(), None),
        SidebarStableFileRead::Changed => return Ok(SidebarRegistryIndicatorState::default()),
        SidebarStableFileRead::Stable(bytes, stamp) => {
            let provenance = serde_json::from_slice::<SidebarRegistryProvenance>(&bytes)
                .map_err(|error| format!("invalid .pi/registry.json: {error}"))?;
            if provenance.version != 1 {
                return Err(format!(
                    "unsupported .pi/registry.json version {}",
                    provenance.version
                ));
            }
            (provenance, Some(stamp))
        }
    };

    let local_resources = sidebar_registry_local_resources(root)?;
    let mut hash_budget = MAX_SIDEBAR_REGISTRY_HASH_BYTES;
    let mut local_changes = configured_before
        && local_resources
            .keys()
            .any(|key| !provenance.resources.contains_key(key));

    if !local_changes {
        let mut tracked_resources = provenance.resources.iter().collect::<Vec<_>>();
        tracked_resources.sort_by(|(left, _), (right, _)| left.cmp(right));
        for (key, tracked) in tracked_resources {
            let Some(path) = sidebar_registry_resource_path(root, tracked) else {
                continue;
            };
            if !path.exists() {
                local_changes = true;
                break;
            }
            if tracked.hash.is_empty() {
                return Err(format!("registry provenance for {key} has no content hash"));
            }
            match sidebar_registry_cached_path_changed(
                state,
                root,
                key,
                &path,
                &tracked.hash,
                &mut hash_budget,
            )? {
                Some(changed) => {
                    if changed {
                        local_changes = true;
                        break;
                    }
                }
                None => return Ok(SidebarRegistryIndicatorState::default()),
            }
        }
    }

    if !local_changes {
        for artifact in ["tasks", "plans", "todo"] {
            let tracked = provenance.project_resources.get(artifact);
            let path = sidebar_registry_project_artifact_path(root, artifact);
            let exists = sidebar_registry_project_artifact_exists(&path, artifact, tracked.is_some())?;
            if tracked.is_none() {
                if configured_before && exists {
                    local_changes = true;
                    break;
                }
                continue;
            }
            if !exists {
                local_changes = true;
                break;
            }
            let tracked = tracked.expect("tracked project artifact exists");
            if tracked.hash.is_empty() {
                return Err(format!("registry provenance for project {artifact} has no content hash"));
            }
            let cache_key = format!("project:{artifact}");
            match sidebar_registry_cached_path_changed(
                state,
                root,
                &cache_key,
                &path,
                &tracked.hash,
                &mut hash_budget,
            )? {
                Some(changed) => {
                    if changed {
                        local_changes = true;
                        break;
                    }
                }
                None => return Ok(SidebarRegistryIndicatorState::default()),
            }
        }
    }

    if let Some(expected) = provenance_stamp {
        if sidebar_file_stamp(&provenance_path)? != Some(expected) {
            return Ok(SidebarRegistryIndicatorState::default());
        }
    } else if provenance_path.exists() {
        return Ok(SidebarRegistryIndicatorState::default());
    }
    if sidebar_registry_surface_stamp(&pi_dir)? != surface_before {
        return Ok(SidebarRegistryIndicatorState::default());
    }
    let configured_after = match sidebar_registry_configured(home, root)? {
        Some(configured) => configured,
        None => return Ok(SidebarRegistryIndicatorState::default()),
    };
    if configured_before != configured_after {
        return Ok(SidebarRegistryIndicatorState::default());
    }

    Ok(SidebarRegistryIndicatorState {
        local_changes,
        stable: true,
        error: None,
    })
}

fn sidebar_registry_configured(home: &Path, root: &Path) -> Result<Option<bool>, String> {
    let mut remote: Option<String> = None;
    let user_path = user_config_path(home, UserConfigKind::PiToolsSuite);
    for path in [
        Some(user_path),
        env::var_os("PI_CONFIG_DIR").map(|dir| PathBuf::from(dir).join("pi-tools-suite.jsonc")),
        Some(root.join(".pi/pi-tools-suite.jsonc")),
    ]
    .into_iter()
    .flatten()
    {
        match sidebar_registry_remote_override(&path)? {
            SidebarRegistryRemoteOverride::Unstable => return Ok(None),
            SidebarRegistryRemoteOverride::Absent => {}
            SidebarRegistryRemoteOverride::Present(value) => remote = value,
        }
    }
    if let Ok(value) = env::var("PI_RESOURCE_REGISTRY_REMOTE") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            remote = Some(trimmed.to_owned());
        }
    }
    Ok(Some(remote.is_some()))
}

enum SidebarRegistryRemoteOverride {
    Absent,
    Unstable,
    Present(Option<String>),
}

fn sidebar_registry_remote_override(path: &Path) -> Result<SidebarRegistryRemoteOverride, String> {
    let bytes = match sidebar_read_stable_file(path, MAX_USER_CONFIG_BYTES)? {
        SidebarStableFileRead::Missing => return Ok(SidebarRegistryRemoteOverride::Absent),
        SidebarStableFileRead::Changed => return Ok(SidebarRegistryRemoteOverride::Unstable),
        SidebarStableFileRead::Stable(bytes, _) => bytes,
    };
    let source = std::str::from_utf8(&bytes)
        .map_err(|error| format!("invalid {} UTF-8: {error}", path.display()))?;
    let normalized = match normalize_jsonc(source) {
        Ok(normalized) => normalized,
        Err(_) => return Ok(SidebarRegistryRemoteOverride::Absent),
    };
    let value = match serde_json::from_str::<serde_json::Value>(&normalized) {
        Ok(value) => value,
        Err(_) => return Ok(SidebarRegistryRemoteOverride::Absent),
    };
    let Some(registry) = value.get("resourceRegistry").and_then(serde_json::Value::as_object) else {
        return Ok(SidebarRegistryRemoteOverride::Absent);
    };
    if !registry.contains_key("remote") {
        return Ok(SidebarRegistryRemoteOverride::Absent);
    }
    let remote = registry
        .get("remote")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    Ok(SidebarRegistryRemoteOverride::Present(remote))
}

fn sidebar_registry_surface_stamp(pi_dir: &Path) -> Result<(Option<SidebarFileStamp>, Option<SidebarFileStamp>, Option<SidebarFileStamp>), String> {
    Ok((
        sidebar_path_stamp(pi_dir)?,
        sidebar_path_stamp(&pi_dir.join("skills"))?,
        sidebar_path_stamp(&pi_dir.join("agents"))?,
    ))
}

fn sidebar_registry_local_resources(root: &Path) -> Result<HashMap<String, PathBuf>, String> {
    let mut resources = HashMap::new();
    let mut count = 0usize;
    let skills = root.join(".pi/skills");
    if skills.exists() {
        for entry in fs::read_dir(&skills)
            .map_err(|error| format!("failed to read {}: {error}", skills.display()))?
        {
            let entry = entry.map_err(|error| format!("failed to read skill entry: {error}"))?;
            count += 1;
            if count > MAX_SIDEBAR_REGISTRY_ENTRIES {
                return Err("too many local registry resources to inspect cheaply".to_owned());
            }
            let file_type = entry
                .file_type()
                .map_err(|error| format!("failed to inspect skill entry: {error}"))?;
            if !file_type.is_dir() || file_type.is_symlink() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if !sidebar_registry_safe_name(&name) || name == ".DS_Store" {
                continue;
            }
            let path = entry.path();
            if path.join("SKILL.md").is_file() {
                resources.insert(format!("skill:{name}"), path);
            }
        }
    }
    let agents = root.join(".pi/agents");
    if agents.exists() {
        for entry in fs::read_dir(&agents)
            .map_err(|error| format!("failed to read {}: {error}", agents.display()))?
        {
            let entry = entry.map_err(|error| format!("failed to read agent entry: {error}"))?;
            count += 1;
            if count > MAX_SIDEBAR_REGISTRY_ENTRIES {
                return Err("too many local registry resources to inspect cheaply".to_owned());
            }
            let file_type = entry
                .file_type()
                .map_err(|error| format!("failed to inspect agent entry: {error}"))?;
            if !file_type.is_file() || file_type.is_symlink() {
                continue;
            }
            let file_name = entry.file_name().to_string_lossy().into_owned();
            let Some(name) = file_name.strip_suffix(".md") else {
                continue;
            };
            if name.starts_with('.') || !sidebar_registry_safe_name(name) {
                continue;
            }
            resources.insert(format!("agent:{name}"), entry.path());
        }
    }
    Ok(resources)
}

fn sidebar_registry_safe_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains("..")
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        && name.as_bytes()[0].is_ascii_alphanumeric()
}

fn sidebar_registry_resource_path(
    root: &Path,
    tracked: &SidebarRegistryProvenanceEntry,
) -> Option<PathBuf> {
    if !sidebar_registry_safe_name(&tracked.name) {
        return None;
    }
    match tracked.resource_type.as_str() {
        "skill" => Some(root.join(".pi/skills").join(&tracked.name)),
        "agent" => Some(root.join(".pi/agents").join(format!("{}.md", tracked.name))),
        _ => None,
    }
}

fn sidebar_registry_project_artifact_path(root: &Path, artifact: &str) -> PathBuf {
    match artifact {
        "tasks" => root.join(".pi/tasks.jsonc"),
        "plans" => root.join(".pi/plans"),
        "todo" => root.join(".pi/TODO.md"),
        _ => root.join(".pi"),
    }
}

fn sidebar_registry_project_artifact_exists(
    path: &Path,
    artifact: &str,
    tracked: bool,
) -> Result<bool, String> {
    if artifact != "plans" || tracked {
        return Ok(path.exists());
    }
    if !path.exists() {
        return Ok(false);
    }
    let mut count = 0usize;
    sidebar_registry_has_trackable_file(path, &mut count)
}

fn sidebar_registry_has_trackable_file(path: &Path, count: &mut usize) -> Result<bool, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("failed to inspect {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() || metadata.is_file() {
        return Ok(true);
    }
    if !metadata.is_dir() {
        return Ok(true);
    }
    for entry in fs::read_dir(path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?
    {
        let entry = entry.map_err(|error| format!("failed to read {}: {error}", path.display()))?;
        if entry.file_name().to_string_lossy() == ".DS_Store" {
            continue;
        }
        *count += 1;
        if *count > MAX_SIDEBAR_REGISTRY_ENTRIES {
            return Err("project plans are too large to inspect cheaply".to_owned());
        }
        if sidebar_registry_has_trackable_file(&entry.path(), count)? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn sidebar_registry_cached_path_changed(
    state: &SidebarIndicatorState,
    root: &Path,
    cache_key: &str,
    path: &Path,
    expected_hash: &str,
    hash_budget: &mut u64,
) -> Result<Option<bool>, String> {
    let (fingerprint_before, file_bytes) = sidebar_registry_tree_fingerprint(path)?;
    let cached = state
        .registry_cache
        .lock()
        .ok()
        .and_then(|cache| cache.get(root).and_then(|workspace| workspace.entries.get(cache_key)).cloned());
    if let Some(cached) = cached {
        if cached.expected_hash == expected_hash && cached.fingerprint == fingerprint_before {
            let (fingerprint_after, _) = sidebar_registry_tree_fingerprint(path)?;
            return Ok((fingerprint_before == fingerprint_after).then_some(cached.changed));
        }
    }

    if file_bytes > *hash_budget {
        return Ok(None);
    }
    *hash_budget -= file_bytes;
    let actual_hash = sidebar_registry_hash_path(path)?;
    let (fingerprint_after, _) = sidebar_registry_tree_fingerprint(path)?;
    if fingerprint_before != fingerprint_after {
        return Ok(None);
    }
    let changed = actual_hash != expected_hash;
    if let Ok(mut cache) = state.registry_cache.lock() {
        if !cache.contains_key(root) && cache.len() >= 32 {
            cache.clear();
        }
        cache
            .entry(root.to_path_buf())
            .or_default()
            .entries
            .insert(
                cache_key.to_owned(),
                SidebarRegistryCacheEntry {
                    expected_hash: expected_hash.to_owned(),
                    fingerprint: fingerprint_after,
                    changed,
                },
            );
    }
    Ok(Some(changed))
}

fn sidebar_registry_tree_fingerprint(path: &Path) -> Result<(u64, u64), String> {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let mut count = 0usize;
    let mut bytes = 0u64;
    sidebar_registry_fingerprint_visit(path, "", &mut count, &mut bytes, &mut hasher)?;
    Ok((hasher.finish(), bytes))
}

fn sidebar_registry_fingerprint_visit(
    path: &Path,
    relative: &str,
    count: &mut usize,
    bytes: &mut u64,
    hasher: &mut impl Hasher,
) -> Result<(), String> {
    *count += 1;
    if *count > MAX_SIDEBAR_REGISTRY_ENTRIES {
        return Err("registry resource is too large to inspect cheaply".to_owned());
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("failed to inspect {}: {error}", path.display()))?;
    relative.hash(hasher);
    metadata.len().hash(hasher);
    sidebar_modified_ns(&metadata).hash(hasher);
    if metadata.file_type().is_symlink() {
        return Err(format!("registry resource contains a symbolic link: {relative}"));
    }
    if metadata.is_file() {
        *bytes = bytes.saturating_add(metadata.len());
        1u8.hash(hasher);
        return Ok(());
    }
    if !metadata.is_dir() {
        return Err(format!("registry resource contains an unsupported entry: {relative}"));
    }
    2u8.hash(hasher);
    let mut entries = fs::read_dir(path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    entries.retain(|entry| entry.file_name().to_string_lossy() != ".DS_Store");
    entries.sort_by_key(|entry| entry.file_name().to_string_lossy().into_owned());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let child_relative = if relative.is_empty() {
            name
        } else {
            format!("{relative}/{name}")
        };
        sidebar_registry_fingerprint_visit(&entry.path(), &child_relative, count, bytes, hasher)?;
    }
    Ok(())
}

fn sidebar_registry_hash_path(path: &Path) -> Result<String, String> {
    let mut hasher = Sha256::new();
    let mut count = 0usize;
    let mut bytes = 0u64;
    sidebar_registry_hash_visit(path, "", &mut count, &mut bytes, &mut hasher)?;
    Ok(format!("{:x}", hasher.finalize()))
}

fn sidebar_registry_hash_visit(
    path: &Path,
    relative: &str,
    count: &mut usize,
    bytes: &mut u64,
    hasher: &mut Sha256,
) -> Result<(), String> {
    *count += 1;
    if *count > MAX_SIDEBAR_REGISTRY_ENTRIES {
        return Err("registry resource is too large to hash cheaply".to_owned());
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("failed to inspect {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() {
        return Err(format!("registry resource contains a symbolic link: {relative}"));
    }
    if metadata.is_file() {
        *bytes = bytes.saturating_add(metadata.len());
        if *bytes > MAX_SIDEBAR_REGISTRY_HASH_BYTES {
            return Err("registry resource is too large to hash in the indicator service".to_owned());
        }
        hasher.update(b"file\0");
        hasher.update(relative.as_bytes());
        hasher.update(b"\0");
        let mut file = fs::File::open(path)
            .map_err(|error| format!("failed to open {}: {error}", path.display()))?;
        let mut buffer = [0u8; 16 * 1024];
        loop {
            let read = file
                .read(&mut buffer)
                .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        return Ok(());
    }
    if !metadata.is_dir() {
        return Err(format!("registry resource contains an unsupported entry: {relative}"));
    }
    hasher.update(b"dir\0");
    hasher.update(relative.as_bytes());
    hasher.update(b"\0");
    let mut entries = fs::read_dir(path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    entries.retain(|entry| entry.file_name().to_string_lossy() != ".DS_Store");
    entries.sort_by_key(|entry| entry.file_name().to_string_lossy().into_owned());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let child_relative = if relative.is_empty() {
            name
        } else {
            format!("{relative}/{name}")
        };
        sidebar_registry_hash_visit(&entry.path(), &child_relative, count, bytes, hasher)?;
    }
    Ok(())
}

fn sidebar_read_stable_file(path: &Path, max_bytes: u64) -> Result<SidebarStableFileRead, String> {
    let Some(before) = sidebar_file_stamp(path)? else {
        return Ok(SidebarStableFileRead::Missing);
    };
    if before.len > max_bytes {
        return Err(format!("{} is too large to inspect", path.display()));
    }
    let bytes = fs::read(path).map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!("{} grew too large while being inspected", path.display()));
    }
    let Some(after) = sidebar_file_stamp(path)? else {
        return Ok(SidebarStableFileRead::Changed);
    };
    if before != after {
        return Ok(SidebarStableFileRead::Changed);
    }
    Ok(SidebarStableFileRead::Stable(bytes, after))
}

fn sidebar_file_stamp(path: &Path) -> Result<Option<SidebarFileStamp>, String> {
    match fs::metadata(path) {
        Ok(metadata) => {
            if !metadata.is_file() {
                return Err(format!("{} is not a file", path.display()));
            }
            Ok(Some(SidebarFileStamp {
                len: metadata.len(),
                modified_ns: sidebar_modified_ns(&metadata),
            }))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("failed to inspect {}: {error}", path.display())),
    }
}

fn sidebar_path_stamp(path: &Path) -> Result<Option<SidebarFileStamp>, String> {
    match fs::metadata(path) {
        Ok(metadata) => Ok(Some(SidebarFileStamp {
            len: metadata.len(),
            modified_ns: sidebar_modified_ns(&metadata),
        })),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("failed to inspect {}: {error}", path.display())),
    }
}

fn sidebar_modified_ns(metadata: &fs::Metadata) -> u128 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

fn sidebar_git_indicator_state(root: &Path) -> SidebarGitIndicatorState {
    // A project nested inside some unrelated parent repository should not make
    // the Activity Bar look dirty. Source Control is intentionally scoped to a
    // repository opened at its root, matching the full Git panel contract.
    if !root.join(".git").exists() {
        return SidebarGitIndicatorState::default();
    }

    let output = match sidebar_git_status_output(root) {
        Ok(output) => output,
        Err(error) => {
            return SidebarGitIndicatorState {
                available: true,
                error: Some(error),
                ..SidebarGitIndicatorState::default()
            };
        }
    };
    if !output.status.success() {
        return SidebarGitIndicatorState {
            available: true,
            error: Some(git_command_error("Git indicator status", &output)),
            ..SidebarGitIndicatorState::default()
        };
    }
    parse_sidebar_git_status(&output.stdout)
}

fn sidebar_git_status_output(root: &Path) -> Result<std::process::Output, String> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(root)
        .arg("--no-optional-locks")
        .arg("-c")
        .arg("color.ui=false")
        .arg("-c")
        .arg("core.quotepath=false")
        .arg("-c")
        .arg("core.pager=cat")
        .arg("-c")
        .arg("core.fsmonitor=false")
        .args([
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--untracked-files=normal",
        ])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start Git indicator status: {error}"))?;
    let process_id = child.id();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Git indicator stdout pipe is unavailable".to_owned())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Git indicator stderr pipe is unavailable".to_owned())?;
    let stdout_thread = thread::spawn(move || read_bounded_idx_stream(stdout, MAX_SIDEBAR_GIT_OUTPUT_BYTES));
    let stderr_thread = thread::spawn(move || read_bounded_idx_stream(stderr, 256 * 1024));
    let deadline = Instant::now() + SIDEBAR_GIT_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(POLL_INTERVAL),
            Ok(None) => {
                force_kill_idx_process(process_id, &mut child);
                let _ = child.wait();
                let _ = stdout_thread.join();
                let _ = stderr_thread.join();
                return Err("Git indicator status timed out".to_owned());
            }
            Err(error) => {
                force_kill_idx_process(process_id, &mut child);
                let _ = child.wait();
                let _ = stdout_thread.join();
                let _ = stderr_thread.join();
                return Err(format!("failed while waiting for Git indicator status: {error}"));
            }
        }
    };
    let (stdout, stdout_truncated) = stdout_thread
        .join()
        .map_err(|_| "Git indicator stdout reader panicked".to_owned())?;
    let (stderr, stderr_truncated) = stderr_thread
        .join()
        .map_err(|_| "Git indicator stderr reader panicked".to_owned())?;
    if stdout_truncated || stderr_truncated {
        return Err("Git indicator status output exceeded its safety limit".to_owned());
    }
    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

fn parse_sidebar_git_status(bytes: &[u8]) -> SidebarGitIndicatorState {
    let mut state = SidebarGitIndicatorState {
        available: true,
        ..SidebarGitIndicatorState::default()
    };
    let records = bytes.split(|byte| *byte == 0).collect::<Vec<_>>();
    let mut index = 0usize;
    while index < records.len() {
        let record = records[index];
        index += 1;
        if record.is_empty() {
            continue;
        }
        let text = String::from_utf8_lossy(record);
        if let Some(value) = text.strip_prefix("# branch.head ") {
            state.detached = value == "(detached)";
            continue;
        }
        if let Some(value) = text.strip_prefix("# branch.ab ") {
            for part in value.split_whitespace() {
                if let Some(value) = part.strip_prefix('+') {
                    state.ahead = value.parse().unwrap_or(0);
                } else if let Some(value) = part.strip_prefix('-') {
                    state.behind = value.parse().unwrap_or(0);
                }
            }
            continue;
        }
        if text.starts_with('#') {
            continue;
        }
        state.dirty = true;
        if text.starts_with("u ") {
            state.conflicted = true;
        } else if text.starts_with("2 ") {
            // Porcelain v2 -z emits a rename/copy's original path as the next
            // NUL record. It is path data, not another status record.
            index = index.saturating_add(1);
        }
    }
    state
}

fn sidebar_scripts_indicator_state(
    app: &AppHandle,
    window_label: &str,
    root: &Path,
) -> SidebarRuntimeIndicatorState {
    let package_error = package_scripts_from(root).err();
    let state = app.state::<PackageTerminalState>();
    let sessions = match state.sessions.lock() {
        Ok(sessions) => sessions,
        Err(_) => {
            return SidebarRuntimeIndicatorState {
                error: Some("package terminal state is poisoned".to_owned()),
                ..SidebarRuntimeIndicatorState::default()
            };
        }
    };
    let mut running_ids = Vec::new();
    let mut failed_ids = Vec::new();
    for (id, session) in sessions.iter().filter(|(_, session)| {
        session.window_label == window_label && session.workspace == root
    }) {
        if session.status == PackageTerminalStatus::Running {
            running_ids.push(id.clone());
        } else if session.status == PackageTerminalStatus::Failed
            || (session.status == PackageTerminalStatus::Exited
                && session.exit_code.is_some_and(|code| code != 0))
        {
            failed_ids.push(id.clone());
        }
    }
    running_ids.sort();
    failed_ids.sort();
    SidebarRuntimeIndicatorState {
        running_ids,
        failed_ids,
        error: package_error,
    }
}

fn sidebar_idx_runtime_indicator_state(
    app: &AppHandle,
    window_label: &str,
    root: &Path,
) -> SidebarRuntimeIndicatorState {
    let state = app.state::<IdxOperationState>();
    let operations = match state.operations.lock() {
        Ok(operations) => operations,
        Err(_) => {
            return SidebarRuntimeIndicatorState {
                error: Some("IDX operation state is poisoned".to_owned()),
                ..SidebarRuntimeIndicatorState::default()
            };
        }
    };
    let mut running_ids = Vec::new();
    let mut failed_ids = Vec::new();
    for (id, operation) in operations.iter().filter(|(_, operation)| {
        operation.window_label == window_label && operation.workspace == root
    }) {
        if operation.status == IdxOperationStatus::Running {
            running_ids.push(id.clone());
        } else if matches!(
            operation.status,
            IdxOperationStatus::Failed | IdxOperationStatus::TimedOut
        ) {
            failed_ids.push(id.clone());
        }
    }
    running_ids.sort();
    failed_ids.sort();
    SidebarRuntimeIndicatorState {
        running_ids,
        failed_ids,
        error: None,
    }
}

fn sidebar_settings_indicator_state(home: &Path) -> SidebarSettingsIndicatorState {
    let mut errors = Vec::new();
    for kind in [UserConfigKind::Pix, UserConfigKind::PiToolsSuite] {
        let path = user_config_path(home, kind);
        if !path.exists() {
            continue;
        }
        let label = match kind {
            UserConfigKind::Pix => "pix.jsonc",
            UserConfigKind::PiToolsSuite => "pi-tools-suite.jsonc",
        };
        let content = match fs::metadata(&path) {
            Ok(metadata) if !metadata.is_file() => {
                errors.push(format!("{label} is not a file"));
                continue;
            }
            Ok(metadata) if metadata.len() > MAX_USER_CONFIG_BYTES => {
                errors.push(format!("{label} is too large to edit"));
                continue;
            }
            Ok(_) => match fs::read_to_string(&path) {
                Ok(content) => content,
                Err(error) => {
                    errors.push(format!("failed to read {label}: {error}"));
                    continue;
                }
            },
            Err(error) => {
                errors.push(format!("failed to inspect {label}: {error}"));
                continue;
            }
        };
        let normalized = match normalize_jsonc(&content) {
            Ok(normalized) => normalized,
            Err(_) => {
                errors.push(format!("{label} contains invalid JSONC"));
                continue;
            }
        };
        match serde_json::from_str::<serde_json::Value>(&normalized) {
            Ok(value) if value.is_object() => {
                if let Ok(schema) = serde_json::from_str::<serde_json::Value>(user_config_schema(kind)) {
                    if let Some(issue) = sidebar_settings_schema_issue(&value, &schema, "$", 24) {
                        errors.push(format!("{label}: {issue}"));
                    }
                }
            }
            Ok(_) => errors.push(format!("{label} must contain a JSON object")),
            Err(error) => errors.push(format!("{label} contains invalid JSONC: {error}")),
        }
    }
    SidebarSettingsIndicatorState { errors }
}

fn sidebar_settings_schema_issue(
    value: &serde_json::Value,
    schema: &serde_json::Value,
    location: &str,
    depth: usize,
) -> Option<String> {
    if depth == 0 {
        return None;
    }
    let schema_object = schema.as_object()?;
    if schema_object
        .get("not")
        .and_then(serde_json::Value::as_object)
        .is_some_and(|not| not.is_empty())
    {
        return Some(format!("{location} is a removed setting"));
    }
    if let Some(expected) = schema_object.get("const") {
        if value != expected {
            return Some(format!("{location} has an unsupported value"));
        }
    }
    if let Some(branches) = schema_object.get("anyOf").and_then(serde_json::Value::as_array) {
        if !branches.iter().any(|branch| {
            sidebar_settings_schema_issue(value, branch, location, depth - 1).is_none()
        }) {
            return Some(format!("{location} does not match any allowed value or type"));
        }
        return None;
    }

    match schema_object.get("type").and_then(serde_json::Value::as_str) {
        Some("object") if !value.is_object() => return Some(format!("{location} must be an object")),
        Some("array") if !value.is_array() => return Some(format!("{location} must be an array")),
        Some("string") if !value.is_string() => return Some(format!("{location} must be a string")),
        Some("boolean") if !value.is_boolean() => return Some(format!("{location} must be a boolean")),
        Some("number") if !value.is_number() => return Some(format!("{location} must be a number")),
        Some("integer") if value.as_i64().is_none() && value.as_u64().is_none() => {
            return Some(format!("{location} must be an integer"));
        }
        _ => {}
    }

    if let Some(number) = value.as_f64() {
        if let Some(minimum) = schema_object.get("minimum").and_then(serde_json::Value::as_f64) {
            if number < minimum {
                return Some(format!("{location} must be >= {minimum}"));
            }
        }
        if let Some(maximum) = schema_object.get("maximum").and_then(serde_json::Value::as_f64) {
            if number > maximum {
                return Some(format!("{location} must be <= {maximum}"));
            }
        }
    }

    if let Some(object) = value.as_object() {
        if let Some(required) = schema_object.get("required").and_then(serde_json::Value::as_array) {
            for key in required.iter().filter_map(serde_json::Value::as_str) {
                if !object.contains_key(key) {
                    return Some(format!("{location}.{key} is required"));
                }
            }
        }
        let properties = schema_object.get("properties").and_then(serde_json::Value::as_object);
        let wildcard = schema_object
            .get("patternProperties")
            .and_then(serde_json::Value::as_object)
            .and_then(|patterns| patterns.get("^.*$"));
        for (key, child_value) in object {
            let child_schema = properties.and_then(|properties| properties.get(key)).or(wildcard);
            let Some(child_schema) = child_schema else {
                continue;
            };
            let child_location = format!("{location}.{key}");
            if let Some(issue) = sidebar_settings_schema_issue(
                child_value,
                child_schema,
                &child_location,
                depth - 1,
            ) {
                return Some(issue);
            }
        }
    } else if let Some(array) = value.as_array() {
        if let Some(items) = schema_object.get("items") {
            for (index, child) in array.iter().enumerate() {
                let child_location = format!("{location}[{index}]");
                if let Some(issue) = sidebar_settings_schema_issue(
                    child,
                    items,
                    &child_location,
                    depth - 1,
                ) {
                    return Some(issue);
                }
            }
        }
    }
    None
}

fn idx_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn idx_executable() -> Result<PathBuf, String> {
    resolve_named_executable("idx").ok_or_else(|| {
        "idx is not available in the Desktop environment; install indexer-cli or expose idx in your login-shell PATH"
            .to_owned()
    })
}

fn idx_process_command(executable: &Path, root: &Path, args: &[String]) -> Command {
    let mut command = Command::new(executable);
    command
        .args(args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("NO_COLOR", "1");
    if let Some(path) = package_process_path(executable) {
        command.env("PATH", path);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command
}

fn read_bounded_idx_stream<R: Read>(mut reader: R, max_bytes: usize) -> (Vec<u8>, bool) {
    let mut retained = Vec::with_capacity(max_bytes.min(16 * 1024));
    let mut truncated = false;
    let mut buffer = [0_u8; 8192];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                let remaining = max_bytes.saturating_sub(retained.len());
                if remaining > 0 {
                    retained.extend_from_slice(&buffer[..read.min(remaining)]);
                }
                if read > remaining {
                    truncated = true;
                }
            }
        }
    }
    (retained, truncated)
}

fn run_idx_command(
    executable: &Path,
    root: &Path,
    args: &[String],
    timeout: Duration,
    max_bytes: usize,
) -> Result<IdxCommandResult, String> {
    let mut command = idx_process_command(executable, root, args);
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start idx {}: {error}", args.join(" ")))?;
    let process_id = child.id();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "idx stdout pipe is unavailable".to_owned())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "idx stderr pipe is unavailable".to_owned())?;
    let stdout_thread = thread::spawn(move || read_bounded_idx_stream(stdout, max_bytes));
    let stderr_thread = thread::spawn(move || read_bounded_idx_stream(stderr, max_bytes));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(POLL_INTERVAL),
            Ok(None) => {
                force_kill_idx_process(process_id, &mut child);
                let _ = child.wait();
                let _ = stdout_thread.join();
                let _ = stderr_thread.join();
                return Err(format!("idx {} timed out", args.join(" ")));
            }
            Err(error) => {
                force_kill_idx_process(process_id, &mut child);
                let _ = child.wait();
                let _ = stdout_thread.join();
                let _ = stderr_thread.join();
                return Err(format!("failed while waiting for idx {}: {error}", args.join(" ")));
            }
        }
    };
    let (stdout, stdout_truncated) = stdout_thread
        .join()
        .map_err(|_| "idx stdout reader panicked".to_owned())?;
    let (stderr, stderr_truncated) = stderr_thread
        .join()
        .map_err(|_| "idx stderr reader panicked".to_owned())?;
    Ok(IdxCommandResult {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        exit_code: status.code(),
        truncated: stdout_truncated || stderr_truncated,
    })
}

fn force_kill_idx_process(process_id: u32, child: &mut Child) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(process_id as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill.exe")
            .args(["/PID", &process_id.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
}

fn interrupt_idx_process(process_id: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(process_id as i32), libc::SIGINT);
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill.exe")
            .args(["/PID", &process_id.to_string(), "/T"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

fn idx_overview_from(workspace: &Path) -> Result<IdxOverview, String> {
    let root = canonical_workspace(workspace)?;
    let initialized = root.join(".indexer-cli").is_dir();
    let executable = match idx_executable() {
        Ok(executable) => executable,
        Err(error) => {
            return Ok(IdxOverview {
                available: false,
                executable: None,
                version: None,
                initialized,
                index_status: None,
                wiki_status: None,
                raw_status: String::new(),
                errors: vec![error],
            });
        }
    };
    let mut errors = Vec::new();
    let version = match run_idx_command(
        &executable,
        &root,
        &["--version".to_owned()],
        IDX_COMMAND_TIMEOUT,
        32 * 1024,
    ) {
        Ok(result) if result.exit_code == Some(0) => result
            .stdout
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(str::to_owned),
        Ok(result) => {
            errors.push(non_empty_idx_error("idx --version failed", &result));
            None
        }
        Err(error) => {
            errors.push(error);
            None
        }
    };

    if !initialized {
        return Ok(IdxOverview {
            available: true,
            executable: Some(executable.to_string_lossy().into_owned()),
            version,
            initialized: false,
            index_status: None,
            wiki_status: None,
            raw_status: String::new(),
            errors,
        });
    }

    let index_result = run_idx_command(
        &executable,
        &root,
        &["index".to_owned(), "--status".to_owned()],
        IDX_COMMAND_TIMEOUT,
        128 * 1024,
    );
    let wiki_result = run_idx_command(
        &executable,
        &root,
        &["wiki".to_owned(), "status".to_owned(), "--candidate-limit".to_owned(), "50".to_owned()],
        IDX_COMMAND_TIMEOUT,
        128 * 1024,
    );
    let mut raw_parts = Vec::new();
    let index_status = match index_result {
        Ok(result) => {
            let text = idx_result_text(&result);
            if result.exit_code != Some(0) {
                errors.push(non_empty_idx_error("idx index --status failed", &result));
            }
            if !text.trim().is_empty() {
                raw_parts.push(text.clone());
                Some(parse_idx_index_status(&text))
            } else {
                None
            }
        }
        Err(error) => {
            errors.push(error);
            None
        }
    };
    let wiki_status = match wiki_result {
        Ok(result) => {
            let text = idx_result_text(&result);
            if result.exit_code != Some(0) {
                errors.push(non_empty_idx_error("idx wiki status failed", &result));
            }
            if !text.trim().is_empty() {
                raw_parts.push(text.clone());
                Some(parse_idx_wiki_status(&text))
            } else {
                None
            }
        }
        Err(error) => {
            errors.push(error);
            None
        }
    };

    Ok(IdxOverview {
        available: true,
        executable: Some(executable.to_string_lossy().into_owned()),
        version,
        initialized: true,
        index_status,
        wiki_status,
        raw_status: raw_parts.join("\n\n"),
        errors,
    })
}

fn non_empty_idx_error(prefix: &str, result: &IdxCommandResult) -> String {
    let detail = result.stderr.trim();
    if detail.is_empty() {
        format!("{prefix} with exit code {}", result.exit_code.unwrap_or(-1))
    } else {
        format!("{prefix}: {detail}")
    }
}

fn idx_result_text(result: &IdxCommandResult) -> String {
    match (result.stdout.trim(), result.stderr.trim()) {
        ("", "") => String::new(),
        (stdout, "") => stdout.to_owned(),
        ("", stderr) => stderr.to_owned(),
        (stdout, stderr) => format!("{stdout}\n{stderr}"),
    }
}

fn parse_idx_index_status(raw: &str) -> IdxParsedStatus {
    let mut fields = BTreeMap::new();
    let mut state = None;
    for line in raw.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if let Some(snapshot) = line.strip_prefix("Snapshot: ") {
            if let Some((identifier, suffix)) = snapshot.rsplit_once(" (") {
                fields.insert("snapshot".to_owned(), identifier.trim().to_owned());
                state = Some(suffix.trim_end_matches(')').trim().to_owned());
            } else {
                fields.insert("snapshot".to_owned(), snapshot.to_owned());
            }
            continue;
        }
        for segment in line.split('|').map(str::trim) {
            let Some((key, value)) = segment.split_once(':') else {
                continue;
            };
            fields.insert(normalize_idx_field_key(key), value.trim().to_owned());
        }
    }
    IdxParsedStatus {
        state,
        fields,
        raw: raw.trim().to_owned(),
    }
}

fn parse_idx_wiki_status(raw: &str) -> IdxParsedStatus {
    let mut fields = BTreeMap::new();
    for line in raw.lines().map(str::trim).filter(|line| !line.is_empty()).take(1) {
        for segment in line.split('|').map(str::trim) {
            let Some((key, value)) = segment.split_once(':') else {
                continue;
            };
            fields.insert(normalize_idx_field_key(key), value.trim().to_owned());
        }
    }
    IdxParsedStatus {
        state: None,
        fields,
        raw: raw.trim().to_owned(),
    }
}

fn normalize_idx_field_key(value: &str) -> String {
    let mut result = String::new();
    let mut uppercase_next = false;
    for character in value.trim().chars() {
        if character.is_ascii_alphanumeric() {
            if result.is_empty() {
                result.push(character.to_ascii_lowercase());
            } else if uppercase_next {
                result.push(character.to_ascii_uppercase());
            } else {
                result.push(character.to_ascii_lowercase());
            }
            uppercase_next = false;
        } else if !result.is_empty() {
            uppercase_next = true;
        }
    }
    result
}

fn non_empty_idx_argument(value: &str, label: &str, max_chars: usize) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} cannot be empty"));
    }
    if trimmed.chars().count() > max_chars || trimmed.contains('\0') {
        return Err(format!("{label} is too long or contains invalid characters"));
    }
    Ok(trimmed.to_owned())
}

fn optional_idx_argument(value: &Option<String>, label: &str, max_chars: usize) -> Result<Option<String>, String> {
    value
        .as_deref()
        .map(|value| non_empty_idx_argument(value, label, max_chars))
        .transpose()
}

fn idx_query_args(query: &IdxQuery) -> Result<Vec<String>, String> {
    match query {
        IdxQuery::Code {
            query,
            mode,
            max_files,
            path_prefix,
            include_content,
        } => {
            let query = non_empty_idx_argument(query, "query", 4_000)?;
            let max_files = (*max_files).clamp(1, MAX_IDX_MAX_FILES.min(50));
            let mode = match mode {
                IdxSearchMode::Hybrid => "hybrid",
                IdxSearchMode::Semantic => "semantic",
                IdxSearchMode::Lexical => "lexical",
                IdxSearchMode::Symbol => "symbol",
            };
            let mut args = vec![
                "search".to_owned(),
                query,
                "--max-files".to_owned(),
                max_files.to_string(),
                "--mode".to_owned(),
                mode.to_owned(),
            ];
            if let Some(prefix) = optional_idx_argument(path_prefix, "path prefix", 1_024)? {
                args.extend(["--path-prefix".to_owned(), prefix]);
            }
            if *include_content {
                args.push("--include-content".to_owned());
            }
            Ok(args)
        }
        IdxQuery::Knowledge {
            query,
            limit,
            include_secondary,
            path_prefix,
        } => {
            let query = non_empty_idx_argument(query, "query", 4_000)?;
            let mut args = vec![
                "wiki".to_owned(),
                "search".to_owned(),
                query,
                "--limit".to_owned(),
                (*limit).clamp(1, MAX_IDX_LIMIT.min(20)).to_string(),
            ];
            if *include_secondary {
                args.push("--include-secondary".to_owned());
            }
            if let Some(prefix) = optional_idx_argument(path_prefix, "path prefix", 1_024)? {
                args.extend(["--path-prefix".to_owned(), prefix]);
            }
            Ok(args)
        }
        IdxQuery::Context {
            query,
            budget,
            max_specs,
            max_code,
            max_tests,
            include_secondary,
            path_prefix,
        } => {
            let query = non_empty_idx_argument(query, "query", 4_000)?;
            let mut args = vec![
                "context".to_owned(),
                query,
                "--budget".to_owned(),
                (*budget).clamp(200, 8_000).to_string(),
                "--max-specs".to_owned(),
                (*max_specs).clamp(1, 20).to_string(),
                "--max-code".to_owned(),
                (*max_code).clamp(1, 30).to_string(),
                "--max-tests".to_owned(),
                (*max_tests).clamp(1, 20).to_string(),
            ];
            if *include_secondary {
                args.push("--include-secondary".to_owned());
            }
            if let Some(prefix) = optional_idx_argument(path_prefix, "path prefix", 1_024)? {
                args.extend(["--path-prefix".to_owned(), prefix]);
            }
            Ok(args)
        }
    }
}

fn idx_inspect_args(request: &IdxInspectRequest) -> Result<Vec<String>, String> {
    let path_prefix = optional_idx_argument(&request.path_prefix, "path prefix", 1_024)?;
    match request.command {
        IdxInspectCommand::Architecture => {
            let mut args = vec!["architecture".to_owned()];
            if let Some(prefix) = path_prefix {
                args.extend(["--path-prefix".to_owned(), prefix]);
            }
            Ok(args)
        }
        IdxInspectCommand::Structure => {
            let mut args = vec![
                "structure".to_owned(),
                "--max-depth".to_owned(),
                request.depth.unwrap_or(2).clamp(1, 8).to_string(),
                "--max-files".to_owned(),
                request.max_files.unwrap_or(40).clamp(1, 300).to_string(),
            ];
            if let Some(prefix) = path_prefix {
                args.extend(["--path-prefix".to_owned(), prefix]);
            }
            Ok(args)
        }
        IdxInspectCommand::Ast => Ok(vec![
            "ast".to_owned(),
            non_empty_idx_argument(
                request.target.as_deref().unwrap_or_default(),
                "AST file path",
                2_048,
            )?,
            "--max-depth".to_owned(),
            request.depth.unwrap_or(4).clamp(1, 8).to_string(),
            "--max-nodes".to_owned(),
            request.max_files.unwrap_or(100).clamp(1, 500).to_string(),
        ]),
        IdxInspectCommand::Explain => {
            let mut args = vec![
                "explain".to_owned(),
                non_empty_idx_argument(
                    request.target.as_deref().unwrap_or_default(),
                    "symbol",
                    1_024,
                )?,
            ];
            if request.include_body == Some(true) {
                args.extend(["--include-body".to_owned(), "--body-lines".to_owned(), "80".to_owned()]);
            } else {
                args.push("--signature-only".to_owned());
            }
            if let Some(prefix) = path_prefix {
                args.extend(["--path-prefix".to_owned(), prefix]);
            }
            Ok(args)
        }
        IdxInspectCommand::Deps => {
            let mut args = vec![
                "deps".to_owned(),
                non_empty_idx_argument(
                    request.target.as_deref().unwrap_or_default(),
                    "dependency target",
                    2_048,
                )?,
                "--depth".to_owned(),
                request.depth.unwrap_or(1).clamp(1, 6).to_string(),
                "--direction".to_owned(),
                "both".to_owned(),
            ];
            if request.show_edges == Some(true) {
                args.push("--show-edges".to_owned());
            }
            if request.tests == Some(true) {
                args.push("--tests".to_owned());
            }
            Ok(args)
        }
    }
}

fn idx_knowledge_args(request: &IdxKnowledgeRequest) -> Result<Vec<String>, String> {
    let path = || optional_idx_argument(&request.path, "knowledge path", 2_048);
    match request.action {
        IdxKnowledgeAction::Show => Ok(vec![
            "wiki".to_owned(),
            "show".to_owned(),
            "--path".to_owned(),
            path()?.ok_or_else(|| "show requires a knowledge path".to_owned())?,
        ]),
        IdxKnowledgeAction::Record => {
            if request.source_reviewed != Some(true) {
                return Err("record requires sourceReviewed=true after reading and classifying the source".to_owned());
            }
            let classification = validated_idx_choice(
                request.classification.as_deref(),
                "classification",
                &["spec", "spec-like", "meta-index", "design-only", "guide", "other"],
            )?;
            let source_path = path()?.ok_or_else(|| "record requires a knowledge path".to_owned())?;
            let mut args = vec![
                "wiki".to_owned(),
                "record".to_owned(),
                "--path".to_owned(),
                source_path,
                "--classification".to_owned(),
                classification.to_owned(),
            ];
            if classification == "spec" || classification == "spec-like" {
                let behavior = validated_idx_choice(
                    request.behavior_type.as_deref(),
                    "behavior type",
                    &["as-is", "change", "mixed", "unknown"],
                )?;
                let lifecycle = validated_idx_choice(
                    request.lifecycle.as_deref(),
                    "lifecycle",
                    &["active", "proposed", "historical", "superseded", "unknown"],
                )?;
                args.extend(["--type".to_owned(), behavior.to_owned(), "--lifecycle".to_owned(), lifecycle.to_owned()]);
            }
            if let Some(confidence) = request.confidence.as_deref() {
                let confidence = validated_idx_choice(
                    Some(confidence),
                    "confidence",
                    &["high", "medium", "low", "unknown"],
                )?;
                args.extend(["--confidence".to_owned(), confidence.to_owned()]);
            }
            if let Some(summary) = optional_idx_argument(&request.summary, "summary", 4_000)? {
                args.extend(["--summary".to_owned(), summary]);
            }
            for topic in normalized_idx_strings(request.topics.as_deref(), "topic", 256, 20)? {
                args.extend(["--topic".to_owned(), topic]);
            }
            Ok(args)
        }
        IdxKnowledgeAction::Verify => {
            if request.evidence_reviewed != Some(true) {
                return Err("verify requires evidenceReviewed=true after reviewing the source and relevant code/tests".to_owned());
            }
            Ok(vec![
                "wiki".to_owned(),
                "verify".to_owned(),
                "--path".to_owned(),
                path()?.ok_or_else(|| "verify requires a knowledge path".to_owned())?,
            ])
        }
        IdxKnowledgeAction::Relate => {
            if request.evidence_reviewed != Some(true) {
                return Err("relate requires evidenceReviewed=true after reviewing concrete evidence".to_owned());
            }
            let source_path = path()?.ok_or_else(|| "relate requires a knowledge path".to_owned())?;
            let relation_kind = validated_idx_choice(
                request.relation_kind.as_deref(),
                "relation kind",
                &["implements", "tests", "related", "supersedes", "superseded-by"],
            )?;
            let relation_action = validated_idx_choice(
                request.relation_action.as_deref(),
                "relation action",
                &["add", "remove"],
            )?;
            let targets = normalized_idx_strings(request.target_paths.as_deref(), "target path", 2_048, 30)?;
            if targets.is_empty() {
                return Err("relate requires at least one target path".to_owned());
            }
            let flag = match (relation_kind, relation_action) {
                ("implements", "add") => "--add-code",
                ("implements", "remove") => "--remove-code",
                ("tests", "add") => "--add-test",
                ("tests", "remove") => "--remove-test",
                ("related", "add") => "--add-related-spec",
                ("related", "remove") => "--remove-related-spec",
                ("supersedes", "add") => "--add-supersedes",
                ("supersedes", "remove") => "--remove-supersedes",
                ("superseded-by", "add") => "--add-superseded-by",
                ("superseded-by", "remove") => "--remove-superseded-by",
                _ => return Err("unsupported relation".to_owned()),
            };
            let mut args = vec![
                "wiki".to_owned(),
                "relate".to_owned(),
                "--path".to_owned(),
                source_path,
            ];
            for target in targets {
                args.extend([flag.to_owned(), target]);
            }
            Ok(args)
        }
        IdxKnowledgeAction::Remove => {
            if request.metadata_only_confirmed != Some(true) {
                return Err("remove requires metadataOnlyConfirmed=true; the source document itself is not deleted".to_owned());
            }
            Ok(vec![
                "wiki".to_owned(),
                "remove".to_owned(),
                "--path".to_owned(),
                path()?.ok_or_else(|| "remove requires a knowledge path".to_owned())?,
            ])
        }
        IdxKnowledgeAction::Impact => {
            let paths = normalized_idx_strings(request.paths.as_deref(), "changed path", 2_048, 100)?;
            let mut args = vec!["wiki".to_owned(), "impact".to_owned()];
            args.extend(paths);
            if let Some(base) = optional_idx_argument(&request.base, "git base", 256)? {
                args.extend(["--base".to_owned(), base]);
            }
            args.extend(["--semantic-limit".to_owned(), "10".to_owned()]);
            if request.semantic == Some(false) {
                args.push("--no-semantic".to_owned());
            }
            Ok(args)
        }
    }
}

fn validated_idx_choice<'a>(
    value: Option<&'a str>,
    label: &str,
    allowed: &[&str],
) -> Result<&'a str, String> {
    let value = value.ok_or_else(|| format!("{label} is required"))?;
    if allowed.contains(&value) {
        Ok(value)
    } else {
        Err(format!("invalid {label}"))
    }
}

fn normalized_idx_strings(
    values: Option<&[String]>,
    label: &str,
    max_chars: usize,
    max_items: usize,
) -> Result<Vec<String>, String> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for value in values.unwrap_or_default().iter().take(max_items + 1) {
        if result.len() >= max_items {
            return Err(format!("too many {label} values"));
        }
        let value = non_empty_idx_argument(value, label, max_chars)?;
        if seen.insert(value.clone()) {
            result.push(value);
        }
    }
    Ok(result)
}

fn idx_operation_args(kind: IdxMaintenanceKind) -> Vec<String> {
    match kind {
        IdxMaintenanceKind::Init => vec!["init".to_owned()],
        IdxMaintenanceKind::Index => vec!["index".to_owned()],
        IdxMaintenanceKind::FullIndex => vec!["index".to_owned(), "--full".to_owned()],
        IdxMaintenanceKind::DryRun => vec!["index".to_owned(), "--dry-run".to_owned()],
        IdxMaintenanceKind::Doctor => vec!["doctor".to_owned(), "--force".to_owned(), ".".to_owned()],
        IdxMaintenanceKind::WikiAudit => vec![
            "wiki".to_owned(),
            "audit".to_owned(),
            "--candidate-limit".to_owned(),
            "100".to_owned(),
        ],
        IdxMaintenanceKind::WikiDiscover => vec![
            "wiki".to_owned(),
            "discover".to_owned(),
            "--limit".to_owned(),
            "200".to_owned(),
        ],
        IdxMaintenanceKind::WikiCatalog => vec!["wiki".to_owned(), "catalog".to_owned()],
    }
}

fn idx_operation_snapshot(id: &str, operation: &IdxOperationRecord) -> IdxOperationSnapshot {
    IdxOperationSnapshot {
        id: id.to_owned(),
        window_label: operation.window_label.clone(),
        workspace: operation.workspace.to_string_lossy().into_owned(),
        kind: operation.kind,
        command: operation.command.clone(),
        status: operation.status,
        output: operation.output.clone(),
        started_at_ms: operation.started_at_ms,
        finished_at_ms: operation.finished_at_ms,
        exit_code: operation.exit_code,
    }
}

fn idx_operation_snapshots(
    app: &AppHandle,
    window_label: &str,
    workspace: &Path,
) -> Result<Vec<IdxOperationSnapshot>, String> {
    let state = app.state::<IdxOperationState>();
    let operations = state
        .operations
        .lock()
        .map_err(|_| "IDX operation state is poisoned".to_owned())?;
    let mut snapshots = operations
        .iter()
        .filter(|(_, operation)| operation.window_label == window_label && operation.workspace == workspace)
        .map(|(id, operation)| idx_operation_snapshot(id, operation))
        .collect::<Vec<_>>();
    snapshots.sort_by_key(|snapshot| snapshot.started_at_ms);
    Ok(snapshots)
}

fn prune_idx_operation_history(operations: &mut HashMap<String, IdxOperationRecord>, window_label: &str) {
    let count = operations
        .values()
        .filter(|operation| operation.window_label == window_label)
        .count();
    if count < MAX_IDX_OPERATIONS_PER_WINDOW {
        return;
    }
    let mut completed = operations
        .iter()
        .filter(|(_, operation)| operation.window_label == window_label && operation.status != IdxOperationStatus::Running)
        .map(|(id, operation)| (id.clone(), operation.started_at_ms))
        .collect::<Vec<_>>();
    completed.sort_by_key(|(_, started_at_ms)| *started_at_ms);
    let remove_count = count - MAX_IDX_OPERATIONS_PER_WINDOW + 1;
    for (id, _) in completed.into_iter().take(remove_count) {
        operations.remove(&id);
    }
}

fn start_idx_operation(app: AppHandle, request: IdxOperationRequest) -> Result<IdxOperationSnapshot, String> {
    let root = canonical_workspace(Path::new(&request.workspace))?;
    if request.kind != IdxMaintenanceKind::Init && !root.join(".indexer-cli").is_dir() {
        return Err("this project is not indexed yet; initialize IDX first".to_owned());
    }
    let executable = idx_executable()?;
    let args = idx_operation_args(request.kind);
    let command_label = format!("idx {}", args.join(" "));
    let mut command = idx_process_command(&executable, &root, &args);
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start {command_label}: {error}"))?;
    let process_id = child.id();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "IDX operation stdout pipe is unavailable".to_owned())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "IDX operation stderr pipe is unavailable".to_owned())?;
    let state = app.state::<IdxOperationState>();
    let id = format!(
        "idx-operation-{}",
        state.next_id.fetch_add(1, Ordering::AcqRel).wrapping_add(1)
    );
    let (stop_tx, stop_rx) = mpsc::channel();
    let exited = Arc::new((Mutex::new(false), Condvar::new()));
    let operation_conflict = {
        let mut operations = state
            .operations
            .lock()
            .map_err(|_| "IDX operation state is poisoned".to_owned())?;
        if operations.values().any(|operation| {
            operation.workspace == root && operation.status == IdxOperationStatus::Running
        }) {
            true
        } else {
            prune_idx_operation_history(&mut operations, &request.window_label);
            operations.insert(
                id.clone(),
                IdxOperationRecord {
                    window_label: request.window_label.clone(),
                    workspace: root.clone(),
                    kind: request.kind,
                    command: command_label,
                    status: IdxOperationStatus::Running,
                    output: String::new(),
                    started_at_ms: idx_now_ms(),
                    finished_at_ms: None,
                    exit_code: None,
                    stop_tx: Some(stop_tx),
                    exited: exited.clone(),
                },
            );
            false
        }
    };
    if operation_conflict {
        // Never reap a process while holding the operation registry lock: the
        // running operation's output/supervisor and Activity Bar polling also
        // need that mutex to make progress.
        force_kill_idx_process(process_id, &mut child);
        let _ = child.wait();
        return Err("another IDX maintenance operation is already running for this project".to_owned());
    }

    let stdout_app = app.clone();
    let stdout_id = id.clone();
    let stdout_window = request.window_label.clone();
    thread::spawn(move || stream_idx_operation_output(stdout_app, stdout_window, stdout_id, "stdout", stdout));
    let stderr_app = app.clone();
    let stderr_id = id.clone();
    let stderr_window = request.window_label.clone();
    thread::spawn(move || stream_idx_operation_output(stderr_app, stderr_window, stderr_id, "stderr", stderr));
    let supervisor_app = app.clone();
    let supervisor_id = id.clone();
    let supervisor_window = request.window_label.clone();
    thread::spawn(move || {
        supervise_idx_operation(
            supervisor_app,
            supervisor_window,
            supervisor_id,
            child,
            process_id,
            stop_rx,
            exited,
        )
    });

    let operations = state
        .operations
        .lock()
        .map_err(|_| "IDX operation state is poisoned".to_owned())?;
    operations
        .get(&id)
        .map(|operation| idx_operation_snapshot(&id, operation))
        .ok_or_else(|| "IDX operation disappeared during startup".to_owned())
}

fn stream_idx_operation_output<R: Read + Send + 'static>(
    app: AppHandle,
    window_label: String,
    operation_id: String,
    stream: &'static str,
    mut reader: R,
) {
    let mut buffer = [0_u8; 8192];
    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        let chunk = String::from_utf8_lossy(&buffer[..read]).into_owned();
        append_idx_operation_output(&app, &operation_id, &chunk);
        let _ = app.emit_to(
            &window_label,
            "idx://operation-output",
            IdxOperationOutputEvent {
                operation_id: operation_id.clone(),
                stream: stream.to_owned(),
                chunk,
            },
        );
    }
}

fn append_idx_operation_output(app: &AppHandle, operation_id: &str, chunk: &str) {
    let state = app.state::<IdxOperationState>();
    let Ok(mut operations) = state.operations.lock() else {
        return;
    };
    let Some(operation) = operations.get_mut(operation_id) else {
        return;
    };
    operation.output.push_str(chunk);
    if operation.output.len() > MAX_IDX_LOG_BYTES {
        let excess = operation.output.len() - MAX_IDX_LOG_BYTES;
        let mut start = excess;
        while start < operation.output.len() && !operation.output.is_char_boundary(start) {
            start += 1;
        }
        operation.output.drain(..start);
    }
}

fn supervise_idx_operation(
    app: AppHandle,
    window_label: String,
    operation_id: String,
    mut child: Child,
    process_id: u32,
    stop_rx: mpsc::Receiver<()>,
    exited: ExitSignal,
) {
    let started = Instant::now();
    let mut cancelled = false;
    let mut timed_out = false;
    let mut force_at = None;
    let status = loop {
        if !cancelled && stop_rx.try_recv().is_ok() {
            cancelled = true;
            interrupt_idx_process(process_id);
            force_at = Some(Instant::now() + IDX_STOP_GRACE);
        }
        if !timed_out && started.elapsed() >= IDX_OPERATION_TIMEOUT {
            timed_out = true;
            force_kill_idx_process(process_id, &mut child);
        } else if force_at.is_some_and(|deadline| Instant::now() >= deadline) {
            force_at = None;
            force_kill_idx_process(process_id, &mut child);
        }
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => thread::sleep(POLL_INTERVAL),
            Err(_) => break None,
        }
    };
    let exit_code = status.as_ref().and_then(ExitStatus::code);
    let final_status = if timed_out {
        IdxOperationStatus::TimedOut
    } else if cancelled {
        IdxOperationStatus::Cancelled
    } else if status.as_ref().is_some_and(ExitStatus::success) {
        IdxOperationStatus::Succeeded
    } else {
        IdxOperationStatus::Failed
    };
    let state = app.state::<IdxOperationState>();
    if let Ok(mut operations) = state.operations.lock() {
        if let Some(operation) = operations.get_mut(&operation_id) {
            operation.status = final_status;
            operation.finished_at_ms = Some(idx_now_ms());
            operation.exit_code = exit_code;
            operation.stop_tx = None;
        }
    }
    let _ = app.emit_to(
        &window_label,
        "idx://operation-exit",
        IdxOperationExitEvent {
            operation_id,
            status: final_status,
            exit_code,
        },
    );
    let (lock, wake) = &*exited;
    if let Ok(mut done) = lock.lock() {
        *done = true;
        wake.notify_all();
    }
}

fn stop_idx_operation(app: &AppHandle, window_label: &str, operation_id: &str) -> Result<(), String> {
    let (stop_tx, exited) = {
        let state = app.state::<IdxOperationState>();
        let operations = state
            .operations
            .lock()
            .map_err(|_| "IDX operation state is poisoned".to_owned())?;
        let operation = operations
            .get(operation_id)
            .ok_or_else(|| "IDX operation no longer exists".to_owned())?;
        if operation.window_label != window_label {
            return Err("IDX operation belongs to another window".to_owned());
        }
        if operation.status != IdxOperationStatus::Running {
            return Ok(());
        }
        (operation.stop_tx.clone(), operation.exited.clone())
    };
    if let Some(stop_tx) = stop_tx {
        let _ = stop_tx.send(());
    }
    if wait_for_exit(&exited, IDX_STOP_GRACE + Duration::from_secs(5))? {
        Ok(())
    } else {
        Err("timed out waiting for IDX operation to stop".to_owned())
    }
}

fn stop_idx_operations_for_workspace(
    app: &AppHandle,
    window_label: &str,
    workspace: &Path,
) -> Result<(), String> {
    let ids = {
        let state = app.state::<IdxOperationState>();
        let operations = state
            .operations
            .lock()
            .map_err(|_| "IDX operation state is poisoned".to_owned())?;
        operations
            .iter()
            .filter(|(_, operation)| {
                operation.window_label == window_label
                    && operation.workspace == workspace
                    && operation.status == IdxOperationStatus::Running
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>()
    };
    for id in ids {
        let _ = stop_idx_operation(app, window_label, &id);
    }
    Ok(())
}

fn stop_idx_operations_for_window(app: &AppHandle, window_label: &str) {
    let operations = {
        let state = app.state::<IdxOperationState>();
        let Ok(operations) = state.operations.lock() else {
            return;
        };
        operations
            .iter()
            .filter(|(_, operation)| {
                operation.window_label == window_label && operation.status == IdxOperationStatus::Running
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>()
    };
    for id in operations {
        let _ = stop_idx_operation(app, window_label, &id);
    }
    if let Ok(mut operations) = app.state::<IdxOperationState>().operations.lock() {
        operations.retain(|_, operation| operation.window_label != window_label);
    }
}

fn stop_all_idx_operations(app: &AppHandle) {
    let targets = {
        let state = app.state::<IdxOperationState>();
        let Ok(operations) = state.operations.lock() else {
            return;
        };
        operations
            .iter()
            .filter(|(_, operation)| operation.status == IdxOperationStatus::Running)
            .map(|(id, operation)| (operation.window_label.clone(), id.clone()))
            .collect::<Vec<_>>()
    };
    for (window_label, id) in targets {
        let _ = stop_idx_operation(app, &window_label, &id);
    }
}

fn package_scripts_from(workspace: &Path) -> Result<PackageScriptsSnapshot, String> {
    let root = canonical_workspace(workspace)?;
    let requested = root.join("package.json");
    if !requested.exists() {
        return Ok(PackageScriptsSnapshot {
            package_path: requested.to_string_lossy().into_owned(),
            exists: false,
            package_name: None,
            package_manager: detect_package_manager(&root, None),
            scripts: Vec::new(),
        });
    }
    let package_path = fs::canonicalize(&requested)
        .map_err(|error| format!("failed to resolve {}: {error}", requested.display()))?;
    if !package_path.starts_with(&root) {
        return Err("package.json resolves outside the workspace".to_owned());
    }
    let metadata = fs::metadata(&package_path)
        .map_err(|error| format!("failed to inspect {}: {error}", package_path.display()))?;
    if !metadata.is_file() {
        return Err(format!("{} is not a file", package_path.display()));
    }
    if metadata.len() > MAX_PACKAGE_JSON_BYTES {
        return Err(format!(
            "package.json is too large to inspect (maximum {} MB)",
            MAX_PACKAGE_JSON_BYTES / (1024 * 1024)
        ));
    }
    let source = fs::read_to_string(&package_path)
        .map_err(|error| format!("failed to read {}: {error}", package_path.display()))?;
    let parsed: serde_json::Value = serde_json::from_str(&source)
        .map_err(|error| format!("package.json is invalid JSON: {error}"))?;
    let root_object = parsed
        .as_object()
        .ok_or_else(|| "package.json root must be an object".to_owned())?;
    let package_name = root_object
        .get("name")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let mut scripts = root_object
        .get("scripts")
        .and_then(serde_json::Value::as_object)
        .map(|scripts| {
            scripts
                .iter()
                .filter_map(|(name, value)| {
                    value.as_str().map(|command| PackageScript {
                        name: name.clone(),
                        command: command.to_owned(),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    scripts.sort_by(|left, right| left.name.cmp(&right.name));
    let package_manager = detect_package_manager(&root, root_object.get("packageManager"));
    Ok(PackageScriptsSnapshot {
        package_path: package_path.to_string_lossy().into_owned(),
        exists: true,
        package_name,
        package_manager,
        scripts,
    })
}

fn detect_package_manager(
    root: &Path,
    configured: Option<&serde_json::Value>,
) -> PackageManagerKind {
    if let Some(value) = configured.and_then(serde_json::Value::as_str) {
        let normalized = value.trim().to_ascii_lowercase();
        if normalized == "pnpm" || normalized.starts_with("pnpm@") {
            return PackageManagerKind::Pnpm;
        }
        if normalized == "yarn" || normalized.starts_with("yarn@") {
            return PackageManagerKind::Yarn;
        }
        if normalized == "bun" || normalized.starts_with("bun@") {
            return PackageManagerKind::Bun;
        }
        if normalized == "npm" || normalized.starts_with("npm@") {
            return PackageManagerKind::Npm;
        }
    }
    if root.join("pnpm-lock.yaml").is_file() {
        PackageManagerKind::Pnpm
    } else if root.join("yarn.lock").is_file() {
        PackageManagerKind::Yarn
    } else if root.join("bun.lock").is_file() || root.join("bun.lockb").is_file() {
        PackageManagerKind::Bun
    } else {
        PackageManagerKind::Npm
    }
}

fn package_terminal_snapshots(
    app: &AppHandle,
    window_label: &str,
    workspace: &Path,
) -> Result<Vec<PackageTerminalSnapshot>, String> {
    let state = app.state::<PackageTerminalState>();
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "package terminal state is poisoned".to_owned())?;
    let mut snapshots = sessions
        .iter()
        .filter(|(_, session)| {
            session.window_label == window_label && session.workspace == workspace
        })
        .map(|(id, session)| package_terminal_snapshot(id, session))
        .collect::<Vec<_>>();
    snapshots.sort_by_key(|snapshot| snapshot.started_at_ms);
    Ok(snapshots)
}

fn package_terminal_snapshot(
    id: &str,
    session: &PackageTerminalSession,
) -> PackageTerminalSnapshot {
    PackageTerminalSnapshot {
        id: id.to_owned(),
        kind: session.kind,
        script: session.script.clone(),
        command: session.command.clone(),
        status: session.status,
        exit_code: session.exit_code,
        signal: session.signal.clone(),
        output_base64: BASE64.encode(&session.output),
        started_at_ms: session.started_at_ms,
    }
}

fn start_package_terminal(
    app: AppHandle,
    window_label: String,
    workspace: PathBuf,
    script: String,
    cols: u16,
    rows: u16,
) -> Result<PackageTerminalSnapshot, String> {
    let root = canonical_workspace(&workspace)?;
    let package = package_scripts_from(&root)?;
    package
        .scripts
        .iter()
        .find(|candidate| candidate.name == script)
        .ok_or_else(|| format!("package.json has no script named {script:?}"))?;
    let launcher = resolve_package_manager_launcher(package.package_manager)?;
    let mut command = package_command_builder(&launcher, package.package_manager, &script)?;
    if let Some(path) = package_process_path(&launcher.executable) {
        command.env("PATH", path);
    }
    let command_label = package_manager_command_label(package.package_manager, &script);
    spawn_package_terminal(
        app,
        window_label,
        root,
        PackageTerminalKind::Script,
        script,
        command_label,
        command,
        cols,
        rows,
    )
}

fn start_shell_terminal(
    app: AppHandle,
    window_label: String,
    workspace: PathBuf,
    cols: u16,
    rows: u16,
) -> Result<PackageTerminalSnapshot, String> {
    let root = canonical_workspace(&workspace)?;
    let (mut command, label, command_label) = shell_terminal_command()?;
    if let Some(path) = login_shell_path().or_else(|| env::var_os("PATH")) {
        command.env("PATH", path);
    }
    spawn_package_terminal(
        app,
        window_label,
        root,
        PackageTerminalKind::Shell,
        label,
        command_label,
        command,
        cols,
        rows,
    )
}

fn spawn_package_terminal(
    app: AppHandle,
    window_label: String,
    root: PathBuf,
    kind: PackageTerminalKind,
    label: String,
    command_label: String,
    mut command: CommandBuilder,
    cols: u16,
    rows: u16,
) -> Result<PackageTerminalSnapshot, String> {
    let size = validated_terminal_size(cols, rows)?;
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(size)
        .map_err(|error| format!("failed to create terminal: {error}"))?;
    command.cwd(&root);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "Pix");
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("failed to start {command_label}: {error}"))?;
    let process_id = child.process_id();
    #[cfg(unix)]
    let process_group_leader = pair.master.process_group_leader();
    #[cfg(not(unix))]
    let process_group_leader: Option<i32> = None;
    let killer = Arc::new(Mutex::new(child.clone_killer()));
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("failed to read package terminal: {error}"))?;
    let writer =
        Arc::new(Mutex::new(pair.master.take_writer().map_err(|error| {
            format!("failed to open package terminal input: {error}")
        })?));
    let master = Arc::new(Mutex::new(pair.master));
    let exited = Arc::new((Mutex::new(false), Condvar::new()));
    let started_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64;
    let state = app.state::<PackageTerminalState>();
    let id = format!(
        "pkg-terminal-{}",
        state.next_id.fetch_add(1, Ordering::AcqRel).wrapping_add(1)
    );
    let terminal_limit_reached = {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "package terminal state is poisoned".to_owned())?;
        prune_package_terminal_history(&mut sessions, &window_label);
        let running_count = sessions
            .values()
            .filter(|session| session.window_label == window_label && session.running.is_some())
            .count();
        if running_count >= MAX_RUNNING_PACKAGE_TERMINALS_PER_WINDOW {
            true
        } else {
            sessions.insert(
                id.clone(),
                PackageTerminalSession {
                    window_label: window_label.clone(),
                    workspace: root.clone(),
                    kind,
                    script: label,
                    command: command_label.clone(),
                    started_at_ms,
                    status: PackageTerminalStatus::Running,
                    exit_code: None,
                    signal: None,
                    stop_requested: false,
                    output: Vec::new(),
                    running: Some(PackageTerminalRunning {
                        master: master.clone(),
                        writer: writer.clone(),
                        killer: killer.clone(),
                        exited: exited.clone(),
                        process_id,
                        process_group_leader,
                    }),
                },
            );
            false
        }
    };
    if terminal_limit_reached {
        // Reaping a rejected process can block; release the shared terminal
        // registry first so output/exit bookkeeping and sidebar polling remain live.
        let mut child = child;
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!(
            "at most {MAX_RUNNING_PACKAGE_TERMINALS_PER_WINDOW} package terminals may run at once"
        ));
    }

    let output_app = app.clone();
    let output_id = id.clone();
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    append_package_terminal_output(&output_app, &output_id, &buffer[..read])
                }
                Err(_) => break,
            }
        }
    });

    let supervisor_app = app.clone();
    let supervisor_id = id.clone();
    thread::spawn(move || supervise_package_terminal(supervisor_app, supervisor_id, child, exited));

    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "package terminal state is poisoned".to_owned())?;
    sessions
        .get(&id)
        .map(|session| package_terminal_snapshot(&id, session))
        .ok_or_else(|| "package terminal disappeared during startup".to_owned())
}

#[cfg(unix)]
fn shell_terminal_command() -> Result<(CommandBuilder, String, String), String> {
    let executable = env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.is_file())
        .unwrap_or_else(|| PathBuf::from("/bin/sh"));
    let label = executable
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("shell")
        .to_owned();
    let command_label = executable.to_string_lossy().into_owned();
    Ok((CommandBuilder::new(executable), label, command_label))
}

#[cfg(windows)]
fn shell_terminal_command() -> Result<(CommandBuilder, String, String), String> {
    let executable = env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into());
    let path = PathBuf::from(&executable);
    let label = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("cmd")
        .to_owned();
    let command_label = path.to_string_lossy().into_owned();
    Ok((CommandBuilder::new(executable), label, command_label))
}

fn package_manager_command_label(manager: PackageManagerKind, script: &str) -> String {
    format!("{} run {}", manager.executable(), script)
}

#[cfg(not(windows))]
fn package_command_builder(
    launcher: &PackageManagerLauncher,
    _manager: PackageManagerKind,
    script: &str,
) -> Result<CommandBuilder, String> {
    let mut command = CommandBuilder::new(&launcher.executable);
    command.args(&launcher.prefix_args);
    command.arg("run");
    command.arg(script);
    Ok(command)
}

#[cfg(windows)]
fn package_command_builder(
    launcher: &PackageManagerLauncher,
    _manager: PackageManagerKind,
    script: &str,
) -> Result<CommandBuilder, String> {
    if !script
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || "-_.:@/".contains(character))
    {
        return Err("this package script name contains characters that cannot be launched safely on Windows".to_owned());
    }
    let executable = launcher.executable.to_string_lossy();
    if executable.contains('"') || executable.contains('%') {
        return Err("package manager path cannot be launched safely by cmd.exe".to_owned());
    }
    let prefix = if launcher.prefix_args.is_empty() {
        String::new()
    } else {
        format!(" {}", launcher.prefix_args.join(" "))
    };
    let command_line = format!("\"{}\"{} run {}", executable, prefix, script);
    let shell = env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into());
    let mut command = CommandBuilder::new(shell);
    command.arg("/D");
    command.arg("/S");
    command.arg("/C");
    command.arg(command_line);
    Ok(command)
}

fn validated_terminal_size(cols: u16, rows: u16) -> Result<PtySize, String> {
    if !(2..=500).contains(&cols) || !(1..=300).contains(&rows) {
        return Err("terminal size is outside the supported range".to_owned());
    }
    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}

fn resolve_package_manager_launcher(
    manager: PackageManagerKind,
) -> Result<PackageManagerLauncher, String> {
    let name = manager.executable();
    if let Some(executable) = resolve_named_executable(name) {
        return Ok(PackageManagerLauncher {
            executable,
            prefix_args: Vec::new(),
        });
    }

    if matches!(manager, PackageManagerKind::Pnpm | PackageManagerKind::Yarn) {
        if let Some(executable) = resolve_named_executable("corepack") {
            return Ok(PackageManagerLauncher {
                executable,
                prefix_args: vec![name.to_owned()],
            });
        }
    }

    Err(format!(
        "could not find {name} in the Desktop environment; install it or make it available in your login shell PATH"
    ))
}

fn resolve_named_executable(name: &str) -> Option<PathBuf> {
    if let Some(path) = executable_in_current_path(name) {
        return Some(path);
    }

    #[cfg(unix)]
    {
        let shell = env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into());
        let lookup = format!("command -v {name}");
        if let Ok(output) = Command::new(shell).args(["-lc", &lookup]).output() {
            if output.status.success() {
                if let Some(line) = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .map(str::trim)
                    .find(|line| !line.is_empty())
                {
                    let path = PathBuf::from(line);
                    if path.is_absolute() && path.is_file() {
                        return Some(path);
                    }
                }
            }
        }
    }

    #[cfg(windows)]
    {
        for candidate in [
            format!("{name}.cmd"),
            format!("{name}.exe"),
            name.to_owned(),
        ] {
            if let Ok(output) = Command::new("where.exe").arg(&candidate).output() {
                if !output.status.success() {
                    continue;
                }
                if let Some(line) = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .map(str::trim)
                    .find(|line| !line.is_empty())
                {
                    let path = PathBuf::from(line);
                    if path.is_file() {
                        return Some(path);
                    }
                }
            }
        }
    }

    None
}

fn executable_in_current_path(name: &str) -> Option<PathBuf> {
    let paths = env::var_os("PATH")?;
    for directory in env::split_paths(&paths) {
        #[cfg(windows)]
        let candidates = [
            directory.join(format!("{name}.cmd")),
            directory.join(format!("{name}.exe")),
            directory.join(name),
        ];
        #[cfg(not(windows))]
        let candidates = [directory.join(name)];
        for candidate in candidates {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn package_process_path(executable: &Path) -> Option<std::ffi::OsString> {
    let parent = executable.parent()?;
    let mut paths = vec![parent.to_path_buf()];
    let inherited_path = login_shell_path().or_else(|| env::var_os("PATH"));
    if let Some(existing) = inherited_path {
        paths.extend(env::split_paths(&existing));
    }
    env::join_paths(paths).ok()
}

#[cfg(unix)]
fn login_shell_path() -> Option<std::ffi::OsString> {
    let shell = env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into());
    let output = Command::new(shell)
        .args(["-lc", "printf '%s\\n' \"$PATH\""])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .rev()
        .find(|line| !line.is_empty())
        .map(std::ffi::OsString::from)
}

#[cfg(not(unix))]
fn login_shell_path() -> Option<std::ffi::OsString> {
    None
}

fn prune_package_terminal_history(
    sessions: &mut HashMap<String, PackageTerminalSession>,
    window_label: &str,
) {
    let count = sessions
        .values()
        .filter(|session| session.window_label == window_label)
        .count();
    if count < MAX_PACKAGE_TERMINALS_PER_WINDOW {
        return;
    }
    let mut completed = sessions
        .iter()
        .filter(|(_, session)| session.window_label == window_label && session.running.is_none())
        .map(|(id, session)| (id.clone(), session.started_at_ms))
        .collect::<Vec<_>>();
    completed.sort_by_key(|(_, started_at_ms)| *started_at_ms);
    let remove_count = count - MAX_PACKAGE_TERMINALS_PER_WINDOW + 1;
    for (id, _) in completed.into_iter().take(remove_count) {
        sessions.remove(&id);
    }
}

fn append_package_terminal_output(app: &AppHandle, terminal_id: &str, data: &[u8]) {
    let state = app.state::<PackageTerminalState>();
    let window_label = {
        let Ok(mut sessions) = state.sessions.lock() else {
            return;
        };
        let Some(session) = sessions.get_mut(terminal_id) else {
            return;
        };
        if data.len() >= MAX_PACKAGE_TERMINAL_OUTPUT_BYTES {
            session.output.clear();
            session
                .output
                .extend_from_slice(&data[data.len() - MAX_PACKAGE_TERMINAL_OUTPUT_BYTES..]);
        } else {
            let overflow = session
                .output
                .len()
                .saturating_add(data.len())
                .saturating_sub(MAX_PACKAGE_TERMINAL_OUTPUT_BYTES);
            if overflow > 0 {
                session.output.drain(..overflow.min(session.output.len()));
            }
            session.output.extend_from_slice(data);
        }
        session.window_label.clone()
    };
    let _ = app.emit_to(
        &window_label,
        "package-terminal://output",
        PackageTerminalOutputEvent {
            terminal_id: terminal_id.to_owned(),
            data_base64: BASE64.encode(data),
        },
    );
}

fn supervise_package_terminal(
    app: AppHandle,
    terminal_id: String,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    exited: ExitSignal,
) {
    let result = child.wait();
    let (window_label, status, exit_code, signal) = {
        let state = app.state::<PackageTerminalState>();
        let Ok(mut sessions) = state.sessions.lock() else {
            signal_exit(&exited);
            return;
        };
        let Some(session) = sessions.get_mut(&terminal_id) else {
            signal_exit(&exited);
            return;
        };
        let (status, exit_code, signal) = match result {
            Ok(exit) => (
                if session.stop_requested {
                    PackageTerminalStatus::Stopped
                } else {
                    PackageTerminalStatus::Exited
                },
                Some(exit.exit_code()),
                exit.signal().map(str::to_owned),
            ),
            Err(error) => {
                append_terminal_error_line(
                    &mut session.output,
                    &format!("terminal wait failed: {error}"),
                );
                (PackageTerminalStatus::Failed, None, None)
            }
        };
        session.status = status;
        session.exit_code = exit_code;
        session.signal = signal.clone();
        session.running = None;
        (session.window_label.clone(), status, exit_code, signal)
    };
    let _ = app.emit_to(
        &window_label,
        "package-terminal://exit",
        PackageTerminalExitEvent {
            terminal_id,
            status,
            exit_code,
            signal,
        },
    );
    signal_exit(&exited);
}

fn signal_exit(exited: &ExitSignal) {
    let (lock, wake) = &**exited;
    if let Ok(mut done) = lock.lock() {
        *done = true;
        wake.notify_all();
    }
}

fn append_terminal_error_line(output: &mut Vec<u8>, message: &str) {
    let line = format!("\r\n[pix] {message}\r\n");
    let overflow = output
        .len()
        .saturating_add(line.len())
        .saturating_sub(MAX_PACKAGE_TERMINAL_OUTPUT_BYTES);
    if overflow > 0 {
        output.drain(..overflow.min(output.len()));
    }
    output.extend_from_slice(line.as_bytes());
}

fn write_package_terminal(
    app: &AppHandle,
    window_label: &str,
    terminal_id: &str,
    data: &[u8],
) -> Result<(), String> {
    let writer = {
        let state = app.state::<PackageTerminalState>();
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "package terminal state is poisoned".to_owned())?;
        let session = package_terminal_for_window(&sessions, window_label, terminal_id)?;
        let running = session
            .running
            .as_ref()
            .ok_or_else(|| "package terminal is not running".to_owned())?;
        running.writer.clone()
    };
    let mut writer = writer
        .lock()
        .map_err(|_| "package terminal input is poisoned".to_owned())?;
    writer
        .write_all(data)
        .and_then(|()| writer.flush())
        .map_err(|error| format!("failed to write package terminal input: {error}"))
}

fn resize_package_terminal(
    app: &AppHandle,
    window_label: &str,
    terminal_id: &str,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let size = validated_terminal_size(cols, rows)?;
    let master = {
        let state = app.state::<PackageTerminalState>();
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "package terminal state is poisoned".to_owned())?;
        let session = package_terminal_for_window(&sessions, window_label, terminal_id)?;
        let running = session
            .running
            .as_ref()
            .ok_or_else(|| "package terminal is not running".to_owned())?;
        running.master.clone()
    };
    let result = master
        .lock()
        .map_err(|_| "package terminal PTY state is poisoned".to_owned())?
        .resize(size)
        .map_err(|error| format!("failed to resize package terminal: {error}"));
    result
}

fn package_terminal_for_window<'a>(
    sessions: &'a HashMap<String, PackageTerminalSession>,
    window_label: &str,
    terminal_id: &str,
) -> Result<&'a PackageTerminalSession, String> {
    let session = sessions
        .get(terminal_id)
        .ok_or_else(|| "package terminal no longer exists".to_owned())?;
    if session.window_label != window_label {
        return Err("package terminal belongs to another window".to_owned());
    }
    Ok(session)
}

fn stop_package_terminal(
    app: &AppHandle,
    window_label: &str,
    terminal_id: &str,
    force: bool,
) -> Result<(), String> {
    let (writer, killer, exited, process_id, process_group_leader) = {
        let state = app.state::<PackageTerminalState>();
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "package terminal state is poisoned".to_owned())?;
        let session = sessions
            .get_mut(terminal_id)
            .ok_or_else(|| "package terminal no longer exists".to_owned())?;
        if session.window_label != window_label {
            return Err("package terminal belongs to another window".to_owned());
        }
        let Some(running) = session.running.as_ref() else {
            return Ok(());
        };
        session.stop_requested = true;
        (
            running.writer.clone(),
            running.killer.clone(),
            running.exited.clone(),
            running.process_id,
            running.process_group_leader,
        )
    };

    if !force {
        // Never wait behind a blocked stdin write just to deliver Ctrl+C. If
        // the writer is busy, skip the polite interrupt and let the normal
        // grace period advance to process-tree termination.
        if let Ok(mut writer) = writer.try_lock() {
            let _ = writer.write_all(b"\x03");
            let _ = writer.flush();
        }
        if wait_for_exit(&exited, PACKAGE_TERMINAL_STOP_GRACE)? {
            return Ok(());
        }
    }
    force_kill_package_terminal(process_group_leader, process_id, &killer);
    if wait_for_exit(&exited, PACKAGE_TERMINAL_STOP_TIMEOUT)? {
        Ok(())
    } else {
        Err("timed out waiting for package terminal to stop".to_owned())
    }
}

fn force_kill_package_terminal(
    process_group_leader: Option<i32>,
    process_id: Option<u32>,
    killer: &Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
) {
    #[cfg(unix)]
    if let Some(process_group_leader) = process_group_leader.filter(|pid| *pid > 0) {
        // The package manager and its normal descendants share the PTY's
        // foreground process group. Kill the whole group after Ctrl+C grace so
        // a dev server child cannot survive a Stop/workspace/window teardown.
        unsafe {
            libc::kill(-process_group_leader, libc::SIGKILL);
        }
    }

    #[cfg(windows)]
    if let Some(process_id) = process_id {
        // portable-pty terminates only the immediate process on Windows.
        // taskkill /T covers the script's process tree before the handle-level
        // fallback below.
        let _ = Command::new("taskkill.exe")
            .args(["/PID", &process_id.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    #[cfg(not(windows))]
    let _ = process_id;
    #[cfg(not(unix))]
    let _ = process_group_leader;

    if let Ok(mut killer) = killer.lock() {
        let _ = killer.kill();
    }
}

fn wait_for_exit(exited: &ExitSignal, timeout: Duration) -> Result<bool, String> {
    let (lock, wake) = &**exited;
    let done = lock
        .lock()
        .map_err(|_| "package terminal exit signal is poisoned".to_owned())?;
    if *done {
        return Ok(true);
    }
    let (done, timeout) = wake
        .wait_timeout_while(done, timeout, |done| !*done)
        .map_err(|_| "package terminal exit signal is poisoned".to_owned())?;
    Ok(*done || !timeout.timed_out())
}

fn forget_package_terminal(
    app: &AppHandle,
    window_label: &str,
    terminal_id: &str,
) -> Result<(), String> {
    let state = app.state::<PackageTerminalState>();
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "package terminal state is poisoned".to_owned())?;
    let session = package_terminal_for_window(&sessions, window_label, terminal_id)?;
    if session.running.is_some() {
        return Err("stop the package terminal before closing it".to_owned());
    }
    sessions.remove(terminal_id);
    Ok(())
}

fn stop_package_terminals_for_workspace(
    app: &AppHandle,
    window_label: &str,
    workspace: &Path,
    force: bool,
) -> Result<(), String> {
    let ids = {
        let state = app.state::<PackageTerminalState>();
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "package terminal state is poisoned".to_owned())?;
        sessions
            .iter()
            .filter(|(_, session)| {
                session.window_label == window_label
                    && session.workspace == workspace
                    && session.running.is_some()
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>()
    };
    for id in ids {
        stop_package_terminal(app, window_label, &id, force)?;
    }
    Ok(())
}

fn stop_package_terminals_for_window(app: &AppHandle, window_label: &str) {
    let ids = {
        let state = app.state::<PackageTerminalState>();
        let Ok(sessions) = state.sessions.lock() else {
            return;
        };
        sessions
            .iter()
            .filter(|(_, session)| {
                session.window_label == window_label && session.running.is_some()
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>()
    };
    for id in ids {
        let _ = stop_package_terminal(app, window_label, &id, true);
    }
    if let Ok(mut sessions) = app.state::<PackageTerminalState>().sessions.lock() {
        sessions.retain(|_, session| session.window_label != window_label);
    }
}

fn stop_all_package_terminals(app: &AppHandle) {
    let window_labels = {
        let state = app.state::<PackageTerminalState>();
        let Ok(sessions) = state.sessions.lock() else {
            return;
        };
        sessions
            .values()
            .map(|session| session.window_label.clone())
            .collect::<HashSet<_>>()
    };
    for window_label in window_labels {
        stop_package_terminals_for_window(app, &window_label);
    }
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

fn project_file_exists_from(workspace: &Path, relative_path: &Path) -> bool {
    resolve_project_file_path(workspace, relative_path).is_ok()
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
        return read_task_document_path(&root, &path, max_bytes);
    }

    Ok(empty_task_document())
}

fn read_task_document_path(
    root: &Path,
    path: &Path,
    max_bytes: u64,
) -> Result<ProjectTaskDocument, String> {
    let canonical = fs::canonicalize(&path)
        .map_err(|error| format!("failed to resolve {}: {error}", path.display()))?;
    if !canonical.starts_with(&root) {
        return Err(".pi/tasks.jsonc resolves outside the workspace".to_owned());
    }
    let metadata = fs::metadata(&canonical)
        .map_err(|error| format!("failed to inspect {}: {error}", canonical.display()))?;
    if !metadata.is_file() {
        return Err(".pi/tasks.jsonc is not a file".to_owned());
    }
    if metadata.len() > max_bytes {
        return Err(".pi/tasks.jsonc is too large (maximum 1 MB)".to_owned());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    fs::File::open(&canonical)
        .map_err(|error| format!("failed to open .pi/tasks.jsonc: {error}"))?
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read .pi/tasks.jsonc: {error}"))?;
    if bytes.len() as u64 > max_bytes {
        return Err(".pi/tasks.jsonc grew beyond the 1 MB limit".to_owned());
    }
    let source = std::str::from_utf8(&bytes)
        .map_err(|error| format!("invalid .pi/tasks.jsonc UTF-8: {error}"))?;
    let normalized = normalize_jsonc(source)?;
    let mut document: ProjectTaskDocument = serde_json::from_str(&normalized)
        .map_err(|error| format!("invalid .pi/tasks.jsonc: {error}"))?;
    if document.schema.is_none() {
        document.schema = Some(PROJECT_TASKS_SCHEMA_URL.to_owned());
    }
    validate_task_document(&document)?;
    Ok(document)
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
        if task.title.chars().count() > 200 {
            return Err(format!("task {} has an invalid title", task.id));
        }
        if task.title.trim().is_empty()
            && task
                .description
                .as_ref()
                .map_or(true, |value| value.trim().is_empty())
        {
            return Err(format!("task {} needs a title or description", task.id));
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

#[cfg(not(windows))]
fn replace_workspace_config_file(temporary: &Path, target: &Path) -> Result<(), String> {
    fs::rename(temporary, target)
        .map_err(|error| format!("failed to replace .pi/workspace.jsonc: {error}"))
}

#[cfg(windows)]
fn replace_workspace_config_file(temporary: &Path, target: &Path) -> Result<(), String> {
    if !target.exists() {
        return fs::rename(temporary, target)
            .map_err(|error| format!("failed to install .pi/workspace.jsonc: {error}"));
    }
    let backup = target.with_extension("jsonc.bak");
    let _ = fs::remove_file(&backup);
    fs::rename(target, &backup)
        .map_err(|error| format!("failed to prepare .pi/workspace.jsonc replacement: {error}"))?;
    if let Err(error) = fs::rename(temporary, target) {
        let _ = fs::rename(&backup, target);
        return Err(format!("failed to replace .pi/workspace.jsonc: {error}"));
    }
    let _ = fs::remove_file(backup);
    Ok(())
}

#[cfg(unix)]
fn sync_directory(directory: &Path) -> Result<(), String> {
    fs::File::open(directory)
        .and_then(|file| file.sync_all())
        .map_err(|error| format!("failed to flush project directory: {error}"))
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

    let session_title_extension = env::var_os("PIX_ACP_SESSION_TITLE_EXTENSION")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../dist/bundled-extensions/session-title/index.js")
        });
    if !session_title_extension.is_file() {
        return Err(format!(
            "Pix session-title extension not found at {} (run `npm run build:pix` first or set PIX_ACP_SESSION_TITLE_EXTENSION)",
            session_title_extension.display()
        ));
    }

    let workspace_undo_extension = env::var_os("PIX_ACP_WORKSPACE_UNDO_EXTENSION")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../dist/bundled-extensions/workspace-undo/index.js")
        });
    if !workspace_undo_extension.is_file() {
        return Err(format!(
            "Pix workspace-undo extension not found at {} (run `npm run build:pix` first or set PIX_ACP_WORKSPACE_UNDO_EXTENSION)",
            workspace_undo_extension.display()
        ));
    }

    let mut child = Command::new(&node)
        .arg(&entry)
        .env("PIX_ACP_QUESTION_EXTENSION", &question_extension)
        .env("PIX_ACP_SESSION_TITLE_EXTENSION", &session_title_extension)
        .env("PIX_ACP_WORKSPACE_UNDO_EXTENSION", &workspace_undo_extension)
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
        .manage(PackageTerminalState::default())
        .manage(UserConfigState::default())
        .manage(WorkspaceConfigState::default())
        .manage(SidebarIndicatorState::default())
        .manage(IdxOperationState::default())
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
            deepgram_token,
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
            write_project_workspace_config_if_unchanged,
            project_file_exists,
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
            home_file_exists,
            read_user_config,
            write_user_config,
            write_user_config_if_unchanged,
            workspace_sidebar_indicator_poll,
            idx_overview,
            idx_query,
            idx_inspect,
            idx_knowledge,
            idx_operation_list,
            idx_operation_start,
            idx_operation_stop,
            idx_operation_stop_workspace,
            package_scripts,
            package_terminal_list,
            package_terminal_start,
            package_terminal_start_shell,
            package_terminal_write,
            package_terminal_resize,
            package_terminal_stop,
            package_terminal_forget,
            package_terminal_stop_workspace,
            local_file_exists,
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
                stop_package_terminals_for_window(&handle, &window_label);
                stop_idx_operations_for_window(&handle, &window_label);
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
                        stop_package_terminals_for_window(&handle, &window_label);
                        stop_idx_operations_for_window(&handle, &window_label);
                    }
                    stop_all_package_terminals(&handle);
                    stop_all_idx_operations(&handle);
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
    fn serializes_idx_operation_events_for_frontend_payloads() {
        let output = serde_json::to_value(IdxOperationOutputEvent {
            operation_id: "idx-operation-1".to_owned(),
            stream: "stdout".to_owned(),
            chunk: "indexed\n".to_owned(),
        })
        .expect("serialize IDX output event");
        assert_eq!(
            output,
            serde_json::json!({
                "operationId": "idx-operation-1",
                "stream": "stdout",
                "chunk": "indexed\n",
            })
        );

        let exit = serde_json::to_value(IdxOperationExitEvent {
            operation_id: "idx-operation-1".to_owned(),
            status: IdxOperationStatus::Succeeded,
            exit_code: Some(0),
        })
        .expect("serialize IDX exit event");
        assert_eq!(
            exit,
            serde_json::json!({
                "operationId": "idx-operation-1",
                "status": "succeeded",
                "exitCode": 0,
            })
        );
    }

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
    fn discovers_root_package_scripts_and_package_manager() {
        let workspace = temporary_workspace("package-scripts");
        fs::write(
            workspace.join("package.json"),
            r#"{
  "name": "demo-package",
  "packageManager": "pnpm@10.0.0",
  "scripts": {
    "test": "vitest run",
    "dev": "vite"
  }
}
"#,
        )
        .expect("write package.json");

        let snapshot = package_scripts_from(&workspace).expect("discover package scripts");
        assert!(snapshot.exists);
        assert_eq!(snapshot.package_name.as_deref(), Some("demo-package"));
        assert_eq!(snapshot.package_manager, PackageManagerKind::Pnpm);
        assert_eq!(
            snapshot.scripts,
            vec![
                PackageScript {
                    name: "dev".to_owned(),
                    command: "vite".to_owned(),
                },
                PackageScript {
                    name: "test".to_owned(),
                    command: "vitest run".to_owned(),
                },
            ]
        );
        fs::remove_dir_all(workspace).expect("remove temporary workspace");
    }

    #[test]
    fn package_script_discovery_handles_missing_package_and_lockfile_manager() {
        let workspace = temporary_workspace("package-scripts-missing");
        fs::write(workspace.join("yarn.lock"), "# lock\n").expect("write yarn lockfile");

        let missing = package_scripts_from(&workspace).expect("discover missing package.json");
        assert!(!missing.exists);
        assert_eq!(missing.package_manager, PackageManagerKind::Yarn);
        assert!(missing.scripts.is_empty());

        fs::write(workspace.join("package.json"), "[]\n").expect("write invalid package root");
        assert!(package_scripts_from(&workspace).is_err());
        fs::remove_dir_all(workspace).expect("remove temporary workspace");
    }

    #[test]
    fn validates_package_terminal_dimensions() {
        assert_eq!(
            validated_terminal_size(120, 30)
                .expect("valid terminal")
                .cols,
            120
        );
        assert!(validated_terminal_size(1, 30).is_err());
        assert!(validated_terminal_size(120, 0).is_err());
    }

    #[test]
    fn parses_idx_overview_status_fields() {
        let index = parse_idx_index_status(
            "Snapshot: abc-123 (completed)\nCreated: 1789035207186  |  Git ref: deadbeef\nFiles: 743  |  Symbols: 7949  |  Chunks: 451  |  Dependencies: 3512\nLanguages: typescript: 690, svelte: 29\n",
        );
        assert_eq!(index.state.as_deref(), Some("completed"));
        assert_eq!(index.fields.get("snapshot").map(String::as_str), Some("abc-123"));
        assert_eq!(index.fields.get("gitRef").map(String::as_str), Some("deadbeef"));
        assert_eq!(index.fields.get("files").map(String::as_str), Some("743"));

        let wiki = parse_idx_wiki_status(
            "primary specs: 44 (43 current/proposed) | fresh: 36 | needs review: 7 | unresolved refs: 8\nRecommendation: review changed inputs.\n",
        );
        assert_eq!(
            wiki.fields.get("primarySpecs").map(String::as_str),
            Some("44 (43 current/proposed)")
        );
        assert_eq!(wiki.fields.get("needsReview").map(String::as_str), Some("7"));
        assert_eq!(wiki.fields.get("unresolvedRefs").map(String::as_str), Some("8"));
    }

    #[test]
    fn builds_typed_idx_query_arguments() {
        let args = idx_query_args(&IdxQuery::Code {
            query: "workspace sidebar".to_owned(),
            mode: IdxSearchMode::Semantic,
            max_files: 500,
            path_prefix: Some("desktop/src".to_owned()),
            include_content: false,
        })
        .expect("code query args");
        assert_eq!(
            args,
            vec![
                "search",
                "workspace sidebar",
                "--max-files",
                "50",
                "--mode",
                "semantic",
                "--path-prefix",
                "desktop/src",
            ]
        );

        let context = idx_query_args(&IdxQuery::Context {
            query: "task lifecycle".to_owned(),
            budget: 1400,
            max_specs: 4,
            max_code: 6,
            max_tests: 4,
            include_secondary: false,
            path_prefix: None,
        })
        .expect("context args");
        assert_eq!(context[0..2], ["context", "task lifecycle"]);

        let decoded: IdxQueryRequest = serde_json::from_value(serde_json::json!({
            "workspace": "/workspace",
            "query": {
                "kind": "code",
                "query": "sidebar",
                "mode": "hybrid",
                "maxFiles": 5,
                "pathPrefix": "desktop/src"
            }
        }))
        .expect("camelCase query request");
        assert!(matches!(decoded.query, IdxQuery::Code { max_files: 5, .. }));
    }

    #[test]
    fn builds_typed_idx_inspection_arguments() {
        let structure = idx_inspect_args(&IdxInspectRequest {
            workspace: "/workspace".to_owned(),
            command: IdxInspectCommand::Structure,
            target: None,
            path_prefix: Some("desktop/src".to_owned()),
            depth: Some(3),
            max_files: Some(80),
            include_body: None,
            show_edges: None,
            tests: None,
        })
        .expect("structure args");
        assert_eq!(
            structure,
            vec![
                "structure",
                "--max-depth",
                "3",
                "--max-files",
                "80",
                "--path-prefix",
                "desktop/src",
            ]
        );

        let explain = idx_inspect_args(&IdxInspectRequest {
            workspace: "/workspace".to_owned(),
            command: IdxInspectCommand::Explain,
            target: Some("WorkspaceSidebar".to_owned()),
            path_prefix: None,
            depth: None,
            max_files: None,
            include_body: Some(false),
            show_edges: None,
            tests: None,
        })
        .expect("explain args");
        assert!(explain.ends_with(&["--signature-only".to_owned()]));
    }

    #[test]
    fn idx_knowledge_mutations_require_review_confirmations() {
        let base = IdxKnowledgeRequest {
            workspace: "/workspace".to_owned(),
            action: IdxKnowledgeAction::Verify,
            path: Some("specs/behavior.md".to_owned()),
            classification: None,
            behavior_type: None,
            lifecycle: None,
            confidence: None,
            summary: None,
            topics: None,
            target_paths: None,
            relation_kind: None,
            relation_action: None,
            source_reviewed: None,
            evidence_reviewed: None,
            metadata_only_confirmed: None,
            paths: None,
            base: None,
            semantic: None,
        };
        assert!(idx_knowledge_args(&base).is_err());
        let verified = IdxKnowledgeRequest {
            evidence_reviewed: Some(true),
            ..base
        };
        assert_eq!(
            idx_knowledge_args(&verified).expect("verified args"),
            vec!["wiki", "verify", "--path", "specs/behavior.md"]
        );
    }

    #[test]
    fn builds_interactive_shell_terminal_command() {
        let (command, label, command_label) =
            shell_terminal_command().expect("build shell terminal");
        assert!(!label.trim().is_empty());
        assert!(!command_label.trim().is_empty());
        assert_eq!(command.get_argv().len(), 1);
    }

    #[test]
    fn validates_project_file_links_without_reading_file_contents() {
        let workspace = temporary_workspace("project-link-validation");
        fs::create_dir(workspace.join("docs")).expect("create docs directory");
        fs::write(workspace.join("docs/guide.md"), [0xff, 0xfe]).expect("write binary contents");

        assert!(project_file_exists_from(
            &workspace,
            Path::new("docs/guide.md")
        ));
        assert!(!project_file_exists_from(&workspace, Path::new("evals.md")));
        assert!(!project_file_exists_from(
            &workspace,
            Path::new("../guide.md")
        ));
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
    fn sidebar_git_indicator_reports_dirty_repository_without_full_git_snapshot_work() {
        let workspace = temporary_workspace("sidebar-git-indicator");
        initialize_git_repository(&workspace);

        let clean = sidebar_git_indicator_state(&workspace);
        assert!(clean.available);
        assert!(!clean.dirty);
        assert!(!clean.conflicted);
        assert!(clean.error.is_none());

        fs::write(workspace.join("tracked.txt"), "changed\n").expect("modify tracked file");
        let dirty = sidebar_git_indicator_state(&workspace);
        assert!(dirty.available);
        assert!(dirty.dirty);
        assert!(!dirty.conflicted);
        assert!(dirty.error.is_none());

        fs::remove_dir_all(workspace).expect("remove temporary workspace");
    }

    #[test]
    fn sidebar_git_indicator_parser_skips_rename_path_records() {
        let renamed = parse_sidebar_git_status(
            b"# branch.head main\0# branch.ab +2 -1\02 R. renamed\0u looks-like-status.ts\0",
        );
        assert!(renamed.available);
        assert!(renamed.dirty);
        assert!(!renamed.conflicted);
        assert_eq!(renamed.ahead, 2);
        assert_eq!(renamed.behind, 1);

        let conflicted = parse_sidebar_git_status(b"# branch.head main\0u UU conflict.ts\0");
        assert!(conflicted.dirty);
        assert!(conflicted.conflicted);
    }

    #[test]
    fn sidebar_registry_indicator_detects_tracked_local_edits() {
        let workspace = temporary_workspace("sidebar-registry-tracked");
        let home = temporary_workspace("sidebar-registry-home");
        let skill = workspace.join(".pi/skills/demo");
        fs::create_dir_all(&skill).expect("create skill directory");
        fs::write(skill.join("SKILL.md"), "hello\n").expect("write skill");
        let hash = sidebar_registry_hash_path(&skill).expect("hash skill");
        assert_eq!(
            hash,
            "906b614c27e4807264026c53f5017570ac51970b1f0e092a54d9a35f063fb33a"
        );
        fs::write(
            workspace.join(".pi/registry.json"),
            format!(
                "{{\"version\":1,\"resources\":{{\"skill:demo\":{{\"type\":\"skill\",\"name\":\"demo\",\"hash\":\"{hash}\"}}}},\"projectResources\":{{}}}}\n"
            ),
        )
        .expect("write registry provenance");

        let state = SidebarIndicatorState::default();
        let clean = sidebar_registry_indicator_state(&state, &workspace, &home);
        assert!(clean.stable);
        assert!(!clean.local_changes);
        assert!(clean.error.is_none());

        fs::write(skill.join("SKILL.md"), "changed locally\n").expect("edit skill");
        let changed = sidebar_registry_indicator_state(&state, &workspace, &home);
        assert!(changed.stable);
        assert!(changed.local_changes);
        assert!(changed.error.is_none());

        fs::remove_dir_all(workspace).expect("remove temporary workspace");
        fs::remove_dir_all(home).expect("remove temporary home");
    }

    #[test]
    fn sidebar_registry_indicator_flags_local_only_resources_only_when_configured() {
        let workspace = temporary_workspace("sidebar-registry-local-only");
        let home = temporary_workspace("sidebar-registry-config-home");
        fs::create_dir_all(workspace.join(".pi/agents")).expect("create agents directory");
        fs::write(
            workspace.join(".pi/agents/test-runner.md"),
            "---\nname: test-runner\n---\n",
        )
        .expect("write local agent");
        let state = SidebarIndicatorState::default();

        let unconfigured = sidebar_registry_indicator_state(&state, &workspace, &home);
        assert!(unconfigured.stable);
        assert!(!unconfigured.local_changes);

        let config_dir = home.join(".config/pi");
        fs::create_dir_all(&config_dir).expect("create config directory");
        fs::write(
            config_dir.join("pi-tools-suite.jsonc"),
            "{ \"resourceRegistry\": { \"remote\": \"git@example.invalid:registry.git\" } }\n",
        )
        .expect("write registry config");
        let configured = sidebar_registry_indicator_state(&state, &workspace, &home);
        assert!(configured.stable);
        assert!(configured.local_changes);
        assert!(configured.error.is_none());

        fs::remove_dir_all(workspace).expect("remove temporary workspace");
        fs::remove_dir_all(home).expect("remove temporary home");
    }

    #[test]
    fn git_status_diff_stage_and_unstage_are_workspace_scoped() {
        let workspace = temporary_workspace("git-source-control");
        initialize_git_repository(&workspace);
        fs::write(workspace.join("deleted.txt"), "one\ntwo\nthree\n")
            .expect("write file that will be deleted");
        git_output(&workspace, &["add", "deleted.txt"]).expect("stage file that will be deleted");
        git_output(
            &workspace,
            &["commit", "--no-gpg-sign", "-m", "add deleted fixture"],
        )
        .expect("commit file that will be deleted");
        fs::write(workspace.join("tracked.txt"), "after\n").expect("modify tracked file");
        fs::write(workspace.join("new.txt"), "new\n").expect("write untracked file");
        fs::remove_file(workspace.join("deleted.txt")).expect("delete tracked file");

        let before = git_status_from(&workspace).expect("read git status");
        assert_eq!(before.branch, "main");
        assert!(!before.detached);
        let tracked = before
            .changes
            .iter()
            .find(|change| change.path == "tracked.txt")
            .expect("tracked change");
        assert!(tracked.unstaged && !tracked.staged);
        assert_eq!(tracked.unstaged_additions, Some(1));
        assert_eq!(tracked.unstaged_deletions, Some(1));

        let untracked = before
            .changes
            .iter()
            .find(|change| change.path == "new.txt")
            .expect("untracked change");
        assert!(untracked.untracked);
        assert_eq!(untracked.unstaged_additions, Some(1));
        assert_eq!(untracked.unstaged_deletions, Some(0));

        let deleted = before
            .changes
            .iter()
            .find(|change| change.path == "deleted.txt")
            .expect("deleted change");
        assert_eq!(deleted.unstaged_additions, Some(0));
        assert_eq!(deleted.unstaged_deletions, Some(3));

        let working = git_diff_from(&workspace, Some("tracked.txt"), GitDiffScope::Unstaged)
            .expect("read working diff");
        assert!(working.content.contains("-before"));
        assert!(working.content.contains("+after"));

        git_stage_from(&workspace, Some("tracked.txt")).expect("stage tracked file");
        let staged = git_status_from(&workspace).expect("read staged status");
        let staged_tracked = staged
            .changes
            .iter()
            .find(|change| change.path == "tracked.txt")
            .expect("staged tracked change");
        assert!(staged_tracked.staged && !staged_tracked.unstaged);
        assert_eq!(staged_tracked.staged_additions, Some(1));
        assert_eq!(staged_tracked.staged_deletions, Some(1));
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
    fn writes_project_workspace_config_with_atomic_replacement() {
        let workspace = temporary_workspace("workspace-config-write");
        let first = write_project_workspace_config_from(
            &workspace,
            "{\n  // Project identity\n  \"color\": \"#7aa2f7\"\n}\n",
        )
        .expect("write workspace config");
        assert_eq!(first.path, ".pi/workspace.jsonc");
        assert!(first.content.contains("#7aa2f7"));

        let second = write_project_workspace_config_if_unchanged_from(
            &workspace,
            Some(&first.content),
            "{\n  \"color\": \"#ff8844\"\n}\n",
        )
        .expect("replace workspace config");
        assert!(second.written);
        let second_document = second.document.expect("written workspace config");
        assert!(second_document.content.contains("#ff8844"));
        assert!(!second_document.content.contains("#7aa2f7"));
        assert_eq!(
            fs::read_to_string(workspace.join(".pi/workspace.jsonc")).expect("read config"),
            second_document.content,
        );

        let stale = write_project_workspace_config_if_unchanged_from(
            &workspace,
            Some(&first.content),
            "{\n  \"color\": \"#22cc88\"\n}\n",
        )
        .expect("reject stale workspace config write");
        assert!(!stale.written);
        assert!(stale
            .document
            .expect("current workspace config")
            .content
            .contains("#ff8844"));

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
    fn user_settings_configs_resolve_under_the_platform_home_and_round_trip() {
        let home = temporary_workspace("user-settings-config");
        let pix_path = user_config_path(&home, UserConfigKind::Pix);
        let tools_path = user_config_path(&home, UserConfigKind::PiToolsSuite);
        assert_eq!(pix_path, home.join(".config/pi/pix.jsonc"));
        assert_eq!(tools_path, home.join(".config/pi/pi-tools-suite.jsonc"));

        let missing =
            read_user_config_from(&home, UserConfigKind::Pix).expect("read missing config");
        assert!(!missing.exists);
        assert!(missing.content.contains(PIX_CONFIG_SCHEMA_URL));
        assert!(missing.schema.contains("ignoreContextFiles"));
        assert!(
            serde_json::from_str::<serde_json::Value>(user_config_schema(UserConfigKind::Pix))
                .is_ok()
        );
        assert!(
            serde_json::from_str::<serde_json::Value>(user_config_schema(
                UserConfigKind::PiToolsSuite
            ))
            .is_ok()
        );

        let saved = write_user_config_from(
            &home,
            UserConfigKind::Pix,
            "{\n  // preserve JSONC\n  \"ignoreContextFiles\": true\n}",
        )
        .expect("write user config");
        assert!(saved.exists);
        assert!(saved.content.contains("// preserve JSONC"));
        assert!(saved.content.ends_with('\n'));
        assert_eq!(
            fs::read_to_string(&pix_path).expect("read saved config"),
            saved.content
        );

        fs::remove_dir_all(home).expect("remove temporary home");
    }

    #[test]
    fn conditional_user_config_write_rejects_stale_snapshots() {
        let home = temporary_workspace("user-settings-config-cas");
        let initial = read_user_config_from(&home, UserConfigKind::Pix).expect("read initial config");

        let first = write_user_config_if_unchanged_from(
            &home,
            UserConfigKind::Pix,
            &initial.content,
            "{\n  \"visibleModels\": [\"openai/a\"]\n}\n",
        )
        .expect("write first config");
        assert!(first.written);

        let stale = write_user_config_if_unchanged_from(
            &home,
            UserConfigKind::Pix,
            &initial.content,
            "{\n  \"visibleModels\": [\"zai/b\"]\n}\n",
        )
        .expect("reject stale config");
        assert!(!stale.written);
        assert_eq!(stale.document.content, first.document.content);

        fs::remove_dir_all(home).expect("remove temporary home");
    }

    #[test]
    fn resolves_deepgram_runtime_config_from_user_pix_config_with_env_fallback() {
        let home = temporary_workspace("deepgram-user-config");
        let path = user_config_path(&home, UserConfigKind::Pix);
        fs::create_dir_all(path.parent().expect("config parent")).expect("create config directory");
        fs::write(
            &path,
            r#"{
              // Secrets belong in the user config, not project config.
              "dictation": {
                "apiKey": " dg-config-key ",
                "model": "nova-3",
                "language": "ru",
                "languages": {
                  "ru": { "deepgramLanguage": "ru" },
                },
              },
            }"#,
        )
        .expect("write pix config");

        let config = resolve_deepgram_runtime_config(&home, Some("dg-env-key".to_owned()))
            .expect("resolve config");
        assert_eq!(config.api_key, "dg-config-key");
        assert_eq!(config.model, "nova-3");
        assert_eq!(config.language, "ru");

        fs::write(&path, "{ \"dictation\": { \"apiKey\": \"\" } }\n")
            .expect("clear config key");
        let fallback = resolve_deepgram_runtime_config(&home, Some("dg-env-key".to_owned()))
            .expect("resolve env fallback");
        assert_eq!(fallback.api_key, "dg-env-key");
        assert_eq!(fallback.model, "nova-3");
        assert_eq!(fallback.language, "en");
        assert_eq!(
            resolve_deepgram_api_key(&home, Some("dg-env-key".to_owned()))
                .expect("resolve env fallback"),
            "dg-env-key"
        );
        assert!(resolve_deepgram_api_key(&home, None)
            .expect_err("missing key should fail")
            .contains("dictation.apiKey"));

        fs::remove_dir_all(home).expect("remove temporary home");
    }

    #[test]
    fn sidebar_settings_indicator_detects_jsonc_and_schema_errors() {
        let home = temporary_workspace("sidebar-settings-indicator");
        let path = user_config_path(&home, UserConfigKind::Pix);
        fs::create_dir_all(path.parent().expect("config parent")).expect("create config directory");

        fs::write(&path, "{\n  // valid JSONC\n  \"ignoreContextFiles\": true,\n}\n")
            .expect("write valid config");
        assert!(sidebar_settings_indicator_state(&home).errors.is_empty());

        fs::write(&path, "{ \"ignoreContextFiles\": \"yes\" }\n")
            .expect("write schema-invalid config");
        let schema_invalid = sidebar_settings_indicator_state(&home);
        assert_eq!(schema_invalid.errors.len(), 1);
        assert!(schema_invalid.errors[0].contains("ignoreContextFiles"));

        fs::write(&path, "{\n").expect("write malformed config");
        let malformed = sidebar_settings_indicator_state(&home);
        assert_eq!(malformed.errors.len(), 1);
        assert!(malformed.errors[0].contains("invalid JSONC"));

        fs::remove_dir_all(home).expect("remove temporary home");
    }

    #[test]
    fn user_settings_reject_normalized_content_over_the_size_limit_before_writing() {
        let home = temporary_workspace("user-settings-config-size-limit");
        let path = user_config_path(&home, UserConfigKind::Pix);
        fs::create_dir_all(path.parent().expect("config parent")).expect("create config directory");
        fs::write(&path, "{}\n").expect("write existing config");

        let content = "x".repeat(MAX_USER_CONFIG_BYTES as usize);
        let error = write_user_config_from(&home, UserConfigKind::Pix, &content)
            .expect_err("reject normalized oversized config");

        assert!(error.contains("config is too large to save"));
        assert_eq!(
            fs::read_to_string(&path).expect("read unchanged config"),
            "{}\n"
        );
        fs::remove_dir_all(home).expect("remove temporary home");
    }

    #[test]
    fn validates_home_file_links_without_opening_them() {
        let home = temporary_workspace("home-link-validation");
        fs::create_dir_all(home.join(".config/pi")).expect("create config directory");
        fs::write(home.join(".config/pi/pix.jsonc"), "{}\n").expect("write config");

        assert!(home_file_exists_from(
            &home,
            Path::new("~/.config/pi/pix.jsonc")
        ));
        assert!(!home_file_exists_from(&home, Path::new("~/missing.jsonc")));
        assert!(!home_file_exists_from(&home, Path::new("~/../secret.txt")));
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
    fn allows_untitled_tasks_with_description_but_rejects_empty_tasks() {
        let mut untitled = sample_task_document();
        untitled.tasks[0].title.clear();
        validate_task_document(&untitled).expect("untitled task with description should be valid");

        untitled.tasks[0].description = Some("   ".to_owned());
        assert!(validate_task_document(&untitled)
            .expect_err("empty task should fail")
            .contains("needs a title or description"));
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
    fn ignores_unsupported_tasks_json() {
        let workspace = temporary_workspace("unsupported-task-json");
        fs::create_dir(workspace.join(".pi")).expect("create .pi directory");
        fs::write(
            workspace.join(".pi/tasks.json"),
            serde_json::to_vec_pretty(&sample_task_document()).expect("encode unsupported task document"),
        )
        .expect("write unsupported task document");

        let document = read_project_tasks_from(&workspace, 1024 * 1024).expect("read tasks");
        assert_eq!(document, empty_task_document());
        assert!(workspace.join(".pi/tasks.json").is_file());
        assert!(!workspace.join(".pi/tasks.jsonc").exists());
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
