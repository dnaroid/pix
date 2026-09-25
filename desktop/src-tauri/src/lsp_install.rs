use serde::Serialize;
use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};
use tauri::{AppHandle, Manager};

const MAX_INSTALL_OUTPUT_BYTES: usize = 512 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
struct InstallSpec {
    installer_id: &'static str,
    executable: String,
    args: Vec<String>,
    bin: PathBuf,
    env: BTreeMap<String, String>,
    preflight: Vec<InstallCommand>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct InstallCommand {
    executable: String,
    args: Vec<String>,
    env: BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspInstallResult {
    pub installer_id: String,
    pub bin: String,
    pub env: BTreeMap<String, String>,
    pub output: String,
}

#[tauri::command]
pub async fn install_lsp_server(
    app: AppHandle,
    installer_id: String,
) -> Result<LspInstallResult, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("failed to resolve the home directory: {error}"))?;
    tauri::async_runtime::spawn_blocking(move || install_lsp_server_from(&home, &installer_id))
        .await
        .map_err(|error| format!("LSP installer task failed: {error}"))?
}

fn install_lsp_server_from(home: &Path, installer_id: &str) -> Result<LspInstallResult, String> {
    let spec = install_spec(home, installer_id)
        .ok_or_else(|| format!("unsupported LSP installer: {installer_id}"))?;
    if let Some(parent) = spec.bin.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }

    let mut log = Vec::new();
    for command in &spec.preflight {
        log.push(run_install_command(command)?);
    }
    log.push(run_install_command(&InstallCommand {
        executable: spec.executable.clone(),
        args: spec.args.clone(),
        env: spec.env.clone(),
    })?);

    if !spec.bin.is_file() || !command_succeeds(&spec.bin, &spec.env) {
        return Err(format!(
            "{} installation completed but the language-server executable could not be verified at {}",
            spec.installer_id,
            spec.bin.display()
        ));
    }

    Ok(LspInstallResult {
        installer_id: spec.installer_id.to_owned(),
        bin: spec.bin.to_string_lossy().into_owned(),
        env: spec.env,
        output: truncate_output(&log.join("\n\n")),
    })
}

fn run_install_command(command: &InstallCommand) -> Result<String, String> {
    let output = Command::new(&command.executable)
        .args(&command.args)
        .envs(&command.env)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| {
            format!(
                "failed to start {}: {error}",
                display_command(&command.executable, &command.args)
            )
        })?;
    let rendered = render_output(command, &output);
    if !output.status.success() {
        return Err(format!(
            "LSP installation failed:\n{}",
            truncate_output(&rendered)
        ));
    }
    Ok(rendered)
}

fn render_output(command: &InstallCommand, output: &Output) -> String {
    let mut rendered = format!("$ {}", display_command(&command.executable, &command.args));
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stdout.trim().is_empty() {
        rendered.push('\n');
        rendered.push_str(stdout.trim_end());
    }
    if !stderr.trim().is_empty() {
        rendered.push('\n');
        rendered.push_str(stderr.trim_end());
    }
    rendered
}

fn display_command(executable: &str, args: &[String]) -> String {
    std::iter::once(executable)
        .chain(args.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(" ")
}

fn command_succeeds(bin: &Path, env: &BTreeMap<String, String>) -> bool {
    Command::new(bin)
        .arg("--version")
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn truncate_output(value: &str) -> String {
    if value.len() <= MAX_INSTALL_OUTPUT_BYTES {
        return value.to_owned();
    }
    let wanted = value.len().saturating_sub(MAX_INSTALL_OUTPUT_BYTES);
    let start = value
        .char_indices()
        .find(|(index, _)| *index >= wanted)
        .map(|(index, _)| index)
        .unwrap_or(value.len());
    format!("… output truncated …\n{}", &value[start..])
}

fn npm_spec(
    home: &Path,
    installer_id: &'static str,
    packages: &[&str],
    binary: &str,
) -> InstallSpec {
    let prefix = home.join(".local/share/pix/lsp").join(installer_id);
    let mut args = vec![
        "install".to_owned(),
        "--prefix".to_owned(),
        prefix.to_string_lossy().into_owned(),
    ];
    args.extend(packages.iter().map(|package| (*package).to_owned()));
    InstallSpec {
        installer_id,
        executable: "npm".to_owned(),
        args,
        bin: prefix.join("node_modules/.bin").join(binary),
        env: installer_base_env(),
        preflight: Vec::new(),
    }
}

fn installer_base_env() -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    if let Some(path) = super::login_shell_path().or_else(|| env::var_os("PATH")) {
        env.insert("PATH".to_owned(), path.to_string_lossy().into_owned());
    }
    env
}

fn install_spec(home: &Path, installer_id: &str) -> Option<InstallSpec> {
    let root = home.join(".local/share/pix/lsp");
    match installer_id {
        "typescript" => Some(npm_spec(
            home,
            "typescript",
            &["typescript", "typescript-language-server"],
            "typescript-language-server",
        )),
        "svelte" => Some(npm_spec(
            home,
            "svelte",
            &["svelte-language-server"],
            "svelteserver",
        )),
        "vue" => Some(npm_spec(
            home,
            "vue",
            &["@vue/language-server", "typescript"],
            "vue-language-server",
        )),
        "python" => {
            let prefix = root.join("python");
            let python = prefix.join("bin/python");
            let install_env = installer_base_env();
            Some(InstallSpec {
                installer_id: "python",
                executable: python.to_string_lossy().into_owned(),
                args: vec![
                    "-m".to_owned(),
                    "pip".to_owned(),
                    "install".to_owned(),
                    "--upgrade".to_owned(),
                    "python-lsp-server".to_owned(),
                ],
                bin: prefix.join("bin/pylsp"),
                env: install_env.clone(),
                preflight: vec![InstallCommand {
                    executable: "python3".to_owned(),
                    args: vec![
                        "-m".to_owned(),
                        "venv".to_owned(),
                        prefix.to_string_lossy().into_owned(),
                    ],
                    env: install_env,
                }],
            })
        }
        "go" => {
            let prefix = root.join("go");
            let mut env = installer_base_env();
            env.insert("GOBIN".to_owned(), prefix.to_string_lossy().into_owned());
            Some(InstallSpec {
                installer_id: "go",
                executable: "go".to_owned(),
                args: vec![
                    "install".to_owned(),
                    "golang.org/x/tools/gopls@latest".to_owned(),
                ],
                bin: prefix.join("gopls"),
                env,
                preflight: Vec::new(),
            })
        }
        "rust" => Some(InstallSpec {
            installer_id: "rust",
            executable: "rustup".to_owned(),
            args: vec![
                "component".to_owned(),
                "add".to_owned(),
                "rust-analyzer".to_owned(),
            ],
            bin: home.join(".cargo/bin/rust-analyzer"),
            env: installer_base_env(),
            preflight: Vec::new(),
        }),
        "ruby" => {
            let prefix = root.join("ruby");
            let mut env = installer_base_env();
            env.insert("GEM_HOME".to_owned(), prefix.to_string_lossy().into_owned());
            env.insert("GEM_PATH".to_owned(), prefix.to_string_lossy().into_owned());
            Some(InstallSpec {
                installer_id: "ruby",
                executable: "gem".to_owned(),
                args: vec![
                    "install".to_owned(),
                    "--install-dir".to_owned(),
                    prefix.to_string_lossy().into_owned(),
                    "--no-document".to_owned(),
                    "ruby-lsp".to_owned(),
                ],
                bin: prefix.join("bin/ruby-lsp"),
                env,
                preflight: Vec::new(),
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installer_catalog_uses_fixed_commands_and_pix_owned_paths() {
        let home = Path::new("/Users/test");
        let typescript = install_spec(home, "typescript").expect("typescript installer");
        assert_eq!(typescript.executable, "npm");
        assert!(typescript.bin.ends_with(
            ".local/share/pix/lsp/typescript/node_modules/.bin/typescript-language-server"
        ));

        let python = install_spec(home, "python").expect("python installer");
        assert_eq!(python.preflight[0].executable, "python3");
        assert!(python
            .bin
            .ends_with(".local/share/pix/lsp/python/bin/pylsp"));

        let go = install_spec(home, "go").expect("go installer");
        assert_eq!(
            go.env.get("GOBIN").map(String::as_str),
            Some("/Users/test/.local/share/pix/lsp/go")
        );
        assert!(install_spec(home, "../../evil").is_none());
        assert!(install_spec(home, "shell").is_none());
    }
}
