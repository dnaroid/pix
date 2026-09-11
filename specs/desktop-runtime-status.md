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
- DCP telemetry is loaded only when that popover is opened. Periodic/model/context status refreshes never traverse the DCP branch, and an already-loaded DCP snapshot is preserved across those refreshes.
- The popover opens immediately while its telemetry request is in flight and shows a compact loading state; DCP loading never gates the rest of the workbench.
- The DCP popover remains technical and compact, uses semantic Desktop popover/chrome tokens, supports text selection, closes on outside pointer interaction or Escape, and does not block the rest of the workbench.
- The DCP popover exposes a compact `Compress` action when the runtime advertises the `/dcp` extension command and the session is idle. While compression is running the control shows a busy state and cannot be invoked again.
- The action runs the existing `/dcp compress` command through the normal Desktop prompt pipeline without adding a local user-message row. It intentionally does not call Pi's native `compact()` RPC: DCP owns candidate selection, generated summaries, compression blocks, journal persistence, and stale-plan transaction guards.
- When the active model/provider exposes account quota data, the status bar shows hourly and/or weekly remaining percentages with compact horizontal tracks and reset countdowns.
- Model-limit color thresholds match the TUI: below 20% remaining is error, below 50% remaining is warning, otherwise success. The TUI long-window projected-exhaustion warning heuristic is retained.
- Clicking the model-limit control forces a fresh quota request. Normal model-quota refresh happens when the active runtime/model changes and every five minutes.
- Antigravity quota refresh is also keyed by the active thinking level because current versioned Gemini Flash models can route to tier-specific Google model keys (for example `gemini-3.8-flash-high` for `xhigh`). Changing thinking therefore refreshes quota immediately instead of waiting for the periodic poll.
- Antigravity live quota lookup prefers the public quota bucket, then the active tier route when Google exposes quota only on that route. A rejected saved access token is refreshed through the configured Google OAuth client and retried before quota is considered unavailable; the project id carried by the live access credential is retained for the quota request.
- Antigravity quota auth resolves the same Pi agent directory and OAuth-client environment fallbacks as the provider itself, while provider-observed cached shared Flash quota remains a fallback for current versioned Flash models, including when a successful live response omits the active current-route quota bucket.
- Antigravity quota lookup uses the same Pi agent directory and OAuth-client environment contract as the Antigravity provider (`getAgentDir()` / `PI_CODING_AGENT_DIR` and `PI_ANTIGRAVITY_GOOGLE_CLIENT_*`). Current versioned Flash models (3.5–3.8) may use the shared cached `gemini-flash` quota bucket when an exact versioned bucket is not present.
- Context data refreshes after each completed prompt without forcing a quota network request. DCP data refreshes on the next popover open instead of running in the post-turn hot path.
- A failed quota refresh retains the previously displayed quota snapshot; an explicit unavailable/unsupported result clears it.
- Quota refreshes are tracked with a generation independent of snapshot (context/DCP) refreshes: a concurrent non-quota snapshot refresh must not invalidate a successful in-flight quota refresh; only a newer quota refresh supersedes an in-flight one.
- Concurrent quota refresh requests for the same Desktop session/model/thinking route share one ACP-side provider query. Desktop generation guards still decide which response may update visible state, so deduplication removes redundant network I/O without weakening stale-response protection.
- DCP requests have their own per-session generation guard so a late response from a forgotten/reloaded runtime cannot overwrite the current session snapshot.
- Runtime status is scoped per Desktop session and is cleared when that runtime is forgotten or the ACP connection is reset.
- The same status-bar chrome also hosts the separate Session activity entry/HUD. Session Plan/Subagent counts come from pushed session-state snapshots rather than the runtime-status request, so opening or updating that HUD does not add quota/context polling.

## Protocol bridge

- Desktop uses the private `pix/session/runtime_status` ACP request.
- The request accepts `sessionId` plus `refreshModelUsage`; when the latter is false ACP skips provider quota I/O.
- ACP obtains context usage from Pi's public `getSessionStats()` response.
- DCP details use a separate private `pix/session/dcp_stats` request. ACP gets the active session tree through Pi's async `getTree()` RPC, derives the active branch in memory, and passes that branch into the shared Pix TUI DCP formatter. This avoids synchronous full-JSONL traversal in the ACP event loop while still keeping one DCP formatting implementation.
- Manual compression reuses the DCP extension's `/dcp compress` entrypoint; no additional Desktop-only compression protocol is introduced.
- Model quota refresh reuses the shared Pix model-usage module, including provider auth/refresh behavior.
- The response marks model-usage refresh as `skipped`, `ready`, `unavailable`, or `failed` so Desktop can distinguish stale-preserving transient failures from unsupported/unavailable quota data.

## Related files

- `src/app/rendering/dcp-stats.ts`
- `src/app/model/model-usage-controller.ts`
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
- ACP tests cover on-demand DCP loading, assert periodic runtime status never asks Pi for the session tree, and verify that two concurrent quota refresh requests for one session/model/thinking route execute one provider query.
- ACP tests assert that `/dcp compress` remains extension-owned and never falls through to native Pi context compaction.
- Desktop ACP-client tests cover independent runtime-status and DCP request shapes plus response validation for context, DCP text, and quota windows.
- Desktop helper tests cover TUI threshold parity, reset formatting, compact token formatting, and projected-exhaustion warning behavior.
- Desktop helper tests cover the refresh-generation race: a non-quota snapshot refresh that settles first must not discard a successful in-flight quota refresh, while a newer quota refresh still supersedes an older in-flight one.
- Desktop helper tests assert that periodic snapshots preserve lazily loaded DCP telemetry.
- Shared DCP formatter tests assert that an injected active branch bypasses synchronous session-file reads.
- Shared model-usage tests cover Antigravity tier-specific `Gemini 3.8 Flash` quota keys, thinking-level refresh, rejected-access refresh/retry, access credential project ids, configured Pi agent directories, OAuth-client environment credentials, and cached Flash fallback.
- Shared model-usage tests cover current Antigravity Flash quota fallback, custom Pi agent directories, and Antigravity OAuth client credentials supplied through the provider environment contract.
- Desktop `check` and `build:web`, ACP typecheck/tests, and focused Desktop tests pass.

## Risks / compatibility

- If Pi cannot provide the active tree, or if the shared Pix formatter is unavailable in a standalone ACP build, Desktop still receives context usage and quota status while the DCP popover reports telemetry as unavailable.
- Quota providers may fail because of network/auth state. Such failures are intentionally best-effort status-chrome concerns and do not fail the active chat session.
