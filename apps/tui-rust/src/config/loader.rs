use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use thiserror::Error;
use tracing::{debug, warn};

use super::types::{IconThemeConfig, PixConfig};

const PIX_MODEL_ENV: &str = "PIX_MODEL";
const PIX_THEME_ENV: &str = "PIX_THEME";
const PIX_STREAMING_BEHAVIOR_ENV: &str = "PIX_STREAMING_BEHAVIOR";
const PIX_PROMPT_ENHANCER_MODEL_ENV: &str = "PIX_PROMPT_ENHANCER_MODEL";
const PIX_AUTOCOMPLETE_MODEL_ENV: &str = "PIX_AUTOCOMPLETE_MODEL";
const PIX_SESSION_TITLE_MODEL_ENV: &str = "PIX_SESSION_TITLE_MODEL";
const PIX_IGNORE_CONTEXT_FILES_ENV: &str = "PIX_IGNORE_CONTEXT_FILES";
const PIX_MAX_PROJECT_SESSIONS_ENV: &str = "PIX_MAX_PROJECT_SESSIONS";
const PIX_ICON_THEME_ENV: &str = "PIX_ICON_THEME";
const PIX_USE_FALLBACK_ICONS_ENV: &str = "PIX_USE_FALLBACK_ICONS";

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("read {path}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("parse TOML {path}: {source}")]
    Toml {
        path: PathBuf,
        #[source]
        source: toml::de::Error,
    },
    #[error("parse JSON {path}: {source}")]
    Json {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
}

pub fn load_config() -> Result<PixConfig, ConfigError> {
    load_config_with_cli_model(None)
}

pub fn load_config_with_cli_model(cli_model_ref: Option<&str>) -> Result<PixConfig, ConfigError> {
    let mut config = if let Some(config_dir) = dirs::config_dir() {
        load_from_config_dir(&config_dir)?
    } else {
        warn!("dirs::config_dir() returned None; using pix defaults");
        PixConfig::default()
    };

    apply_env_overrides(&mut config, std::env::vars());
    apply_cli_overrides(&mut config, cli_model_ref);
    Ok(config)
}

fn load_from_config_dir(config_dir: &Path) -> Result<PixConfig, ConfigError> {
    let pix_dir = config_dir.join("pix");
    for file_name in ["config.toml", "config.json", "config.jsonc"] {
        let path = pix_dir.join(file_name);
        if !path.exists() {
            continue;
        }
        debug!(path = %path.display(), "loading pix config");
        return load_from_path(&path);
    }
    Ok(PixConfig::default())
}

fn load_from_path(path: &Path) -> Result<PixConfig, ConfigError> {
    let raw = fs::read_to_string(path).map_err(|source| ConfigError::Read {
        path: path.to_path_buf(),
        source,
    })?;

    let mut config = match path.extension().and_then(|s| s.to_str()) {
        Some("toml") => toml::from_str::<PixConfig>(&raw).map_err(|source| ConfigError::Toml {
            path: path.to_path_buf(),
            source,
        })?,
        Some("jsonc") => {
            let stripped = strip_jsonc_comments(&raw);
            serde_json::from_str::<PixConfig>(&strip_trailing_json_commas(&stripped)).map_err(
                |source| ConfigError::Json {
                    path: path.to_path_buf(),
                    source,
                },
            )?
        }
        _ => serde_json::from_str::<PixConfig>(&raw).map_err(|source| ConfigError::Json {
            path: path.to_path_buf(),
            source,
        })?,
    };
    config.refresh_derived();
    Ok(config)
}

fn apply_cli_overrides(config: &mut PixConfig, cli_model_ref: Option<&str>) {
    if let Some(model) = non_empty(cli_model_ref) {
        config.set_model_ref(model);
    }
}

fn apply_env_overrides<I, K, V>(config: &mut PixConfig, env: I)
where
    I: IntoIterator<Item = (K, V)>,
    K: AsRef<str>,
    V: AsRef<str>,
{
    let env: BTreeMap<String, String> = env
        .into_iter()
        .map(|(k, v)| (k.as_ref().to_string(), v.as_ref().to_string()))
        .collect();

    if let Some(model) = env_non_empty(&env, PIX_MODEL_ENV) {
        config.set_model_ref(model);
    }
    if let Some(theme) = env_non_empty(&env, PIX_THEME_ENV) {
        config.theme_name = theme.to_string();
    }
    if let Some(streaming) = env_non_empty(&env, PIX_STREAMING_BEHAVIOR_ENV) {
        config.streaming_behavior = streaming.to_string();
    }
    if let Some(model) = env_non_empty(&env, PIX_PROMPT_ENHANCER_MODEL_ENV) {
        config.prompt_enhancer.model_ref = model.to_string();
    }
    if let Some(model) = env_non_empty(&env, PIX_AUTOCOMPLETE_MODEL_ENV) {
        config.autocomplete.model_ref = model.to_string();
    }
    if let Some(model) = env_non_empty(&env, PIX_SESSION_TITLE_MODEL_ENV) {
        config.session_title.model_ref = model.to_string();
    }
    if let Some(value) = env_non_empty(&env, PIX_IGNORE_CONTEXT_FILES_ENV).and_then(parse_bool) {
        config.ignore_context_files = value;
    }
    if let Some(value) =
        env_non_empty(&env, PIX_MAX_PROJECT_SESSIONS_ENV).and_then(|v| v.parse::<u32>().ok())
    {
        config.max_project_sessions = value;
    }
    if let Some(icon_theme) = icon_theme_from_env(&env) {
        config.icon_theme = IconThemeConfig { name: icon_theme };
    }
}

fn env_non_empty<'a>(env: &'a BTreeMap<String, String>, key: &str) -> Option<&'a str> {
    non_empty(env.get(key).map(String::as_str))
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|v| !v.is_empty())
}

fn parse_bool(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn icon_theme_from_env(env: &BTreeMap<String, String>) -> Option<String> {
    env_non_empty(env, PIX_USE_FALLBACK_ICONS_ENV)
        .and_then(|v| match v.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" | "fallback" => Some("fallback".to_string()),
            "0" | "false" | "no" | "off" | "nerdfont" | "nerd-font" => Some("nerdFont".to_string()),
            _ => None,
        })
        .or_else(|| {
            env_non_empty(env, PIX_ICON_THEME_ENV).and_then(|v| {
                let normalized = v.trim().to_ascii_lowercase().replace([' ', '_', '-'], "");
                match normalized.as_str() {
                    "fallback" | "plain" | "ascii" => Some("fallback".to_string()),
                    "nerdfont" | "font" | "icons" => Some("nerdFont".to_string()),
                    _ => None,
                }
            })
        })
}

/// Strip `//` and `/* */` comments while preserving JSON string contents.
pub fn strip_jsonc_comments(input: &str) -> String {
    #[derive(Clone, Copy)]
    enum State {
        Normal,
        String,
        Escape,
        LineComment,
        BlockComment,
        BlockCommentStar,
    }

    let mut out = String::with_capacity(input.len());
    let mut state = State::Normal;
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        match state {
            State::Normal => match ch {
                '"' => {
                    out.push(ch);
                    state = State::String;
                }
                '/' if chars.peek() == Some(&'/') => {
                    chars.next();
                    state = State::LineComment;
                }
                '/' if chars.peek() == Some(&'*') => {
                    chars.next();
                    state = State::BlockComment;
                }
                _ => out.push(ch),
            },
            State::String => {
                out.push(ch);
                match ch {
                    '\\' => state = State::Escape,
                    '"' => state = State::Normal,
                    _ => {}
                }
            }
            State::Escape => {
                out.push(ch);
                state = State::String;
            }
            State::LineComment => {
                if ch == '\n' {
                    out.push('\n');
                    state = State::Normal;
                }
            }
            State::BlockComment => {
                if ch == '*' {
                    state = State::BlockCommentStar;
                } else if ch == '\n' {
                    out.push('\n');
                }
            }
            State::BlockCommentStar => {
                if ch == '/' {
                    state = State::Normal;
                } else if ch != '*' {
                    if ch == '\n' {
                        out.push('\n');
                    }
                    state = State::BlockComment;
                }
            }
        }
    }

    out
}

fn strip_trailing_json_commas(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    let mut in_string = false;
    let mut escaped = false;

    while let Some(ch) = chars.next() {
        if in_string {
            out.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }

        if ch == '"' {
            in_string = true;
            out.push(ch);
            continue;
        }

        if ch == ',' {
            let mut lookahead = chars.clone();
            while matches!(lookahead.peek(), Some(c) if c.is_whitespace()) {
                lookahead.next();
            }
            if matches!(lookahead.peek(), Some('}' | ']')) {
                continue;
            }
        }
        out.push(ch);
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_jsonc(text: &str, env: &[(&str, &str)], cli: Option<&str>) -> PixConfig {
        let stripped = strip_jsonc_comments(text);
        let mut config: PixConfig = serde_json::from_str(&strip_trailing_json_commas(&stripped))
            .expect("jsonc config should parse");
        config.refresh_derived();
        apply_env_overrides(
            &mut config,
            env.iter()
                .map(|(k, v)| ((*k).to_string(), (*v).to_string())),
        );
        apply_cli_overrides(&mut config, cli);
        config
    }

    fn parse_toml(text: &str, env: &[(&str, &str)], cli: Option<&str>) -> PixConfig {
        let mut config: PixConfig = toml::from_str(text).expect("toml config should parse");
        config.refresh_derived();
        apply_env_overrides(
            &mut config,
            env.iter()
                .map(|(k, v)| ((*k).to_string(), (*v).to_string())),
        );
        apply_cli_overrides(&mut config, cli);
        config
    }

    #[test]
    fn defaults_applied() {
        let config = parse_jsonc("{}", &[], None);
        assert_eq!(config.model, "openai-codex/gpt-5.5:medium");
        assert_eq!(config.theme_name, "default");
        assert_eq!(config.prompt_enhancer.model_ref, "zai/glm-5-turbo");
        assert!(config.tool_renderer.tools.contains_key("apply_patch"));
    }

    #[test]
    fn jsonc_comment_stripping_preserves_strings() {
        let config = parse_jsonc(
            r#"{
              // line comment
              "defaultModel": { "modelRef": "vendor/http://model", "thinking": "low" },
              "themeName": "dark//not-comment", /* block comment */
            }"#,
            &[],
            None,
        );
        assert_eq!(config.model, "vendor/http://model:low");
        assert_eq!(config.theme_name, "dark//not-comment");
    }

    #[test]
    fn toml_parse() {
        let config = parse_toml(
            r#"
              theme_name = "light"

              [default_model]
              model_ref = "anthropic/claude-sonnet"
              thinking = "high"

              [autocomplete]
              model_ref = "zai/custom"
              debounce_ms = 500
            "#,
            &[],
            None,
        );
        assert_eq!(config.theme_name, "light");
        assert_eq!(config.model, "anthropic/claude-sonnet:high");
        assert_eq!(config.autocomplete.model_ref, "zai/custom");
        assert_eq!(config.autocomplete.timeout_ms, 3_000);
    }

    #[test]
    fn env_override_beats_file() {
        let config = parse_jsonc(
            r#"{ "defaultModel": { "modelRef": "file/model", "thinking": "low" }, "themeName": "light" }"#,
            &[
                (PIX_MODEL_ENV, "env/model:xhigh"),
                (PIX_THEME_ENV, "env-theme"),
            ],
            None,
        );
        assert_eq!(config.model, "env/model:xhigh");
        assert_eq!(config.theme_name, "env-theme");
    }

    #[test]
    fn cli_override_beats_env() {
        let config = parse_jsonc(
            r#"{ "defaultModel": { "modelRef": "file/model", "thinking": "low" } }"#,
            &[(PIX_MODEL_ENV, "env/model:medium")],
            Some("cli/model:off"),
        );
        assert_eq!(config.model, "cli/model:off");
    }
}
