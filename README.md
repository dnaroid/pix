# Pix

Pix is a terminal UI for the Pi coding agent. It uses the Pi agent and SDK, but replaces the default screen with a workspace-oriented interface: session tabs, compact tool calls, local shell commands, voice dictation, and a bundled `pi-tools-suite` extension pack.

The npm package is named `pi-ui-extend`; the installed command is `pix`.

## Highlights

- Work with multiple workspace sessions in tabs and resume them after restart.
- Read tool calls as compact rows; click a row to expand or collapse details.
- Run local shell commands from chat with `!command`, or full TTY programs with `!!command`.
- Dictate prompts locally with Vosk in Russian or English.
- Improve a draft prompt with `/enhance`.
- Undo the last supported workspace edit with `/undo`.
- Search, import, export, clone, fork, and resume saved sessions.
- See status widgets for todos, subagents, model selection, context usage, and compaction.
- Use extensions that can show toasts, menus, and above-input widgets.

## Requirements

- Node.js `>=22.19.0 <25`.
- A terminal with good Unicode support.
- Recommended font: JetBrainsMono Nerd Font. If icons render as squares, use the fallback icon theme.
- On Linux, clipboard integration works best with one of: `wl-copy`, `xclip`, `xsel`, or `termux-clipboard-set`.
- For voice dictation, install one recorder: SoX (`rec`/`sox`), `ffmpeg`, or `arecord` on Linux.

## Install

Fastest start:

```bash
npx pi-ui-extend install
```

Then run Pix in your project:

```bash
npx pi-ui-extend --cwd /path/to/workspace
```

For regular use, install Pix globally from npm so the `pix` command is always available:

```bash
npm install -g pi-ui-extend --ignore-scripts
```

Check your installation and environment:

```bash
pix install
```

To only print the report without changing anything:

```bash
pix install --check
```

The published package includes the compiled JavaScript, the `pix` launcher, docs, and the bundled `pi-tools-suite` extension. End users do not need to clone this repository or build TypeScript.

On startup, Pix also links the bundled `pi-tools-suite` into Pi's standard user extension directory:

```text
~/.pi/agent/extensions/pi-tools-suite
```

Pix will not overwrite a normal directory at that path. If the path is a symlink created by Pix, it is refreshed automatically.

## First run

Open the project you want the agent to work in:

```bash
pix --cwd /path/to/workspace
```

If `--cwd` is omitted, Pix uses the current directory:

```bash
cd /path/to/workspace
pix
```

Useful startup flags:

- `--cwd <path>` — workspace for files, settings, resources, and agent sessions.
- `--no-session` — start a temporary in-memory session without persistence.
- `--model <provider/model[:thinking]>` — choose the startup model, for example:

```bash
pix --model anthropic/claude-sonnet-4-20250514:medium
```

## Accounts and models

Pix uses Pi providers and accounts. After installation, you can usually import or add accounts from inside Pix:

- `/opencode-import` — import opencode accounts.
- `/antigravity-import` — import Antigravity OAuth accounts.
- `/antigravity-add-account` — add another Antigravity account.
- `/model` — choose a model.
- `/thinking` — choose a thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `auto`.
- `/scoped-models` — configure the model list used by the picker and quick switching.

## Common actions

### Send a prompt

Type your request and press `Enter`.

### Run a shell command

```text
!npm test
```

The command runs locally and appears in the UI as a transient block. This output is not saved into the SDK session.

While a command is running:

- `Enter` sends the current editor text to the process stdin.
- `Ctrl+C` interrupts the process.

### Run an interactive TTY command

```text
!!top
```

Use `!!` for full-screen or interactive programs.

### Dictate a prompt

- `Ctrl+G` starts or stops local dictation.
- Click the microphone/language widget on the right to toggle dictation or switch language.

On first use, Pix downloads small Vosk models:

- Russian: `vosk-model-small-ru-0.22`
- English: `vosk-model-small-en-us-0.15`

Language and enabled models are configured in `~/.config/pi/pix.jsonc`.

### Undo the last supported edit

```text
/undo
```

Undo is available for supported Pix file mutations.

## Keyboard shortcuts

- `Enter` — send the prompt.
- `Ctrl+C` — stop the current agent response; if the agent is idle, exit Pix.
- `Ctrl+D` — exit when the input is empty.
- `Ctrl+L` — redraw the screen.
- `Ctrl+G` — start or stop voice dictation.
- `PageUp` / `PageDown` — scroll history.
- Mouse wheel — scroll history.
- Click a tool row — expand or collapse tool output.

Open the in-app shortcut help with:

```text
/hotkeys
```

## Slash commands

Type `/` to open the command picker. Commands with arguments can also be typed directly.

| Command | Purpose |
|---|---|
| `/settings` | Show current session settings, model, and theme. |
| `/model` | Choose a model or set `provider/model[:thinking]`. |
| `/thinking` | Choose a thinking level or `auto`. |
| `/scoped-models` | Configure models for the picker and quick switching. |
| `/enhance` | Improve the current draft prompt. |
| `/copy` | Copy the last assistant response. |
| `/name` | Rename the session or generate a name automatically. |
| `/session` | Show session stats: messages, tokens, and cost. |
| `/usage` | Show quota/account usage and context fill. |
| `/export [path]` | Export the session. Default is HTML; `.jsonl` exports JSONL. |
| `/import <path.jsonl>` | Import and continue a JSONL session. |
| `/share` | Share the session as a private GitHub gist; requires the `gh` CLI. |
| `/fork [entry-id]` | Fork the session from the latest or selected user message. |
| `/clone` | Duplicate the current session at the current position. |
| `/jump [query]` | Jump to a previous user message. |
| `/search <text>` | Search saved sessions. |
| `/resume [path\|query]` | Open another session. |
| `/new` | Start a new session in the current tab. |
| `/new_tab` | Start a new session in a new tab. |
| `/compact [instructions]` | Compact context with optional instructions. |
| `/reload` | Reload keybindings, extensions, skills, prompts, and themes. |
| `/update` | Check for Pix updates; install from the shell with `pix update`. |
| `/changelog` | Show the changelog for Pi packages. |
| `/quit`, `/exit` | Exit Pix. |

Extensions, prompt templates, and skills can add more commands to the same picker.

## Update

Check for updates inside Pix:

```text
/update
```

Check or install updates from the shell:

```bash
pix update --check
pix update
```

Force reinstall:

```bash
pix update --force
```

`pix update` updates the Pix npm package, pinned Pi SDK dependencies, renderer-owned extensions, and the bundled `pi-tools-suite`. On the next startup, Pix refreshes the extension symlink in `~/.pi/agent/extensions/pi-tools-suite`.

Update checks are disabled by any of these environment variables:

- `PI_OFFLINE=1`
- `PI_SKIP_VERSION_CHECK=1`
- `PIX_SKIP_VERSION_CHECK=1`

If Pi packages are installed separately and managed by Pi itself, update them separately:

```bash
pi update --extensions
pi update
```

## Configuration

User Pix config:

```text
~/.config/pi/pix.jsonc
```

Common settings:

```jsonc
{
  "iconTheme": "fallback",
  "dictation": {
    "language": "en"
  }
}
```

Bundled `pi-tools-suite` config:

```text
~/.config/pi/pi-tools-suite.jsonc
```

Use it to enable and configure LSP servers, sub-agent presets, and tool-suite modules.

Useful environment variables:

- `PIX_USE_FALLBACK_ICONS=1` or `PIX_ICON_THEME=fallback` — use plain symbols instead of Nerd Font icons.
- `PIX_ICON_THEME=nerdFont` — force Nerd Font icons.
- `PIX_DISABLE_TERMINAL_OUTPUT_BUFFER=1` or `PIX_TERMINAL_OUTPUT_BUFFER=0` — disable the terminal output buffer region.

## Troubleshooting

### Node is too old

Pix requires Node.js `>=22.19.0 <25`. Upgrade Node with your version manager, for example:

```bash
nvm install 22
nvm use 22
```

or:

```bash
mise install node@22.19.0
mise use -g node@22.19.0
```

### Icons are rendered as squares

Start Pix with fallback icons:

```bash
PIX_USE_FALLBACK_ICONS=1 pix
```

Or save the setting in `~/.config/pi/pix.jsonc`:

```jsonc
{
  "iconTheme": "fallback"
}
```

### Clipboard does not work on Linux

Install one of the clipboard helpers: `wl-copy`, `xclip`, `xsel`, or `termux-clipboard-set`, then run:

```bash
pix install --check
```

### Voice dictation does not work

Check that one recorder is installed: SoX, `ffmpeg`, or `arecord`. Then restart Pix and press `Ctrl+G`.

## For developers and extension authors

This README focuses on installing and using Pix as an end user. If you want to develop Pix itself or write renderer-aware extensions, see the source tree, `docs/`, and the exported SDK entrypoint:

```ts
import type { PixExtensionUIContext } from "pi-ui-extend/sdk";
```

Local development from a source checkout usually starts with:

```bash
npm install --ignore-scripts
npm run dev -- --cwd /path/to/workspace
npm run check
```
