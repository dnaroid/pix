# Desktop and TUI session parity

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Show the same project sessions and restored open tabs in Pix Desktop that Pix TUI discovers.

## Scope

- Reconcile native Pi JSONL sessions into the ACP session map during `session/list`.
- Preserve existing ACP session IDs for already-mapped Pi session files.
- Report the TUI tab snapshot through ACP metadata.
- Keep Desktop's saved-session chooser separate from restored/open tab membership.

## Non-goals

- Keeping tab changes live-synchronized between already-running Desktop and TUI processes.
- Changing the TUI tab snapshot format.
- Changing ACP session deletion semantics.

## Behavior

- A project-scoped `session/list` includes native sessions created by either TUI or Desktop.
- A discovered native session is persisted in the ACP map so `session/load` can open it later.
- Reconciliation deduplicates by resolved Pi session path and retains an existing ACP ID when present.
- The response carries ordered TUI open-tab session IDs in namespaced ACP metadata.
- Desktop uses the returned sessions as the source for saved-session discovery. The titlebar still contains only restored TUI tabs, Desktop-opened tabs, and the active session.
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
- When restoring an older mapped session whose persisted history is unavailable, Desktop first waits for the concurrent runtime load. A loadable empty session is retained; only a record whose history and runtime both fail is cleaned up. Runtime-load generations prevent a late completion from repopulating state after that cleanup.
- Per-session activity indicators may decorate titlebar tabs, but runtime activity never changes restored membership, ordering, close semantics, or saved-session discovery.
- Missing, malformed, or stale tab snapshots produce no restored tabs and do not break session listing.
- Overlapping Desktop refreshes cannot apply results from an older workspace or ACP connection.
- If native discovery fails, mapped ACP sessions remain available.

## Related files

- `acp/src/acp/pix-acp-agent.ts`
- `acp/src/acp/session-map.ts`
- `acp/src/acp/tui-tabs.ts`
- `desktop/src/App.svelte`
- `desktop/src/lib/acp-client.ts`
- `src/app/session/tabs-controller.ts`
- `specs/tui-session-tabs.md`

## Verification

- ACP tests cover native discovery, stable mapping, cwd filtering, fallback, and tab metadata.
- Session-map tests cover bulk path reconciliation and ID collisions.
- Desktop unit tests cover metadata parsing and tab ordering.
- ACP and Desktop checks pass.

## Risks / unknowns

- A native session deleted only from the ACP map can be rediscovered on a later list; deletion behavior is unchanged and outside this fix.
- Tab metadata is a Pix extension to ACP and is ignored by other ACP clients.

## Evidence

- Confirmed by code: TUI lists sessions with `SessionManager.list(cwd)` and persists tabs under `~/.pi/agent/pix/tabs`.
- Confirmed by code: ACP previously listed only `pix-acp/sessions.json` records.
- Confirmed by local metadata: the native project session set and TUI tab snapshot contain more entries than the ACP map.
