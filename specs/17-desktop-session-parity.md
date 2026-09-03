# Spec: Desktop and TUI session parity

## Type

Change

## Goal

Show the same project sessions and restored open tabs in Pix Desktop that Pix TUI discovers.

## Scope

- Reconcile native Pi JSONL sessions into the ACP session map during `session/list`.
- Preserve existing ACP session IDs for already-mapped Pi session files.
- Report the TUI tab snapshot through ACP metadata.
- Keep Desktop's all-session selector separate from its top tab strip.

## Non-goals

- Keeping tab changes live-synchronized between already-running Desktop and TUI processes.
- Changing the TUI tab snapshot format.
- Changing ACP session deletion semantics.

## Behavior

- A project-scoped `session/list` includes native sessions created by either TUI or Desktop.
- A discovered native session is persisted in the ACP map so `session/load` can open it later.
- Reconciliation deduplicates by resolved Pi session path and retains an existing ACP ID when present.
- The response carries ordered TUI open-tab session IDs in namespaced ACP metadata.
- Desktop uses all returned sessions in its selector and only restored TUI tabs, Desktop-opened tabs, and the active session in its tab strip.
- Missing, malformed, or stale tab snapshots produce no restored tabs and do not break session listing.
- Overlapping Desktop refreshes cannot apply results from an older workspace or ACP connection.
- If native discovery fails, mapped ACP sessions remain available.

## Related files

- `acp/src/acp/pix-acp-agent.ts`
- `acp/src/acp/session-map.ts`
- `acp/src/acp/tui-tabs.ts`
- `desktop/src/App.svelte`
- `desktop/src/lib/acp-client.ts`

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
