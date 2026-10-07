---
kind: spec
status: active
---

# Deepgram voice input

## Status

Active contract for terminal and desktop voice dictation.

## Contract

Pix uses Deepgram live speech-to-text for voice input. The long-lived credential
is configured as `dictation.apiKey` in the frontend-specific user Pix config:
TUI uses `~/.config/pi/pix.jsonc`, while Desktop uses the independent
`~/.config/pi/pix-desktop.jsonc`; `DEEPGRAM_API_KEY` remains a compatibility fallback.
The permanent key must stay outside UI/browser runtime code.

### Terminal UI

- When the first non-empty PCM chunk is successfully forwarded to the open
  Deepgram socket, the owning recording emits one short terminal bell (BEL)
  to signal that the microphone is ready and the user can speak. Terminal
  sound/mute preferences control whether BEL is audible; non-TTY output is silent.
  Errors, stale scopes, cancelled starts and stop-time buffered audio do not
  produce a readiness cue. Sound failure never interrupts dictation.
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
- TUI credential resolution prefers `dictation.apiKey` from the loaded user Pix
  config and falls back to `DEEPGRAM_API_KEY`. Project
  `$WORKSPACE/.pi/pix.jsonc` files may
  configure dictation behavior but cannot override the user-level API key.
- Missing credentials, recorder failures, connection failures, and recognition
  failures return voice state to idle and surface an error without affecting
  non-voice input.
- Application shutdown uses a separate force-dispose path: it invalidates voice
  ownership, kills a live recorder, and closes the socket immediately rather
  than consuming the application's 250 ms shutdown budget on STT finalization.

### Desktop composer

- After the connected recorder emits its `start` event, emit one quiet 100 ms
  readiness tone to signal that the user can speak. Web Audio is prepared during
  the microphone action; unavailable/blocked audio is best-effort and never
  delays or fails dictation. Failed/cancelled starts do not beep. Stop/disposal
  releases the cue's audio context and nodes, with no delayed playback.
- The normal message composer exposes a microphone action when browser media
  APIs are available. Editor mode and questionnaire/custom-answer mode do not
  expose voice input.
- On macOS, the microphone-position F5 key toggles the same recording in the
  active Pix window, including when a text input has focus. This uses a HID
  head-insert event tap with Accessibility permission, not a WebView keydown
  handler; see [the permission decision](../docs/decisions/0062-macos-dictation-key.md).
  Only a ready normal composer with a registered listener can opt its window
  in. Editor/question modes and other apps/windows are not targets; frontend
  delivery rechecks focus, composer eligibility and modal-dialog exclusion.
- The native shortcut is enabled only when Desktop credential resolution finds
  a non-empty `dictation.apiKey` or the `DEEPGRAM_API_KEY` fallback. This is a
  presence check, not validation of the key against Deepgram. Config reads run
  on the blocking pool, with latest-request-wins application on the main thread;
  they refresh on listener activation, Pix window activation and Settings saves.
  External file edits take effect on the next Pix window activation.
- With no configured key, no eligible composer, or missing Accessibility
  permission, no event tap is installed for that window and macOS dictation
  remains available. Only configured voice input can trigger the permission
  prompt, at most once per process; granting permission is retried on returning
  to Pix. The on-screen microphone does not require Accessibility.
- The tap suppresses an accepted F5 down/up pair and held-key repeats, emitting
  one window-targeted event per press. Shift/Control/Option/Command combinations
  and other keys pass through. Disposal disables the window in order even if
  native registration is still in flight; destroying the last eligible window,
  removing credentials, or exiting releases the event tap/run-loop source.
  Native registration is owned by a per-mount token so an old composer's late
  teardown cannot disable its replacement in the same window.
- Starting voice input requests a short-lived Deepgram access token from the
  Tauri backend, then requests microphone access and opens the Deepgram
  WebSocket from the WebView.
- The Tauri `deepgram_token` command reads `dictation.apiKey` directly from the
  Desktop user `~/.config/pi/pix-desktop.jsonc` on the Rust side, never falling
  back to TUI `pix.jsonc`, then falls back to `DEEPGRAM_API_KEY`, and
  exchanges it through Deepgram `/v1/auth/grant` with a 60-second TTL. Its
  blocking HTTP work runs on Tauri's blocking pool with explicit connection and
  total request deadlines. The permanent API key is never returned to
  JavaScript.
- Deepgram currently requires the API key used with `/v1/auth/grant` to have
  Member-or-higher authorization. A lower-privilege key may still be valid for
  direct STT calls but cannot mint the short-lived token required by Desktop's
  WebView transport. HTTP 401/402/403 grant failures are decoded by the native
  host into actionable credential, billing, or permission diagnostics instead
  of surfacing only a bare status code.
- The token response also carries the non-secret Deepgram model and language
  resolved from the same user Pix config. For current Desktop configuration,
  `dictation.language` is the Deepgram language code itself and is sent directly;
  defaults are `nova-3` and `en`. The Settings UI does not expose a separate
  language registry or human-readable language labels.
- The WebView authenticates the live socket with the temporary bearer token and
  records browser-supported Opus/container audio with `MediaRecorder`, emitting
  chunks every 250 ms.
- Desktop recognition uses the `/v1/listen` Nova-3 transport, matching terminal
  dictation defaults instead of maintaining a separate desktop-only multilingual
  model selection.
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

`dictation.apiKey` is the preferred Deepgram credential and is intended only for
the relevant frontend's user config (`pix.jsonc` for TUI, `pix-desktop.jsonc`
for Desktop); the Desktop Settings form exposes its own value as a sensitive
field. Desktop config accepts only `dictation.apiKey`, `dictation.language`,
and `dictation.model` (default `nova-3`).

The TUI additionally has the active language-picker configuration:
`dictation.languages`, keyed by the selectable local language code, with each
entry's `label` and optional `deepgramLanguage` transport code. This is the
only language remap because the terminal picker consumes that map and its
defaults define English and Russian. Desktop sends `dictation.language`
directly and has no language map. Legacy Vosk fields and undocumented
`voice`/`voiceInput`, `models`, `selectedLanguage`/`currentLanguage`,
`deepgramApiKey`/`deepgramModel`, and per-language alias forms are not accepted. Pix does not
download Vosk models or load/install Vosk bindings.

## Verification

- `tests/voice-controller.test.ts` covers terminal URL/auth transport, PCM
  forwarding, interim/final parsing, finalize/last-interim behavior, errors,
  stale-scope rejection, one readiness cue per capture and silent cancellation.
- `tests/config.test.ts` covers the user-config API key, project-secret rejection,
  and Deepgram defaults.
- `desktop/src/lib/deepgram.test.ts` covers desktop recorder format choice,
  configured Nova-3 language/model transport, finalization, Results parsing,
  recorder-start readiness and cancelled/failed start silence.
- `desktop/src/lib/dictation-ready-cue.test.ts` covers short-tone scheduling,
  one-shot playback, audio resource cleanup, blocked audio and late resume.
- `desktop/src/lib/dictation-shortcut.test.ts` covers listener ownership,
  eligibility at delivery, late registration, errors and serialized native
  enable/disable teardown. `desktop/src-tauri/src/dictation_shortcut.rs` unit
  tests cover key filtering, pass-through without eligibility and one toggle per
  held press, including release after focus changes. Native key-window routing,
  macOS permission prompts and hardware microphone routing require macOS QA;
  unit tests do not establish that a physical microphone key reaches the tap.
- `npm run check:desktop`/desktop tests cover Svelte integration and the composer
  surface. Rust unit coverage includes user-config key resolution and environment
  fallback; compilation validates it when a Rust toolchain is available.

## Non-goals

- Offline/local speech recognition.
- Persisting or replaying microphone audio.
- Exposing the permanent Deepgram API key to the desktop WebView.
- Voice input in the desktop editor or questionnaire modes.

## Implementation

- `src/app/input/voice-controller.ts`
- `desktop/src/lib/deepgram.ts`
- `desktop/src/lib/dictation-ready-cue.ts`
- `desktop/src/lib/dictation-shortcut.ts`
- `desktop/src/components/prompt-composer-voice-controller.svelte.ts`
- `desktop/src-tauri/src/dictation_shortcut.rs`
- `desktop/src-tauri/src/lib.rs`
- `desktop/src-tauri/Cargo.toml`
- `desktop/src-tauri/Cargo.lock`

## Tests

- `tests/voice-controller.test.ts`
- `tests/config.test.ts`
- `desktop/src/lib/deepgram.test.ts`
- `desktop/src/lib/dictation-ready-cue.test.ts`
- `desktop/src/lib/dictation-shortcut.test.ts`
- `desktop/src-tauri/src/dictation_shortcut.rs`
- `desktop/src-tauri/src/lib.rs`
