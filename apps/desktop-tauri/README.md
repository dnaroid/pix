# Pix Desktop (Tauri)

Tauri-based desktop UI for the Pi coding agent. It is a sibling workspace of the `pix` terminal app and uses the same `@earendil-works/pi-coding-agent` SDK through a Node sidecar.

> **Status — current prototype.** React talks to a Rust Tauri host via `rpc_call` / `rpc_subscribe`. Rust proxies line-delimited SDK-shaped JSON to a custom Node dispatcher. Implemented: workspace picker, persistent sessions, tabbed chat with per-workspace tab restore, tool-call cards, history loading, minimal slash commands, streaming/abort, and status bar. There is intentionally no sidebar.

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

- Command: `{ "id": "req-1", "type": "prompt", "message": "hi" }`
- Response: `{ "id": "req-1", "type": "response", "command": "prompt", "success": true, "data": ... }`
- Event: `{ "type": "agent_start" | "message_update" | "tool_execution_*" | ... }`

Implemented commands include `prompt`, `abort`, `get_state`, `get_messages`, `get_session_stats`, `new_session`, `switch_session`, `set_session_name`, `pix:list_sessions`, and `pix:set_cwd`.

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
- Typing `/` opens a minimal slash-command menu. Current built-ins: `/help`, `/new`, `/clear`, `/refresh`, `/abort`.
- Switching tabs/folders and closing tabs are blocked while an agent run is streaming, because the sidecar has one active SDK session subscription.
- On session switch or workspace restore, the UI calls `get_messages` and transforms SDK messages into sanitized chat messages, filtering reasoning/image internals and attaching tool results to tool-call cards.
- Sidecar logs must go to stderr only; stdout is reserved for JSONL protocol records.
