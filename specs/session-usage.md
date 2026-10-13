---
kind: spec
status: active
---

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
  a versioned JSON note containing `runDir` and `agentId`. Legacy `agent:<id>`
  notes remain readable.
- The originating parent session manager is captured by the tool invocation and
  owns the usage append. A background agent finishing after a tab/session switch
  must never charge the newly active session.
- Retries and model/provider fallbacks are intentionally counted per finalized
  child assistant call; each provider call was billable even if a later retry or
  fallback ultimately produced the accepted result.
- The runner also appends version-1 `pi-tools-suite:subagent-statistics` custom
  entries on that captured parent manager: task preview (id, role, icon, requested
  model, task and scope), tool execution starts (name), and terminal state.
  Optional telemetry failures must not interrupt execution or billing. No tool
  arguments/results or child transcript are copied. Tool counts are starts,
  including failed/cancelled calls, not successful completions.
- Durable statistics group by `(runDir, agentId)` rather than agent id alone.
  Earlier spawn tool-result previews may recover task metadata. Legacy id-only
  usage matches a unique known run, or remains a legacy id row when no run is
  known. Ambiguous/missing notes are included in child-unattributed totals;
  missing billing and tool telemetry are shown as unknown, never invented zeros.
  Status/lookups of other runs do not make those runs part of this session.

## UI behavior

The experimental [Heads up observer](heads-up-observer.md) also records finalized
side-inference usage in the originating session, using the `heads-up` usage kind.
A dismissed or stale finding does not erase the request's usage. Provider
failures that return no usage cannot be reconstructed. Its model rows participate
in the same provider/model breakdown; its own status additionally reports check
and token counters without estimating subscription quota.

The temporary [Desktop BTW chat](desktop-btw.md) records finalized side-response
usage with the `btw` kind in its original parent session. It does not persist side
questions/answers. Cancelled or discarded results still count when the provider
returns usage; calls without usage cannot be reconstructed. An accounting failure
blocks further BTW inference until reload rather than silently losing known spend.

- In Pix TUI, clicking `Usage` opens a session-owned dialog with on-demand
  loading, guarded refresh and retryable errors; repeat activation closes it.
  Desktop opens it only on
  button activation (click, Enter or Space), not hover or mere focus. Neither
  forces a provider quota refresh. See [status-bar click popups](../docs/decisions/0048-status-bar-click-popups.md).
  Desktop keeps the panel open after pointer departure. Repeat activation closes
  it without another spend request; Escape, outside pointer interaction or focus
  leaving the trigger/panel region also dismiss it. Escape restores trigger focus.
- The compact session detail remains intentionally compact and does not split parent-agent
  and sub-agent consumption into separate presentation rows; both are one session.
  Desktop keeps recorded cost in its on-demand detail popover, but does not show a
  dollar amount inline in the status bar. TUI also keeps money out of the status
  bar, but now shows recorded costs in its on-demand breakdown (with compact
  text bars for token shares when several models contributed).
  Its separately labelled, account-wide Limits section uses only cached
  hourly/weekly quota windows and reset-credit metadata; opening Usage never
  polls the provider. `Provider pages` offers the same allowlisted external
  destinations as Desktop. `Refresh limits` on Claude Code is an explicit
  quota-only refresh, distinct from `Refresh spend`.
  Desktop adds a `Subagents` button at the right of the Session usage header,
  shown only after a spend snapshot loads with a nonempty subagent call list.
  It is hidden while the snapshot is unavailable, when the optional breakdown
  is absent, or when its call list is empty; calls without recorded billable
  usage still qualify. It opens a separate native modal with
  rotating-chevron task disclosures, role icons, requested/recorded models,
  tool-start counts, exact token categories and per-run token/cost totals.
  Between `Session usage` and `Subagents`, active Claude Code routes or sessions
  with recorded Claude Code calls additionally
  show a compact OAuth-account select populated from the user-level
  `pi-tools-suite.jsonc`. A named selection saves the preferred profile for
  **future** model requests using a compare-and-swap JSONC write, without
  changing any currently streaming request. `Default` or `Auto` clears that
  preference depending on rotation mode. `Last: <name>` indicates the
  profile most recently attempted in this session; it is not a billing/quota
  attribution guarantee. Saved quota rows may still reflect a prior login,
  and merely selecting a profile never triggers network quota polling.
  Sessions without active or recorded Claude Code calls do not render this
  selector. With no configured OAuth
  profiles, the selector and last-attempted-account label are entirely hidden;
  configuration remains in Tools Suite Settings. Details of profile selection
  and bounded fallback belong in
  [Claude Code provider](./claude-code-provider.md).
  The modal shows the list of subagent calls and their expandable details,
  without run statuses, session-wide totals, main-agent comparisons or explanatory
  banners/footer. The role icon sits directly before the role name in a fixed
  semantic blue, independent of status or primary accent. Recognized providers
  use shared provider logos before recorded/configured model labels in the summary;
  expanded details do not repeat model labels or a model table. Unknown providers
  keep text labels without an empty icon slot. Tool calls appear as a list of
  names/counts only when nonempty, without a heading or unknown/empty-tool text.
  The Run path is immediately clickable when project navigation is available,
  without an existence check while rendering. Only activation validates that the
  directory exists inside the current workspace; a valid target closes the modal
  and reveals the folder in Project Files. Missing or inaccessible targets remain
  plain text after a failed activation. Session/workspace changes and teardown
  invalidate stale completions. Changed files and their coverage gaps are not
  displayed in this modal; optional durable changes data remains available in
  the usage protocol independently of presentation.
  Completed runs remain visible; no active-only HUD or child-file
  traversal is used. Old runtimes without the optional breakdown show an
  unavailable message. Refresh uses the same guarded spend request, never quota
  refresh or model inference, and retains the last snapshot on failure.
  Escape/backdrop/close dismiss only the modal and return focus to its invoker;
  the underlying Usage panel remains open, and session teardown removes both.
  Backend accounting still conserves main, subagent, side-call and unattributed
  usage independently of this list-only presentation. Estimated per-run costs
  in this modal use `~` for API-equivalent pricing.
  TUI exposes the same persisted child-run breakdown with a `Subagents (n)`
  action, a keyboard-searchable selector and a separate per-run dialog.
  It displays role icons, recorded/configured models, task/scope, available
  tool-start counts, exact input/output/cache counters, per-run tokens/costs,
  and run identity; unknown telemetry stays explicitly unknown. Estimated
  child costs use `~`. As on Desktop, it omits statuses, main-agent comparisons,
  explanatory banners and change-coverage summaries. `Open run` validates
  existence and canonical containment in the current workspace only when
  activated; failed targets cease to be actionable. The dialog can scroll
  using the mouse wheel; leaving the selector returns to Usage, while a valid
  opened run returns to its session summary. PageUp/PageDown also scroll
  longer dialog details from the keyboard. Session/tab changes prevent
  stale reads, menus and run validation from resurfacing an old popup.
  Desktop displays monetary values without an approximation prefix; estimated
  model values explain in an accessible label that these are original-model API rates, not
  subscription charges. `costEstimated` propagates from calls to model, provider
  and session totals through ACP.
  Known subscription provider headings offer an accessible external-link icon:
  Claude Code opens `https://claude.ai/code#settings/usage`; OpenAI Codex opens
  `https://chatgpt.com/settings/usage?tab=overview`; z.ai (`zai`) opens
  `https://z.ai/manage-apikey/coding-plan/personal/usage`. Unknown providers get no guessed URL.
  The native external opener launches the page in the system browser, without
  refreshing quota or making a model call. Failed opening shows a retryable error.
- Model labels use the same model-color conventions as the rest of Pix. TUI
  honors configured `modelColors` rules with the normal provider-palette
  fallback; Desktop uses its matching model-ref tone mapping and shows the
  shared provider glyph beside each recognized provider heading.
- Desktop loads the spend report on demand through `pix/session/usage`; TUI reads
  the owning session's complete persisted entries on demand. Opening the popup
  does not start a model request and does not refresh provider quota. TUI
  retains the last successful report after an explicit spend refresh fails.
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
  combines weekly cycle dates and remaining quota on one timeline in a labelled **Limits**
  section, alongside the hourly remaining-quota row when supplied. Header-derived rate
  windows remain status-bar-trigger-only. This is account-wide telemetry,
  never session-attributed usage. See [usage limits and model
  chart](desktop-quota-calendar.md) and [decision
  0039](../docs/decisions/0039-quota-reset-calendar.md), which supersede the
  former no-account-quota-block rule for this explicitly separated section.
  Session-attributed values are recorded token totals and recorded/estimated
  model costs, not an allocation of subscription quota or payment.
- When the recorded-spend breakdown includes more than one model with nonzero
  tokens (across any providers), the same Usage surface also shows a
  provider-agnostic donut chart of token share by model, directly above the
  existing provider/model table. With zero or one model with nonzero tokens it is omitted;
  the existing table is unaffected either way.
- Existing hourly/weekly account quota polling and status-bar indicators remain
  independent runtime chrome; opening the session-spend popup never refreshes
  them. The Limits section and model donut use the existing runtime/session-usage
  snapshots, not a new request.

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

## Implementation

- `src/app/session/session-usage.ts`
- `src/app/session/session-usage-pricing.ts`
- `src/app/session/session-subagent-usage.ts`
- `src/app/session/session-subagent-changes.ts`
- `src/app/screen/mouse-controller.ts`
- `src/app/model/model-usage-controller.ts`
- `external/pi-tools-suite/src/async-subagents/core/usage.ts`
- `external/pi-tools-suite/src/async-subagents/core/statistics.ts`
- `external/pi-tools-suite/src/async-subagents/tools/spawn.ts`
- `acp/src/acp/desktop-commands.ts`
- `acp/src/acp/pix-acp-agent.ts`
- `desktop/src/lib/acp-client.ts`
- `desktop/src/lib/acp-client-types.ts`
- `desktop/src/lib/acp-response-parsers.ts`
- `desktop/src/lib/session-usage.ts`
- `desktop/src/lib/subagent-usage.ts`
- `desktop/src/lib/subagent-usage-parser.ts`
- `desktop/src/lib/project-path-navigation.ts`
- `desktop/src/lib/validated-project-path.ts`
- `desktop/src/app/session-runtime-status.svelte.ts`
- `desktop/src/components/RuntimeStatusBarItems.svelte`
- `desktop/src/components/SubagentUsageDialog.svelte`
- `desktop/src/components/ValidatedProjectPath.svelte`

## Tests

- `tests/session-usage.test.ts`
- `tests/session-subagent-usage.test.ts`
- `tests/session-subagent-changes.test.ts`
- `tests/mouse-controller.test.ts`
- `external/pi-tools-suite/test/async-subagents-usage.test.ts`
- `external/pi-tools-suite/test/async-subagents-statistics.test.ts`
- `acp/test/agent.test.ts`
- `desktop/src/lib/acp-client.test.ts`
- `desktop/src/lib/session-usage.test.ts`
- `desktop/src/lib/subagent-usage.test.ts`
- `desktop/src/lib/project-path-navigation.test.ts`
- `desktop/src/lib/validated-project-path.test.ts`
- `desktop/src/components/SubagentUsageDialog.test.ts`
- `desktop/src/app/session-runtime-status.test.ts`
- `desktop/src/components/StatusBarHover.test.ts`

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
  append on the captured parent manager; statistics tests cover captured-parent
  task/tool/state telemetry and session aggregation, including ambiguous legacy
  identities and missing telemetry.
- Root subagent usage tests cover aggregation and conservation. Desktop tests
  cover parsing and formatting; dialog source-contract tests pin content,
  dismissal wiring and disclosure affordances, not rendered interactions.
  Native UI behavior requires separate UI QA.
- Desktop ACP-client and runtime lifecycle tests cover the independent usage
  request and stale forget/reset completion handling.
- Desktop source-contract tests pin click-only popup activation, dismissal and
  Usage content placement; they do not establish rendered or native UI behavior.

## Risks / compatibility

- Old sessions created before async-agent usage mirroring cannot reconstruct
  exact historical child-agent cost unless that usage was already persisted by
  another mechanism. Pix reports what is recorded; it does not invent missing
  historical spend.
- Providers may report zero monetary cost while still reporting tokens. Only the
  known Claude Code proxy uses the documented API-equivalent estimate fallback;
  it is not the actual subscription bill. TUI presentation remains token-only.
