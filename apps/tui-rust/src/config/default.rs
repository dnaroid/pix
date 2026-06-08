use std::collections::{BTreeMap, HashMap};

use super::types::*;

impl Default for PixConfig {
    fn default() -> Self {
        let default_model = DefaultModelConfig::default();
        Self {
            model: resolve_default_model_ref(&default_model),
            theme_name: "default".to_string(),
            streaming_behavior: "stream".to_string(),
            ignore_context_files: false,
            max_project_sessions: 0,
            default_model,
            tool_renderer: ToolRendererConfig::default(),
            output_filters: OutputFiltersConfig::default(),
            prompt_enhancer: PromptEnhancerConfig::default(),
            session_title: SessionTitleConfig::default(),
            autocomplete: AutocompleteConfig::default(),
            model_colors: ModelColorsConfig::default(),
            icon_theme: IconThemeConfig::default(),
            dictation: DictationConfig::default(),
            keybindings: KeybindingsConfig::default(),
        }
    }
}

impl Default for DefaultModelConfig {
    fn default() -> Self {
        Self {
            model_ref: "openai-codex/gpt-5.5".to_string(),
            thinking: Some(ThinkingLevel::Medium),
        }
    }
}

impl Default for ToolRendererConfig {
    fn default() -> Self {
        Self {
            default: ToolRendererRule {
                preview_lines: Some(0),
                direction: Some(PreviewDirection::Head),
                color: Some("toolTitle".to_string()),
                default_expanded: None,
                compact_hidden: None,
                hidden: None,
            },
            tools: default_tool_rules(),
        }
    }
}

impl Default for PromptEnhancerConfig {
    fn default() -> Self {
        Self {
            model_ref: "zai/glm-5-turbo".to_string(),
        }
    }
}

impl Default for SessionTitleConfig {
    fn default() -> Self {
        Self {
            model_ref: "zai/glm-5-turbo".to_string(),
        }
    }
}

impl Default for AutocompleteConfig {
    fn default() -> Self {
        Self {
            model_ref: "zai/glm-5-turbo".to_string(),
            debounce_ms: 350,
            timeout_ms: 3_000,
            max_tokens: 48,
            max_prompt_tokens: 1_200,
            include_recent_messages: 0,
        }
    }
}

impl Default for ModelColorsConfig {
    fn default() -> Self {
        Self {
            rules: BTreeMap::from([
                ("zai/*".to_string(), "success".to_string()),
                ("openai-codex/*".to_string(), "modelOpenAI".to_string()),
                ("antigravity/*".to_string(), "warning".to_string()),
                (
                    "antigravity/antigravity-claude-*".to_string(),
                    "error".to_string(),
                ),
            ]),
            direct_rules: BTreeMap::new(),
        }
    }
}

impl Default for IconThemeConfig {
    fn default() -> Self {
        Self {
            name: "nerdFont".to_string(),
        }
    }
}

impl Default for DictationConfig {
    fn default() -> Self {
        Self {
            language: "en".to_string(),
            languages: HashMap::from([
                (
                    "en".to_string(),
                    VoiceModelDefinition {
                        dir_name: "vosk-model-small-en-us-0.15".to_string(),
                        url: "https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip"
                            .to_string(),
                        label: "English".to_string(),
                    },
                ),
                (
                    "ru".to_string(),
                    VoiceModelDefinition {
                        dir_name: "vosk-model-small-ru-0.22".to_string(),
                        url: "https://alphacephei.com/vosk/models/vosk-model-small-ru-0.22.zip"
                            .to_string(),
                        label: "Russian".to_string(),
                    },
                ),
            ]),
        }
    }
}

impl Default for KeybindingsConfig {
    fn default() -> Self {
        Self {
            hints: BTreeMap::from([
                ("submit".to_string(), "Enter".to_string()),
                ("newline".to_string(), "Alt+Enter".to_string()),
                ("abort".to_string(), "Esc".to_string()),
                ("quit".to_string(), "Ctrl+C".to_string()),
                ("undo".to_string(), "Ctrl+Z".to_string()),
                ("compact".to_string(), "Ctrl+R".to_string()),
                ("newSession".to_string(), "Ctrl+N".to_string()),
            ]),
        }
    }
}

fn rule(
    preview_lines: Option<u32>,
    direction: Option<PreviewDirection>,
    color: &str,
    default_expanded: bool,
    hidden: bool,
) -> ToolRendererRule {
    ToolRendererRule {
        preview_lines,
        direction,
        color: Some(color.to_string()),
        default_expanded: default_expanded.then_some(true),
        compact_hidden: None,
        hidden: hidden.then_some(true),
    }
}

fn default_tool_rules() -> BTreeMap<String, ToolRendererRule> {
    let head = Some(PreviewDirection::Head);
    let tail = Some(PreviewDirection::Tail);
    BTreeMap::from([
        (
            "bash".to_string(),
            rule(Some(6), tail, "warning", false, false),
        ),
        (
            "Bash".to_string(),
            rule(Some(6), tail, "warning", false, false),
        ),
        (
            "shell".to_string(),
            rule(Some(6), tail, "warning", false, false),
        ),
        (
            "shell_command".to_string(),
            rule(Some(6), tail, "warning", false, false),
        ),
        (
            "repo_*".to_string(),
            rule(Some(6), head, "warning", false, false),
        ),
        (
            "apply_patch".to_string(),
            rule(Some(9999), head, "toolMutation", true, false),
        ),
        (
            "edit".to_string(),
            rule(Some(9999), head, "toolMutation", true, false),
        ),
        (
            "Edit".to_string(),
            rule(Some(9999), head, "toolMutation", true, false),
        ),
        (
            "write".to_string(),
            rule(Some(9999), head, "toolMutation", true, false),
        ),
        (
            "Write".to_string(),
            rule(Some(9999), head, "toolMutation", true, false),
        ),
        (
            "ast_apply".to_string(),
            rule(Some(9999), head, "toolMutation", true, false),
        ),
        (
            "Read".to_string(),
            rule(Some(0), head, "success", false, false),
        ),
        (
            "read".to_string(),
            rule(Some(0), head, "success", false, false),
        ),
        (
            "ast_grep".to_string(),
            rule(Some(6), head, "toolSearch", false, false),
        ),
        (
            "ast_*".to_string(),
            rule(None, None, "toolSearch", false, false),
        ),
        (
            "compress".to_string(),
            rule(Some(0), head, "info", false, false),
        ),
        (
            "web_search".to_string(),
            rule(Some(6), tail, "toolSearch", false, false),
        ),
        (
            "web_fetch".to_string(),
            rule(Some(12), tail, "toolSearch", false, false),
        ),
        (
            "question".to_string(),
            rule(Some(6), tail, "accent", false, false),
        ),
        (
            "subagents".to_string(),
            rule(Some(0), tail, "muted", false, false),
        ),
        ("todo".to_string(), rule(None, None, "accent", false, true)),
        ("ls".to_string(), rule(None, None, "success", false, false)),
        ("LS".to_string(), rule(None, None, "success", false, false)),
        (
            "grep".to_string(),
            rule(None, None, "toolSearch", false, false),
        ),
        (
            "Grep".to_string(),
            rule(None, None, "toolSearch", false, false),
        ),
        (
            "find".to_string(),
            rule(None, None, "toolSearch", false, false),
        ),
        (
            "Glob".to_string(),
            rule(None, None, "toolSearch", false, false),
        ),
        (
            "skill".to_string(),
            rule(Some(0), None, "toolSearch", false, false),
        ),
    ])
}
