---
kind: spec
status: active
---

# Desktop active-run close warning

## Behavior

- Closing a running conversation tab through any workbench close affordance
  requires explicit consent. Desktop uses a native warning dialog with **Close
  tab** and **Cancel**, not WebView `window.confirm`. Browser preview retains a
  browser confirmation fallback. Idle tabs close without a warning.
- Until consent, the tab, runtime and active work remain intact. Repeated close
  attempts for that session reuse the pending operation instead of opening another
  dialog. Dialog errors cancel the close and report an error. A workspace/client
  change while awaiting consent invalidates the close.
- Closing a native window with active conversations warns with **Close window**
  and **Cancel**. Closing an idle window does not warn for runs in another window.
- Application Quit, including macOS Cmd+Q, warns with **Quit Pix** and **Cancel**
  when any window reports active conversations. Confirmation applies to all
  windows. Only one native window/quit warning can be pending at a time.
- The `watch:all` development Restart excludes windows whose only running
  prompts are waiting for recoverable question-tool answers. Other running
  sessions, non-question forms, and draft first-prompt materialization still
  require Restart consent. This exception does not change window-close or
  ordinary Quit warnings; answering a question restores Restart protection.
- Cancellation never starts backend teardown or freezes the window restore
  snapshot. Confirmation continues existing clean-exit/resource cleanup and
  persistence behavior. Closing the last window asks only once.
- Native window activity includes background conversation prompts and a draft's
  first-prompt materialization; selecting another tab does not hide that activity.
  Activity writes are serialized and intermediate updates coalesced. Destroyed
  windows are removed from the native activity registry.

## Constraints and failure cases

- Warning state reflects Desktop-reported runtime activity; it does not detect
  arbitrary external processes or prevent forced termination/crashes. Activity
  IPC failures are reported through the ordinary Desktop error path.
- This does not add unsent-composer or unsaved-document warnings, or change TUI.
- An isolated QA process may finish without a consent dialog after its own
  infrastructure SIGINT/SIGTERM/SIGHUP cancellation. This still runs the native
  save/child-cleanup worker; it does not change working-app Quit/Restart or QA
  user-interaction warnings. See `wiki/development/testing/desktop-qa-isolated-launch.md`.
- Related contracts: [conversation tabs](../conversations/desktop-session-tabs.md) and
  [window persistence](desktop-window-state.md).
- Native ownership rationale: [0024](../../decisions/0024-desktop-close-warning.md).

## Verification

Run focused Desktop tests, Desktop check and native Cargo check/tests. In native
macOS Desktop verify cancel/confirm for active/background tab close, window close
and Cmd+Q across multiple windows, as well as silent idle close.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"ce04263df32a9e7989ffbc942466e77f668ab8668205aa2366b46526207f29e5","checkedAt":"2026-10-31T00:30:39.182Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":60,"reportLanguage":"ru"} -->
