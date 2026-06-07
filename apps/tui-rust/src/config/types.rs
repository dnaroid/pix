use std::collections::{BTreeMap, HashMap};

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct PixConfig {
    /// Resolved default model ref, including an optional thinking suffix.
    /// This is derived from `default_model` and env/CLI overrides.
    #[serde(skip)]
    pub model: String,

    #[serde(alias = "themeName", alias = "theme")]
    pub theme_name: String,
    #[serde(alias = "streamingBehavior")]
    pub streaming_behavior: String,
    #[serde(alias = "ignoreContextFiles")]
    pub ignore_context_files: bool,
    #[serde(alias = "maxProjectSessions")]
    pub max_project_sessions: u32,

    #[serde(alias = "defaultModel", alias = "modelDefault")]
    pub default_model: DefaultModelConfig,
    #[serde(alias = "toolRenderer")]
    pub tool_renderer: ToolRendererConfig,
    #[serde(alias = "outputFilters")]
    pub output_filters: OutputFiltersConfig,
    #[serde(alias = "promptEnhancer")]
    pub prompt_enhancer: PromptEnhancerConfig,
    #[serde(alias = "sessionTitle")]
    pub session_title: SessionTitleConfig,
    #[serde(alias = "autoComplete")]
    pub autocomplete: AutocompleteConfig,
    #[serde(alias = "modelColors")]
    pub model_colors: ModelColorsConfig,
    #[serde(alias = "iconTheme", alias = "icons")]
    pub icon_theme: IconThemeConfig,
    #[serde(alias = "voiceInput", alias = "voice")]
    pub dictation: DictationConfig,
    pub keybindings: KeybindingsConfig,
}

impl PixConfig {
    pub fn refresh_derived(&mut self) {
        self.model = resolve_default_model_ref(&self.default_model);
        self.model_colors.normalize();
        self.dictation.normalize();
    }

    pub fn set_model_ref(&mut self, model_ref: &str) {
        if let Some(default_model) = normalize_default_model_ref(model_ref) {
            self.default_model = default_model;
            self.refresh_derived();
        }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct DefaultModelConfig {
    #[serde(alias = "modelRef", alias = "model")]
    pub model_ref: String,
    #[serde(alias = "thinkingLevel")]
    pub thinking: Option<ThinkingLevel>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ThinkingLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
}

impl ThinkingLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
        }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct ToolRendererConfig {
    pub default: ToolRendererRule,
    pub tools: BTreeMap<String, ToolRendererRule>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Default)]
#[serde(default)]
pub struct ToolRendererRule {
    #[serde(alias = "previewLines")]
    pub preview_lines: Option<u32>,
    pub direction: Option<PreviewDirection>,
    pub color: Option<String>,
    #[serde(alias = "defaultExpanded")]
    pub default_expanded: Option<bool>,
    #[serde(alias = "compactHidden")]
    pub compact_hidden: Option<bool>,
    pub hidden: Option<bool>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PreviewDirection {
    Head,
    Tail,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Default)]
#[serde(default)]
pub struct OutputFiltersConfig {
    pub patterns: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct PromptEnhancerConfig {
    #[serde(alias = "modelRef", alias = "model")]
    pub model_ref: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct SessionTitleConfig {
    #[serde(alias = "modelRef", alias = "model")]
    pub model_ref: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct AutocompleteConfig {
    #[serde(alias = "modelRef", alias = "model")]
    pub model_ref: String,
    #[serde(alias = "debounceMs")]
    pub debounce_ms: u64,
    #[serde(alias = "timeoutMs")]
    pub timeout_ms: u64,
    #[serde(alias = "maxTokens")]
    pub max_tokens: u32,
    #[serde(alias = "maxPromptTokens")]
    pub max_prompt_tokens: u32,
    #[serde(alias = "includeRecentMessages", alias = "recentMessages")]
    pub include_recent_messages: u32,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct ModelColorsConfig {
    pub rules: BTreeMap<String, String>,
    #[serde(flatten)]
    pub(crate) direct_rules: BTreeMap<String, serde_json::Value>,
}

impl ModelColorsConfig {
    pub fn normalize(&mut self) {
        for (pattern, color) in std::mem::take(&mut self.direct_rules) {
            if let Some(color) = color.as_str() {
                self.rules
                    .entry(pattern)
                    .or_insert_with(|| color.to_string());
            }
        }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct IconThemeConfig {
    pub name: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct DictationConfig {
    pub language: String,
    pub languages: HashMap<String, VoiceModelDefinition>,
}

impl DictationConfig {
    pub fn normalize(&mut self) {
        self.language = normalize_language_key(&self.language).unwrap_or_else(|| "en".to_string());
        self.languages = std::mem::take(&mut self.languages)
            .into_iter()
            .filter_map(|(language, mut definition)| {
                let language = normalize_language_key(&language)?;
                definition.normalize(&language);
                Some((language, definition))
            })
            .collect();
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Default)]
#[serde(default)]
pub struct VoiceModelDefinition {
    #[serde(alias = "dirName", alias = "model", alias = "modelDir")]
    pub dir_name: String,
    pub url: String,
    pub label: String,
}

impl VoiceModelDefinition {
    pub fn normalize(&mut self, language: &str) {
        self.dir_name = self.dir_name.trim().to_string();
        self.url = self.url.trim().to_string();
        self.label = if self.label.trim().is_empty() {
            fallback_voice_label(language)
        } else {
            self.label.trim().to_string()
        };
    }
}

pub type DictationLanguageModelConfig = VoiceModelDefinition;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct KeybindingsConfig {
    /// Human-readable keybinding hints keyed by action name.
    pub hints: BTreeMap<String, String>,
}

pub fn normalize_default_model_ref(model_ref: &str) -> Option<DefaultModelConfig> {
    let trimmed = model_ref.trim();
    if trimmed.is_empty() {
        return None;
    }

    let Some((model, suffix)) = trimmed.rsplit_once(':') else {
        return Some(DefaultModelConfig {
            model_ref: trimmed.to_string(),
            thinking: None,
        });
    };

    let thinking = parse_thinking_level(suffix);
    Some(DefaultModelConfig {
        model_ref: if thinking.is_some() { model } else { trimmed }.to_string(),
        thinking,
    })
}

pub fn resolve_default_model_ref(config: &DefaultModelConfig) -> String {
    let model = strip_thinking_suffix(&config.model_ref);
    match config.thinking {
        Some(thinking) if !model.trim().is_empty() => format!("{model}:{}", thinking.as_str()),
        _ => model,
    }
}

fn strip_thinking_suffix(model_ref: &str) -> String {
    match model_ref.rsplit_once(':') {
        Some((model, suffix)) if parse_thinking_level(suffix).is_some() => model.to_string(),
        _ => model_ref.trim().to_string(),
    }
}

fn parse_thinking_level(value: &str) -> Option<ThinkingLevel> {
    match value.trim().to_ascii_lowercase().as_str() {
        "off" => Some(ThinkingLevel::Off),
        "minimal" => Some(ThinkingLevel::Minimal),
        "low" => Some(ThinkingLevel::Low),
        "medium" => Some(ThinkingLevel::Medium),
        "high" => Some(ThinkingLevel::High),
        "xhigh" => Some(ThinkingLevel::Xhigh),
        _ => None,
    }
}

fn normalize_language_key(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_ascii_lowercase())
}

fn fallback_voice_label(language: &str) -> String {
    language
        .split(['-', '_'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => {
                    first.to_uppercase().collect::<String>() + &chars.as_str().to_ascii_lowercase()
                }
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dictation_default_language_is_en() {
        let config = DictationConfig::default();
        assert_eq!(config.language, "en");
    }

    #[test]
    fn dictation_default_models_include_en_and_ru() {
        let config = DictationConfig::default();

        let en = config.languages.get("en").expect("en model");
        assert_eq!(en.dir_name, "vosk-model-small-en-us-0.15");
        assert!(en.url.ends_with("vosk-model-small-en-us-0.15.zip"));
        assert_eq!(en.label, "English");

        let ru = config.languages.get("ru").expect("ru model");
        assert_eq!(ru.dir_name, "vosk-model-small-ru-0.22");
        assert!(ru.url.ends_with("vosk-model-small-ru-0.22.zip"));
        assert_eq!(ru.label, "Russian");
    }

    #[test]
    fn dictation_normalize_trims_and_lowercases_language_keys() {
        let mut config = DictationConfig {
            language: " EN ".to_string(),
            languages: HashMap::from([
                (
                    " EN ".to_string(),
                    VoiceModelDefinition {
                        dir_name: " vosk-en ".to_string(),
                        url: " https://example.invalid/en.zip ".to_string(),
                        label: "  ".to_string(),
                    },
                ),
                (
                    " ".to_string(),
                    VoiceModelDefinition {
                        dir_name: "ignored".to_string(),
                        url: "https://example.invalid/ignored.zip".to_string(),
                        label: "Ignored".to_string(),
                    },
                ),
            ]),
        };

        config.normalize();

        assert_eq!(config.language, "en");
        assert_eq!(config.languages.len(), 1);
        let en = config.languages.get("en").expect("normalized en model");
        assert_eq!(en.dir_name, "vosk-en");
        assert_eq!(en.url, "https://example.invalid/en.zip");
        assert_eq!(en.label, "En");
    }

    #[test]
    fn dictation_normalize_keeps_empty_language_map() {
        let mut config = DictationConfig {
            language: " ".to_string(),
            languages: HashMap::new(),
        };

        config.normalize();

        assert_eq!(config.language, "en");
        assert!(config.languages.is_empty());
    }
}
