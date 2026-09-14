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

Full reads capture session/leaf identity. Because the lazy full-history reader
yields to the event loop, a bounded retry is allowed when the leaf only advanced
by appending descendants on the same active branch while the read was in flight.
A read snapshot from another lineage cannot authorize that retry even if the
current branch still contains the captured leaf. A real branch move/fork, a
branch that keeps moving beyond the retry bound, a malformed return or a failed
read cannot initialize a new journal from an apparently empty tail. A failed
context read invalidates provider-ready state;
failed startup replay remains explicitly blocked. Async loads/projections from
an earlier session epoch cannot publish into a replacement owner.

`model_select` clears both pending and previously successful provider exposure,
freshness and patience, while preserving durable blocks and frozen anchors.
The selected model's context window overrides an old SDK sample's window.
Fork/restart replay only the selected ancestor chain: a fork before a compression
commit does not inherit that commit; a fork after it preserves its summary and
metrics. Raw parent history is never rewritten by these reads or forks.

### Lazy-tail retry invariant

`readFullBranchEntries()` and lazy `getBranch()` are **not two versions of the
same ordered branch**. The former reconstructs the complete selected ancestry;
the latter exposes cached JSONL presentation entries. That tail can omit old
ancestors and interleave abandoned branches, including diagnostic-only resume
branches left by another runtime. For example:

```text
JSONL/presentation order: root, A, side, B, C
parent links:            A -> root; side -> A; B -> A; C -> B
active ancestry at C:    root, A, B, C
```

A normal append `B -> C` must remain retryable even though walking backwards by
array position compares `side` with `A`. This caused a regression after the
September 2026 Desktop-to-TUI startup-read fix: stronger positional lineage
checks reintroduced sticky `DCP journal is blocked` errors on valid sessions.

The retry proof in `readDcpJournalBranch()` has these requirements:

- Capture session/manager and leaf identities around the async read. Return
  history only from a stable full read whose tip matches the captured leaf.
  Descendant races permit at most three total reads, never an unbounded loop.
- Validate the read snapshot as a single root-to-tip `id`/`parentId` chain for
  retry authorization. Index current presentation entries by ID and **walk
  `parentId` from the captured current leaf**, not from the array's last item.
  The old leaf and read tip must both be on that chain. A fork tip merely
  present elsewhere in the presentation tail proves nothing.
- Overlapping identities must have identical parent links. SDK entry IDs and
  parent links are immutable within the session. Missing older ancestors may
  come only from the complete read snapshot. Missing links not present in
  either view, cycles, duplicate IDs and conflicting parents deny the retry.
- The combined parent-link index is only proof that another read is safe. It
  is **never returned as context or journal history**. No synchronous hydration,
  `getEntry()` fallback, persistent history rewrite or new journal initialization
  may be used to make this check pass. Real branch/owner changes, malformed
  reads and exhausted retries remain fail-closed.

**Do not replace this with a positional prefix/suffix comparison, even after
finding the old leaf; do not replace it with `some(id === oldLeaf)` either.**
The first rejects valid lazy histories, while the second admits snapshots from
an unrelated fork. Keep the positive lazy-tail and negative fork-lineage tests
together whenever changing this code.

The positive integration regression uses a real persisted journal with a
compressed block, real off-branch JSONL records and `openLazySessionManager`
with a partial tail. It gates startup reads before/after the concurrent tool
result append and then exercises `session_start(startup) -> before_agent_start
-> context -> before_provider_request`. It requires successful retry, preserved
compression/IDs, retained late result, excluded side-branch/raw compressed text,
no forced UI hydration and an append-only archive. It is a deterministic
runtime-lifecycle test, not a live Desktop/TUI GUI or remote-model test.

## Verification

- `tests/dcp-stats.test.ts`: accounting/provenance, exact diagnostic boundaries,
  unknown/stale values, broken chains, injected ACP branches and async reads.
- `tests/dcp-lifecycle.integration.test.ts`: actual `SessionManager` and
  `openLazySessionManager`, resume with init/block outside the hot tail,
  non-tip forks, model-capacity downgrade, unknown exposure, read failures,
  same-timestamp identity collisions, obsolete async loads and the startup
  side-branch/late-append regression through provider hooks.
- `tests/dcp-journal-branch.test.ts`: partial/interleaved presentation tails,
  missing old ancestors, foreign read tips even when present in the tail,
  conflicting/missing/cyclic parent links, duplicate IDs, stable-leaf fork-back,
  changed owners and bounded retries.
- `tests/mouse-controller.test.ts`: on-demand dialog integration.
- `external/pi-tools-suite/test/compress-pruner.test.ts`: `/dcp stats` uses the
  same report and preserves the user-only message boundary.
- Existing DCP journal, transaction-fault and marathon suites remain required.

Run the named host tests with `node --import tsx --test`, the DCP tests with
`bun test`, and both root/suite TypeScript checks. Live model-choice evals are a
separate layer; changing report accounting does not imply a new live-model pass.
