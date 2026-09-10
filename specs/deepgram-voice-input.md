# Deepgram voice input

## Status

Active contract for terminal and desktop voice dictation.

## Contract

Pix uses Deepgram live speech-to-text for voice input. `DEEPGRAM_API_KEY` is the
only long-lived Deepgram credential and must stay outside UI/browser code.

### Terminal UI

- `Ctrl+G` and the status microphone toggle one recording owned by the active
  input scope.
- Audio capture continues to use the first available local recorder
  (`rec`/`sox`, platform `ffmpeg`, or Linux `arecord`) and produces 16 kHz mono
  signed 16-bit PCM.
- PCM is streamed to `wss://api.deepgram.com/v1/listen` using the configured
  Deepgram model (default `nova-3`) and selected language.
- Interim `Results` are rendered as the existing live voice partial. Final
  `Results` are inserted at the current editor selection/cursor using the
  existing whitespace-preserving insertion behavior.
- Normal stopping sends `SIGTERM` to the local recorder and waits for its
  `close` event so final buffered PCM is forwarded before Deepgram `Finalize`.
  The wait is bounded; a stuck recorder is escalated to `SIGKILL` before the
  short Deepgram final-result grace period.
- Async starts, partials, finals, recorder callbacks, and stop-time results may
  mutate editor/UI state only while the captured input scope and generation
  still own the recording. A tab/scope change discards stale voice output,
  matching `docs/concurrency.md`.
- Once terminal voice input is disposed during application shutdown, in-flight
  language/toggle continuations cannot start another recorder or socket.
- Missing credentials, recorder failures, connection failures, and recognition
  failures return voice state to idle and surface an error without affecting
  non-voice input.
- Application shutdown uses a separate force-dispose path: it invalidates voice
  ownership, kills a live recorder, and closes the socket immediately rather
  than consuming the application's 250 ms shutdown budget on STT finalization.

### Desktop composer

- The normal message composer exposes a microphone action when browser media
  APIs are available. Editor mode and questionnaire/custom-answer mode do not
  expose voice input.
- Starting voice input requests a short-lived Deepgram access token from the
  Tauri backend, then requests microphone access and opens the Deepgram
  WebSocket from the WebView.
- The Tauri `deepgram_token` command reads `DEEPGRAM_API_KEY` locally and
  exchanges it through Deepgram `/v1/auth/grant` with a 60-second TTL. Its
  blocking HTTP work runs on Tauri's blocking pool with explicit connection and
  total request deadlines. The permanent API key is never returned to
  JavaScript.
- The WebView authenticates the live socket with the temporary bearer token and
  records browser-supported Opus/container audio with `MediaRecorder`, emitting
  chunks every 250 ms.
- Desktop recognition uses `nova-3` with `language=multi` so English/Russian
  and mixed-language dictation do not require a composer language switcher.
- Interim text is shown below the composer without mutating the draft. Final
  text is inserted at the current textarea selection/cursor using the same
  spacing rule as terminal voice input.
- A desktop recording is owned by the `activeSessionId` captured when it starts.
  If the active session changes, later interim/final callbacks from the old
  recording are discarded immediately, even if the user returns to that session
  before graceful stop/finalization has finished.
- Submit and defer stop/finalize active dictation first, so the latest
  recognized words are applied to the bound draft before the action reads or
  queues it.
- Normal stopping first lets `MediaRecorder` emit its final `dataavailable`
  chunk, then sends Deepgram `Finalize`, releases all microphone tracks, closes
  the socket, clears interim UI, and commits a remaining interim at most once.
- Component disposal/unmount invalidates the recording generation first and
  releases recorder, socket, and microphone tracks immediately. It does not
  wait for finalization or commit an unsettled interim into a destroyed
  composer.
- Repeated microphone toggles while a stop is already in flight join that stop
  and do not restart recording from the same user action.
- macOS builds declare `NSMicrophoneUsageDescription`; desktop CSP permits
  `wss://api.deepgram.com` and does not permit exposing the permanent key.

## Configuration compatibility

`dictation.language`, `dictation.languages`, and persisted language selection
remain supported. `dictation.model` selects the Deepgram speech model and
defaults to `nova-3`; each language may set `deepgramLanguage`, defaulting to
its map key.

Legacy Vosk `dirName`, `url`, and per-language `model` fields remain parseable
for existing config files but are deprecated and ignored by the Deepgram
runtime. Pix does not download Vosk models or load/install Vosk bindings.

## Verification

- `tests/voice-controller.test.ts` covers terminal URL/auth transport, PCM
  forwarding, interim/final parsing, finalize/last-interim behavior, errors,
  and stale-scope rejection.
- `tests/config.test.ts` covers Deepgram defaults plus legacy dictation config
  compatibility.
- `desktop/src/lib/deepgram.test.ts` covers desktop recorder format choice,
  multilingual live URL, transport/finalization, and Deepgram result parsing.
- `npm run check:desktop`/desktop tests cover Svelte integration and the composer
  surface. Rust compilation additionally validates the Tauri token broker when
  a Rust toolchain is available.

## Non-goals

- Offline/local speech recognition.
- Persisting or replaying microphone audio.
- Exposing `DEEPGRAM_API_KEY` to the desktop WebView.
- Voice input in the desktop editor or questionnaire modes.
