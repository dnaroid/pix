# Session usage and billing accounting

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Give Pix TUI and Desktop one session-spend view that reports recorded billable
usage, includes async sub-agents, and does not confuse account-wide quota
percentages with spend attributable to one conversation.

## Accounting

- Session spend is the sum of recorded billable calls in the persisted session,
  including abandoned/forked branches. Rewinding conversation ancestry does not
  undo provider billing, so a spend view must not hide calls merely because they
  are no longer on the active branch.
- Normal assistant-message `usage`, explicit session `usage` entries, and usage
  attached to compaction/branch-summary/tool-result entries participate when
  present. Provider/model attribution comes from assistant or explicit usage
  records; usage without that identity remains `Unattributed` rather than being
  guessed.
- Totals expose recorded input/output/cache token counters and total tokens.
  Monetary totals normally use the recorded `cost.total` already stored by Pi.
  For `pi-claude-code-provider` calls with zero/missing cost, known original
  Anthropic model tariffs estimate API-equivalent spend from separate input,
  output, cache-read and cache-write counters (including one-hour cache writes).
  Positive recorded cost is never replaced. Other providers, unknown models and
  total-token-only records are not repriced; persisted entries are not modified.
  Explicit original model IDs use their exact SDK catalog entry. Subscription
  aliases use the bridge's current defaults: `opus` → `claude-opus-5-5`,
  `sonnet` → `claude-sonnet-5`, `fable` → `claude-fable-5-1`, and
  `haiku` → `claude-haiku-4-5`. Historical alias calls cannot prove their served
  version and therefore remain estimates using these defaults.
- The breakdown groups recorded/estimated spend first by provider and then by model.
  Each model row owns its combined token/cost totals regardless of whether a
  call came from the parent agent, an async sub-agent, a retry, or a fallback.

## Async sub-agents

- Every finalized child assistant `message_end` carries provider/model/usage.
  The async-subagents runner mirrors that usage into the originating parent
  session through Pi's durable `appendUsage` entry with kind `async-subagent` and
  an agent-id note.
- The originating parent session manager is captured by the tool invocation and
  owns the usage append. A background agent finishing after a tab/session switch
  must never charge the newly active session.
- Retries and model/provider fallbacks are intentionally counted per finalized
  child assistant call; each provider call was billable even if a later retry or
  fallback ultimately produced the accepted result.

## UI behavior

The experimental [Heads up observer](heads-up-observer.md) also records finalized
side-inference usage in the originating session, using the `heads-up` usage kind.
A dismissed or stale finding does not erase the request's usage. Provider
failures that return no usage cannot be reconstructed. Its model rows participate
in the same provider/model breakdown; its own status additionally reports check
and token counters without estimating subscription quota.

- In Pix TUI, clicking `Usage` opens session usage. Desktop opens it only on
  button activation (click, Enter or Space), not hover or mere focus. Neither
  forces a provider quota refresh. See [status-bar click popups](../docs/decisions/0048-status-bar-click-popups.md).
  Desktop keeps the panel open after pointer departure. Repeat activation closes
  it without another spend request; Escape, outside pointer interaction or focus
  leaving the trigger/panel region also dismiss it. Escape restores trigger focus.
- The session detail remains intentionally compact and does not split parent-agent
  and sub-agent consumption into separate presentation rows; both are one session.
  Desktop keeps recorded cost in its on-demand detail popover, but does not show a
  dollar amount inline in the status bar. TUI shows token totals only and does not
  render monetary prices.
  Desktop displays monetary values without an approximation prefix; estimated
  model values explain in a tooltip that these are original-model API rates, not
  subscription charges. `costEstimated` propagates from calls to model, provider
  and session totals through ACP.
  Known subscription provider headings offer an accessible external-link icon:
  Claude Code opens `https://claude.ai/code#settings/usage`; OpenAI Codex opens
  `https://chatgpt.com/codex/cloud/settings/analytics#usage`; z.ai (`zai`) opens
  `https://z.ai/manage-apikey/coding-plan/personal/usage`. Unknown providers get no guessed URL.
  The native external opener launches the page in the system browser, without
  refreshing quota or making a model call. Failed opening shows a retryable error.
- Model labels use the same model-color conventions as the rest of Pix. TUI
  honors configured `modelColors` rules with the normal provider-palette
  fallback; Desktop uses its matching model-ref tone mapping and shows the
  shared provider glyph beside each recognized provider heading.
- Desktop loads the spend report on demand through `pix/session/usage`; TUI reads
  the owning session's complete persisted entries on demand. Opening the popup
  does not start a model request and does not refresh provider quota.
- For an active Claude Code provider session, Desktop also offers an explicit
  `Refresh limits` action in this popover. This action is separate from opening
  Usage and from recorded session spend; it nudges a bounded headless Claude
  CLI, then queries Pix's quota endpoint and updates the independent status-bar
  limits. It never interprets CLI output as billable usage or quota.
- Active TUI/Desktop sessions expose `Usage` even when their provider has no
  quota API, because recorded session spend does not depend on quota support.
- Desktop marks session spend requestable only after that session's Pi runtime is
  ready. If the popover was opened during runtime warm-up, it starts the request
  when readiness arrives instead of leaving an ambiguous unloaded state. A failed
  first load is shown as an explicit retryable error; if an older successful
  snapshot already exists, that snapshot remains visible after a refresh failure.
- A Desktop UI-only draft has no session spend and the session-spend popup does
  not manufacture quota-only content for it.

## Quota percentages

- Current provider quota APIs do not provide a reliable mapping from recorded
  per-model token/cost usage to account quota percentage points, nor do they
  identify which concurrent session consumed those points.
- The recorded-spend breakdown shows no quota percentages and no synthetic
  provider/session-share percentage. Desktop's shared Usage surface additionally
  shows a separately labelled **Account quota · Weekly** reset calendar when
  the active provider supplies a weekly window. This is account-wide telemetry,
  never session-attributed usage. See [quota reset calendar](desktop-quota-calendar.md)
  and [decision 0039](../docs/decisions/0039-quota-reset-calendar.md), which supersede
  the former no-account-quota-block rule for this explicitly separated section.
  Session-attributed values are recorded token totals and recorded/estimated
  model costs, not an allocation of subscription quota or payment.
- Existing hourly/weekly account quota polling and status-bar indicators remain
  independent runtime chrome; opening the session-spend popup never refreshes
  them. The weekly calendar uses the existing runtime snapshot, not a new request.

## Lifecycle and concurrency

- Desktop session-usage requests have a per-session generation guard independent
  of runtime-status, quota, and DCP generations. Forget/reset invalidates stale
  completions and their busy-state cleanup; an old request cannot repopulate a
  reopened session.
- TUI waits for the full-session read and validates the captured session owner
  and tab lifecycle before showing a dialog. Stale completion is discarded.
- Loaded Desktop spend snapshots are scoped to their session and cleared when
  that runtime is forgotten or the ACP connection resets.
- Running async sub-agents do not intentionally disable session-usage reads.
  Usage already durably mirrored into the parent session remains readable; a
  child call that has not finalized yet is not counted until its usage entry is
  appended.

## Protocol

- `pix/session/usage` accepts `{ sessionId }` and returns `{ sessionId, usage }`.
- ACP reads Pi's persisted entries with the flat append-order `getEntries()` RPC
  and runs the shared Pix session-usage aggregator over all of them. It does not
  ask a quota provider or synchronously traverse the JSONL file, and it avoids
  the nested `get_tree` response, which cannot be JSON-serialized once a linear
  session chain grows past the RPC process stack limit.

## Related files

- `src/app/session/session-usage.ts`
- `src/app/session/session-usage-pricing.ts`
- `src/app/screen/mouse-controller.ts`
- `src/app/model/model-usage-controller.ts`
- `external/pi-tools-suite/src/async-subagents/core/usage.ts`
- `external/pi-tools-suite/src/async-subagents/tools/spawn.ts`
- `acp/src/acp/desktop-commands.ts`
- `acp/src/acp/pix-acp-agent.ts`
- `desktop/src/lib/acp-client.ts`
- `desktop/src/lib/acp-client-types.ts`
- `desktop/src/lib/acp-response-parsers.ts`
- `desktop/src/lib/session-usage.ts`
- `desktop/src/app/session-runtime-status.svelte.ts`
- `desktop/src/components/RuntimeStatusBarItems.svelte`

## Verification

- Shared unit tests cover provider/model grouping, merging parent and async-agent
  calls into one model total, unattributed usage, and the compact formatter.
  `tests/session-usage.test.ts` also covers proxy aliases, explicit original IDs,
  separate cache tariffs, one-hour writes, estimate propagation, preservation of
  positive cost/unknown models/other providers, and immutable persisted records.
- TUI mouse tests assert that Usage opens the compact colored token breakdown and
  contains no monetary price, agent/subagent split, session-share percentage, or
  quota block.
- Async-subagents tests validate child `message_end` extraction and durable usage
  append on the captured parent manager.
- Desktop ACP-client and runtime lifecycle tests cover the independent usage
  request and stale forget/reset completion handling.
- Desktop visual regression tests pin the Usage popover and the absence of the
  former click-to-refresh interaction.

## Risks / compatibility

- Old sessions created before async-agent usage mirroring cannot reconstruct
  exact historical child-agent cost unless that usage was already persisted by
  another mechanism. Pix reports what is recorded; it does not invent missing
  historical spend.
- Providers may report zero monetary cost while still reporting tokens. Only the
  known Claude Code proxy uses the documented API-equivalent estimate fallback;
  it is not the actual subscription bill. TUI presentation remains token-only.
