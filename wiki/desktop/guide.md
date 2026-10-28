# Pix Desktop

<!-- markdownlint-disable MD013 -->

Pix Desktop is the native Tauri/Svelte frontend for Pix. It ships with its own
Pix + ACP runtime, so installing the TUI is optional.

## Install

Use the native package for the current OS/CPU from
[GitHub Releases](https://github.com/dnaroid/pix/releases). Pix Desktop is
currently supported on macOS only; Windows/Linux Desktop packages are legacy
tooling, not a supported product:

| Platform | Package |
| --- | --- |
| Windows x64 | Legacy tooling only; unsupported |
| macOS Apple Silicon | `.dmg` |
| Linux x64 | Legacy tooling only; unsupported |

Release packages contain their own Node.js/Pix/ACP runtime. See
[Installing Pix](../getting-started/installation.md) for checksum verification, upgrade and legacy
cleanup rules.

## Desktop workspace

Pix Desktop uses one project-oriented workbench instead of reproducing the TUI
inside a window.

The left Activity Bar exposes:

- **Tasks** — project-local SQLite tasks (`.pi/tasks.sqlite`) with full UI
  management, Quick Add, drag-and-drop, linked sessions and SHA-256 attachments;
  slash commands and the agent task tool supplement the UI;
- **Project** — file explorer with keyboard navigation and external-editor
  actions;
- **Source Control** — branch/status, diffs, stage/unstage, commit/push, code
  review and safe repository tools;
- **Registry** — private Git-backed skills/agents/project-state synchronization;
- **Package Scripts** — project package scripts and interactive terminals;
- **Search indexes** — local and semantic search-store status by source;
- **Usage** — Pix session usage across this project or all projects, with
  selectable time period and cost, token and call metrics;
- **LSP** — language-server status and controls;
- **Settings** — Desktop-specific model, voice, editor and Source Control
  preferences.

The Usage panel charts support hover and keyboard-focus tooltips, and clicking
a day, hour or model toggles a chart filter. Active day/hour filters appear as
removable chips; chart cross-filtering keeps the relevant breakdowns visible.
See the [usage panel specification](../usage/desktop-usage-stats.md) for filter
and tooltip behavior.

Settings → General includes a **Theme** preference: **System** (default),
**Light**, or **Dark**. Pix applies it through the native window appearance, so
system color-scheme-aware web content follows the selected theme. Changes are
reapplied when the window regains focus or the Desktop configuration changes.

Long-lived files, media, Git diff/review surfaces, and the interactive Terminal
opened by composer `!!` commands live in the main workbench tab strip rather
than modal windows.

## First run

The first-run dialog verifies the bundled runtime and can optionally:

- import supported OpenCode credentials without overwriting existing Pi
  credentials by default;
- import a static Codex `OPENAI_API_KEY` when Pi has no OpenAI credential;
- configure optional native repository semantic search.

ChatGPT/Codex OAuth refresh tokens are deliberately not copied between auth
stores.

Shipped defaults contain no provider/model ids. When providers are connected
and no default model is configured, Desktop opens a **Main / Fast / Strong**
model setup dialog. Skip dismisses it for this browser profile (remembered in
local storage). Reopen it from any model summary in Settings with **Edit in
wizard…**; cancelling a manual run changes nothing.

Steps: Roles (first run) or **In use** (manual run), then per-feature pages
(Features, Routing & desktop, Agents) with model, fallback chips and thinking
level per slot, then optional **Search & embeddings**. The **In use** step lists
every configured model with its usage count; replacing one updates it
everywhere — roles, slots, fallback lists and the frontier list. Unsupported
thinking levels move to the nearest supported level, slots with constraints
(vision Lookup, OpenRouter-only search & task classifier) keep the old model,
a **Newer: … — replace** hint appears when the catalog has a newer release of
the same provider and line, and **New frontier release** makes a model the
primary frontier model while keeping the previous one in the list.

The frontier primary defaults to the Strong role; extra frontier models have
no role default. An untouched frontier list keeps existing entries with their
flags and aliases; an edited list replaces everything after the primary.
Saving writes `pix.jsonc`, `pi-tools-suite.jsonc` and, when it exists,
`pix-desktop.jsonc` (including `search.intentModelRef`, one key for search
intent and task type classification), plus `search.embedding` /
`search.rerankerModel` when search is enabled. Open Settings editors reload
from disk afterwards. Setup uses sessionless ACP requests and does not create
a chat session.

Settings show models read-only with **Edit in wizard…**: Default & router
models, Feature models, Git models, Observer model, Sub-agent models, Lookup
models and Summarizer models. Wizard-managed routing tiers (simple, standard,
complex, expert) show model/thinking read-only; custom tiers stay editable, as
do non-model settings such as Auto by default, routing fallback tier, visible
models, RAG thinking effort, autocomplete limits, frontier flags and economy.

Code and Knowledge use native local search. Optional semantic retrieval requires
explicit project consent/configuration in `.pi/search/semantic.json`; eligible
chunks and queries may be sent externally using `OPENROUTER_API_KEY`. Existing
Legacy search directories/configuration are not consulted.

## Project initialization states

Desktop exposes explicit setup actions instead of failing with generic empty
panels:

- Source Control shows **Initialize Git** when the selected workspace has no Git
  repository. Pix refuses to create a nested repository when the workspace is
  already inside another Git root.
- Registry offers **Initialize project Registry** as an optional full scaffold
  setup (SQLite tasks, plans and attachments); saving a task, plan, attachment
  or project setting creates only the required `.pi` storage on demand. Merely
  opening/reading a workspace does not create `.pi`. Creating a new `.pi`
  appends `/.pi/` to the root `.gitignore` while preserving existing rules and
  newline style; existing `.pi` directories are not retroactively ignored.
  Initialization does not import, read or remove old JSONC task files.
- Search indexes reports local/semantic store state without initializing or
  repairing indexes.

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

Project settings (name color and logo) open from **Project settings…** at the
bottom of the project switcher menu, or by right-clicking the project badge in
the titlebar. They can assign a logo using **Initials** or **Image**. Images may
be selected with the native file chooser or generated through OpenRouter; they
remain previews until saved. A saved image is stored as `.pi/project-icon.png`,
`.jpg`, `.webp`, `.gif` or `.svg` (content-detected, up to 4 MB) and referenced
by `.pi/workspace.jsonc`. Generation uses `OPENROUTER_API_KEY` or the OpenRouter
key in Pi's `auth.json`; it sends the project name, optional prompt (up to 1000
characters) and up to the first 1000 README characters to the provider. The
default image model is `google/gemini-2.5-flash-image`; configure
`desktop.projectIcon.model` in global or project `pix-desktop.jsonc` to override
it. `.pi` cleanup preserves the canonical icon files. See the
[project identity contract](workbench/desktop-project-titlebar.md).

See [Configuration and accounts](../configuration/guide.md) for provider and voice setup.

## BTW side questions

Open **⋯ → Side question (BTW)** in the composer to ask about the current task
in a resizable pane on the right. `/btw` also opens it; `/btw question` sends a
question there. Both work while the main agent is running or paused. Opening the
pane alone does not call a model or move the main draft and attachments.

BTW supports follow-up questions and Markdown/code answers. Its model/effort
button opens the same **Model + Thinking** selector as the statusbar, using your
Desktop visible-model list rather than showing every model. **Manage** edits
that shared list. Choose a model and its supported thinking level, then Apply;
the selection affects only the next BTW question, never the main agent.
**Same as main session** inherits both the parent's resolved model and effort;
**Use main** restores this mode. Applied effort choices are remembered per model
only while the side chat exists; they do not change the main model defaults.
**Add selected text** explicitly includes a selected transcript/file
excerpt. BTW has no tools: it cannot independently read files, search or run tests.
Each question uses current completed parent context; shortened context is labelled.

**Stop** stops only the side response. Hiding the pane keeps its temporary
history, draft and reading position; reopening restores them. Each parent session
has its own side conversation. **New conversation** clears it. Closing/replacing
the parent runtime, reconnecting or exiting discards the temporary conversation;
it is not saved into the main chat or restored after restart.

Use **Copy** or **Insert** on an answer to reuse it. Insert requires an empty main
composer with no attachments and only writes a draft; it never sends it. Model
usage still counts towards the original session. See the [BTW contract](conversations/desktop-btw.md).

## Observer (experimental)

The **binoculars** on the right of the statusbar are grey when Observer is off and primary-colored
when enabled, except static amber binoculars while blocked by an Observer budget limit.
The tooltip and popup say «Достигнут лимит проверок» and show the earliest known
quota release time (not a promised check or full reset). Once the runtime clears
the limit, the binoculars return to primary. They pulse only while checking (unless reduced motion is enabled).
Click it for the **current-session switch**, **Check now**, current state/reason,
last check result and duration, and actual usage counters. The switch is saved
with this session and restored after restart; other sessions are unaffected.
Opening this popup does not
call a model. Checking does consume the selected provider's tokens/quota.

The popup's **Observer settings** action opens **Settings → Desktop → Observer**.
Choose the observer model independently of the main agent, set enablement for
new sessions and cadence, and expand advanced budgets/timing for input/output
limits, timeout and notice lifetime. Save applies defaults to new or reloaded
sessions; it does not change the active session's switch. Trusted project
configuration can override the user defaults. TUI settings are independent.

Findings still appear above the composer with evidence and feedback. **Insert
question** only fills an empty draft; it does not send it or change code. A
waiting observer may need more completed agent turns, not only elapsed time.
See the [feature contract](../assistants/observer/heads-up-observer.md) and the
[reproducible evaluator](../assistants/observer/evaluation.md) for limitations and checks.

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
