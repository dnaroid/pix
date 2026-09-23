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
- Exact totals expose input/output/cache token counters, total tokens, and the
  provider-reported monetary `cost.total` already stored by Pi.
- The breakdown groups exact recorded spend first by provider and then by model.
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

- In both Pix TUI and Desktop, clicking `Usage` opens session usage instead of
  forcing a provider quota refresh.
- The session detail remains intentionally compact and does not split parent-agent
  and sub-agent consumption into separate presentation rows; both are one session.
  Desktop keeps recorded cost in its on-demand detail popover, but does not show a
  dollar amount inline in the status bar. TUI shows token totals only and does not
  render monetary prices.
- Model labels use the same model-color conventions as the rest of Pix. TUI
  honors configured `modelColors` rules with the normal provider-palette
  fallback; Desktop uses its matching model-ref tone mapping.
- Desktop loads the spend report on demand through `pix/session/usage`; TUI reads
  the owning session's complete persisted entries on demand. Opening the popup
  does not start a model request and does not refresh provider quota.
- Active TUI/Desktop sessions expose `Usage` even when their provider has no
  quota API, because recorded session spend does not depend on quota support.
- A Desktop UI-only draft has no session spend and the session-spend popup does
  not manufacture quota-only content for it.

## Quota percentages

- Current provider quota APIs do not provide a reliable mapping from recorded
  per-model token/cost usage to account quota percentage points, nor do they
  identify which concurrent session consumed those points.
- The session-spend popup therefore shows **no account quota block and no quota
  percentages**. It also shows no synthetic provider/session-share percentage.
  Exact session-attributed values are the recorded model token/cost totals.
- Existing hourly/weekly account quota polling and status-bar indicators remain
  independent runtime chrome; opening the session-spend popup never refreshes
  them and the popup does not repeat them.

## Lifecycle and concurrency

- Desktop session-usage requests have a per-session generation guard independent
  of runtime-status, quota, and DCP generations. Forget/reset invalidates stale
  completions and their busy-state cleanup; an old request cannot repopulate a
  reopened session.
- TUI waits for the full-session read and validates the captured session owner
  and tab lifecycle before showing a dialog. Stale completion is discarded.
- Loaded Desktop spend snapshots are scoped to their session and cleared when
  that runtime is forgotten or the ACP connection resets.

## Protocol

- `pix/session/usage` accepts `{ sessionId }` and returns `{ sessionId, usage }`.
- ACP reads Pi's in-memory session tree with `getTree()`, traverses all persisted
  entries, and runs the shared Pix session-usage aggregator. It does not ask a
  quota provider or synchronously traverse the JSONL file.

## Related files

- `src/app/session/session-usage.ts`
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
- Providers may report zero monetary cost while still reporting tokens; accounting
  keeps that recorded cost even though TUI presentation is token-only.
