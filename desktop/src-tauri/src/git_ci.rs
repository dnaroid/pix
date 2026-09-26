//! Remote CI status through the user's existing GitHub/GitLab CLI authentication.
//!
//! The commands in this module are intentionally read-only. Every external CLI
//! process is isolated, has stdin disabled, is bounded by a deadline, and can be
//! cancelled by request id so workspace/window teardown cannot strand children.

use super::{git_output, git_repository_root, native_process, run_blocking, POLL_INTERVAL};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    env,
    io::Read,
    path::{Path, PathBuf},
    process::{ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

const CI_COMMAND_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_CI_STDOUT_BYTES: usize = 2 * 1024 * 1024;
const MAX_CI_STDERR_BYTES: usize = 128 * 1024;
const MAX_CI_RUNS: usize = 20;
const MAX_CI_JOBS: usize = 100;

#[derive(Default)]
pub(crate) struct GitCiProcessState {
    requests: Arc<Mutex<HashMap<String, GitCiRequest>>>,
}

struct GitCiRequest {
    window_label: String,
    cancelled: Arc<AtomicBool>,
}

impl GitCiProcessState {
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
        let Ok(mut requests) = self.requests.lock() else {
            return;
        };
        for request in requests.values() {
            request.cancelled.store(true, Ordering::Release);
        }
        requests.clear();
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum GitCiProvider {
    Github,
    Gitlab,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum GitCiAvailability {
    Ready,
    NoRemote,
    AmbiguousRemote,
    UnsupportedRemote,
    CliMissing,
    AuthRequired,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum GitCiStatus {
    Queued,
    Running,
    Success,
    Failure,
    Cancelled,
    Neutral,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitCiRun {
    id: String,
    name: String,
    status: GitCiStatus,
    raw_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    branch: Option<String>,
    head_sha: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    updated_at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitCiJob {
    id: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    stage: Option<String>,
    status: GitCiStatus,
    raw_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    completed_at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitCiSnapshot {
    #[serde(skip_serializing_if = "Option::is_none")]
    provider: Option<GitCiProvider>,
    availability: GitCiAvailability,
    #[serde(skip_serializing_if = "Option::is_none")]
    remote_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project: Option<String>,
    head_sha: String,
    local_only: bool,
    runs: Vec<GitCiRun>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitCiJobsResult {
    run_id: String,
    jobs: Vec<GitCiJob>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct RemoteInfo {
    name: String,
    host: String,
    project: String,
    provider: GitCiProvider,
}

struct CliOutput {
    status: ExitStatus,
    stdout: String,
    stderr: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GithubRun {
    database_id: u64,
    #[serde(default)]
    workflow_name: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    conclusion: String,
    #[serde(default)]
    head_sha: String,
    head_branch: Option<String>,
    url: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
}

#[derive(Deserialize)]
struct GitlabPipeline {
    id: u64,
    #[serde(default)]
    status: String,
    #[serde(default)]
    sha: String,
    #[serde(rename = "ref")]
    branch: Option<String>,
    web_url: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
    name: Option<String>,
}

#[derive(Deserialize)]
struct GithubRunView {
    #[serde(default)]
    jobs: Vec<GithubJob>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GithubJob {
    database_id: u64,
    #[serde(default)]
    name: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    conclusion: String,
    url: Option<String>,
    started_at: Option<String>,
    completed_at: Option<String>,
}

#[derive(Deserialize)]
struct GitlabJob {
    id: u64,
    #[serde(default)]
    name: String,
    stage: Option<String>,
    #[serde(default)]
    status: String,
    web_url: Option<String>,
    started_at: Option<String>,
    finished_at: Option<String>,
}

#[tauri::command]
pub(crate) async fn git_ci_status(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, GitCiProcessState>,
    workspace: String,
    expected_head: String,
    request_id: String,
) -> Result<GitCiSnapshot, String> {
    validate_request_id(&request_id)?;
    validate_head(&expected_head)?;
    let requests = Arc::clone(&state.requests);
    let cancelled = register_request(&requests, &request_id, window.label())?;
    let cleanup_requests = Arc::clone(&requests);
    let cleanup_id = request_id.clone();
    let cleanup_token = Arc::clone(&cancelled);
    let result = run_blocking(move || {
        ci_status_from(Path::new(&workspace), &expected_head, cancelled.as_ref())
    })
    .await;
    unregister_request(&cleanup_requests, &cleanup_id, &cleanup_token);
    result
}

#[tauri::command]
pub(crate) async fn git_ci_jobs(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, GitCiProcessState>,
    workspace: String,
    expected_head: String,
    run_id: String,
    request_id: String,
) -> Result<GitCiJobsResult, String> {
    validate_request_id(&request_id)?;
    validate_head(&expected_head)?;
    validate_run_id(&run_id)?;
    let requests = Arc::clone(&state.requests);
    let cancelled = register_request(&requests, &request_id, window.label())?;
    let cleanup_requests = Arc::clone(&requests);
    let cleanup_id = request_id.clone();
    let cleanup_token = Arc::clone(&cancelled);
    let result = run_blocking(move || {
        ci_jobs_from(
            Path::new(&workspace),
            &expected_head,
            &run_id,
            cancelled.as_ref(),
        )
    })
    .await;
    unregister_request(&cleanup_requests, &cleanup_id, &cleanup_token);
    result
}

#[tauri::command]
pub(crate) fn git_ci_cancel(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, GitCiProcessState>,
    request_id: String,
) -> Result<bool, String> {
    validate_request_id(&request_id)?;
    let token = state
        .requests
        .lock()
        .map_err(|_| "CI request registry is unavailable".to_owned())?
        .get(&request_id)
        .filter(|request| request.window_label == window.label())
        .map(|request| Arc::clone(&request.cancelled));
    if let Some(token) = token {
        token.store(true, Ordering::Release);
        Ok(true)
    } else {
        Ok(false)
    }
}

fn register_request(
    requests: &Arc<Mutex<HashMap<String, GitCiRequest>>>,
    request_id: &str,
    window_label: &str,
) -> Result<Arc<AtomicBool>, String> {
    let token = Arc::new(AtomicBool::new(false));
    let mut requests = requests
        .lock()
        .map_err(|_| "CI request registry is unavailable".to_owned())?;
    if let Some(previous) = requests.insert(
        request_id.to_owned(),
        GitCiRequest {
            window_label: window_label.to_owned(),
            cancelled: Arc::clone(&token),
        },
    ) {
        previous.cancelled.store(true, Ordering::Release);
    }
    Ok(token)
}

fn unregister_request(
    requests: &Arc<Mutex<HashMap<String, GitCiRequest>>>,
    request_id: &str,
    token: &Arc<AtomicBool>,
) {
    let Ok(mut requests) = requests.lock() else {
        return;
    };
    if requests
        .get(request_id)
        .is_some_and(|current| Arc::ptr_eq(&current.cancelled, token))
    {
        requests.remove(request_id);
    }
}

fn validate_request_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 160
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.'))
    {
        return Err("invalid CI request id".to_owned());
    }
    Ok(())
}

fn validate_head(value: &str) -> Result<(), String> {
    if !(7..=64).contains(&value.len()) || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("invalid Git HEAD for CI lookup".to_owned());
    }
    Ok(())
}

fn validate_run_id(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 32 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("invalid CI run id".to_owned());
    }
    Ok(())
}

fn ci_status_from(
    workspace: &Path,
    expected_head: &str,
    cancelled: &AtomicBool,
) -> Result<GitCiSnapshot, String> {
    let root = git_repository_root(workspace)?;
    ensure_current_head(&root, expected_head)?;
    let remote = match resolve_remote(&root) {
        Ok(Some(remote)) => remote,
        Ok(None) => {
            return Ok(unavailable_snapshot(
                expected_head,
                GitCiAvailability::NoRemote,
                None,
                "No Git remote is configured",
            ));
        }
        Err(error) if error.starts_with("ambiguous Git remote") => {
            return Ok(unavailable_snapshot(
                expected_head,
                GitCiAvailability::AmbiguousRemote,
                None,
                &error,
            ));
        }
        Err(error) if error.starts_with("unsupported Git remote") => {
            return Ok(unavailable_snapshot(
                expected_head,
                GitCiAvailability::UnsupportedRemote,
                None,
                &error,
            ));
        }
        Err(error) => return Err(error),
    };
    let local_only = !remote_contains_head(&root, &remote.name, expected_head)?;
    let executable_name = match remote.provider {
        GitCiProvider::Github => "gh",
        GitCiProvider::Gitlab => "glab",
    };
    let Some(executable) = resolve_cli_executable(executable_name) else {
        return Ok(unavailable_snapshot(
            expected_head,
            GitCiAvailability::CliMissing,
            Some(&remote),
            &format!("{executable_name} CLI is not installed or not visible to Pix"),
        ));
    };
    if cancelled.load(Ordering::Acquire) {
        return Err("CI request cancelled".to_owned());
    }
    let runs = match remote.provider {
        GitCiProvider::Github => github_runs(&executable, &root, &remote, expected_head, cancelled),
        GitCiProvider::Gitlab => gitlab_runs(&executable, &root, &remote, expected_head, cancelled),
    };
    match runs {
        Ok(runs) => Ok(GitCiSnapshot {
            provider: Some(remote.provider),
            availability: GitCiAvailability::Ready,
            remote_name: Some(remote.name),
            host: Some(remote.host),
            project: Some(remote.project),
            head_sha: expected_head.to_owned(),
            local_only,
            runs,
            error: None,
        }),
        Err(error) if error == "CI request cancelled" => Err(error),
        Err(error) => {
            let auth = run_auth_check(&executable, &root, &remote, cancelled);
            if matches!(&auth, Err(detail) if detail == "CI request cancelled") {
                return Err("CI request cancelled".to_owned());
            }
            if let Ok(auth) = auth {
                if !auth.status.success() {
                    let detail = cli_error_detail(&auth);
                    return Ok(unavailable_snapshot(
                        expected_head,
                        GitCiAvailability::AuthRequired,
                        Some(&remote),
                        &format!(
                            "{} authentication is required for {}{detail}",
                            executable_name, remote.host
                        ),
                    ));
                }
            }
            Ok(GitCiSnapshot {
                provider: Some(remote.provider),
                availability: GitCiAvailability::Error,
                remote_name: Some(remote.name),
                host: Some(remote.host),
                project: Some(remote.project),
                head_sha: expected_head.to_owned(),
                local_only,
                runs: Vec::new(),
                error: Some(error),
            })
        }
    }
}

fn ci_jobs_from(
    workspace: &Path,
    expected_head: &str,
    run_id: &str,
    cancelled: &AtomicBool,
) -> Result<GitCiJobsResult, String> {
    let root = git_repository_root(workspace)?;
    ensure_current_head(&root, expected_head)?;
    let remote = resolve_remote(&root)?.ok_or("No Git remote is configured")?;
    let executable_name = match remote.provider {
        GitCiProvider::Github => "gh",
        GitCiProvider::Gitlab => "glab",
    };
    let executable = resolve_cli_executable(executable_name)
        .ok_or_else(|| format!("{executable_name} CLI is not installed or not visible to Pix"))?;
    let jobs = match remote.provider {
        GitCiProvider::Github => github_jobs(&executable, &root, &remote, run_id, cancelled),
        GitCiProvider::Gitlab => gitlab_jobs(&executable, &root, &remote, run_id, cancelled),
    };
    let jobs = match jobs {
        Ok(jobs) => jobs,
        Err(error) if error == "CI request cancelled" => return Err(error),
        Err(error) => {
            let auth = run_auth_check(&executable, &root, &remote, cancelled);
            if matches!(&auth, Err(detail) if detail == "CI request cancelled") {
                return Err("CI request cancelled".to_owned());
            }
            if let Ok(auth) = auth {
                if !auth.status.success() {
                    return Err(format!(
                        "{} authentication is required for {}{}",
                        executable_name,
                        remote.host,
                        cli_error_detail(&auth)
                    ));
                }
            }
            return Err(error);
        }
    };
    Ok(GitCiJobsResult {
        run_id: run_id.to_owned(),
        jobs,
    })
}

fn unavailable_snapshot(
    head: &str,
    availability: GitCiAvailability,
    remote: Option<&RemoteInfo>,
    error: &str,
) -> GitCiSnapshot {
    GitCiSnapshot {
        provider: remote.map(|remote| remote.provider),
        availability,
        remote_name: remote.map(|remote| remote.name.clone()),
        host: remote.map(|remote| remote.host.clone()),
        project: remote.map(|remote| remote.project.clone()),
        head_sha: head.to_owned(),
        local_only: false,
        runs: Vec::new(),
        error: Some(error.to_owned()),
    }
}

fn ensure_current_head(root: &Path, expected_head: &str) -> Result<(), String> {
    let output = git_output(root, &["rev-parse", "HEAD"])?;
    let head = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if head != expected_head {
        return Err("Git HEAD changed while CI status was being requested".to_owned());
    }
    Ok(())
}

fn resolve_remote(root: &Path) -> Result<Option<RemoteInfo>, String> {
    let remote_names = git_output(root, &["remote"])?;
    let mut names = String::from_utf8_lossy(&remote_names.stdout)
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    names.sort();
    names.dedup();
    if names.is_empty() {
        return Ok(None);
    }
    let branch = git_output(root, &["branch", "--show-current"])?;
    let branch = String::from_utf8_lossy(&branch.stdout).trim().to_owned();
    let configured = if branch.is_empty() {
        None
    } else {
        let key = format!("branch.{branch}.remote");
        super::git_output_raw(root, &["config", "--get", &key])
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| {
                let value = String::from_utf8_lossy(&output.stdout).trim().to_owned();
                (!value.is_empty() && value != ".").then_some(value)
            })
    };
    let name = select_remote_name(&names, configured.as_deref())?;
    let url = git_output(root, &["remote", "get-url", &name])?;
    let url = String::from_utf8_lossy(&url.stdout).trim().to_owned();
    let Some((host, project)) = parse_remote_url(&url) else {
        return Err("unsupported Git remote URL".to_owned());
    };
    let Some(provider) = provider_from_host(&host) else {
        return Err(format!("unsupported Git remote host: {host}"));
    };
    Ok(Some(RemoteInfo {
        name,
        host,
        project,
        provider,
    }))
}

fn select_remote_name(names: &[String], configured: Option<&str>) -> Result<String, String> {
    if let Some(configured) = configured {
        if names.iter().any(|name| name == configured) {
            return Ok(configured.to_owned());
        }
    }
    if names.iter().any(|name| name == "origin") {
        return Ok("origin".to_owned());
    }
    if names.len() == 1 {
        return Ok(names[0].clone());
    }
    Err(
        "ambiguous Git remote selection: configure a branch upstream or an origin remote"
            .to_owned(),
    )
}

fn parse_remote_url(value: &str) -> Option<(String, String)> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let (host, path) = if let Some((_, remainder)) = value.split_once("://") {
        let slash = remainder.find('/')?;
        let authority = &remainder[..slash];
        let host = authority
            .rsplit_once('@')
            .map_or(authority, |(_, host)| host);
        (host, &remainder[slash + 1..])
    } else {
        let (authority, path) = value.split_once(':')?;
        let host = authority
            .rsplit_once('@')
            .map_or(authority, |(_, host)| host);
        (host, path)
    };
    let host = host.trim().trim_matches('/');
    let project = path
        .trim()
        .trim_matches('/')
        .strip_suffix(".git")
        .unwrap_or(path.trim().trim_matches('/'));
    if host.is_empty()
        || project.is_empty()
        || !project.contains('/')
        || host.chars().any(char::is_whitespace)
        || project.chars().any(char::is_whitespace)
    {
        return None;
    }
    Some((host.to_owned(), project.to_owned()))
}

fn provider_from_host(host: &str) -> Option<GitCiProvider> {
    let host = host.to_ascii_lowercase();
    if host == "github.com" || host.contains("github") {
        Some(GitCiProvider::Github)
    } else if host == "gitlab.com" || host.contains("gitlab") {
        Some(GitCiProvider::Gitlab)
    } else {
        None
    }
}

fn remote_contains_head(root: &Path, remote: &str, head: &str) -> Result<bool, String> {
    let prefix = format!("refs/remotes/{remote}/");
    let output = git_output(
        root,
        &[
            "for-each-ref",
            "--format=%(refname)",
            "--contains",
            head,
            &prefix,
        ],
    )?;
    Ok(!String::from_utf8_lossy(&output.stdout).trim().is_empty())
}

fn resolve_cli_executable(name: &str) -> Option<PathBuf> {
    let executable_name = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    };
    if let Some(path) = env::var_os("PATH") {
        for directory in env::split_paths(&path) {
            let candidate = directory.join(&executable_name);
            if candidate.is_file() {
                return Some(candidate);
            }
            #[cfg(windows)]
            {
                let cmd = directory.join(format!("{name}.cmd"));
                if cmd.is_file() {
                    return Some(cmd);
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    for directory in ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"] {
        let candidate = Path::new(directory).join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    if let Some(home) = env::var_os("HOME") {
        let candidate = PathBuf::from(home)
            .join(".local/bin")
            .join(&executable_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn run_auth_check(
    executable: &Path,
    root: &Path,
    remote: &RemoteInfo,
    cancelled: &AtomicBool,
) -> Result<CliOutput, String> {
    let args = match remote.provider {
        GitCiProvider::Github => vec![
            "auth".to_owned(),
            "status".to_owned(),
            "--active".to_owned(),
            "--hostname".to_owned(),
            remote.host.clone(),
        ],
        GitCiProvider::Gitlab => vec![
            "auth".to_owned(),
            "status".to_owned(),
            "--hostname".to_owned(),
            remote.host.clone(),
        ],
    };
    run_cli(executable, root, &args, cancelled)
}

fn github_runs(
    executable: &Path,
    root: &Path,
    remote: &RemoteInfo,
    head: &str,
    cancelled: &AtomicBool,
) -> Result<Vec<GitCiRun>, String> {
    let repository = github_repository(remote);
    let args = vec![
        "run".to_owned(),
        "list".to_owned(),
        "--commit".to_owned(),
        head.to_owned(),
        "--limit".to_owned(),
        MAX_CI_RUNS.to_string(),
        "--json".to_owned(),
        "databaseId,workflowName,name,status,conclusion,headSha,headBranch,url,createdAt,updatedAt"
            .to_owned(),
        "--repo".to_owned(),
        repository,
    ];
    let output = require_cli_success(
        "GitHub Actions lookup",
        run_cli(executable, root, &args, cancelled)?,
    )?;
    let parsed: Vec<GithubRun> = serde_json::from_str(&output.stdout)
        .map_err(|error| format!("could not decode gh workflow runs: {error}"))?;
    Ok(parsed
        .into_iter()
        .filter(|run| run.head_sha == head)
        .take(MAX_CI_RUNS)
        .map(|run| {
            let raw_status = if run.status == "completed" && !run.conclusion.is_empty() {
                run.conclusion.clone()
            } else {
                run.status.clone()
            };
            GitCiRun {
                id: run.database_id.to_string(),
                name: if run.workflow_name.trim().is_empty() {
                    if run.name.trim().is_empty() {
                        "Workflow".to_owned()
                    } else {
                        run.name
                    }
                } else {
                    run.workflow_name
                },
                status: github_status(&run.status, &run.conclusion),
                raw_status,
                url: run.url,
                branch: run.head_branch,
                head_sha: run.head_sha,
                created_at: run.created_at,
                updated_at: run.updated_at,
            }
        })
        .collect())
}

fn gitlab_runs(
    executable: &Path,
    root: &Path,
    remote: &RemoteInfo,
    head: &str,
    cancelled: &AtomicBool,
) -> Result<Vec<GitCiRun>, String> {
    let endpoint = format!(
        "projects/{}/pipelines?sha={head}&per_page={MAX_CI_RUNS}",
        percent_encode_project(&remote.project)
    );
    let args = vec![
        "api".to_owned(),
        "--hostname".to_owned(),
        remote.host.clone(),
        endpoint,
    ];
    let output = require_cli_success(
        "GitLab pipeline lookup",
        run_cli(executable, root, &args, cancelled)?,
    )?;
    let parsed: Vec<GitlabPipeline> = serde_json::from_str(&output.stdout)
        .map_err(|error| format!("could not decode glab pipelines: {error}"))?;
    Ok(parsed
        .into_iter()
        .filter(|run| run.sha == head)
        .take(MAX_CI_RUNS)
        .map(|run| GitCiRun {
            id: run.id.to_string(),
            name: run
                .name
                .filter(|name| !name.trim().is_empty())
                .unwrap_or_else(|| format!("Pipeline #{}", run.id)),
            status: gitlab_status(&run.status),
            raw_status: run.status,
            url: run.web_url,
            branch: run.branch,
            head_sha: run.sha,
            created_at: run.created_at,
            updated_at: run.updated_at,
        })
        .collect())
}

fn github_jobs(
    executable: &Path,
    root: &Path,
    remote: &RemoteInfo,
    run_id: &str,
    cancelled: &AtomicBool,
) -> Result<Vec<GitCiJob>, String> {
    let args = vec![
        "run".to_owned(),
        "view".to_owned(),
        run_id.to_owned(),
        "--json".to_owned(),
        "jobs".to_owned(),
        "--jq".to_owned(),
        "{jobs: [.jobs[] | {databaseId,name,status,conclusion,url,startedAt,completedAt}]}"
            .to_owned(),
        "--repo".to_owned(),
        github_repository(remote),
    ];
    let output = require_cli_success(
        "GitHub Actions jobs lookup",
        run_cli(executable, root, &args, cancelled)?,
    )?;
    let parsed: GithubRunView = serde_json::from_str(&output.stdout)
        .map_err(|error| format!("could not decode gh workflow jobs: {error}"))?;
    Ok(parsed
        .jobs
        .into_iter()
        .take(MAX_CI_JOBS)
        .map(|job| {
            let raw_status = if job.status == "completed" && !job.conclusion.is_empty() {
                job.conclusion.clone()
            } else {
                job.status.clone()
            };
            GitCiJob {
                id: job.database_id.to_string(),
                name: job.name,
                stage: None,
                status: github_status(&job.status, &job.conclusion),
                raw_status,
                url: job.url,
                started_at: job.started_at,
                completed_at: job.completed_at,
            }
        })
        .collect())
}

fn gitlab_jobs(
    executable: &Path,
    root: &Path,
    remote: &RemoteInfo,
    run_id: &str,
    cancelled: &AtomicBool,
) -> Result<Vec<GitCiJob>, String> {
    let endpoint = format!(
        "projects/{}/pipelines/{run_id}/jobs?per_page={MAX_CI_JOBS}",
        percent_encode_project(&remote.project)
    );
    let args = vec![
        "api".to_owned(),
        "--hostname".to_owned(),
        remote.host.clone(),
        endpoint,
    ];
    let output = require_cli_success(
        "GitLab pipeline jobs lookup",
        run_cli(executable, root, &args, cancelled)?,
    )?;
    let parsed: Vec<GitlabJob> = serde_json::from_str(&output.stdout)
        .map_err(|error| format!("could not decode glab pipeline jobs: {error}"))?;
    Ok(parsed
        .into_iter()
        .take(MAX_CI_JOBS)
        .map(|job| GitCiJob {
            id: job.id.to_string(),
            name: job.name,
            stage: job.stage,
            status: gitlab_status(&job.status),
            raw_status: job.status,
            url: job.web_url,
            started_at: job.started_at,
            completed_at: job.finished_at,
        })
        .collect())
}

fn github_repository(remote: &RemoteInfo) -> String {
    if remote.host.eq_ignore_ascii_case("github.com") {
        remote.project.clone()
    } else {
        format!("{}/{}", remote.host, remote.project)
    }
}

fn github_status(status: &str, conclusion: &str) -> GitCiStatus {
    match status.to_ascii_lowercase().as_str() {
        "queued" | "waiting" | "pending" | "requested" => GitCiStatus::Queued,
        "in_progress" | "running" => GitCiStatus::Running,
        "completed" => match conclusion.to_ascii_lowercase().as_str() {
            "success" => GitCiStatus::Success,
            "failure" | "timed_out" | "action_required" | "startup_failure" | "stale" => {
                GitCiStatus::Failure
            }
            "cancelled" => GitCiStatus::Cancelled,
            _ => GitCiStatus::Neutral,
        },
        "success" => GitCiStatus::Success,
        "failure" | "failed" => GitCiStatus::Failure,
        "cancelled" => GitCiStatus::Cancelled,
        _ => GitCiStatus::Neutral,
    }
}

fn gitlab_status(status: &str) -> GitCiStatus {
    match status.to_ascii_lowercase().as_str() {
        "created" | "waiting_for_resource" | "preparing" | "pending" | "scheduled" => {
            GitCiStatus::Queued
        }
        "running" => GitCiStatus::Running,
        "success" => GitCiStatus::Success,
        "failed" => GitCiStatus::Failure,
        "canceled" | "cancelled" => GitCiStatus::Cancelled,
        _ => GitCiStatus::Neutral,
    }
}

fn percent_encode_project(project: &str) -> String {
    let mut encoded = String::with_capacity(project.len());
    for byte in project.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push('%');
            encoded.push_str(&format!("{byte:02X}"));
        }
    }
    encoded
}

fn run_cli(
    executable: &Path,
    root: &Path,
    args: &[String],
    cancelled: &AtomicBool,
) -> Result<CliOutput, String> {
    if cancelled.load(Ordering::Acquire) {
        return Err("CI request cancelled".to_owned());
    }
    let mut command = std::process::Command::new(executable);
    command
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_PROMPT", "1")
        .env("GLAB_CHECK_UPDATE", "false")
        .env("GLAB_SEND_TELEMETRY", "false")
        .env("NO_COLOR", "1")
        .env("PAGER", "cat")
        .env("GH_PAGER", "cat")
        .env("GLAB_PAGER", "cat")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    native_process::isolate(&mut command);
    let mut child = native_process::spawn(&mut command)
        .map_err(|error| format!("failed to start {}: {error}", executable.to_string_lossy()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "CI command stdout pipe is unavailable".to_owned())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "CI command stderr pipe is unavailable".to_owned())?;
    let stdout_thread = thread::spawn(move || read_bounded(stdout, MAX_CI_STDOUT_BYTES));
    let stderr_thread = thread::spawn(move || read_bounded(stderr, MAX_CI_STDERR_BYTES));
    let deadline = Instant::now() + CI_COMMAND_TIMEOUT;

    let status = loop {
        if cancelled.load(Ordering::Acquire) {
            let _ = native_process::force_stop(&mut child);
            let _ = child.wait();
            let _ = stdout_thread.join();
            let _ = stderr_thread.join();
            return Err("CI request cancelled".to_owned());
        }
        match native_process::exited_before_reap(&child) {
            Ok(true) => {
                // The leader may have spawned helpers that inherited the pipes. Kill the
                // process group before reaping so no descendant can keep a pipe alive.
                let _ = native_process::force_stop(&mut child);
                break child
                    .wait()
                    .map_err(|error| format!("failed to reap CI command: {error}"))?;
            }
            Ok(false) => {}
            Err(error) => {
                let _ = native_process::force_stop(&mut child);
                let _ = child.wait();
                let _ = stdout_thread.join();
                let _ = stderr_thread.join();
                return Err(format!("failed to observe CI command: {error}"));
            }
        }
        #[cfg(not(unix))]
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("failed to observe CI command: {error}"))?
        {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = native_process::force_stop(&mut child);
            let _ = child.wait();
            let _ = stdout_thread.join();
            let _ = stderr_thread.join();
            return Err(format!(
                "{} command timed out after {} seconds",
                executable
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("CI"),
                CI_COMMAND_TIMEOUT.as_secs()
            ));
        }
        thread::sleep(POLL_INTERVAL);
    };
    let stdout = stdout_thread
        .join()
        .map_err(|_| "CI stdout reader failed".to_owned())?;
    let stderr = stderr_thread
        .join()
        .map_err(|_| "CI stderr reader failed".to_owned())?;
    Ok(CliOutput {
        status,
        stdout,
        stderr,
    })
}

fn read_bounded(mut reader: impl Read, limit: usize) -> String {
    let mut captured = Vec::with_capacity(limit.min(64 * 1024));
    let mut buffer = [0u8; 8192];
    loop {
        let Ok(read) = reader.read(&mut buffer) else {
            break;
        };
        if read == 0 {
            break;
        }
        if captured.len() < limit {
            let remaining = limit - captured.len();
            captured.extend_from_slice(&buffer[..read.min(remaining)]);
        }
    }
    String::from_utf8_lossy(&captured).into_owned()
}

fn require_cli_success(label: &str, output: CliOutput) -> Result<CliOutput, String> {
    if output.status.success() {
        Ok(output)
    } else {
        Err(format!("{label} failed{}", cli_error_detail(&output)))
    }
}

fn cli_error_detail(output: &CliOutput) -> String {
    let stderr = output.stderr.trim();
    let stdout = output.stdout.trim();
    let detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        return output
            .status
            .code()
            .map(|code| format!(" (exit code {code})"))
            .unwrap_or_else(|| " (terminated without an exit code)".to_owned());
    };
    let detail = detail.lines().next().unwrap_or(detail).trim();
    if detail.is_empty() {
        String::new()
    } else {
        format!(": {detail}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_common_github_and_gitlab_remote_urls() {
        assert_eq!(
            parse_remote_url("git@github.com:owner/repo.git"),
            Some(("github.com".to_owned(), "owner/repo".to_owned()))
        );
        assert_eq!(
            parse_remote_url("https://gitlab.example.com/group/nested/repo.git"),
            Some((
                "gitlab.example.com".to_owned(),
                "group/nested/repo".to_owned()
            ))
        );
        assert_eq!(
            parse_remote_url("ssh://git@github.example.com/acme/repo.git"),
            Some(("github.example.com".to_owned(), "acme/repo".to_owned()))
        );
        assert_eq!(parse_remote_url("local-path"), None);
    }

    #[test]
    fn recognizes_provider_hosts_without_accepting_unrelated_hosts() {
        assert_eq!(
            provider_from_host("github.com"),
            Some(GitCiProvider::Github)
        );
        assert_eq!(
            provider_from_host("github.enterprise.example"),
            Some(GitCiProvider::Github)
        );
        assert_eq!(
            provider_from_host("gitlab.com"),
            Some(GitCiProvider::Gitlab)
        );
        assert_eq!(provider_from_host("code.example.com"), None);
    }

    #[test]
    fn normalizes_provider_statuses() {
        assert_eq!(github_status("queued", ""), GitCiStatus::Queued);
        assert_eq!(github_status("in_progress", ""), GitCiStatus::Running);
        assert_eq!(github_status("completed", "success"), GitCiStatus::Success);
        assert_eq!(
            github_status("completed", "timed_out"),
            GitCiStatus::Failure
        );
        assert_eq!(gitlab_status("pending"), GitCiStatus::Queued);
        assert_eq!(gitlab_status("running"), GitCiStatus::Running);
        assert_eq!(gitlab_status("success"), GitCiStatus::Success);
        assert_eq!(gitlab_status("failed"), GitCiStatus::Failure);
    }

    #[test]
    fn encodes_nested_gitlab_project_paths() {
        assert_eq!(
            percent_encode_project("group/sub/repo"),
            "group%2Fsub%2Frepo"
        );
    }

    #[test]
    fn remote_selection_never_guesses_between_ambiguous_remotes() {
        let remotes = vec!["backup".to_owned(), "upstream".to_owned()];
        assert_eq!(
            select_remote_name(&remotes, Some("upstream")).unwrap(),
            "upstream"
        );
        assert!(select_remote_name(&remotes, None)
            .unwrap_err()
            .contains("ambiguous Git remote selection"));

        let with_origin = vec!["mirror".to_owned(), "origin".to_owned()];
        assert_eq!(select_remote_name(&with_origin, None).unwrap(), "origin");
        assert_eq!(
            select_remote_name(&["only".to_owned()], None).unwrap(),
            "only"
        );
    }

    #[test]
    fn window_cancellation_only_removes_owned_ci_requests() {
        let state = GitCiProcessState::default();
        let one = register_request(&state.requests, "one", "window-a").unwrap();
        let two = register_request(&state.requests, "two", "window-b").unwrap();

        state.cancel_window("window-a");
        assert!(one.load(Ordering::Acquire));
        assert!(!two.load(Ordering::Acquire));
        {
            let requests = state.requests.lock().unwrap();
            assert!(!requests.contains_key("one"));
            assert!(requests.contains_key("two"));
        }

        state.cancel_all();
        assert!(two.load(Ordering::Acquire));
        assert!(state.requests.lock().unwrap().is_empty());
    }
}
