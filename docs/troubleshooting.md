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

## Pix Desktop Linux AppImage opens a blank window

If terminal stderr contains:

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
