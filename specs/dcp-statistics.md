# DCP statistics and lifecycle observability

## Type

As-is

## Lifecycle

Active implemented contract.

## Report ownership

`external/pi-tools-suite/src/dcp/statistics.js` is the shared, read-only ESM
reducer/formatter for `/dcp stats`, the TUI dialog and ACP/Desktop. The compiled
host imports this shipped JavaScript directly, without loading the TypeScript
extension runtime. Opening statistics never prunes history or calls a model.

The report separates these quantities:

- SDK usage, which may lag, from the **last prepared DCP request**. Its scalar
  snapshot includes the selected model, input capacity/output reserve, resolved
  routine/strong/hard thresholds, modes and pressure reason. It is dated and is
  not presented as live provider-measured token usage. A changed model makes an
  old snapshot stale; an epoch boundary invalidates it until another request.
- Active/retired/total journal blocks, active summary estimates and distinct
  pruned result bodies. Block count is not called an operation count. The
  input/projection reduction covers message estimates, not the system prompt,
  tool schemas, billing, or lifetime token occurrences.
- Model/tool commits, autonomous commits and block-only consolidation commits.
  Multi-block tool transactions count once by their call/operation identity.
  Historical blocks without identifiable provenance are reported separately.
- Measured positive commit gains. New transactions place one optional
  `commitMetrics` record on their first block, in the same durable publication
  as the rewrite. It contains operation ID, kind, before/after estimates and net
  gain. Validation rejects malformed or non-positive metrics. Retries never
  create a second measurement. Gains from old unmeasured blocks are unknown,
  not inferred as zero. A sum of measured deltas is not current context savings
  or saved billing.
- The Desktop context-hover `DCP saved ~N tokens` value is intentionally a
  different live runtime metric: the extension's `state.tokensSaved` estimate,
  also used by `/dcp context`. It is not derived from `measuredGain`, does not
  change this durable report's accounting, and is not a billing claim.
- Journaled anchors and context projection events, versus recorded provider
  attempts containing reminders and correlated successful completed
  opportunities. Failed attempts may count as attempts, never as successful
  completion. Repeated context callbacks do not invent provider opportunities.
  The former `Sent` label and `Compliance proxy` ratio are removed.

## Diagnostic records are not recovery authority

Version-1 `dcp-diagnostic` custom entries contain only scalar epoch, request,
completion and rejected-auto-attempt observations. They are separate from the
`dcp-journal` projection decisions. They carry no raw message bodies, tool
arguments or credentials, never enter provider context, and their write failure
cannot invalidate a successful rewrite or provider operation.

These records are produced at lifecycle/provider boundaries, not on every
context callback. Delivery counts cover instrumented history only. Absence of
older instrumentation is shown as unknown. No diagnostic record restores
provider-seen evidence, freshness grants or patience into a resumed runtime.

## Full branch and owner boundaries

The TUI uses `loadDcpStatsToast()` with an async full-branch read when supported;
it does not hydrate the lazy UI cursor synchronously on click. ACP continues to
supply the complete active branch from its existing async tree request. The
explicit synchronous formatter remains available for already-loaded branches
and diagnostics. A failed full reader never falls back to a truncated tail.
Invalid/missing journal chains and incomplete histories display unknown values,
not reassuring zero counters or a claim that persistence is healthy.

The runtime and report must distinguish a presentation cursor (`getBranch()` on
a lazy manager) from full provider context and the complete journal branch.
Current `LazySessionManager.buildSessionContext()` reconstructs full context;
DCP reads the full branch to bind exact entry identities and replay the journal.
Stats, startup replay and explicit sweep use the full-branch reader too.

Full reads capture session/leaf identity. A changed branch, malformed return or
failed read cannot initialize a new journal from an apparently empty tail. A
failed context read invalidates provider-ready state; failed startup replay
remains explicitly blocked. Async loads/projections from an earlier session
epoch cannot publish into a replacement owner.

`model_select` clears both pending and previously successful provider exposure,
freshness and patience, while preserving durable blocks and frozen anchors.
The selected model's context window overrides an old SDK sample's window.
Fork/restart replay only the selected ancestor chain: a fork before a compression
commit does not inherit that commit; a fork after it preserves its summary and
metrics. Raw parent history is never rewritten by these reads or forks.

## Verification

- `tests/dcp-stats.test.ts`: accounting/provenance, exact diagnostic boundaries,
  unknown/stale values, broken chains, injected ACP branches and async reads.
- `tests/dcp-lifecycle.integration.test.ts`: actual `SessionManager` and
  `openLazySessionManager`, resume with init/block outside the hot tail,
  non-tip forks, model-capacity downgrade, unknown exposure, read failures,
  same-timestamp identity collisions and obsolete async loads.
- `tests/mouse-controller.test.ts`: on-demand dialog integration.
- `external/pi-tools-suite/test/compress-pruner.test.ts`: `/dcp stats` uses the
  same report and preserves the user-only message boundary.
- Existing DCP journal, transaction-fault and marathon suites remain required.

Run the named host tests with `node --import tsx --test`, the DCP tests with
`bun test`, and both root/suite TypeScript checks. Live model-choice evals are a
separate layer; changing report accounting does not imply a new live-model pass.
