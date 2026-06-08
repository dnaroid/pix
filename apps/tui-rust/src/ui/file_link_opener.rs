use std::env;
use std::path::{is_separator, Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenResult {
    pub target: OpenTarget,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenTarget {
    Editor,
    System,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum EditorKind {
    Cursor,
    JetBrains,
    VsCode,
    Windsurf,
    Zed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct EditorLaunch {
    args: Vec<String>,
    candidates: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileLocation {
    column: Option<usize>,
    line: Option<usize>,
    path: PathBuf,
}

pub fn open_file_link(url: &str) -> Result<OpenResult, String> {
    let Some(location) = parse_file_url(url) else {
        return Err("unsupported link target".to_string());
    };

    let env = env_map();
    let editor = detect_editor(env);
    if let Some(launch) = preferred_editor_launch(env, &location, editor.as_ref()) {
        if try_spawn_candidates(&launch.candidates, &launch.args) {
            return Ok(OpenResult {
                target: OpenTarget::Editor,
                label: editor
                    .as_ref()
                    .map(editor_display_name)
                    .unwrap_or("editor")
                    .to_string(),
            });
        }
    }

    let system_args = vec![location.path.to_string_lossy().to_string()];
    if spawn_system_viewer(&system_args) {
        return Ok(OpenResult {
            target: OpenTarget::System,
            label: "system viewer".to_string(),
        });
    }

    Err("failed to open file link".to_string())
}

fn parse_file_url(url: &str) -> Option<FileLocation> {
    let path = url.strip_prefix("file://")?;
    let decoded = percent_decode(path)?;
    let (path_part, line, column) = strip_line_suffix(&decoded);
    Some(FileLocation {
        path: PathBuf::from(path_part),
        line,
        column,
    })
}

fn strip_line_suffix(text: &str) -> (&str, Option<usize>, Option<usize>) {
    let last = text.rfind(':');
    let Some(last_idx) = last else {
        return (text, None, None);
    };
    let last_part = &text[last_idx + 1..];
    if !all_ascii_digits(last_part) {
        return (text, None, None);
    }

    let before_last = &text[..last_idx];
    if let Some(second_idx) = before_last.rfind(':') {
        let second_part = &before_last[second_idx + 1..];
        let path_part = &before_last[..second_idx];
        if !path_part.is_empty() && all_ascii_digits(second_part) {
            return (
                path_part,
                second_part.parse::<usize>().ok(),
                last_part.parse::<usize>().ok(),
            );
        }
    }

    (before_last, last_part.parse::<usize>().ok(), None)
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut idx = 0;
    while idx < bytes.len() {
        if bytes[idx] == b'%' {
            let hi = *bytes.get(idx + 1)?;
            let lo = *bytes.get(idx + 2)?;
            let value = hex_value(hi)? << 4 | hex_value(lo)?;
            out.push(value);
            idx += 3;
        } else {
            out.push(bytes[idx]);
            idx += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn preferred_editor_launch(
    env: &std::collections::HashMap<String, String>,
    location: &FileLocation,
    editor: Option<&EditorKind>,
) -> Option<EditorLaunch> {
    let editor = editor?;
    Some(match editor {
        EditorKind::Cursor => EditorLaunch {
            args: vec!["--goto".to_string(), goto_target(location)],
            candidates: command_candidates(env.get("CURSOR_CLI").cloned(), &["cursor"]),
        },
        EditorKind::JetBrains => EditorLaunch {
            args: jetbrains_target_args(location),
            candidates: command_candidates(
                env.get("JETBRAINS_IDE_CLI").cloned(),
                &[
                    "idea",
                    "idea64",
                    "webstorm",
                    "webstorm64",
                    "pycharm",
                    "pycharm64",
                    "goland",
                    "goland64",
                    "clion",
                    "clion64",
                    "phpstorm",
                    "phpstorm64",
                    "rubymine",
                    "rubymine64",
                    "rider",
                    "rider64",
                ],
            ),
        },
        EditorKind::VsCode => EditorLaunch {
            args: vec!["--goto".to_string(), goto_target(location)],
            candidates: command_candidates(env.get("VSCODE_CLI").cloned(), &["code", "code-insiders"]),
        },
        EditorKind::Windsurf => EditorLaunch {
            args: vec!["--goto".to_string(), goto_target(location)],
            candidates: command_candidates(env.get("WINDSURF_CLI").cloned(), &["windsurf"]),
        },
        EditorKind::Zed => EditorLaunch {
            args: vec![zed_target(location)],
            candidates: zed_command_candidates(env),
        },
    })
}

fn detect_editor(env: &std::collections::HashMap<String, String>) -> Option<EditorKind> {
    let term_program = env.get("TERM_PROGRAM").map(|v| v.trim().to_ascii_lowercase());
    let terminal_emulator = env
        .get("TERMINAL_EMULATOR")
        .map(|v| v.trim().to_ascii_lowercase());
    let terminal_provider = env
        .get("TERMINAL_PROVIDER")
        .map(|v| v.trim().to_ascii_lowercase());

    if term_program.as_deref() == Some("cursor")
        || env.contains_key("CURSOR_TRACE_ID")
        || env.contains_key("CURSOR_TRACE")
    {
        return Some(EditorKind::Cursor);
    }
    if term_program.as_deref() == Some("windsurf") {
        return Some(EditorKind::Windsurf);
    }
    if term_program.as_deref() == Some("zed") || env.contains_key("ZED_CLI") {
        return Some(EditorKind::Zed);
    }
    if term_program.as_deref() == Some("vscode")
        || env.contains_key("VSCODE_IPC_HOOK_CLI")
        || env.contains_key("VSCODE_GIT_IPC_HANDLE")
    {
        return Some(EditorKind::VsCode);
    }
    if terminal_emulator
        .as_deref()
        .is_some_and(|value| value.contains("jetbrains"))
        || terminal_provider.as_deref() == Some("jetbrains")
    {
        return Some(EditorKind::JetBrains);
    }
    None
}

fn editor_display_name(editor: &EditorKind) -> &'static str {
    match editor {
        EditorKind::Cursor => "Cursor",
        EditorKind::JetBrains => "JetBrains IDE",
        EditorKind::VsCode => "VS Code",
        EditorKind::Windsurf => "Windsurf",
        EditorKind::Zed => "Zed",
    }
}

fn goto_target(location: &FileLocation) -> String {
    let path = location.path.to_string_lossy();
    match (location.line, location.column) {
        (Some(line), Some(column)) => format!("{path}:{line}:{column}"),
        (Some(line), None) => format!("{path}:{line}"),
        _ => path.to_string(),
    }
}

fn zed_target(location: &FileLocation) -> String {
    goto_target(location)
}

fn jetbrains_target_args(location: &FileLocation) -> Vec<String> {
    let path = location.path.to_string_lossy().to_string();
    match location.line {
        Some(line) => vec!["--line".to_string(), line.to_string(), path],
        None => vec![path],
    }
}

fn command_candidates(primary: Option<String>, rest: &[&str]) -> Vec<String> {
    primary
        .into_iter()
        .chain(rest.iter().map(|candidate| (*candidate).to_string()))
        .filter(|candidate| !candidate.is_empty())
        .collect()
}

fn zed_command_candidates(env: &std::collections::HashMap<String, String>) -> Vec<String> {
    let mut candidates = vec![];
    if let Some(cli) = env.get("ZED_CLI") {
        if !cli.is_empty() {
            candidates.push(cli.clone());
        }
    }
    candidates.push("zed".to_string());
    candidates.push("zeditor".to_string());
    if env::consts::OS == "macos" {
        candidates.push("/opt/homebrew/bin/zed".to_string());
        candidates.push("/usr/local/bin/zed".to_string());
    }
    candidates
}

fn try_spawn_candidates(candidates: &[String], args: &[String]) -> bool {
    for command in candidates {
        if !can_run_command(command) {
            continue;
        }
        if spawn_detached(command, args) {
            return true;
        }
    }
    false
}

fn can_run_command(command: &str) -> bool {
    if has_path_separator(command) || Path::new(command).is_absolute() {
        return Path::new(command).exists();
    }
    command_on_path(command)
}

fn has_path_separator(command: &str) -> bool {
    command.chars().any(is_separator)
}

fn command_on_path(command: &str) -> bool {
    let Some(path) = env::var_os("PATH") else {
        return false;
    };
    let extensions = windows_extensions(command);
    env::split_paths(&path).any(|entry| {
        path_command_candidates(&entry, command, &extensions)
            .into_iter()
            .any(|candidate| candidate.exists())
    })
}

fn windows_extensions(command: &str) -> Vec<String> {
    if env::consts::OS != "windows" || Path::new(command).extension().is_some() {
        return vec![String::new()];
    }
    env::var("PATHEXT")
        .ok()
        .map(|value| value.split(';').map(str::to_string).collect())
        .unwrap_or_else(|| vec![".EXE".to_string(), ".CMD".to_string(), ".BAT".to_string(), ".COM".to_string()])
}

fn path_command_candidates(entry: &Path, command: &str, extensions: &[String]) -> Vec<PathBuf> {
    if env::consts::OS != "windows" || Path::new(command).extension().is_some() {
        return vec![entry.join(command)];
    }
    let mut candidates = Vec::with_capacity(extensions.len() + 1);
    candidates.push(entry.join(command));
    candidates.extend(extensions.iter().map(|extension| entry.join(format!("{command}{extension}"))));
    candidates
}

fn spawn_system_viewer(args: &[String]) -> bool {
    match env::consts::OS {
        "macos" => spawn_detached("open", args),
        "windows" => spawn_detached("cmd", &["/c".to_string(), "start".to_string(), "".to_string(), args[0].clone()]),
        _ => spawn_detached("xdg-open", args),
    }
}

fn spawn_detached(command: &str, args: &[String]) -> bool {
    Command::new(command).args(args).spawn().is_ok()
}

fn env_map() -> &'static std::collections::HashMap<String, String> {
    use std::sync::OnceLock;
    static ENV: OnceLock<std::collections::HashMap<String, String>> = OnceLock::new();
    ENV.get_or_init(|| env::vars().collect())
}

fn all_ascii_digits(text: &str) -> bool {
    !text.is_empty() && text.chars().all(|ch| ch.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn parses_file_url_with_line_and_column() {
        let location = parse_file_url("file:///tmp/demo.rs:12:3").expect("url");
        assert_eq!(location.path, PathBuf::from("/tmp/demo.rs"));
        assert_eq!(location.line, Some(12));
        assert_eq!(location.column, Some(3));
    }

    #[test]
    fn parses_percent_encoded_file_url() {
        let location = parse_file_url("file:///tmp/My%20File.rs:9").expect("url");
        assert_eq!(location.path, PathBuf::from("/tmp/My File.rs"));
        assert_eq!(location.line, Some(9));
        assert_eq!(location.column, None);
    }

    #[test]
    fn keeps_windows_drive_paths_without_column_suffix() {
        let (path, line, column) = strip_line_suffix("C:/workspace/demo.rs:14");
        assert_eq!(path, "C:/workspace/demo.rs");
        assert_eq!(line, Some(14));
        assert_eq!(column, None);
    }

    #[test]
    fn builds_vscode_goto_target() {
        let location = FileLocation {
            path: PathBuf::from("/tmp/demo.rs"),
            line: Some(7),
            column: Some(2),
        };
        assert_eq!(goto_target(&location), "/tmp/demo.rs:7:2");
    }

    #[test]
    fn builds_jetbrains_line_args() {
        let location = FileLocation {
            path: PathBuf::from("/tmp/demo.rs"),
            line: Some(11),
            column: Some(4),
        };
        assert_eq!(jetbrains_target_args(&location), vec!["--line", "11", "/tmp/demo.rs"]);
    }

    #[test]
    fn detects_vscode_from_ipc_hook() {
        let mut env = HashMap::new();
        env.insert("VSCODE_IPC_HOOK_CLI".to_string(), "/tmp/ipc".to_string());
        assert_eq!(detect_editor(&env), Some(EditorKind::VsCode));
    }

    #[test]
    fn detects_jetbrains_from_terminal_emulator() {
        let mut env = HashMap::new();
        env.insert(
            "TERMINAL_EMULATOR".to_string(),
            "JetBrains-JediTerm".to_string(),
        );
        assert_eq!(detect_editor(&env), Some(EditorKind::JetBrains));
    }

    #[test]
    fn builds_full_jetbrains_candidate_list() {
        let mut env = HashMap::new();
        env.insert("TERMINAL_PROVIDER".to_string(), "JetBrains".to_string());
        let location = FileLocation {
            path: PathBuf::from("/tmp/demo.rs"),
            line: Some(11),
            column: Some(4),
        };
        let launch = preferred_editor_launch(&env, &location, detect_editor(&env).as_ref())
            .expect("launch");
        assert!(launch.candidates.starts_with(&[
            "idea".to_string(),
            "idea64".to_string(),
            "webstorm".to_string(),
        ]));
    }
}
