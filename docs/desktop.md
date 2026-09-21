# Pix Desktop

<!-- markdownlint-disable MD013 -->

Pix Desktop is the native Tauri/Svelte frontend for Pix. It ships with its own
Pix + ACP runtime, so installing the TUI is optional.

## Install

Use the native package for the current OS/CPU from
[GitHub Releases](https://github.com/dnaroid/pix/releases):

| Platform | Package |
| --- | --- |
| Windows x64 | NSIS `-setup.exe` |
| macOS Apple Silicon | `.dmg` |
| Linux x64 | `.AppImage` and `.deb` |

Release packages contain their own Node.js/Pix/ACP runtime. See
[Installing Pix](installation.md) for checksum verification, upgrade and legacy
cleanup rules.

## Desktop workspace

Pix Desktop uses one project-oriented workbench instead of reproducing the TUI
inside a window.

The left Activity Bar exposes:

- **Tasks** — project-local tasks stored in `.pi/tasks.jsonc`, including
  attachments and session links;
- **Project** — file explorer with keyboard navigation, project settings and
  external-editor actions;
- **Source Control** — branch/status, diffs, stage/unstage, commit/push, code
  review and safe repository tools;
- **Registry** — private Git-backed skills/agents/project-state synchronization;
- **Package Scripts** — project package scripts and interactive terminals;
- **IDX** — repository index status, initialization, managed IDX installation,
  typed code/knowledge queries and Spec Wiki maintenance;
- **Settings** — Desktop-specific model, voice, editor and Source Control
  preferences.

Long-lived files, media and Git diff/review surfaces open in the main workbench
tab strip rather than modal windows.

## First run

The first-run dialog verifies the bundled runtime and can optionally:

- import supported OpenCode credentials without overwriting existing Pi
  credentials by default;
- import a static Codex `OPENAI_API_KEY` when Pi has no OpenAI credential;
- install managed `indexer-cli` into Pix's private tools directory.

ChatGPT/Codex OAuth refresh tokens are deliberately not copied between auth
stores.

IDX installation is separate from project indexing. Installing the CLI never
creates `.indexer-cli` for a project automatically; initialize an individual
project from the IDX panel when needed.

## Project initialization states

Desktop exposes explicit setup actions instead of failing with generic empty
panels:

- Source Control shows **Initialize Git** when the selected workspace has no Git
  repository. Pix refuses to create a nested repository when the workspace is
  already inside another Git root.
- Registry shows **Initialize project Registry** when `.pi` is absent. It
  creates the project-owned task/plans/attachment skeleton without overwriting an
  existing `.pi/tasks.jsonc`.
- IDX shows **Install IDX** when neither a system/login-shell `idx` nor Pix's
  managed copy is available. After installation the panel refreshes
  automatically.
- When IDX exists but the project has not been indexed, **Initialize** creates
  the project-local index explicitly.

## Configuration

Desktop does not inherit the TUI's `pix.jsonc`.

User configuration:

```text
~/.config/pi/pix-desktop.jsonc
```

Project override:

```text
<workspace>/.pi/pix-desktop.jsonc
```

Schema:

```text
https://unpkg.com/pi-ui-extend/schemas/pix-desktop.json
```

The Desktop profile contains settings consumed by Desktop/ACP, including model
defaults, prompt helpers, visible models, external editor, voice input and Git
review/commit-message model preferences. TUI-only renderer/theme settings stay
in `pix.jsonc`.

See [Configuration and accounts](configuration.md) for provider and voice setup.

## Updates

Packaged production Desktop builds use Tauri Updater. On startup Pix checks the
signed release feed; when a newer version exists, the UI exposes an Update
action with download progress.

Windows uses the packaged installer flow. macOS/Linux offer Restart after the
replacement is ready. Development/watch builds do not run the production
updater, and Desktop never falls back to npm or the portable-TUI updater.

## Linux AppImage blank window: `EGL_BAD_PARAMETER`

This issue was reproduced on a Fedora/Bazzite-family Wayland/Mesa system. The
repository keeps the original diagnostic handoff separately; the instructions
below are the generalized user-facing fix.

### Symptom

Pix Desktop launches a window, but the WebView remains blank. Starting the
AppImage from a terminal shows:

```text
Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...
```

An `atk-bridge` accessibility warning may also appear; in the reproduced case
that warning was not the cause of the blank window.

The observed failure is consistent with a Wayland/Mesa compatibility problem
where the AppImage's bundled `libwayland-client` conflicts with the host
EGL/Mesa stack.

### Workaround

Apply this only when the AppImage has the exact blank-window /
`EGL_BAD_PARAMETER` symptom.

Assuming the AppImage is stored as:

```text
~/.local/opt/pix-desktop/pix-desktop.AppImage
```

create a wrapper beside it:

```sh
#!/bin/sh
set -eu

app_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
wayland_lib=$(ldconfig -p 2>/dev/null | awk '/libwayland-client\.so\.0/{print $NF; exit}')

if [ -n "${wayland_lib:-}" ] && [ -r "$wayland_lib" ]; then
  export LD_PRELOAD="$wayland_lib${LD_PRELOAD:+:$LD_PRELOAD}"
fi

exec "$app_dir/pix-desktop.AppImage" "$@"
```

Save it as:

```text
~/.local/opt/pix-desktop/pix-desktop
```

then:

```bash
chmod +x ~/.local/opt/pix-desktop/pix-desktop
```

If a user desktop entry exists, point `Exec=` and `TryExec=` at the wrapper
rather than directly at the AppImage, for example:

```ini
Exec=/home/YOU/.local/opt/pix-desktop/pix-desktop %U
TryExec=/home/YOU/.local/opt/pix-desktop/pix-desktop
```

On the reproduced host, `ldconfig -p` resolved the host library to
`/usr/lib64/libwayland-client.so.0`; the wrapper intentionally discovers the
path instead of hard-coding it.

Do not remove a working wrapper during an upgrade until the new AppImage has
been tested without it.

### If the error is different

Do not apply the preload workaround to unrelated failures. Capture stderr from a
terminal launch and diagnose the exact message. In particular, an ACP warning is
not established by the `EGL_BAD_PARAMETER` log alone.

## Desktop UI automation

Native Desktop verification needs a desktop-capable automation environment.
Browser-only automation is not a substitute for testing the Tauri/WebKit
application. On Linux, semantic native automation may also require a working
AT-SPI accessibility bus.
