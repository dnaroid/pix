# Troubleshooting

<!-- markdownlint-disable MD013 -->

## Icons look wrong

Run:

```bash
pix install --check
```

Pix is designed for **JetBrainsMono Nerd Font** but falls back to plain glyphs.
`pix install` can install the recommended font for the current user; configure
the terminal to use it and restart the terminal.

## Clipboard images do not paste on Linux

On Wayland, install `wl-clipboard`. On X11, install `xclip` or `xsel`.
Then rerun:

```bash
pix install --check
```

## Voice input is unavailable

Check the frontend-specific config:

- TUI: `~/.config/pi/pix.jsonc`;
- Desktop: `~/.config/pi/pix-desktop.jsonc`.

Set `dictation.apiKey` or use the `DEEPGRAM_API_KEY` compatibility fallback.
Desktop needs a key allowed to call Deepgram `/v1/auth/grant` (Member-or-higher
authorization) and OS microphone permission.

The TUI additionally needs an audio recorder such as SoX, `ffmpeg`, or
`arecord` on Linux.

See [Configuration and accounts](../configuration/guide.md#voice-input).

## Provider login dialog is missing

Pix TUI does not currently reproduce Pi's interactive `/login` / `/logout`
dialogs. Authenticate in stock Pi:

```bash
npx @earendil-works/pi-coding-agent
```

Use `/login`, exit Pi, then reload/restart Pix. Provider-supported environment
keys also work.

## Repository search tools are absent

The bundled `project-search` module must be enabled in Pi tools-suite
configuration. Code/Knowledge retrieval uses the native backend and does not
require an external search installation or project initialization. Native semantic
search requires explicit global `search.embedding` in
`~/.config/pi/pi-tools-suite.jsonc` and respects enabled project sources, not
legacy project `semantic.json` or separate consent flags. OpenRouter credentials
come from `OPENROUTER_API_KEY` then shared Pi auth; Ollama needs no key. Lexical
retrieval makes no embedding-provider calls. See the
[native search contract](../search/native-repository-search.md).
Legacy external-search data is left untouched and is not used as a fallback.

## TUI memory grows rapidly during model thinking

If the `pix`/Pi TUI process grows into multiple gigabytes while a model is
streaming reasoning, first check whether the persisted session is actually
large. A small JSONL session together with rapidly increasing RSS is a strong
signal that the growth is in the live rendering/streaming path rather than in
stored conversation history.

Pix has two protections for this failure mode:

- collapsed thinking rows whose preview is disabled do not format, wrap, or
  syntax-highlight their hidden body on every streaming update;
- when a provider exposes an authoritative partial thinking block, Pix
  reconciles against that snapshot instead of blindly appending the event's
  `delta`, because some OpenAI-compatible endpoints report cumulative reasoning
  text in the delta field.

The second case is especially dangerous: repeatedly appending cumulative
snapshots makes the in-memory thinking string grow approximately quadratically
even though the final persisted assistant message can remain small.

For diagnosis, leave the memory watchdog enabled. It writes RSS/heap reports to
`~/.config/pi/memory-reports/` and periodic samples to `~/.config/pi/logs/`.
See [Unified diagnostic logging](../operations/logging.md) for retention and privacy
details.
See [Memory watchdog](../configuration/guide.md#memory-watchdog) and the engineering note
[TUI streaming-thinking memory growth](../tui/tui-streaming-thinking-memory.md)
for the root cause, invariants, and regression coverage.

## Pix Desktop Linux AppImage opens a blank window

Linux Desktop is legacy, unsupported tooling (macOS is the only supported
Desktop platform). If you still run the legacy Linux AppImage and terminal
stderr contains:

```text
Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...
```

use the documented
[Linux AppImage Wayland/Mesa workaround](../desktop/guide.md#linux-appimage-blank-window-eglbadparameter).
Do not apply that workaround to unrelated Desktop errors.

## An extension behaves differently from stock Pi

Pix supports the Pi SDK extension UI surface, including toasts, widgets, menus,
dialogs, custom UI and terminal input hooks. Extensions that depend on private
renderer internals may still need adaptation.

Extension code that also runs headlessly should keep `ctx.hasUI` guards around
UI-only behavior. See [Extension authors](../development/extensions.md).

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"ccb0ebccd30039947a2435c2835093e14d48fb27119277dcffbeba5c4ec4bf8f","checkedAt":"2026-10-31T13:55:01.354Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":59,"reportLanguage":"ru"} -->
