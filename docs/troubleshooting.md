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

See [Configuration and accounts](configuration.md#voice-input).

## Provider login dialog is missing

Pix TUI does not currently reproduce Pi's interactive `/login` / `/logout`
dialogs. Authenticate in stock Pi:

```bash
npx @earendil-works/pi-coding-agent
```

Use `/login`, exit Pi, then reload/restart Pix. Provider-supported environment
keys also work.

## Repository discovery tools are absent

TUI repository discovery requires `indexer-cli` and a project-local
`.indexer-cli` index.

Run Pix from the project:

```bash
cd /path/to/project
pix
```

Then use `/idx-init` and reload when required.

Pix Desktop has a dedicated IDX panel. When `idx` is unavailable, the panel can
install a managed copy into Pix's private tools directory. Project index
initialization remains a separate explicit action.

For a new project, `/idx-init` / `idx init` defaults to OpenRouter, not Ollama.
Supply `OPENROUTER_API_KEY` in the environment or `~/.config/idx/.env`, or
explicitly select local mode with `idx init --embedding local` (Ollama required,
no key). Installing the CLI itself needs neither. Existing projects retain
their saved provider without an override; do not use a mode switch as an
unapproved repair. `idx doctor` checks saved providers, and failed prerequisites
must stop before index deletion. See
[IDX embedding providers](configuration.md#idx-embedding-providers), including
the external-data disclosure and mixed-project doctor behavior.

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
`~/.config/pi/memory-reports/` and periodic samples to `~/.config/pi/pix.log`.
See [Memory watchdog](configuration.md#memory-watchdog) and the engineering note
[TUI streaming-thinking memory growth](../specs/tui-streaming-thinking-memory.md)
for the root cause, invariants, and regression coverage.

## Pix Desktop Linux AppImage opens a blank window

Linux Desktop is legacy, unsupported tooling (macOS is the only supported
Desktop platform). If you still run the legacy Linux AppImage and terminal
stderr contains:

```text
Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...
```

use the documented
[Linux AppImage Wayland/Mesa workaround](desktop.md#linux-appimage-blank-window-egl_bad_parameter).
Do not apply that workaround to unrelated Desktop errors.

## An extension behaves differently from stock Pi

Pix supports the Pi SDK extension UI surface, including toasts, widgets, menus,
dialogs, custom UI and terminal input hooks. Extensions that depend on private
renderer internals may still need adaptation.

Extension code that also runs headlessly should keep `ctx.hasUI` guards around
UI-only behavior. See [Extension authors](extensions.md).
