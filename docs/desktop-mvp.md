# Spec: Pix Desktop MVP

## Type

Change

## Goal

Provide a lightweight desktop client for Pix using Tauri 2 and Svelte 5 +
TypeScript. The first vertical slice must let a user select a workspace, open
or create a pi session, send a prompt, observe streamed assistant/thought/tool
updates, cancel a running turn, and answer extension elicitations.

## Scope

- A standalone `desktop/` package; the existing terminal UI remains unchanged.
- A Tauri process host for the existing `acp/dist/main.js` adapter.
- An ACP 1.4 JSON-RPC client in the Svelte application.
- Workspace selection, recent sessions, transcript replay, model/thinking
  selectors, prompt composition, cancellation, and one-field form
  elicitations.
- Development commands and a documented local setup path.

## Non-goals

- Feature parity with `PiUiExtendApp`.
- Voice input, an embedded terminal, custom widgets, image attachments,
  markdown/diff rendering, or authentication management.
- Bundling Node or a platform-specific standalone `pix-acp` executable in this
  first slice. Development uses Node plus pix-acp's pinned pi npm dependency;
  distributable sidecar packaging is a follow-up milestone.
- Reimplementing the pi runtime in Rust or the webview.

## Behavior

1. Tauri starts one isolated `pix-acp` child and exposes only start, line-send,
   and stop commands to the webview. Arbitrary shell execution is not exposed.
2. The client initializes ACP with form-elicitation support before creating or
   loading a session.
3. Selecting a workspace lists its persisted sessions. The user can create a
   session or load one; loading replays its transcript. Clicking the active
   session tab opens a searchable session selector below the tabs, matching the
   terminal UI's active-tab behavior. Each visible tab also has a close button;
   closing a tab does not delete its persisted session, so it remains available
   from the selector.
4. A submitted prompt appears immediately as a user message. ACP
   `session/update` notifications incrementally update assistant text,
   thoughts, and tool activity.
5. While a prompt request is pending, duplicate submission is disabled and a
   stop action sends `session/cancel`. Final updates remain accepted until the
   prompt response settles.
6. Model and thought-level controls reflect ACP `configOptions` and use
   `session/set_config_option` for changes.
7. A form `elicitation/create` request blocks in a modal until the user accepts
   or cancels. String/select/boolean fields emitted by `pix-acp` are supported.
8. Adapter exits, malformed protocol messages, and request failures are shown
   as recoverable UI errors; all pending requests reject when the adapter exits.

## Contracts

- Webview → Rust commands:
  - `acp_start()` returning the child generation number
  - `acp_send(generation, line)` where `line` is one newline-free JSON-RPC
    object and the generation must still own the child
  - `acp_stop(generation)`; stale generations cannot stop a replacement child
- Rust → webview events:
  - `acp://stdout` with `{ generation, line }` for one complete stdout line
  - `acp://stderr` with `{ generation, line }` for one diagnostic line
  - `acp://exit` with the generation and child exit status
- Rust starts `node ../../acp/dist/main.js` by default. `PIX_ACP_NODE_BINARY`
  and `PIX_ACP_ENTRY` may override executable and entry path for development.
- Webview ↔ adapter payloads follow `@agentclientprotocol/sdk` 1.4.0 types.

## Invariants

- ACP stdout is protocol-only; diagnostics are never parsed as JSON-RPC.
- At most one adapter child is owned by an application window.
- At most one active prompt exists per ACP session.
- A workspace path must be non-empty and absolute before `session/new` or
  `session/load`.
- Pending JSON-RPC calls have deterministic cleanup on response, send failure,
  adapter exit, and client disposal.
- Reconnect clears session-local UI state and ignores events from older child
  generations.

## Edge cases

- Repeated start is idempotent; repeated stop succeeds.
- Stop closes adapter stdin first so pix-acp can dispose nested pi processes,
  then forces termination after a bounded grace period.
- A stale persisted session may fail to load; the UI remains usable for a new
  session.
- Cancellation is a notification, so the UI waits for the original prompt
  response rather than assuming immediate completion.
- Unknown ACP updates are ignored rather than crashing the transcript.
- Unsupported or malformed elicitation schemas are cancelled.

## Related files

- `desktop/`
- `acp/src/main.ts`
- `acp/src/acp/pix-acp-agent.ts`
- `acp/src/acp/event-translator.ts`
- `acp/src/acp/ui-request-bridge.ts`

## Verification

- `npm --prefix desktop run check`
- `npm --prefix desktop test`
- `npm run check:acp`
- `npm run check`
- `cargo check --manifest-path desktop/src-tauri/Cargo.toml`

## Risks / unknowns

- Production bundles still need a platform-specific strategy for shipping
  Node/pi/pix-acp or a compiled standalone sidecar.
- Tauri/Rust verification requires a local Rust toolchain; frontend tests
  remain runnable independently.
- ACP 1.4 live message chunks from `pix-acp` may omit `messageId`; the desktop
  reducer therefore coalesces adjacent chunks by role when no id is present.

## Evidence

- Confirmed by code: `pix-acp` supports the required session, prompt, cancel,
  config, streamed update, replay, and elicitation surfaces.
- Confirmed by tests: `acp/test/agent.test.ts` and
  `acp/test/event-translator.test.ts` cover those adapter contracts.
- Confirmed by docs: Tauri 2 supports a Vite frontend and child-process event
  bridging; Svelte 5 supports typed components and rune-based state.
- Inferred: a narrow Rust process host is safer and easier to package later
  than exposing a general shell plugin to the webview.
- Unknown: final production sidecar packaging format and signing/notarization
  workflow.
