# TUI session tabs and UI-only draft conversations

## Purpose

Pix TUI uses the same lazy conversation lifecycle as Pix Desktop: opening a
new tab is a UI operation, while creating a Pi session is deferred until the
user actually sends work to the agent.

## Behavior

- `New Tab` opens or reactivates one **UI-only draft tab**. The draft has a
  normal tab identity for focus/input ownership, but it has no persisted
  session path and owns no Pi runtime.
- Opening the draft must not call the new-session runtime factory, create a Pi
  session file, or add anything to the persisted TUI tab snapshot.
- When Pix starts without an explicit session and without a restorable real
  tab, startup enters the same UI-only draft state without creating a Pi
  runtime.
- An untouched draft renders the saved-session selector as the draft tab's own
  conversation surface, with the title **Open a conversation**. It is not a
  global under-tabs popup layered over the previous real tab. The selector uses
  the normal TUI search, Up/Down navigation, Enter activation, and Escape
  dismissal behavior.
- The first row is **New session** and is selected by default. Enter on this row
  only dismisses the selector and returns terminal input to the composer; it
  does not create a Pi runtime or persisted session. The real session is still
  deferred until the first normal prompt submit.
- Saved-session discovery follows that synthetic row and excludes every saved
  session already represented by a real open TUI tab.
- Typing, pasting, adding attachments, path insertion, or voice input marks the
  draft as edited and dismisses the selector, but does not create a Pi session.
- A normal first prompt submission materializes the draft in place: Pix creates
  the new runtime, activates/binds it, converts the same tab id from draft to
  real-session ownership, and only then submits the prompt.
- Resource slash commands that require a Pi session materialize the draft
  before execution. Purely local slash commands and shell input do not create a
  Pi session merely because the draft exists.
- Choosing a saved conversation from the draft selector loads that persisted
  session directly into the same draft tab. Pix does not create or tear down a
  throwaway new session.
- Closing a draft tab is a UI-only close. Closing the last real persisted tab
  in normal session mode leaves a draft tab rather than eagerly starting
  another Pi session.
- Closing an active draft while another real tab exists closes the draft-owned
  session selector synchronously before restoring the real tab. The selector
  must not survive as a resume popup on the restored tab.
- Returning from a draft restores the cached real-tab conversation immediately
  when available. If a required history refresh is cancelled or fails, Pix
  falls back to that cached snapshot instead of leaving the restored tab with
  an empty conversation surface.
- The sole UI-only draft tab is the minimum conversation surface and cannot be
  closed. Its close glyph/target is omitted, and close commands against it are
  ignored until another real tab exists.
- `--no-session` keeps its existing in-memory session lifecycle and does not opt
  into the persisted-session draft-tab behavior.

## Persistence and parity

- Only real tabs with persisted `sessionPath` values are serialized to the TUI
  tabs snapshot.
- Saving a workspace that currently contains only a UI-only draft writes an
  empty real-tab snapshot so an older persisted tab set cannot reappear on the
  next launch.
- Desktop/TUI ACP tab metadata therefore continues to contain only real Pi
  sessions. A TUI draft never appears in Desktop `session/list` results or
  restored-tab metadata.
- Restored real tabs remain ordered and selected by the existing snapshot
  rules; the draft is a transient TUI surface layered on top of that
  real-session membership model.

## Concurrency and ownership invariants

- Draft creation, materialization, saved-session replacement, switching, and
  closing run through the serialized tab lifecycle mutation queue.
- Draft activation is atomic with respect to rendering: the draft is marked as
  the pending/active tab before old-runtime UI cleanup starts, and the old
  visible runtime is detached before cleanup callbacks that may render. A
  synchronous render during teardown therefore cannot reactivate the previous
  real tab while the draft selector is opening.
- First-prompt materialization marks the draft pending before awaiting runtime
  creation so repeated submits cannot create duplicate sessions.
- Async materialization and saved-session loads may mutate visible state only
  while the captured lifecycle generation and draft tab id still own the
  operation. Stale runtimes are disposed instead of being adopted by a newer
  tab, and a failed draft-to-real-tab switch restores the real tab's prior
  activity indicator.
- Input and command scopes include the active tab id, so late selector/session
  list or command continuations from a displaced draft cannot modify the newly
  active tab.
- Switching away from a real tab to a draft detaches the visible runtime
  subscription/UI while retaining the real runtime under its owning background
  tab. Switching back restores that runtime or lazily reloads it by session
  path.

## Related files

- `src/app/session/tabs-controller.ts`
- `src/app/session/session-lifecycle-controller.ts`
- `src/app/input/input-action-controller.ts`
- `src/app/popup/popup-menu-controller.ts`
- `src/app/popup/menu-items-controller.ts`
- `src/app/popup/popup-action-controller.ts`
- `src/app/commands/command-navigation-actions.ts`
- `src/app/commands/command-host.ts`
- `src/app/app.ts`
- `tests/tabs-controller.test.ts`
- `tests/input-action-controller.test.ts`
- `tests/menu-items-controller.test.ts`
- `tests/command-navigation-actions.test.ts`
- `tests/popup-menu-controller.test.ts`
- `tests/popup-action-controller.test.ts`
- `specs/desktop-session-parity.md`

## Verification

- Tab-controller tests cover UI-only New Tab, startup without a runtime, direct
  saved-session replacement, lazy first-prompt materialization, and failed
  materialization and draft-to-real switch rollback.
- Input-action tests cover materializing the draft only when a normal first
  prompt is actually submitted.
- Menu/popup tests cover excluding already-open sessions, omitting the **new**
  row, the **Open a conversation** selector label, and direct replacement of
  the draft tab.
- Command-navigation tests cover synchronizing the draft selector query while a
  shared saved-session load is already in progress.
- `npm run test:inner`
- `npx tsc --noEmit`
