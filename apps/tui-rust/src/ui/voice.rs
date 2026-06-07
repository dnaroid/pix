//! Voice dictation controller.
//!
//! The public API is available in every build. The default build wires the
//! API to `voice_stub.rs` so pix-tui compiles without libvosk. Enabling the
//! `voice` Cargo feature switches to the native Vosk/cpal implementation.

use std::collections::HashMap;

use crate::config::{DictationConfig, VoiceModelDefinition};

#[derive(Debug, Clone, PartialEq)]
pub enum VoiceInputState {
    Idle,
    Installing(String),
    Downloading(f32),
    Loading,
    Listening,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VoiceTranscriptUpdate {
    pub partial: Option<String>,
    pub final_text: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum VoiceEvent {
    StateChanged(VoiceInputState),
    Transcript(VoiceTranscriptUpdate),
    Error(String),
    Progress(String),
}

pub(crate) const VOICE_DISABLED_MESSAGE: &str =
    "voice input is disabled — rebuild with --features voice";
pub(crate) const VOICE_ENABLE_COMMAND: &str = "cargo build --release --features voice";
const VOICE_TOGGLE_KEY: &str = "Ctrl+M";

#[cfg(not(feature = "voice"))]
#[path = "voice_stub.rs"]
mod imp;

#[cfg(not(feature = "voice"))]
pub use imp::VoiceController;

#[cfg(feature = "voice")]
mod imp {
    use std::fs::{self, File};
    use std::io::{self, Read, Write};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use anyhow::{anyhow, Context, Result};
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::{SampleFormat, SampleRate, Stream, StreamConfig};
    use rust_vosk as vosk;
    use tokio::sync::{mpsc, oneshot};
    use tokio::task::JoinHandle;
    use zip::ZipArchive;

    use super::{
        initial_language, language_label, sorted_languages, DictationConfig, HashMap, VoiceEvent,
        VoiceInputState, VoiceModelDefinition, VoiceTranscriptUpdate, VOICE_TOGGLE_KEY,
    };
    const SAMPLE_RATE: u32 = 16_000;
    const PARTIAL_THROTTLE: Duration = Duration::from_millis(100);

    #[derive(Debug, Clone)]
    pub struct VoiceController {
        inner: Arc<Mutex<Inner>>,
    }

    #[derive(Debug)]
    struct Inner {
        languages: Vec<String>,
        definitions: HashMap<String, VoiceModelDefinition>,
        language: String,
        state: VoiceInputState,
        recording: Option<RecordingHandle>,
        cancel_flag: Option<Arc<AtomicBool>>,
        models_root: PathBuf,
        // Model cache is intentionally kept inside the feature-gated impl so
        // default builds never touch the native Vosk types.
        model_cache: HashMap<String, Arc<vosk::Model>>,
    }

    #[derive(Debug)]
    struct RecordingHandle {
        stop_tx: oneshot::Sender<()>,
        task: JoinHandle<()>,
        #[allow(dead_code)]
        stream: Stream,
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
                    recording: None,
                    cancel_flag: None,
                    models_root: default_models_root(),
                    model_cache: HashMap::new(),
                })),
            }
        }

        pub fn current_language(&self) -> &str {
            // The API mirrors the TS controller. Return a short-lived leaked
            // string so callers can inspect the language without holding the
            // internal mutex across render code. This is bounded by the small
            // language set and only changes on explicit toggles.
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
            let inner = self.inner.lock().expect("voice mutex");
            if inner.definitions.is_empty() {
                return format!("{VOICE_TOGGLE_KEY} configure voice");
            }
            let label = language_label(&inner.definitions, &inner.language);
            match inner.state {
                VoiceInputState::Idle => format!("{VOICE_TOGGLE_KEY} voice ({label})"),
                VoiceInputState::Listening => format!("{VOICE_TOGGLE_KEY} stop voice"),
                VoiceInputState::Loading
                | VoiceInputState::Downloading(_)
                | VoiceInputState::Installing(_) => format!("{VOICE_TOGGLE_KEY} cancel voice"),
            }
        }

        pub fn status_widget_text(&self) -> String {
            let inner = self.inner.lock().expect("voice mutex");
            let label = language_label(&inner.definitions, &inner.language);
            match &inner.state {
                VoiceInputState::Idle => String::new(),
                VoiceInputState::Installing(step) => format!("🎙 {label} {step}"),
                VoiceInputState::Downloading(progress) => {
                    format!("🎙 {label} model {:>3.0}%", progress)
                }
                VoiceInputState::Loading => format!("🎙 {label} starting…"),
                VoiceInputState::Listening => format!("🎙 {label} listening"),
            }
        }

        pub fn status_widget_active(&self) -> bool {
            !matches!(self.state(), VoiceInputState::Idle)
        }

        pub async fn start_recording(&mut self, event_tx: mpsc::Sender<VoiceEvent>) -> Result<()> {
            let (language, definition, models_root, cancel_flag) = {
                let mut inner = self.inner.lock().expect("voice mutex");
                if !matches!(inner.state, VoiceInputState::Idle) {
                    return Ok(());
                }
                if inner.definitions.is_empty() {
                    return Err(anyhow!(
                        "no dictation languages are configured; add dictation.languages entries or remove the custom dictation override"
                    ));
                }
                let Some(definition) = inner.definitions.get(&inner.language).cloned() else {
                    return Err(anyhow!(
                        "dictation language is not configured: {}",
                        inner.language
                    ));
                };
                validate_definition(&inner.language, &definition)?;
                let cancel_flag = Arc::new(AtomicBool::new(false));
                inner.state = VoiceInputState::Loading;
                inner.cancel_flag = Some(cancel_flag.clone());
                let _ = event_tx.try_send(VoiceEvent::StateChanged(inner.state.clone()));
                (
                    inner.language.clone(),
                    definition,
                    inner.models_root.clone(),
                    cancel_flag,
                )
            };

            let result = self
                .start_recording_inner(
                    language.clone(),
                    definition,
                    models_root,
                    cancel_flag.clone(),
                    event_tx.clone(),
                )
                .await;

            match result {
                Ok(()) => Ok(()),
                Err(_err) if cancel_flag.load(Ordering::Relaxed) => {
                    self.finish_run(cancel_flag, VoiceInputState::Idle).await;
                    Ok(())
                }
                Err(err) => {
                    self.finish_run(cancel_flag, VoiceInputState::Idle).await;
                    Err(err)
                }
            }
        }

        pub async fn stop_recording(&mut self) -> Result<()> {
            let recording = {
                let mut inner = self.inner.lock().expect("voice mutex");
                inner.state = VoiceInputState::Idle;
                if let Some(cancel_flag) = inner.cancel_flag.take() {
                    cancel_flag.store(true, Ordering::Relaxed);
                }
                inner.recording.take()
            };
            if let Some(recording) = recording {
                let _ = recording.stop_tx.send(());
                let _ = recording.task.await;
            }
            Ok(())
        }

        async fn set_state(&self, state: VoiceInputState, event_tx: &mpsc::Sender<VoiceEvent>) {
            self.inner.lock().expect("voice mutex").state = state.clone();
            event_tx.send(VoiceEvent::StateChanged(state)).await.ok();
        }

        async fn start_recording_inner(
            &self,
            language: String,
            definition: VoiceModelDefinition,
            models_root: PathBuf,
            cancel_flag: Arc<AtomicBool>,
            event_tx: mpsc::Sender<VoiceEvent>,
        ) -> Result<()> {
            let Some(model_path) = ensure_model(
                language.clone(),
                definition,
                models_root,
                cancel_flag.clone(),
                event_tx.clone(),
            )
            .await
            .with_context(|| format!("failed to prepare Vosk model for {language}"))?
            else {
                self.finish_run(cancel_flag, VoiceInputState::Idle).await;
                return Ok(());
            };

            if cancel_flag.load(Ordering::Relaxed) {
                self.finish_run(cancel_flag, VoiceInputState::Idle).await;
                return Ok(());
            }

            self.set_state(VoiceInputState::Loading, &event_tx).await;
            let model = self.cached_model(&language, &model_path)?;
            if cancel_flag.load(Ordering::Relaxed) {
                self.finish_run(cancel_flag, VoiceInputState::Idle).await;
                return Ok(());
            }
            let recognizer = Arc::new(Mutex::new(vosk::Recognizer::new(
                &model,
                SAMPLE_RATE as f32,
            )?));
            let (stream, stop_tx, task) = start_audio_stream(recognizer, event_tx.clone()).await?;

            if cancel_flag.load(Ordering::Relaxed) {
                let _ = stop_tx.send(());
                let _ = task.await;
                self.finish_run(cancel_flag, VoiceInputState::Idle).await;
                return Ok(());
            }

            {
                let mut inner = self.inner.lock().expect("voice mutex");
                inner.recording = Some(RecordingHandle {
                    stop_tx,
                    task,
                    stream,
                });
                inner.cancel_flag = Some(cancel_flag);
                inner.state = VoiceInputState::Listening;
            }
            event_tx
                .send(VoiceEvent::StateChanged(VoiceInputState::Listening))
                .await
                .ok();
            event_tx
                .send(VoiceEvent::Progress(format!("Voice input on ({language})")))
                .await
                .ok();
            Ok(())
        }

        async fn finish_run(&self, cancel_flag: Arc<AtomicBool>, state: VoiceInputState) {
            let mut inner = self.inner.lock().expect("voice mutex");
            if inner
                .cancel_flag
                .as_ref()
                .is_some_and(|flag| Arc::ptr_eq(flag, &cancel_flag))
            {
                inner.cancel_flag = None;
            }
            inner.state = state;
        }

        fn cached_model(&self, language: &str, model_path: &Path) -> Result<Arc<vosk::Model>> {
            let mut inner = self.inner.lock().expect("voice mutex");
            if let Some(model) = inner.model_cache.get(language) {
                return Ok(model.clone());
            }
            let model = Arc::new(vosk::Model::new(model_path.to_string_lossy().as_ref())?);
            inner
                .model_cache
                .insert(language.to_string(), model.clone());
            Ok(model)
        }
    }

    impl Drop for VoiceController {
        fn drop(&mut self) {
            if Arc::strong_count(&self.inner) == 1 {
                let mut inner = self.inner.lock().expect("voice mutex");
                if let Some(cancel_flag) = inner.cancel_flag.take() {
                    cancel_flag.store(true, Ordering::Relaxed);
                }
                if let Some(recording) = inner.recording.take() {
                    let _ = recording.stop_tx.send(());
                    recording.task.abort();
                }
            }
        }
    }

    fn default_models_root() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
            .join("pix")
            .join("models")
            .join("vosk")
    }

    async fn ensure_model(
        language: String,
        definition: VoiceModelDefinition,
        models_root: PathBuf,
        cancel_flag: Arc<AtomicBool>,
        event_tx: mpsc::Sender<VoiceEvent>,
    ) -> Result<Option<PathBuf>> {
        tokio::task::spawn_blocking(move || {
            let model_path = models_root.join(&definition.dir_name);
            if looks_like_vosk_model(&model_path) {
                return Ok(Some(model_path));
            }
            if cancel_flag.load(Ordering::Relaxed) {
                return Ok(None);
            }
            if definition.url.trim().is_empty() {
                return Err(anyhow!(
                    "no download URL configured for {} ({language}); install a model at {} or set dictation.languages.{language}.url",
                    definition.label,
                    model_path.display()
                ));
            }

            fs::create_dir_all(&models_root)?;
            event_tx
                .blocking_send(VoiceEvent::StateChanged(VoiceInputState::Downloading(0.0)))
                .ok();
            event_tx
                .blocking_send(VoiceEvent::Progress(format!(
                    "Downloading {} Vosk model…",
                    definition.label
                )))
                .ok();

            let zip_path = models_root.join(format!("{}.zip", definition.dir_name));
            let temp_path = models_root.join(format!(
                "{}.tmp-{}",
                definition.dir_name,
                std::process::id()
            ));
            let _ = fs::remove_file(&zip_path);
            let _ = fs::remove_dir_all(&temp_path);

            if !download_file(&definition.url, &zip_path, &cancel_flag, &event_tx)? {
                let _ = fs::remove_file(&zip_path);
                let _ = fs::remove_dir_all(&temp_path);
                return Ok(None);
            }
            fs::create_dir_all(&temp_path)?;
            event_tx
                .blocking_send(VoiceEvent::StateChanged(VoiceInputState::Installing(
                    "extracting model…".to_string(),
                )))
                .ok();
            extract_zip(&zip_path, &temp_path)?;

            if cancel_flag.load(Ordering::Relaxed) {
                let _ = fs::remove_file(&zip_path);
                let _ = fs::remove_dir_all(&temp_path);
                return Ok(None);
            }

            event_tx
                .blocking_send(VoiceEvent::StateChanged(VoiceInputState::Installing(
                    "finalizing…".to_string(),
                )))
                .ok();

            let extracted = temp_path.join(&definition.dir_name);
            if !looks_like_vosk_model(&extracted) {
                let _ = fs::remove_file(&zip_path);
                let _ = fs::remove_dir_all(&temp_path);
                return Err(anyhow!(
                    "downloaded {} ({language}) model did not contain a valid Vosk model",
                    definition.label
                ));
            }

            let _ = fs::remove_dir_all(&model_path);
            fs::rename(&extracted, &model_path)?;
            let _ = fs::remove_file(&zip_path);
            let _ = fs::remove_dir_all(&temp_path);
            Ok(Some(model_path))
        })
        .await?
    }

    fn looks_like_vosk_model(path: &Path) -> bool {
        path.join("conf").join("model.conf").is_file()
            && path.join("am").join("final.mdl").is_file()
    }

    fn download_file(
        url: &str,
        destination: &Path,
        cancel_flag: &Arc<AtomicBool>,
        event_tx: &mpsc::Sender<VoiceEvent>,
    ) -> Result<bool> {
        let response = ureq::get(url)
            .call()
            .map_err(|e| anyhow!("download failed: {e}"))?;
        let total = response
            .header("content-length")
            .and_then(|value| value.parse::<u64>().ok());
        let mut reader = response.into_reader();
        let mut file = File::create(destination)?;
        let mut buf = [0_u8; 64 * 1024];
        let mut read_total = 0_u64;
        let mut last_emit = Instant::now() - Duration::from_millis(250);
        loop {
            if cancel_flag.load(Ordering::Relaxed) {
                return Ok(false);
            }
            let n = reader.read(&mut buf)?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n])?;
            read_total = read_total.saturating_add(n as u64);
            if last_emit.elapsed() >= Duration::from_millis(200) {
                if let Some(total) = total.filter(|v| *v > 0) {
                    let pct = ((read_total as f32 / total as f32) * 100.0).clamp(0.0, 100.0);
                    event_tx
                        .blocking_send(VoiceEvent::StateChanged(VoiceInputState::Downloading(pct)))
                        .ok();
                }
                last_emit = Instant::now();
            }
        }
        event_tx
            .blocking_send(VoiceEvent::StateChanged(VoiceInputState::Downloading(
                100.0,
            )))
            .ok();
        Ok(true)
    }

    fn extract_zip(zip_path: &Path, destination: &Path) -> Result<()> {
        let file = File::open(zip_path)?;
        let mut archive = ZipArchive::new(file)?;
        for i in 0..archive.len() {
            let mut file = archive.by_index(i)?;
            let Some(enclosed) = file.enclosed_name().map(Path::to_path_buf) else {
                continue;
            };
            let out = destination.join(enclosed);
            if file.is_dir() {
                fs::create_dir_all(&out)?;
            } else {
                if let Some(parent) = out.parent() {
                    fs::create_dir_all(parent)?;
                }
                let mut output = File::create(&out)?;
                io::copy(&mut file, &mut output)?;
            }
        }
        Ok(())
    }

    async fn start_audio_stream(
        recognizer: Arc<Mutex<vosk::Recognizer>>,
        event_tx: mpsc::Sender<VoiceEvent>,
    ) -> Result<(Stream, oneshot::Sender<()>, JoinHandle<()>)> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| anyhow!("no microphone detected"))?;
        let supported = device
            .supported_input_configs()?
            .find(|cfg| {
                cfg.channels() >= 1
                    && cfg.min_sample_rate().0 <= SAMPLE_RATE
                    && cfg.max_sample_rate().0 >= SAMPLE_RATE
            })
            .ok_or_else(|| anyhow!("microphone does not expose a compatible 16kHz input format"))?;
        let sample_format = supported.sample_format();
        let config = StreamConfig {
            channels: supported.channels(),
            sample_rate: SampleRate(SAMPLE_RATE),
            buffer_size: cpal::BufferSize::Default,
        };
        let channels = config.channels as usize;
        let last_partial = Arc::new(Mutex::new(Instant::now() - PARTIAL_THROTTLE));
        let err_tx = event_tx.clone();
        let err_fn = move |err| {
            let _ = err_tx.try_send(VoiceEvent::Error(format!("voice recorder failed: {err}")));
        };

        let stream = match sample_format {
            SampleFormat::I16 => build_stream::<i16>(
                &device,
                &config,
                channels,
                recognizer,
                event_tx,
                last_partial,
                err_fn,
            )?,
            SampleFormat::U16 => build_stream::<u16>(
                &device,
                &config,
                channels,
                recognizer,
                event_tx,
                last_partial,
                err_fn,
            )?,
            SampleFormat::F32 => build_stream::<f32>(
                &device,
                &config,
                channels,
                recognizer,
                event_tx,
                last_partial,
                err_fn,
            )?,
            _ => return Err(anyhow!("microphone sample format is not supported")),
        };
        stream.play()?;
        let (stop_tx, stop_rx) = oneshot::channel();
        let task = tokio::spawn(async move {
            let _ = stop_rx.await;
        });
        Ok((stream, stop_tx, task))
    }

    fn build_stream<T>(
        device: &cpal::Device,
        config: &StreamConfig,
        channels: usize,
        recognizer: Arc<Mutex<vosk::Recognizer>>,
        event_tx: mpsc::Sender<VoiceEvent>,
        last_partial: Arc<Mutex<Instant>>,
        err_fn: impl FnMut(cpal::StreamError) + Send + 'static,
    ) -> Result<Stream>
    where
        T: cpal::Sample + cpal::SizedSample + Send + 'static,
        i16: cpal::FromSample<T>,
    {
        let stream = device.build_input_stream(
            config,
            move |data: &[T], _| {
                let mut pcm = Vec::with_capacity((data.len() / channels).saturating_mul(2));
                for frame in data.chunks(channels) {
                    let sample: i16 = cpal::Sample::to_sample(frame.first().expect("frame sample"));
                    pcm.extend_from_slice(&sample.to_le_bytes());
                }
                if pcm.is_empty() {
                    return;
                }
                let mut recognizer = recognizer.lock().expect("voice recognizer mutex");
                match recognizer.accept_waveform(&pcm) {
                    Ok(true) => {
                        if let Ok(result) = recognizer.result() {
                            if let Some(text) = transcript_text(&result) {
                                let _ = event_tx.try_send(VoiceEvent::Transcript(
                                    VoiceTranscriptUpdate {
                                        partial: None,
                                        final_text: Some(text),
                                    },
                                ));
                            }
                        }
                    }
                    Ok(false) => {
                        let should_emit = {
                            let mut last = last_partial.lock().expect("voice partial mutex");
                            if last.elapsed() >= PARTIAL_THROTTLE {
                                *last = Instant::now();
                                true
                            } else {
                                false
                            }
                        };
                        if should_emit {
                            if let Ok(partial) = recognizer.partial_result() {
                                if let Some(text) = partial_text(&partial) {
                                    let _ = event_tx.try_send(VoiceEvent::Transcript(
                                        VoiceTranscriptUpdate {
                                            partial: Some(text),
                                            final_text: None,
                                        },
                                    ));
                                }
                            }
                        }
                    }
                    Err(err) => {
                        let _ = event_tx.try_send(VoiceEvent::Error(format!(
                            "voice recognition failed: {err}"
                        )));
                    }
                }
            },
            err_fn,
            None,
        )?;
        Ok(stream)
    }

    fn transcript_text(json: &str) -> Option<String> {
        let value: serde_json::Value = serde_json::from_str(json).ok()?;
        value
            .get("text")?
            .as_str()
            .map(normalize_transcript)
            .filter(|s| !s.is_empty())
    }

    fn partial_text(json: &str) -> Option<String> {
        let value: serde_json::Value = serde_json::from_str(json).ok()?;
        value
            .get("partial")?
            .as_str()
            .map(normalize_transcript)
            .filter(|s| !s.is_empty())
    }

    fn normalize_transcript(text: &str) -> String {
        text.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    fn validate_definition(language: &str, definition: &VoiceModelDefinition) -> Result<()> {
        if definition.dir_name.trim().is_empty() {
            return Err(anyhow!(
                "dictation.languages.{language}.dirName is required for voice input"
            ));
        }
        Ok(())
    }
}

#[cfg(feature = "voice")]
pub use imp::VoiceController;

fn sorted_languages(config: &DictationConfig) -> Vec<String> {
    let mut languages: Vec<String> = config.languages.keys().cloned().collect();
    languages.sort();
    languages
}

fn initial_language(config: &DictationConfig, languages: &[String]) -> String {
    if !config.language.trim().is_empty() && languages.iter().any(|lang| lang == &config.language) {
        return config.language.clone();
    }
    if languages.iter().any(|lang| lang == "en") {
        return "en".to_string();
    }
    languages
        .first()
        .cloned()
        .unwrap_or_else(|| "en".to_string())
}

fn language_label(definitions: &HashMap<String, VoiceModelDefinition>, language: &str) -> String {
    definitions
        .get(language)
        .map(|definition| definition.label.trim())
        .filter(|label| !label.is_empty())
        .unwrap_or(language)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{PixConfig, VoiceModelDefinition};
    use tokio::sync::mpsc;

    fn config_with_languages(language: &str, languages: &[&str]) -> DictationConfig {
        DictationConfig {
            language: language.to_string(),
            languages: languages
                .iter()
                .map(|lang| {
                    (
                        (*lang).to_string(),
                        VoiceModelDefinition {
                            dir_name: format!("vosk-model-{lang}"),
                            url: format!("https://example.invalid/{lang}.zip"),
                            label: lang.to_uppercase(),
                        },
                    )
                })
                .collect(),
        }
    }

    #[test]
    fn voice_state_default_is_idle() {
        let controller = VoiceController::new(&DictationConfig::default());
        assert_eq!(controller.state(), VoiceInputState::Idle);
    }

    #[test]
    fn toggle_language_cycles_through_configured() {
        let mut controller = VoiceController::new(&config_with_languages("en", &["en", "ru"]));

        assert_eq!(controller.current_language(), "en");
        controller.toggle_language();
        assert_eq!(controller.current_language(), "ru");
        controller.toggle_language();
        assert_eq!(controller.current_language(), "en");
    }

    #[test]
    fn status_widget_text_idle_returns_empty() {
        let controller = VoiceController::new(&DictationConfig::default());
        assert_eq!(controller.status_widget_text(), "");
        assert!(!controller.status_widget_active());
    }

    #[test]
    fn input_hint_mentions_voice_shortcut() {
        let controller = VoiceController::new(&DictationConfig::default());

        assert!(controller.input_hint_text().contains("Ctrl+M"));
    }

    #[test]
    #[cfg(feature = "voice")]
    fn status_widget_uses_language_label_when_active() {
        let controller = VoiceController::new(&config_with_languages("en", &["en"]));
        controller.inner.lock().expect("voice mutex").state = VoiceInputState::Listening;

        assert_eq!(controller.status_widget_text(), "🎙 EN listening");
    }

    #[tokio::test]
    #[cfg(not(feature = "voice"))]
    async fn disabled_returns_error_when_feature_off() {
        let mut controller = VoiceController::new(&DictationConfig::default());
        let (tx, _rx) = mpsc::channel(1);

        let err = controller.start_recording(tx).await.unwrap_err();

        assert!(err.to_string().contains(VOICE_DISABLED_MESSAGE));
        assert!(err.to_string().contains("selected language"));
        assert_eq!(controller.state(), VoiceInputState::Idle);
    }

    #[tokio::test]
    #[cfg(not(feature = "voice"))]
    async fn disabled_build_hint_mentions_unavailable_voice() {
        let controller = VoiceController::new(&DictationConfig::default());

        assert!(controller.input_hint_text().contains("unavailable"));
    }

    #[tokio::test]
    #[cfg(feature = "voice")]
    async fn empty_dictation_config_returns_clear_error() {
        let mut controller = VoiceController::new(&DictationConfig {
            language: "en".to_string(),
            languages: HashMap::new(),
        });
        let (tx, _rx) = mpsc::channel(1);

        let err = controller.start_recording(tx).await.unwrap_err();

        assert!(err
            .to_string()
            .contains("no dictation languages are configured"));
    }

    #[test]
    fn voice_event_state_changed_variants() {
        let events = [
            VoiceEvent::StateChanged(VoiceInputState::Idle),
            VoiceEvent::StateChanged(VoiceInputState::Installing("installing".to_string())),
            VoiceEvent::StateChanged(VoiceInputState::Downloading(42.0)),
            VoiceEvent::StateChanged(VoiceInputState::Loading),
            VoiceEvent::StateChanged(VoiceInputState::Listening),
        ];

        assert_eq!(events.len(), 5);
        assert!(matches!(
            events[4],
            VoiceEvent::StateChanged(VoiceInputState::Listening)
        ));
    }

    #[test]
    fn voice_event_transcript_partial_and_final() {
        let partial = VoiceEvent::Transcript(VoiceTranscriptUpdate {
            partial: Some("hel".to_string()),
            final_text: None,
        });
        let final_text = VoiceEvent::Transcript(VoiceTranscriptUpdate {
            partial: None,
            final_text: Some("hello world".to_string()),
        });

        assert!(matches!(
            partial,
            VoiceEvent::Transcript(VoiceTranscriptUpdate {
                partial: Some(_),
                final_text: None
            })
        ));
        assert!(matches!(
            final_text,
            VoiceEvent::Transcript(VoiceTranscriptUpdate {
                partial: None,
                final_text: Some(_)
            })
        ));
    }

    #[test]
    fn voice_controller_handles_unknown_language_gracefully() {
        let controller = VoiceController::new(&config_with_languages("zz", &["ru", "en"]));
        assert_eq!(controller.current_language(), "en");
        assert_eq!(controller.state(), VoiceInputState::Idle);
    }

    #[test]
    fn language_label_falls_back_to_language_code() {
        let definitions = HashMap::from([(
            "pt-br".to_string(),
            VoiceModelDefinition {
                dir_name: "vosk-model-pt-br".to_string(),
                url: "https://example.invalid/pt-br.zip".to_string(),
                label: String::new(),
            },
        )]);

        assert_eq!(language_label(&definitions, "pt-br"), "pt-br");
    }

    #[test]
    fn config_parsing_accepts_dictation_section() {
        let config: PixConfig = serde_json::from_str(
            r#"{
              "dictation": {
                "language": "ru",
                "languages": {
                  "ru": { "dirName": "vosk-model-small-ru-0.22", "url": "https://example.invalid/ru.zip", "label": "Russian" }
                }
              }
            }"#,
        )
        .expect("dictation config parses");

        assert_eq!(config.dictation.language, "ru");
        assert_eq!(config.dictation.languages["ru"].label, "Russian");
    }
}
