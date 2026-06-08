use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use serde_json::Value;

use crate::ui::theme::{Theme, ThemeRole};

pub const PI_FAVORITE_MODEL_REFS: &[&str] = &[
    "amazon-bedrock/us.anthropic.claude-opus-4-6-v1",
    "anthropic/claude-opus-4-8",
    "openai/gpt-5.4",
    "azure-openai-responses/gpt-5.4",
    "openai-codex/gpt-5.5",
    "deepseek/deepseek-v4-pro",
    "google/gemini-3.1-pro-preview",
    "google-vertex/gemini-3.1-pro-preview",
    "github-copilot/gpt-5.4",
    "openrouter/moonshotai/kimi-k2.6",
    "vercel-ai-gateway/zai/glm-5.1",
    "xai/grok-4.20-0309-reasoning",
    "groq/openai/gpt-oss-120b",
    "cerebras/zai-glm-4.7",
    "zai/glm-5.1",
    "mistral/devstral-medium-latest",
    "minimax/MiniMax-M2.7",
    "minimax-cn/MiniMax-M2.7",
    "moonshotai/kimi-k2.6",
    "moonshotai-cn/kimi-k2.6",
    "huggingface/moonshotai/Kimi-K2.6",
    "fireworks/accounts/fireworks/models/kimi-k2p6",
    "together/moonshotai/Kimi-K2.6",
    "opencode/kimi-k2.6",
    "opencode-go/kimi-k2.6",
    "kimi-coding/kimi-for-coding",
    "cloudflare-workers-ai/@cf/moonshotai/kimi-k2.6",
    "cloudflare-ai-gateway/workers-ai/@cf/moonshotai/kimi-k2.6",
    "xiaomi/mimo-v2.5-pro",
    "xiaomi-token-plan-cn/mimo-v2.5-pro",
    "xiaomi-token-plan-ams/mimo-v2.5-pro",
    "xiaomi-token-plan-sgp/mimo-v2.5-pro",
];

pub const MODEL_PICKER_HEADER_ROWS: usize = 3;
pub const MODEL_PICKER_POPUP_HEIGHT: u16 = 14;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelSummary {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub ref_: String,
    pub reasoning: bool,
    pub context_window: Option<u64>,
    pub current: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ModelPickerState {
    pub query: String,
    pub models: Vec<ModelSummary>,
    pub filtered: Vec<usize>,
    pub focus: usize,
    pub loading: bool,
    pub error: Option<String>,
}

impl ModelSummary {
    pub fn label(&self) -> String {
        if !self.name.trim().is_empty() && self.name != self.id {
            self.name.clone()
        } else if !self.id.trim().is_empty() {
            self.id.clone()
        } else {
            self.ref_.clone()
        }
    }

    pub fn meta(&self) -> String {
        let mut parts = vec![self.ref_.clone()];
        if self.current {
            parts.push("current".to_string());
        }
        if self.reasoning {
            parts.push("reasoning".to_string());
        }
        if let Some(context_window) = self.context_window {
            parts.push(format!("{} ctx", format_count(context_window)));
        }
        parts.join(" · ")
    }

    fn searchable_text(&self) -> String {
        format!("{} {} {} {}", self.provider, self.id, self.name, self.ref_).to_ascii_lowercase()
    }
}

impl ModelPickerState {
    pub fn open(&mut self) {
        self.query.clear();
        self.models.clear();
        self.filtered.clear();
        self.focus = 0;
        self.loading = true;
        self.error = None;
    }

    pub fn set_models(&mut self, models: Vec<ModelSummary>) {
        self.loading = false;
        self.error = None;
        self.models = models;
        self.apply_filter(None);
    }

    pub fn set_error(&mut self, message: impl Into<String>) {
        self.loading = false;
        self.error = Some(message.into());
        self.models.clear();
        self.filtered.clear();
        self.focus = 0;
    }

    pub fn push_query_char(&mut self, c: char) {
        self.query.push(c);
        self.apply_filter(None);
    }

    pub fn pop_query_char(&mut self) -> bool {
        let changed = self.query.pop().is_some();
        if changed {
            self.apply_filter(None);
        }
        changed
    }

    pub fn clear_query(&mut self) -> bool {
        if self.query.is_empty() {
            return false;
        }
        self.query.clear();
        self.apply_filter(None);
        true
    }

    pub fn move_up(&mut self) -> bool {
        let previous = self.focus;
        self.focus = self.focus.saturating_sub(1);
        previous != self.focus
    }

    pub fn move_down(&mut self) -> bool {
        if self.filtered.is_empty() {
            return false;
        }
        let previous = self.focus;
        self.focus = self.focus.saturating_add(1).min(self.filtered.len() - 1);
        previous != self.focus
    }

    pub fn page_up(&mut self, page_size: usize) -> bool {
        let previous = self.focus;
        self.focus = self.focus.saturating_sub(page_size.max(1));
        previous != self.focus
    }

    pub fn page_down(&mut self, page_size: usize) -> bool {
        if self.filtered.is_empty() {
            return false;
        }
        let previous = self.focus;
        self.focus = self
            .focus
            .saturating_add(page_size.max(1))
            .min(self.filtered.len() - 1);
        previous != self.focus
    }

    pub fn move_home(&mut self) -> bool {
        let previous = self.focus;
        self.focus = 0;
        previous != self.focus
    }

    pub fn move_end(&mut self) -> bool {
        if self.filtered.is_empty() {
            return false;
        }
        let previous = self.focus;
        self.focus = self.filtered.len() - 1;
        previous != self.focus
    }

    pub fn selected(&self) -> Option<&ModelSummary> {
        self.filtered
            .get(self.focus)
            .and_then(|idx| self.models.get(*idx))
    }

    pub fn visible_start(&self, capacity: usize) -> usize {
        if capacity == 0 || self.filtered.len() <= capacity {
            return 0;
        }
        if self.focus >= capacity {
            self.focus + 1 - capacity
        } else {
            0
        }
    }

    fn apply_filter(&mut self, preferred_ref: Option<&str>) {
        let preferred_ref = preferred_ref
            .map(str::to_string)
            .or_else(|| self.selected().map(|model| model.ref_.clone()));
        let tokens: Vec<String> = self
            .query
            .split_whitespace()
            .map(|part| part.to_ascii_lowercase())
            .collect();
        self.filtered = self
            .models
            .iter()
            .enumerate()
            .filter(|(_, model)| {
                tokens.is_empty()
                    || tokens
                        .iter()
                        .all(|token| model.searchable_text().contains(token))
            })
            .map(|(idx, _)| idx)
            .collect();

        self.focus = preferred_ref
            .as_deref()
            .and_then(|target| {
                self.filtered.iter().position(|idx| {
                    self.models
                        .get(*idx)
                        .is_some_and(|model| model.ref_ == target)
                })
            })
            .or_else(|| {
                self.filtered
                    .iter()
                    .position(|idx| self.models.get(*idx).is_some_and(|model| model.current))
            })
            .unwrap_or(0);
    }
}

pub fn parse_models_response(value: &Value) -> Vec<ModelSummary> {
    value
        .get("models")
        .and_then(Value::as_array)
        .or_else(|| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(parse_model_summary)
        .collect()
}

pub fn favorite_models(mut models: Vec<ModelSummary>) -> Vec<ModelSummary> {
    let favorites = PI_FAVORITE_MODEL_REFS
        .iter()
        .map(|value| value.to_ascii_lowercase())
        .collect::<Vec<_>>();
    let mut filtered = models
        .drain(..)
        .filter(|model| {
            model.current
                || favorites
                    .iter()
                    .any(|favorite| favorite == &model.ref_.to_ascii_lowercase())
        })
        .collect::<Vec<_>>();
    filtered.sort_by(|left, right| {
        right
            .current
            .cmp(&left.current)
            .then_with(|| left.provider.cmp(&right.provider))
            .then_with(|| left.id.cmp(&right.id))
    });
    filtered
}

pub fn parse_model_summary(value: &Value) -> Option<ModelSummary> {
    let id = get_nonempty(value, &["id", "modelId"]).unwrap_or_default();
    let name = get_nonempty(value, &["name"]).unwrap_or_else(|| id.clone());
    let provider = get_nonempty(value, &["provider"]).unwrap_or_default();
    let ref_ = get_nonempty(value, &["ref"]).unwrap_or_else(|| {
        match (provider.is_empty(), id.is_empty()) {
            (false, false) => format!("{provider}/{id}"),
            _ => String::new(),
        }
    });
    if ref_.is_empty() && name.trim().is_empty() {
        return None;
    }
    Some(ModelSummary {
        id,
        name,
        provider,
        ref_,
        reasoning: value
            .get("reasoning")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        context_window: value
            .get("contextWindow")
            .or_else(|| value.get("context_window"))
            .and_then(Value::as_u64),
        current: value
            .get("current")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

pub fn popup_lines(state: &ModelPickerState, theme: &Theme, max_rows: usize) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    lines.push(Line::from(vec![
        Span::styled("filter: ", theme.style_for(ThemeRole::StatusDim)),
        Span::styled(
            if state.query.is_empty() {
                "provider, model id, or name".to_string()
            } else {
                state.query.clone()
            },
            theme.style_for(ThemeRole::CodeInline),
        ),
    ]));
    lines.push(Line::from(Span::styled(
        status_text(state),
        theme.style_for(ThemeRole::StatusDim),
    )));

    if max_rows <= MODEL_PICKER_HEADER_ROWS {
        return lines.into_iter().take(max_rows).collect();
    }

    lines.push(Line::from(""));
    let capacity = max_rows.saturating_sub(MODEL_PICKER_HEADER_ROWS).max(1);
    if state.loading {
        lines.push(Line::from(Span::styled(
            "  Loading models…",
            theme.style_for(ThemeRole::StatusDim),
        )));
        return lines.into_iter().take(max_rows).collect();
    }
    if let Some(error) = &state.error {
        lines.push(Line::from(Span::styled(
            format!("  {error}"),
            theme.style_for(ThemeRole::ToolFailed),
        )));
        return lines.into_iter().take(max_rows).collect();
    }
    if state.filtered.is_empty() {
        lines.push(Line::from(Span::styled(
            "  No models match this filter.",
            theme
                .style_for(ThemeRole::StatusDim)
                .add_modifier(Modifier::DIM),
        )));
        return lines.into_iter().take(max_rows).collect();
    }

    let start = state.visible_start(capacity);
    for (visible_idx, model_idx) in state.filtered.iter().enumerate().skip(start).take(capacity) {
        let Some(model) = state.models.get(*model_idx) else {
            continue;
        };
        let focused = visible_idx == state.focus;
        let arrow = if focused { "› " } else { "  " };
        let label_style = Style::default()
            .fg(model_color(theme, model))
            .add_modifier(if focused { Modifier::BOLD } else { Modifier::empty() });
        let label = if model.current {
            format!("{} ✓", model.ref_)
        } else {
            model.ref_.clone()
        };
        lines.push(Line::from(vec![
            Span::styled(
                arrow.to_string(),
                theme
                    .style_for(ThemeRole::StatusDim)
                    .add_modifier(Modifier::DIM),
            ),
            Span::styled(label, label_style),
            Span::raw("  "),
            Span::styled(model.name.clone(), theme.style_for(ThemeRole::StatusDim)),
        ]));
    }

    lines.into_iter().take(max_rows).collect()
}

fn status_text(state: &ModelPickerState) -> String {
    if state.loading {
        return "Loading models…".to_string();
    }
    if let Some(error) = &state.error {
        return format!("error: {error}");
    }
    if state.filtered.is_empty() {
        return "0 matches · Edit the filter and try again".to_string();
    }
    format!(
        "{} match{} · Type to filter · Enter switches model",
        state.filtered.len(),
        if state.filtered.len() == 1 { "" } else { "es" }
    )
}

fn get_nonempty(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value.get(*key)?.as_str().and_then(|s| {
            let trimmed = s.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        })
    })
}

fn format_count(value: u64) -> String {
    if value >= 1_000_000 {
        format!("{}M", value / 1_000_000)
    } else if value >= 1_000 {
        format!("{}k", value / 1_000)
    } else {
        value.to_string()
    }
}

fn model_color(theme: &Theme, model: &ModelSummary) -> ratatui::style::Color {
    let palette = [
        theme.color_for(ThemeRole::SessionAccent),
        theme.color_for(ThemeRole::DiagInfo),
        theme.resolve_color_ref("toolSearch"),
        theme.resolve_color_ref("toolMutation"),
        theme.color_for(ThemeRole::ToolCompleted),
        theme.color_for(ThemeRole::DiagWarn),
    ];
    let mut hash = 1_779_033_703u32 ^ model.provider.len() as u32;
    for byte in model.provider.bytes() {
        hash = (hash ^ byte as u32).wrapping_mul(3_432_918_353);
        hash = hash.rotate_left(13);
    }
    palette[hash as usize % palette.len()]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn text_of(lines: &[Line<'static>]) -> String {
        lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn parse_models_response_accepts_data_wrapper() {
        let models = parse_models_response(&json!({
            "models": [
                {
                    "id": "gpt-5.5",
                    "name": "GPT 5.5",
                    "provider": "openai-codex",
                    "ref": "openai-codex/gpt-5.5",
                    "reasoning": true,
                    "contextWindow": 200000,
                    "current": true
                }
            ]
        }));
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].label(), "GPT 5.5");
        assert!(models[0].meta().contains("current"));
        assert!(models[0].meta().contains("reasoning"));
    }

    #[test]
    fn model_picker_filter_keeps_current_item_selected_when_possible() {
        let mut state = ModelPickerState::default();
        state.set_models(vec![
            ModelSummary {
                id: "gpt-5.5".to_string(),
                name: "GPT 5.5".to_string(),
                provider: "openai-codex".to_string(),
                ref_: "openai-codex/gpt-5.5".to_string(),
                reasoning: true,
                context_window: None,
                current: false,
            },
            ModelSummary {
                id: "claude-sonnet".to_string(),
                name: "Claude Sonnet".to_string(),
                provider: "anthropic".to_string(),
                ref_: "anthropic/claude-sonnet".to_string(),
                reasoning: true,
                context_window: None,
                current: true,
            },
        ]);

        assert_eq!(
            state.selected().map(|model| model.ref_.as_str()),
            Some("anthropic/claude-sonnet")
        );

        state.push_query_char('a');
        assert_eq!(
            state.selected().map(|model| model.ref_.as_str()),
            Some("anthropic/claude-sonnet")
        );

        state.push_query_char('n');
        assert_eq!(state.filtered.len(), 1);
        assert_eq!(
            state.selected().map(|model| model.ref_.as_str()),
            Some("anthropic/claude-sonnet")
        );
    }

    #[test]
    fn model_picker_navigation_clamps_to_bounds() {
        let mut state = ModelPickerState::default();
        state.set_models(
            (0..6)
                .map(|idx| ModelSummary {
                    id: format!("model-{idx}"),
                    name: format!("Model {idx}"),
                    provider: "provider".to_string(),
                    ref_: format!("provider/model-{idx}"),
                    reasoning: false,
                    context_window: None,
                    current: idx == 0,
                })
                .collect(),
        );

        state.move_end();
        assert_eq!(state.focus, 5);
        state.move_down();
        assert_eq!(state.focus, 5);
        state.page_up(10);
        assert_eq!(state.focus, 0);
    }

    #[test]
    fn popup_lines_show_filter_status_and_focus() {
        let mut state = ModelPickerState::default();
        state.set_models(vec![
            ModelSummary {
                id: "gpt-5.5".to_string(),
                name: "GPT 5.5".to_string(),
                provider: "openai-codex".to_string(),
                ref_: "openai-codex/gpt-5.5".to_string(),
                reasoning: true,
                context_window: Some(200000),
                current: true,
            },
            ModelSummary {
                id: "claude-sonnet".to_string(),
                name: "Claude Sonnet".to_string(),
                provider: "anthropic".to_string(),
                ref_: "anthropic/claude-sonnet".to_string(),
                reasoning: true,
                context_window: None,
                current: false,
            },
        ]);
        state.move_down();
        state.push_query_char('c');
        state.push_query_char('l');
        state.push_query_char('a');

        let text = text_of(&popup_lines(&state, &Theme::default(), 8));
        assert!(text.contains("filter: cla"));
        assert!(text.contains("1 match"));
        assert!(text.contains("› anthropic/claude-sonnet"));
        assert!(text.contains("Claude Sonnet"));
        assert!(!text.contains("GPT 5.5  "));
    }

    #[test]
    fn favorite_models_keeps_current_and_sorts_current_first() {
        let filtered = favorite_models(vec![
            ModelSummary {
                id: "custom-model".to_string(),
                name: "Custom".to_string(),
                provider: "local".to_string(),
                ref_: "local/custom-model".to_string(),
                reasoning: false,
                context_window: None,
                current: true,
            },
            ModelSummary {
                id: "gpt-5.5".to_string(),
                name: "GPT 5.5".to_string(),
                provider: "openai-codex".to_string(),
                ref_: "openai-codex/gpt-5.5".to_string(),
                reasoning: true,
                context_window: None,
                current: false,
            },
            ModelSummary {
                id: "ignored".to_string(),
                name: "Ignored".to_string(),
                provider: "other".to_string(),
                ref_: "other/ignored".to_string(),
                reasoning: false,
                context_window: None,
                current: false,
            },
        ]);

        assert_eq!(filtered.len(), 2);
        assert_eq!(filtered[0].ref_, "local/custom-model");
        assert_eq!(filtered[1].ref_, "openai-codex/gpt-5.5");
    }
}
