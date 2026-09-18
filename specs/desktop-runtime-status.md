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
- Hovering the context control shows absolute context tokens/current window plus the live DCP `tokensSaved` estimate when DCP is active (for example `128K / 200K tokens · DCP saved ~24,680 tokens`). The hover deliberately does not repeat the context percentage already visible in the status bar. The saved value is the extension's running estimate of context removed by pruning/compression, not the durable statistics report's measured commit gain and not a billing counter.
- Clicking the context control opens a non-modal DCP statistics popover above the status bar. It uses the same DCP statistics formatter and session-journal/tool-result data as the TUI.
- The shared report follows [dcp-statistics.md](./dcp-statistics.md): durable blocks and measured commit gains, dated model/budget snapshots, and recorded reminder attempts/completions are separate. Missing instrumentation or failed full-history reads remain unknown; the former compliance proxy is not shown.
- Durable DCP statistics are loaded only when that popover is opened. Periodic/model/context status refreshes never traverse the DCP branch, and an already-loaded durable report is preserved across those refreshes. The lightweight prepared-projection map described below travels with existing session-stat samples and does not load that report.
- The popover opens immediately while its telemetry request is in flight and shows a compact loading state; DCP loading never gates the rest of the workbench.
- The DCP popover remains technical and compact, uses semantic Desktop popover/chrome tokens, supports text selection, closes on outside pointer interaction or Escape, and does not block the rest of the workbench.
- The DCP popover exposes a compact `Compress` action when the runtime advertises the `/dcp` extension command and the session is idle. While compression is running the control shows a busy state and cannot be invoked again.
- The action runs the existing `/dcp compress` command through the normal Desktop prompt pipeline without adding a local user-message row. It intentionally does not call Pi's native `compact()` RPC: DCP owns candidate selection, generated summaries, compression blocks, journal persistence, and stale-plan transaction guards.
- When the active model/provider exposes account quota data, the status bar shows hourly and/or weekly remaining percentages with compact horizontal tracks and reset countdowns.
- Model-limit color thresholds match the TUI: below 20% remaining is error, below 50% remaining is warning, otherwise success. The TUI long-window projected-exhaustion warning heuristic is retained.
- Clicking the model-limit control forces a fresh quota request. Normal model-quota refresh happens when the active runtime/model changes and every five minutes.
- The model-limit `Usage` control remains enabled while a prompt is running and while a quota refresh is already in flight. Overlapping refreshes are handled by the existing Desktop generation guards and ACP single-flight provider query rather than by disabling the status-bar control.
- Between the context and model-limit controls, Desktop shows the same workspace identity as the TUI: the project directory basename followed by the current Git branch in parentheses. The project name uses the configured/deterministic project identity color, the branch remains muted, and detached HEAD omits the branch label. Hovering that project/branch identity shows the full workspace path. Desktop refreshes this branch through a lightweight local Git command on workspace activation/switch and every 30 seconds, matching the TUI branch-cache cadence without running the full Source Control status query.
- A UI-only New Conversation draft has no runtime context/DCP state, but its status bar still shows the workspace project/branch identity. It also shows quota windows for the draft's currently staged model/thinking selection when that provider exposes usage data.
- Draft quota is loaded through the existing sessionless draft-config path and never allocates an ACP/Pi session. Changing the staged model or thinking level invalidates the previous draft quota and starts a best-effort refresh for the new route; an explicit refresh keeps the last successful snapshot visible until its replacement settles.
- Antigravity quota refresh is also keyed by the active thinking level because legacy per-model fallback can route current versioned Gemini Flash models to tier-specific Google model keys (for example `gemini-3.8-flash-high` for `xhigh`). Changing thinking therefore refreshes quota immediately instead of waiting for the periodic poll.
- Antigravity live quota lookup now prefers `retrieveUserQuotaSummary` on the current native agy transport (`daily-cloudcode-pa.googleapis.com` then prod, agy CLI 1.1.24 User-Agent, gzip). The explicit Google `5h` and `weekly` buckets are mapped directly to status-bar windows instead of inferring a window type from time remaining until reset.
- For multi-account Antigravity auth, the `Σ` status is the mean remaining quota across every account that returned the same explicit window; its countdown uses the nearest reset in that pool. This keeps account rotation capacity visible instead of reporting only the currently active account.
- A rejected saved Antigravity access token is refreshed through the configured/stored Google OAuth client and retried. If the summary API is unavailable, the lookup falls back to native-header `fetchAvailableModels`, then to provider-observed cached quota; current versioned Flash models may use the shared cached `gemini-flash` bucket when an exact route is absent.
- Antigravity quota lookup uses the configured Pi agent directory (`getAgentDir()` / `PI_CODING_AGENT_DIR`) and `PI_ANTIGRAVITY_GOOGLE_CLIENT_*` environment credentials in addition to OAuth-client metadata already stored with the provider account.
- Context data is primarily event-driven: ACP pushes a lightweight `pix/session-state` `context-usage` snapshot after Pi `message_end` boundaries and after successful compaction. The same sampled Pi session-stats response also pushes `dcp-tokens-saved`, so the hover estimate advances on the same trustworthy boundaries without an extra RPC. Streaming deltas do not trigger context/DCP-savings polling, so long tool/model loops update between messages without waiting for the whole prompt to settle. Extension slash commands handled entirely in input preflight get one equivalent boundary snapshot because they may mutate context without emitting agent/message lifecycle events.
- The old post-prompt context-only `runtime_status` request is not needed once push updates are active. Runtime activation still loads an initial status snapshot, and the five-minute quota refresh remains as periodic reconciliation while refreshing model limits.
- After successful compaction ACP immediately pushes Pi's post-compaction context state. When Pi reports context tokens as unknown until the next valid assistant response, Desktop shows that unknown state instead of retaining a stale pre-compaction percentage. DCP data refreshes on the next popover open instead of running in the compaction/post-turn hot path.
- A failed quota refresh retains the previously displayed quota snapshot; an explicit unavailable/unsupported result clears it.
- Quota refreshes are tracked with a generation independent of snapshot (context/DCP) refreshes: a concurrent non-quota snapshot refresh must not invalidate a successful in-flight quota refresh; only a newer quota refresh supersedes an in-flight one.
- Concurrent quota refresh requests for the same Desktop session/model/thinking route share one ACP-side provider query. Desktop generation guards still decide which response may update visible state, so deduplication removes redundant network I/O without weakening stale-response protection.
- DCP requests have their own per-session generation guard so a late response from a forgotten/reloaded runtime cannot overwrite the current session snapshot. Runtime-status generations retain a monotonic tombstone on forget; a reset lifecycle generation invalidates both status and DCP responses and their busy-state cleanup, even when the same session and client are reused. Stale status responses cannot recreate a missing snapshot.
- Runtime status is scoped per Desktop session and is cleared when that runtime is forgotten or the ACP connection is reset.
- The same status-bar chrome also hosts the separate Session activity entry/HUD. Session Plan/Subagent counts come from pushed session-state snapshots rather than the runtime-status request, so opening or updating that HUD does not add quota/context polling.
- The Session inspector begins with **one** compact, fixed-size context-capacity map, grouped by token volume rather than message order/count. Total occupied/free capacity comes only from the already-held live SDK `tokens` and positive `contextWindow` denominator; the separately reported percentage is not a denominator. Invalid or unknown context produces unknown cells rather than invented free capacity, and over-capacity samples fill the bounded map while retaining their actual textual percentage. Opening the inspector does not request telemetry. Live `tokensSaved`, block state, last input/projection reduction, and measured commit gain remain distinct textual metrics; durable fields still appear only after the existing on-demand statistics request.
- Within occupied capacity, DCP category volumes are explicitly **approximate**, from a dated **last prepared DCP projection** carrying a runtime revision and owner epoch. The producer partitions current projected-message token estimates into mutually exclusive categories, with incomplete-tool-group protection taking precedence over selected candidate, then active summary, then retained. Candidate is advisory compression guidance, not all eligible content or permission to delete. Compressed means the current summary's size, never the removed original's size. Retained includes other content, not proven-safe content. Historical savings cannot manufacture candidate volumes.
- The map fits those estimates to SDK occupancy: when their total exceeds observed occupied tokens all estimates scale down uniformly; otherwise the unclassified occupied remainder (including system/tool overhead) joins retained/other. Free capacity still comes from SDK usage, not the DCP estimate. Small category shares remain represented within split cells. A missing/invalid DCP snapshot leaves occupied capacity unclassified, not falsely reporting zero candidates. Missing SDK capacity prevents drawing token proportions even when DCP estimates are available.
- Session inspector DCP, Agents, and Plan sections are independently collapsible native `<details>` accordions. DCP starts expanded; Plan and Agents default to collapsed when empty and expanded when their first available snapshot contains visible activity. A manual toggle takes precedence over a late first snapshot. Ordinary snapshot updates preserve browser-owned open state; switching sessions resets the section defaults. Their compact summary headers show context occupancy/DCP savings, active-agent count, and plan completion progress. Native summary semantics retain keyboard access without polling or telemetry loads.

The inspector grid fills occupied content from the top-left in reading order,
with free capacity last; its legend follows the same category order. The pane
does not show an instruction to open the status-bar statistics popover when
journal details have not been loaded. The popover remains available independently.

## Protocol bridge

- Desktop uses the private `pix/session/runtime_status` ACP request.
- The request accepts `sessionId` plus `refreshModelUsage`; when the latter is false ACP skips provider quota I/O.
- ACP obtains context usage from Pi's public `getSessionStats()` response. Pix's RPC entry augments that response with the DCP extension's live `state.tokensSaved` estimate and cached prepared-projection map when available; a process-local symbol bridge keeps full DCP state private. Reading the bridge does not scan history, recompute candidates, invoke a model, or mutate pruning/compression state. Map production reuses the existing context pass and already-selected candidate.
- Live context changes use the existing private `pix/session-state` notification transport with channel `context-usage`; the payload is Pi's context-usage object (or `null` when unavailable). The same sample is sent on `dcp-tokens-saved` as a non-negative integer (or `null` when DCP is unavailable). ACP samples `getSessionStats()` only at message/compaction boundaries, never for streaming text/thinking deltas.
- A pushed context snapshot advances Desktop's snapshot generation so an older in-flight `runtime_status` response cannot overwrite newer context. An in-flight quota refresh keeps its independent quota generation and may still merge its model-limit fields.
- The same sampled response carries `dcpContextMap` and pushes `dcp-context-map` on the existing session-state transport. Its payload is bounded scalar metadata: positive safe revision, nonnegative safe owner epoch, valid preparation timestamp, and four nonnegative safe integer `tokenEstimates` (`candidate`, `protected`, `compressed`, `retained`) with a positive safe total. Invalid/missing telemetry is explicitly unavailable; transport boundaries allowlist fields. No message bodies or range arrays travel to the UI. Older epoch/revision pushes are ignored; accepted pushes invalidate older pending snapshot responses. Owner changes, reset and shutdown invalidate cached telemetry and prevent stale context passes republishing it.
- DCP details use a separate private `pix/session/dcp_stats` request. ACP gets the active session tree through Pi's async `getTree()` RPC, derives the active branch in memory, and passes that branch into the shared Pix TUI DCP formatter. This avoids synchronous full-JSONL traversal in the ACP event loop while still keeping one DCP formatting implementation.
- Manual compression reuses the DCP extension's `/dcp compress` entrypoint; no additional Desktop-only compression protocol is introduced.
- Model quota refresh reuses the shared Pix model-usage module, including provider auth/refresh behavior.
- The response marks model-usage refresh as `skipped`, `ready`, `unavailable`, or `failed` so Desktop can distinguish stale-preserving transient failures from unsupported/unavailable quota data.
- The private sessionless `pix/session/draft_config` request may additionally carry the staged `modelRef`, `thinkingLevel`, and `refreshModelUsage=true`. Its response returns the same model-usage refresh/status shape used by runtime status while remaining workspace-scoped and sessionless.

## Related files

- `external/pi-tools-suite/src/dcp/index.ts`
- `src/app/rendering/dcp-stats.ts`
- `src/app/model/model-usage-controller.ts`
- `src/app/model/model-usage-status.ts`
- `src/context-progress-bar.ts`
- `acp/src/pi/pix-rpc-entry.js`
- `acp/src/pi/pi-rpc-client.ts`
- `acp/src/acp/desktop-commands.ts`
- `acp/src/acp/pix-acp-agent.ts`
- `desktop/src/lib/acp-client.ts`
- `desktop/src/lib/acp-client-types.ts`
- `desktop/src/lib/acp-response-parsers.ts`
- `desktop/src/lib/session-state.ts`
- `desktop/src/lib/acp-pix-extensions.ts`
- `desktop/src/lib/runtime-status.ts`
- `desktop/src/app/session-runtime-status.svelte.ts`
- `desktop/src/app/session-coordinator.ts`
- `desktop/src/app/desktop-status-bar-view-model.svelte.ts`
- `desktop/src/components/StatusBar.svelte`
- `desktop/src/components/RuntimeStatusBarItems.svelte`

## Verification

- ACP tests cover the private runtime-status request with context usage plus live DCP saved-token estimate and no quota refresh.
- ACP tests cover event-driven context/saved-token notifications after message/successful-compaction boundaries and preflight-handled slash commands, and assert that streaming deltas do not sample session stats.
- Pix RPC-entry tests pin the process-local DCP saved-token bridge into `getSessionStats()`.
- ACP tests cover on-demand DCP loading, assert periodic runtime status never asks Pi for the session tree, and verify that two concurrent quota refresh requests for one session/model/thinking route execute one provider query.
- ACP tests assert that `/dcp compress` remains extension-owned and never falls through to native Pi context compaction.
- Desktop ACP-client tests cover independent runtime-status and DCP request shapes plus response validation for context, DCP text, and quota windows.
- Desktop/ACP draft-config tests cover selected-model/thinking quota requests without a session id, and source-level status-bar coverage keeps project/branch plus draft quota visible without rendering fake context chrome.
- Desktop helper tests cover TUI threshold parity, reset formatting, compact token formatting, projected-exhaustion warning behavior, and bounded DCP map derivation for zero, unknown, over-capacity, fractional, and updated live-context samples.
- Desktop visual regression tests cover native Session inspector accordions, their summary metrics, first-snapshot defaults, and the absence of reactive `open` bindings that could reset user choices on updates. Activity-policy tests cover first-display reconciliation and late activity snapshots.
- Runtime-status lifecycle tests exercise deferred completions across forget/reopen and reset, including stale DCP/status responses and busy-state cleanup.
- Token-map tests cover exclusive category allocation, current-summary estimates, cached getters and stale preparation/shutdown completion, malformed scalar metadata, minority split-cell shares, unavailable classification, and under/over-estimated occupancy without inventing free capacity.
- Desktop helper tests cover the refresh-generation race: a non-quota snapshot refresh that settles first must not discard a successful in-flight quota refresh, while a newer quota refresh still supersedes an older in-flight one.
- Desktop helper tests cover pushed-context and pushed-DCP-savings merging; an updated scalar must preserve context, quota and lazily loaded DCP detail text.
- Desktop helper tests assert that periodic snapshots preserve lazily loaded DCP telemetry.
- Shared DCP formatter tests assert that an injected active branch bypasses synchronous session-file reads.
- Shared model-usage tests cover Antigravity tier-specific `Gemini 3.8 Flash` quota keys, thinking-level refresh, rejected-access refresh/retry, access credential project ids, configured Pi agent directories, OAuth-client environment credentials, and cached Flash fallback.
- Shared model-usage tests cover current Antigravity Flash quota fallback, custom Pi agent directories, and Antigravity OAuth client credentials supplied through the provider environment contract.
- Desktop `check` and `build:web`, ACP typecheck/tests, and focused Desktop tests pass.

## Risks / compatibility

- If Pi cannot provide the active tree, or if the shared Pix formatter is unavailable in a standalone ACP build, Desktop still receives context usage and quota status while the DCP popover reports telemetry as unavailable.
- Quota providers may fail because of network/auth state. Such failures are intentionally best-effort status-chrome concerns and do not fail the active chat session.
