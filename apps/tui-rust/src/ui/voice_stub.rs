//! Disabled voice-input implementation for default builds.

use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Result};
use tokio::sync::mpsc;

use super::{
    initial_language, language_label, sorted_languages, VoiceEvent, VoiceInputState,
    VOICE_DISABLED_MESSAGE, VOICE_TOGGLE_KEY,
};
use crate::config::{DictationConfig, VoiceModelDefinition};

#[derive(Debug, Clone)]
pub struct VoiceController {
    inner: Arc<Mutex<Inner>>,
}

#[derive(Debug)]
struct Inner {
    languages: Vec<String>,
    definitions: std::collections::HashMap<String, VoiceModelDefinition>,
    language: String,
    state: VoiceInputState,
}

impl VoiceController {
    pub fn new(config: &DictationConfig) -> Self {
        let languages = sorted_languages(config);
        let language = initial_language(config, &languages);
        Self {
            inner: Arc::new(Mutex::new(Inner {
                languages,
                definitions: config.languages.clone(),
                language,
                state: VoiceInputState::Idle,
            })),
        }
    }

    pub fn current_language(&self) -> &str {
        let language = self.inner.lock().expect("voice mutex").language.clone();
        Box::leak(language.into_boxed_str())
    }

    pub fn toggle_language(&mut self) {
        let mut inner = self.inner.lock().expect("voice mutex");
        if inner.languages.len() <= 1 {
            return;
        }
        let current = inner
            .languages
            .iter()
            .position(|lang| lang == &inner.language)
            .unwrap_or(0);
        let next = (current + 1) % inner.languages.len();
        inner.language = inner.languages[next].clone();
    }

    pub fn state(&self) -> VoiceInputState {
        self.inner.lock().expect("voice mutex").state.clone()
    }

    pub fn input_hint_text(&self) -> String {
        format!("{VOICE_TOGGLE_KEY} voice unavailable")
    }

    pub fn status_widget_text(&self) -> String {
        String::new()
    }

    pub fn status_widget_active(&self) -> bool {
        false
    }

    pub async fn start_recording(&mut self, _event_tx: mpsc::Sender<VoiceEvent>) -> Result<()> {
        let inner = self.inner.lock().expect("voice mutex");
        let label = language_label(&inner.definitions, &inner.language);
        Err(anyhow!(
            "{VOICE_DISABLED_MESSAGE} (selected language: {label})"
        ))
    }

    pub async fn stop_recording(&mut self) -> Result<()> {
        Ok(())
    }
}
