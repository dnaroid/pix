# Desktop runtime context and model limits

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Bring the TUI's context-usage, DCP-session-statistics, and current-model quota signals into Pix Desktop without copying terminal presentation into the GUI. Desktop keeps the same underlying semantics while rendering them as dense IDE status chrome and a lightweight popover.

## Behavior

- Once an active Desktop session runtime is ready, the status bar shows the current context fill percentage and a compact horizontal fill track.
- Context color thresholds match the TUI: up to 30% uses success, 31–50% warning, and above 50% error semantics.
- Clicking the context control opens a non-modal DCP statistics popover above the status bar. It uses the same DCP statistics formatter and session-journal/tool-result data as the TUI.
- The DCP popover remains technical and compact, uses semantic Desktop popover/chrome tokens, supports text selection, closes on outside pointer interaction or Escape, and does not block the rest of the workbench.
- The DCP popover exposes a compact `Compress` action when the runtime advertises the `/dcp` extension command and the session is idle. While compression is running the control shows a busy state and cannot be invoked again.
- The action runs the existing `/dcp compress` command through the normal Desktop prompt pipeline without adding a local user-message row. It intentionally does not call Pi's native `compact()` RPC: DCP owns candidate selection, generated summaries, compression blocks, journal persistence, and stale-plan transaction guards.
- When the active model/provider exposes account quota data, the status bar shows hourly and/or weekly remaining percentages with compact horizontal tracks and reset countdowns.
- Model-limit color thresholds match the TUI: below 20% remaining is error, below 50% remaining is warning, otherwise success. The TUI long-window projected-exhaustion warning heuristic is retained.
- Clicking the model-limit control forces a fresh quota request. Normal model-quota refresh happens when the active runtime/model changes and every five minutes.
- Context and DCP data refresh after each completed prompt without forcing a quota network request.
- A failed quota refresh retains the previously displayed quota snapshot; an explicit unavailable/unsupported result clears it.
- Quota refreshes are tracked with a generation independent of snapshot (context/DCP) refreshes: a concurrent non-quota snapshot refresh must not invalidate a successful in-flight quota refresh; only a newer quota refresh supersedes an in-flight one.
- Runtime status is scoped per Desktop session and is cleared when that runtime is forgotten or the ACP connection is reset.
- The same status-bar chrome also hosts the separate Session activity entry/HUD. Session Plan/Subagent counts come from pushed session-state snapshots rather than the runtime-status request, so opening or updating that HUD does not add quota/context polling.

## Protocol bridge

- Desktop uses the private `pix/session/runtime_status` ACP request.
- The request accepts `sessionId` plus `refreshModelUsage`; when the latter is false ACP skips provider quota I/O.
- ACP obtains context usage from Pi's public `getSessionStats()` response.
- DCP details are formatted by the shared Pix TUI DCP formatter against the persisted Pi session using `SessionManager`, avoiding a second Desktop-specific DCP implementation.
- Manual compression reuses the DCP extension's `/dcp compress` entrypoint; no additional Desktop-only compression protocol is introduced.
- Model quota refresh reuses the shared Pix model-usage module, including provider auth/refresh behavior.
- The response marks model-usage refresh as `skipped`, `ready`, `unavailable`, or `failed` so Desktop can distinguish stale-preserving transient failures from unsupported/unavailable quota data.

## Related files

- `src/app/rendering/dcp-stats.ts`
- `src/app/model/model-usage-status.ts`
- `src/context-progress-bar.ts`
- `acp/src/acp/desktop-commands.ts`
- `acp/src/acp/pix-acp-agent.ts`
- `desktop/src/lib/acp-client.ts`
- `desktop/src/lib/runtime-status.ts`
- `desktop/src/App.svelte`
- `desktop/src/components/StatusBar.svelte`
- `desktop/src/components/RuntimeStatusBarItems.svelte`

## Verification

- ACP tests cover the private runtime-status request and context-usage response without quota refresh.
- ACP tests assert that `/dcp compress` remains extension-owned and never falls through to native Pi context compaction.
- Desktop ACP-client tests cover request shape and response validation for context, DCP text, and quota windows.
- Desktop helper tests cover TUI threshold parity, reset formatting, compact token formatting, and projected-exhaustion warning behavior.
- Desktop helper tests cover the refresh-generation race: a non-quota snapshot refresh that settles first must not discard a successful in-flight quota refresh, while a newer quota refresh still supersedes an older in-flight one.
- Desktop `check` and `build:web`, ACP typecheck/tests, and focused Desktop tests pass.

## Risks / compatibility

- DCP statistics depend on a persisted Pi session file. Before persistence exists, or if the shared Pix formatter is unavailable in a standalone ACP build, Desktop still receives context usage but the DCP popover reports telemetry as unavailable.
- Quota providers may fail because of network/auth state. Such failures are intentionally best-effort status-chrome concerns and do not fail the active chat session.
