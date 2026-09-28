# Desktop global operation lock audit

<!-- markdownlint-disable MD013 -->

## Purpose

Pix Desktop still has one application-wide boolean, `operationRunning`, that
feeds the derived `sessionMutationRunning` state and disables unrelated UI in
several workbench surfaces. This document records the remaining call sites after
the September 2026 lock-localization pass and separates intentional atomic
transitions from technical debt.

The target rule is:

- local/background work owns a local busy state;
- only a transition that mutates the identity or coherent state of the active
  workspace/session may temporarily block active-session mutation;
- an async operation must never clear a lock owned by another operation;
- stale completions must be rejected by captured client/workspace/session
  ownership, not by assuming the UI stayed blocked.

## Fixed in the current pass

- Resource Registry refresh/install/update/push/pull/uninstall/remove already use
  Registry-local `actionId`. Project Registry initialization and cleanup now do
  the same and no longer receive the global lock setter.
- Prompt enhancement no longer blocks the workbench while the model request is
  pending. Duplicate enhancement for the same session is coalesced, and a late
  answer does not overwrite text edited by the user after the request started.
- Background session close/delete now use per-session action ownership. Closing
  or deleting one inactive conversation no longer disables the active
  conversation or unrelated workbench controls. A stale close completion after
  a workspace change is ignored.
- Workspace session startup no longer acquires/releases `operationRunning`
  inside an already locked workspace switch. Concurrent startup requests are
  coalesced only for the same ACP client and workspace; a new workspace gets a
  distinct startup owner.

## Remaining global lock sites

### P1 — replace the ownerless boolean

`operationRunning` is still a single boolean in `desktop/src/App.svelte`.
The surviving call sites usually guard against overlap before setting it, but
the state has no owner/token. Disconnect/reset code can also clear it.

This makes correctness depend on every current and future caller respecting the
same convention. A safer replacement is an owned/scoped mutation coordinator,
for example:

- `workspace-transition`;
- `active-session-transition`;
- local `session:<id>` operations outside the global coordinator.

Releasing a scope should require the same opaque owner that acquired it. The
derived UI state should distinguish "active session cannot mutate" from
"unrelated background work exists".

### P1 — active-session import, reload, and resume are globally scoped

File: `desktop/src/app/conversation-session-actions.ts`

Remaining functions:

- `importConversationPath()`;
- `reloadResources()`;
- `resumeConversationPath()`.

All three mutate the active session/runtime/history, so concurrency with prompt
submission or another active-session transition must remain blocked. The
problem is scope: the global boolean also disables unrelated Registry, Git,
attachments, background tabs, model UI, and other workbench actions.

Recommended direction: migrate these functions to an
`active-session-transition` owner that blocks only controls whose correctness
depends on the active session identity/runtime.

### P1 — active conversation replacement paths share the global lock

Files:

- `desktop/src/app/conversation-fork-action.ts`;
- `desktop/src/app/session-tab-selection.ts`;
- `desktop/src/app/session-tab-closure.ts`.

Affected operations:

- fork and foreground the forked conversation;
- replace the current tab with another session;
- close the active session and select a fallback;
- delete the active session and select a fallback.

These are real atomic active-session transitions and should not simply become
unlocked. They should, however, move to the same owned
`active-session-transition` scope so unrelated panes are not disabled and a
late completion cannot release another transition's lock.

Background close/delete are already per-session and are not part of this debt.

### P1 — undo combines active-session and workspace mutation

File: `desktop/src/app/user-message-context-actions.ts`

`undo` rewinds the active session and reverts recorded workspace mutations,
then reloads history and the composer. This is the strongest remaining reason
for broad exclusion.

Keep it broadly protected until the workspace-revert transaction has explicit
ownership/rollback semantics. When the lock coordinator is introduced, model it
as an operation that owns both the active-session and workspace-mutation scopes
rather than relying on a global boolean.

### P1 — workspace switch keeps the global lock for a long I/O tail

File: `desktop/src/app/workspace-controller.ts`

`select()` currently keeps `operationRunning` while it:

1. stops package terminals and IDX operations;
2. closes workspace sessions;
3. resets all workspace-scoped stores;
4. loads the new startup session, tasks, documents, preferences, and Registry
   project state.

The identity handoff itself must stay atomic. The final load phase is a candidate
for shortening: after the workspace identity has changed, independent stores
already have workspace/generation guards and can populate progressively.

Recommended direction: keep a workspace-transition owner through teardown and
identity reset, then release it once the new workspace owns the UI. Let guarded
loads continue without a full-workbench lock where safe.

### P2 — project task / knowledge session creation is broader than necessary

File: `desktop/src/app/project-actions.svelte.ts`

Functions:

- `refreshKnowledgeBase()`;
- `runTask()`.

Both allocate and foreground a new session and currently use the global lock
during session/runtime setup. They already release it before the long-running
agent prompt starts.

The draft-session path demonstrates a narrower design: it has local
`materializing` state, request ownership, stale-completion guards, and can
continue safely while other tabs are used. A future refactor should reuse that
style for task/knowledge session materialization instead of globally disabling
the Desktop during startup.

## Current global setters

After the current pass, direct global acquisitions are intentionally limited to
the functions above. A quick audit command is:

```sh
grep -RInE 'setOperationRunning\(true\)|operationRunning[[:space:]]*=[[:space:]]*true' \
  desktop/src/app desktop/src/App.svelte
```

Any new call site should be treated as an architectural review point. Prefer an
existing local busy state, per-session owner, request generation, or scoped
transition owner first.

## Exit criteria

This audit can be retired when:

1. the application-wide ownerless boolean is replaced by owned/scoped
   transition state;
2. active-session transitions block only active-session-dependent controls;
3. workspace switching releases its exclusive phase before independent guarded
   data hydration where safe;
4. task/knowledge session creation uses local materialization ownership;
5. tests cover stale completion and same-ID/workspace replacement for each
   scoped owner.
