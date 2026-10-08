# Desktop and TUI session parity

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Show the same project sessions in Pix Desktop that Pix TUI discovers while keeping each surface's persisted open-tab choice stable across its own restarts.

## Scope

- Reconcile native Pi JSONL sessions into the ACP session map during `session/list`.
- Preserve existing ACP session IDs for already-mapped Pi session files.
- Preserve whether a native session is a fork so Desktop can match the TUI tab marker.
- Report the TUI tab snapshot through ACP metadata as a compatibility/reconciliation input.
- Keep Desktop's saved-session chooser separate from restored/open tab membership, and persist Desktop's own ordered real-tab snapshot per workspace within each stable native window label. Active-session pointers share that window scope; ambiguous legacy origin-wide snapshots are not imported.

## Non-goals

- Keeping tab changes live-synchronized between already-running Desktop and TUI processes.
- Changing the TUI tab snapshot format.
- Changing ACP session deletion semantics.

## Behavior

- Pix Desktop's project-scoped `session/list` returns the persisted ACP session
  map immediately instead of synchronously parsing every native JSONL transcript
  (large projects can contain hundreds of megabytes of saved conversations).
  Native TUI/Desktop discovery reconciles in the background. A successful
  changed-directory scan emits `pix/session/catalog_changed` with the owning
  project cwd; Desktop then reloads the list and includes the new sessions.
  The first response may temporarily precede discovery, but never blocks on it.
  Other ACP clients retain synchronous, fully reconciled `session/list`.
- Native background scans are single-flight per cwd and compare file names,
  sizes, mtimes and inode numbers before rereading unchanged JSONL bodies.
  Failures retain mapped conversations and allow retries. A running scan is
  canceled during adapter teardown, and stale connection/workspace notifications
  cannot modify an unrelated Desktop catalog. Notifications received during an
  in-flight initial list or refresh are replayed after that request settles.
- A discovered native session is persisted in the ACP map so `session/load` can open it later.
- Reconciliation deduplicates by resolved Pi session path and retains an existing ACP ID when present.
- Reconciliation persists the native parent-session path internally when present. `session/list` exposes a boolean `pix.isFork` and, when the parent is already mapped, its safe ACP id as `pix.parentSessionId` in that session's namespaced metadata; Desktop never receives a parent path.
- The response carries ordered TUI open-tab session IDs in namespaced ACP metadata.
- Desktop uses the returned sessions as the source for saved-session discovery. Restart restoration uses only the persisted Desktop tab snapshot; if none exists, Desktop treats it as empty and opens the draft rather than falling back to TUI tab state. The TUI snapshot remains an input only to later live reconciliation. The titlebar contains the persisted Desktop real tabs, subsequently reconciled TUI tabs, Desktop-opened tabs, and the active session.
- Desktop and TUI both use UI-only draft tabs for new conversations. A draft is
  not an ACP/Pi session and never participates in `session/list`, restored TUI
  metadata, persisted Desktop active-session ids, or the persisted TUI
  real-tab snapshot.
- In either client, opening a draft or editing its composer does not create a
  session. Selecting a saved session replaces the draft directly; a new real
  session is materialized only on the first prompt or action that requires a
  Pi session.
- Desktop's embedded chooser and TUI's under-tabs chooser present only returned
  sessions that are not already represented by real tabs, so already-open or
  running conversations are not duplicated there.
- Without a search query, Desktop saved-session surfaces render the same fork tree as TUI: roots and siblings are sorted by descending `updatedAt`, each child follows its parent, and arbitrary nesting uses monospaced `├─`/`└─`/`│` connectors. Search results remain flat ranked matches while retaining fork markers.
- When restoring an older mapped session whose persisted history is unavailable, Desktop first waits for the concurrent runtime load. A loadable empty session is retained; only a record whose history and runtime both fail is cleaned up. Runtime-load generations prevent a late completion from repopulating state after that cleanup.
- Per-session activity indicators may decorate titlebar tabs, but runtime activity never changes restored membership, ordering, close semantics, or saved-session discovery.
- Missing or malformed TUI tab snapshots do not break session listing. A stale TUI snapshot cannot resurrect a tab during Desktop restart, including when the Desktop snapshot is missing or explicitly empty; both cases restore the draft instead of old real tabs.
- Overlapping Desktop refreshes cannot apply results from an older workspace or ACP connection.
- If native discovery fails, mapped ACP sessions remain available.

## Related files

- `acp/src/acp/pix-acp-agent.ts`
- `acp/src/acp/session-map.ts`
- `acp/src/acp/tui-tabs.ts`
- `desktop/src/app/session-catalog.svelte.ts`
- `desktop/src/app/session-tabs-state.svelte.ts`
- `desktop/src/app/session-tab-controller.ts`
- `desktop/src/app/desktop-presentation-state.svelte.ts`
- `desktop/src/lib/acp-client.ts`
- `src/app/session/tabs-controller.ts`
- `specs/tui-session-tabs.md`

## Verification

- ACP tests cover native discovery, stable mapping, cwd filtering, fallback, and safe fork-parent/tab metadata.
- Async-catalog tests verify a fast persisted snapshot while a native scan is
  blocked, change notification, unchanged-directory suppression, error retry,
  cancellation, and safe project/connection ownership.
- Session-map tests cover bulk path reconciliation and ID collisions.
- Desktop unit tests cover metadata parsing, Desktop tab-snapshot persistence/restart precedence, stale TUI suppression, explicit-empty restore, tab ordering, fork-tree ordering/nesting, malformed ancestry, and flat search presentation.
- ACP and Desktop checks pass.

## Risks / unknowns

- A native session deleted only from the ACP map can be rediscovered on a later list; deletion behavior is unchanged and outside this fix.
- Tab metadata is a Pix extension to ACP and is ignored by other ACP clients.

## Evidence

- Confirmed by code: TUI lists sessions with `SessionManager.list(cwd)` and persists tabs under `~/.pi/agent/pix/tabs`.
- Confirmed by code: ACP previously listed only `pix-acp/sessions.json` records.
- Confirmed by local metadata: the native project session set and TUI tab snapshot contain more entries than the ACP map.
