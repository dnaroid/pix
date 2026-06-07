# Pix Desktop (Tauri)

Tauri-based desktop UI for the Pi coding agent. It is a sibling workspace of the `pix` terminal app and uses the same `@earendil-works/pi-coding-agent` SDK through a Node sidecar.

> **Status — current prototype.** React talks to a Rust Tauri host via `rpc_call` / `rpc_subscribe`. Rust proxies line-delimited SDK-shaped JSON to a custom Node dispatcher. Implemented: workspace picker, persistent sessions, tabbed chat with per-workspace tab restore, expanded tool-call cards, history loading, SDK/pi-tools-suite slash-command discovery with extension argument completions, path/general composer autocomplete, image attachments via paste/drop/file picker, Web Speech voice dictation, captured `!shell` commands, raw `!!` PTY terminal surface, extension UI request dialogs with select search/timeouts, toasts/widgets/status plus session-scoped lifecycle, explicit degraded handling for custom/component extension UI, real pi-tools-suite interactive command smoke coverage, desktop-native `/model`/`/compact`/`/undo`, streaming/abort, and status bar. There is intentionally no sidebar.

## Architecture

```
React (Vite, port 1420)
  │ invoke("rpc_call", { cmd }) / invoke("rpc_subscribe", { onEvent })
  ▼
Tauri Rust host (src-tauri/)
  │ JSONL over stdio, SDK flat shape { id?, type, ... }
  ▼
Node sidecar (sidecar/src/)
  │ custom dispatcher + @earendil-works/pi-coding-agent SDK
  ▼
AgentSession / SessionManager
```

The frontend never imports or calls the SDK directly. Rust owns native APIs and sidecar process management; the sidecar owns SDK runtime/session operations.

## Layout

```
apps/desktop-tauri/
├── src/                  # React frontend
│   ├── App.tsx           # workspace picker, topbar, tabs, chat, history transform
│   ├── App.css           # Tokyo-Night dark theme
│   └── tools/            # tool-call renderer registry and renderers
├── sidecar/src/          # Node SDK bridge
│   ├── main.ts           # create runtime, switch cwd, run dispatcher
│   ├── dispatcher.ts     # command switch and event subscription rebinding
│   ├── pix-handlers.ts   # pix:list_sessions
│   ├── framing.ts        # strict LF JSONL framing
│   └── protocol.ts       # wire types
└── src-tauri/src/        # Rust host and sidecar bridge
```

## Wire protocol

This is **not JSON-RPC 2.0**. The sidecar uses the SDK-style flat JSONL protocol:

- Command: `{ "id": "req-1", "type": "prompt", "message": "hi", "images": [] }`
- Response: `{ "id": "req-1", "type": "response", "command": "prompt", "success": true, "data": ... }`
- Event: `{ "type": "agent_start" | "message_update" | "tool_execution_*" | ... }`

Implemented sidecar commands include `prompt`, `abort`, `get_state`, `get_messages`, `get_session_stats`, `get_commands`, `get_command_completions`, `extension_ui_response`, `get_models`, `set_model`, `compact`, `undo_last_turn`, `new_session`, `switch_session`, `set_session_name`, `pix:list_sessions`, and `pix:set_cwd`. The sidecar emits `extension_ui_request` events for extension `ctx.ui.*` calls, and the frontend answers dialog methods with `extension_ui_response`. The Rust host also exposes native `run_shell`, `complete_path`, and `pty_*` commands for the desktop `!cmd` flow, composer path autocomplete, and raw `!!` terminal sessions.

## Setup and run

From the repo root:

```bash
npm install --ignore-scripts
npm run desktop:icons
npm run desktop:dev
```

On first launch, choose a project folder. Pix Desktop stores the selected workspace in localStorage under `pix-desktop.workspace`, stores open tabs per cwd under `pix-desktop.tabs:<cwd>`, and resumes the saved active tab when possible.

## Verification

```bash
npm run desktop:check
```

Equivalent expanded checks:

```bash
npm --prefix apps/desktop-tauri run build
npm --prefix apps/desktop-tauri/sidecar run check
cargo check --manifest-path apps/desktop-tauri/src-tauri/Cargo.toml
```

## Env overrides

| Variable | Purpose |
| --- | --- |
| `PIX_SIDECAR_CMD` | Command to spawn, default `node`. |
| `PIX_SIDECAR_ARGS` | Whitespace-separated args, overrides default `--import tsx`. |
| `PIX_SIDECAR_PATH` | Explicit sidecar entry path. |
| `PIX_SIDECAR_AGENT_DIR` | Pi agent dir for auth/skills/extensions, default `~/.pi/agent`. |
| `PIX_SIDECAR_SESSION_MODE` | `persistent` by default; use `in-memory` for ephemeral tests. |
| `RUST_LOG` | Rust tracing filter. |

## Current UX notes

- Tabs are the only session navigation surface; the old sidebar was removed.
- Open tabs and the active tab are restored per workspace across Tauri restarts.
- Typing `/` opens a slash-command menu. Desktop built-ins (`/help`, `/new`, `/clear`, `/refresh`, `/abort`) are merged with SDK-discovered extension, prompt-template, and skill commands from `get_commands`; selecting a discovered command sends it through `prompt` with arguments preserved. When an extension command exposes `getArgumentCompletions`, the frontend debounces `get_command_completions` and shows argument suggestions in the same keyboard/click popup.
- Path/general autocomplete is handled locally through the Rust `complete_path` helper, scoped to the selected workspace. It completes `@path` mentions in normal messages, path-like `!cmd` shell tokens, and generic slash-command arguments when no richer extension/model completion is available.
- Images can be attached from the composer with the image button, paste, or drag/drop. The frontend previews them locally, sends SDK `ImageContent[]` through the sidecar `prompt` command, and keeps file attachments as text/path mentions for now.
- Voice dictation is available from the composer mic button when the current WebView exposes `SpeechRecognition`/`webkitSpeechRecognition`; final transcripts are appended to the composer. Unsupported/error states are shown inline. Offline Vosk parity remains future work.
- Extension commands can request simple UI through the RPC-style `extension_ui_request` surface: `select`, `confirm`, `input`, and `editor` show modal dialogs. Select dialogs include local search, long-list scrolling, option counts, and timeout countdown/self-cancel affordances when an extension passes `dialogOpts.timeout`; `notify` shows toasts; `setWidget` renders scroll-contained text widgets above/below the composer; `setStatus` and working-indicator APIs add status-bar entries; `setHeader`/`setFooter`, component widgets, `custom()`, `setEditorComponent()`, and extension autocomplete providers now have explicit degraded desktop behavior/status instead of silent no-ops; extension widgets/status/dialogs are cleared on session/workspace switch so stale UI does not leak across tabs; `set_editor_text` fills the composer.
- Real `pi-tools-suite` command smoke checks have exercised `/prompt-commands` (`select`, `notify`, `input` cancelled before mutation) and `/subagent-preset-config` (`select` cancelled) through the desktop sidecar path. Keep `PIX_SIDECAR_SESSION_MODE=in-memory` for these checks, but do not redirect `HOME` unless extension discovery is configured for that home; otherwise user extensions are not loaded and slash commands fall through to normal prompts.
- Desktop-native interactive built-ins are available for commands that are not prompt-invokable: `/model` opens a model picker and `/model <provider/id>` sets directly; `/compact [instructions]` runs SDK compaction; `/undo` navigates back to the latest user turn and restores returned editor text when available.
- Typing `!command` runs a short non-interactive shell command in the selected workspace and renders captured stdout/stderr as a shell tool card. Typing `!!command` opens an xterm.js-backed PTY panel in the current workspace for interactive/raw terminal programs; bare `!!` opens the user's shell.
- Tool-call cards include specialized renderers for shell/file/patch/todo/web/folder operations plus repo-index tools, ast-grep/apply, question prompts, subagent orchestration, context compression, and skill activation.
- Switching tabs/folders and closing tabs are blocked while an agent run is streaming, because the sidecar has one active SDK session subscription.
- On session switch or workspace restore, the UI calls `get_messages` and transforms SDK messages into sanitized chat messages, filtering reasoning/image internals and attaching tool results to tool-call cards.
- Sidecar logs must go to stderr only; stdout is reserved for JSONL protocol records.
