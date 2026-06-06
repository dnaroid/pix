# Pix Desktop (Tauri)

Tauri-based desktop UI for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent). Sibling package of the `pi-ui-extend` (pix CLI) terminal app, sharing the same SDK but presenting a window-based interface outside the terminal.

> **Status — Phase 1 SDK bridge.** React frontend talks to the Pi SDK over a generic RPC bridge (`rpc_call` + `rpc_subscribe`) hosted in a Node sidecar running the SDK's built-in `runRpcMode`. Streaming events (`message_update`, `tool_execution_*`, …) flow back to the UI over Tauri IPC channels.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ Tauri process (Rust)                                             │
│  ┌───────────────────────┐   stdin: JSON line (RPC cmd)          │
│  │ src-tauri/ (Rust host)│ ─────────────────────────────────┐    │
│  │                       │                                   │    │
│  │  rpc_call(cmd)        │   stdout: JSON line               │    │
│  │  rpc_subscribe(ch)◀───┼─ response (id) ─ resolve pending   │    │
│  │                       │─ event       ─ broadcast to subs   │    │
│  │  sidecar.rs           │   ┌───────────────────────────────┴──┐ │
│  │   ├ spawn_default()   │   │ Node sidecar (sidecar/src/main.ts)│ │
│  │   ├ SidecarHandle     │   │                                   │ │
│  │   │   ├ call(cmd)     │   │  createAgentSessionRuntime +      │ │
│  │   │   └ subscribe()   │   │  runRpcMode() from                │ │
│  │   └ reader task       │   │  @earendil-works/pi-coding-agent  │ │
│  └────────┬──────────────┘   └───────────────────────────────────┘ │
└───────────┼──────────────────────────────────────────────────────┘
            │  invoke("rpc_call", { cmd })
            │  invoke("rpc_subscribe", { onEvent: channel })
            ▼
┌──────────────────────────────────────────────┐
│ React (Vite) frontend   src/                 │
│   Chat UI with lucide-react icons            │
│   Tauri Channel<unknown> for streaming       │
└──────────────────────────────────────────────┘
```

The frontend never talks to the SDK directly. Every call goes through Rust, which proxies to the sidecar and streams events back. This keeps the trust boundary clean and lets Rust own native niceties (window, tray, notifications, file dialogs, shell open).

### Wire protocol

The sidecar speaks the SDK's native RPC mode protocol (see `node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`):

- **Commands (stdin):** `{"id":"req-1","type":"prompt","message":"hi"}`
- **Responses (stdout):** `{"id":"req-1","type":"response","command":"prompt","success":true,...}`
- **Events (stdout):** `{"type":"agent_start" | "message_update" | "tool_execution_*" | ...}` (no `id`)
- **Extension UI requests:** `{"type":"extension_ui_request",...}` forwarded to UI; response handled in Phase 5+.

Rust assigns a unique `id` to every outgoing command if the caller did not supply one, and uses it to resolve the pending oneshot when the matching response arrives.

## Layout

```
apps/desktop-tauri/
├── package.json          # frontend deps + scripts
├── vite.config.ts        # port 1420 (Tauri convention)
├── tsconfig.json
├── index.html
├── src/                  # React frontend
│   ├── main.tsx
│   ├── App.tsx           # Chat UI: composer + streaming message list
│   ├── App.css           # Tokyo-Night dark theme
│   └── index.css
├── src-tauri/            # Rust host
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── capabilities/
│   ├── icons/            # generated via `npm run icons`
│   └── src/
│       ├── main.rs       # tiny entry, calls lib::run
│       ├── lib.rs        # tauri::Builder + #[tauri::command] rpc_call/rpc_subscribe
│       └── sidecar.rs    # JSON-line stdio bridge with id correlation + event fan-out
├── sidecar/              # Node SDK bridge
│   ├── package.json      # depends on @earendil-works/pi-coding-agent
│   └── src/
│       └── main.ts       # createAgentSessionRuntime + runRpcMode (no custom protocol)
└── scripts/
    └── generate-icons.mjs
```

## Setup

From the repo root:

```bash
npm install                    # workspace-aware install
cd apps/desktop-tauri
npm run icons                  # generate placeholder PNGs into src-tauri/icons/
```

The placeholder icons are solid dark squares. Replace `src-tauri/icons/icon.png` with real artwork and run `npx tauri icon src-tauri/icons/icon.png` to regenerate the full set (including `.icns` / `.ico` for production bundles).

The sidecar reads model/auth config from the default Pi agent directory (`~/.pi/agent/`). Make sure at least one provider is configured there (e.g. `pi` CLI can chat with a model) before launching Pix Desktop.

## Run

```bash
# from apps/desktop-tauri/
npm run tauri:dev
```

This will:
1. Start the Vite dev server on `http://localhost:1420`.
2. Build the Rust binary and launch the Tauri window.
3. Spawn the Node sidecar (via `node --import tsx`) and wire JSON lines over stdio.

Type a message in the composer (bottom). Press **Enter** (or click the arrow) to send. While streaming, the button turns into a **Stop** square — click to abort. Tool calls render as collapsible cards beneath the assistant text.

## Env overrides

| Variable                     | Purpose                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| `PIX_SIDECAR_CMD`            | Command to spawn (default: `node`).                                                  |
| `PIX_SIDECAR_ARGS`           | Whitespace-separated args (overrides `--import tsx`).                                |
| `PIX_SIDECAR_PATH`           | Explicit sidecar entry path; default discovery is used otherwise.                   |
| `PIX_SIDECAR_CWD`            | Working dir passed to `createAgentSessionRuntime` (default: sidecar's own cwd).      |
| `PIX_SIDECAR_AGENT_DIR`      | Pi agent dir for auth/skills/extensions (default: `~/.pi/agent`).                    |
| `PIX_SIDECAR_SESSION_MODE`   | `in-memory` (default, no persistence) or `persistent` (writes session JSONL files).  |
| `RUST_LOG`                   | `tracing_subscriber` filter (default `info,pix_desktop_lib=debug`).                  |

## Verification

```bash
# type-check + Vite build
npm run build

# Rust host
cd src-tauri && cargo check && cd ..

# sidecar smoke (no Tauri window): sends get_state, prints response shape
echo '{"type":"get_state","id":"smoke"}' | \
  node --import tsx sidecar/src/main.ts
```

End-to-end manual smoke: `npm run tauri:dev`, type a message, watch the assistant stream.

## Roadmap

| Phase | Scope                                                                                          | Status   |
| ----- | ---------------------------------------------------------------------------------------------- | -------- |
| 0     | Scaffold + React → Rust → Node ping bridge                                                     | ✅ done  |
| 1     | SDK RPC bridge: `runRpcMode` in sidecar, generic `rpc_call` / `rpc_subscribe` in Rust, streaming chat UI with lucide-react | ✅ done  |
| 2     | Core UI: session list, message history persistence, polished tool cards, model picker          | next     |
| 3     | Tool-call renderer parity with terminal pix (`src/tool-renderers/` port)                       | planned  |
| 4     | Tabs / workspaces, status panels (todos, subagents, model usage, footer)                       | planned  |
| 5     | Slash commands, inline autocomplete, `!cmd` / `!!raw` shells, attachments, voice dictation, extension-ui dialog bridge | planned  |
| 6     | Extension UI surface (toasts, popup menus, widgets) — Pix extension contract port              | planned  |
| 7     | Native niceties: system tray, notifications, "open in Zed", auto-update, code-signed bundles, sidecar bundling (Node SEA / pkg) | planned  |

## Conventions

- **Wire protocol:** the SDK's native RPC mode (line-delimited JSON, **not** JSON-RPC 2.0). Sidecar logs go to **stderr only** — never `console.log` from the sidecar. Use `process.stderr.write(...)` or a logger that writes to stderr.
- **Async on Rust:** Tauri provides the tokio runtime. Sidecar I/O is fully async; never block the Tauri event loop with synchronous `std::process::Command`.
- **Type safety:** the SDK's `docs/rpc.md` is the single source of truth for command and event shapes. We do not duplicate the schema; React treats events as `unknown` and narrows at the switch.
- **Path resolution:** sidecar discovery prefers explicit env vars, then walks known relative paths. Don't hard-code paths inside Rust or Node.
- **Streaming events:** Rust fans out every event to **all** registered Tauri channels. Channel send failures (window closed, etc.) trigger lazy subscriber removal.
