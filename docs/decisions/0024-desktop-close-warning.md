# 0024 — Native Desktop close warnings

- Status: accepted
- Recorded: 2026-10-03
- Decided: 2026-10-03
- Owner / approval evidence: the user requested a warning on closing a running
  tab/application in this implementation conversation (no separate durable
  transcript cited). The parent selected the native integration described below.
- Governing spec: [Desktop close warning](../../specs/desktop-close-warning.md)
- Replaces / replaced by: none

## Context

Desktop already used synchronous `window.confirm` for active tab closure, but
native window/app shutdown had no active-run consent gate. All native exit routes
must leave existing clean teardown and window snapshot semantics intact.

## Observations and sources

- `desktop/src-tauri/src/lib.rs` owns `ExitRequested` and performs snapshot freeze
  before asynchronous process cleanup; guarding only frontend window close would
  not guard native application Quit.
- `desktop/src/app/prompt-runtime.svelte.ts` exposes a reactive set of running
  sessions including background prompts. Draft materialization has separate state.
- Native behavior must be verified in macOS; browser preview is not evidence for
  native window/Quit semantics. No measured latency improvement is claimed.

## Decision

Use the existing Tauri dialog plugin for asynchronous tab warnings. Keep the
window/Quit consent gate in a dedicated native module, before teardown or
snapshot freeze. Report per-window runtime activity from the frontend through
serialized/coalesced IPC. Gate native close/quit dialogs globally to avoid stacked
warnings. Preserve the view-only council participant dismissal exception.

## Alternatives

- WebView `window.confirm` everywhere: cannot gate native application Quit and
  depends on WebView browser-dialog behavior.
- Frontend-only `onCloseRequested`: misses application-wide native Quit and
  complicates cross-window consent.
- Parse backend protocol traffic for activity: avoids frontend reporting delay
  but couples native shutdown to session protocol and misses frontend draft startup.

## Consequences

Cancel preserves resources and restore state. Activity is asynchronously reported,
not an independent backend process census; arbitrary external work and forced
termination are outside scope. Native dialogs keep platform semantics rather
than introducing another themed modal component.

## Revisit when

Activity reporting loses runs or IPC latency is observably significant; product
adds unsaved-document/composer shutdown warnings; or native UI verification shows
platform dialog/exit behavior differs from the contract.
