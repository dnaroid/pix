# DCP reliability mechanisms (as-is spec)

> Risk classes: **data persistence / concurrency / cross-cutting**. Safety and
> fault-boundary machinery around DCP (dynamic context pruning): state
> transactions, ownership epochs, budgets, bounded artifact reads, blocked-
> progress reporting, and the deterministic tests that lock them. Architecture
> and user-facing behavior are specified in
> [dcp.md](./dcp.md); provider-cache stability in
> [dcp-provider-cache-stability.md](./dcp-provider-cache-stability.md).
> All paths below are relative to `external/pi-tools-suite/`.

## Type

As-is

## Lifecycle

Active implemented contract.

## State transaction and ownership epochs

`src/dcp/state-transaction.ts`

- A compression plan is published only through a transaction that captures the
  owning `sessionEpoch` and the source revision when the plan is created.
  `[confirmed by code, state-transaction.ts:85]`
- Publication re-checks session epoch plus transaction/source revision; any
  mismatch aborts with `stale_plan: DCP session, branch, model, configuration
  or source revision changed before publication`. A stale result from an older
  session/branch/model/config is never applied to a newer one. `[confirmed by
  code, state-transaction.ts:97-99]`
- Locked by `test/dcp-transaction-faults.test.ts`:
  - a changed source during the model await cannot reach persistence;
  - the same tool-call id with changed parameters is a conflict, not an
    idempotent success;
  - new interior content is not deleted by a previously committed exact block;
  - failed command persistence neither mutates manual mode nor reports
    success. `[confirmed by tests]`

## Journal mirror, replay and pre-journal gating

`src/dcp/journal.ts`, `src/dcp/index.ts`

- DCP decisions persist as small structured custom entries (`dcp-journal`,
  schema version 1) inside the session itself — no sidecar file. Replay of
  init + delta operations reconstructs the block state. `[confirmed by code,
  journal.ts:12-13,58]`
- A pre-journal conversation is deliberately unsupported (clean break, no
  migration of legacy sessions): operations fail with "DCP is disabled for
  this pre-journal session. Start a new session to use the current DCP
  implementation." `[confirmed by code, index.ts:201,323]`
- A blocked journal throws an explicit `DcpJournalError` carrying the blocked
  reason instead of leaving partial work. `[confirmed by code,
  index.ts:344,444]`
- Pressure that cannot act is reported as a `progress-blocked` diagnostic with
  an inferred reason (`inferDcpBlockedReason`) rather than looping as a no-op.
  `[confirmed by code, index.ts:235,713-722]`
- Locked by `test/dcp-journal.test.ts`, `test/dcp-journal-lifecycle.test.ts`,
  `test/dcp-progress-opportunities.test.ts`. `[confirmed by tests]`

## Budgeted auto-compression

`src/dcp/auto-compress-budget.ts`

- `createBudgetedAutoCompressionBlock` never treats a source-size estimate as
  a net-savings estimate: it tries the economical prefix first, then the
  largest prefix that passed the **same** retention and provider-evidence
  policy; both attempts share one whole-operation deadline (operation timeout
  plus a 1 s finalization grace). A model summarizer may consume at most 75% of
  the configured operation timeout so deterministic extractive fallback and
  publication retain bounded headroom; protection/evidence are never relaxed
  and insufficient gain is never reported as success. `[confirmed by code,
  auto-compress-budget.ts]`
- Rejected attempts are memoized per state + **exact candidate source** key
  (epoch + exact `sourceMembers` for the economical and largest-safe ranges),
  not by the whole growing provider tail. Appending unrelated tool/user traffic
  therefore does not repeatedly prepare the same byte-identical rejected range;
  when exact membership is unavailable the memoizer falls back conservatively
  to the full-context identity. `[confirmed by code, auto-compress-budget.ts;
  confirmed by test/dcp-auto-compression-projection.test.ts]`
- Deterministic extractive fallback is not rejected merely because its
  continuation record exceeds 8192 tokens. Large sources may require a larger
  lossless continuity floor; the shared exact replacement/full-projection gain
  checks decide whether it is economical, and non-positive/insufficient plans
  remain rejected. `[confirmed by code, auto-compress.ts; confirmed by
  test/auto-compress.test.ts]`
- Once a configured model summarizer actually fails/unavailable and DCP reaches
  deterministic extraction, later automatic attempts in that live session skip
  model summarizers; a successful deterministic fallback commit also establishes
  that degraded mode. A later gain/economics rejection after a **successful**
  model summary does not degrade the summarizer merely because the selected
  range was too expensive to replace. This prevents repeated model timeouts
  without turning `non-positive-gain` into a false session-wide model failure.
  `[confirmed by code, dcp/index.ts, auto-compress.ts; confirmed by
  test/auto-compress.test.ts and test/compress-pruner.test.ts]`
- At capacity, a failed exact auto-compression attempt falls through to the
  bounded emergency current-turn pruning floor before abort/handoff. DCP aborts
  only when the projected context still cannot fit after eligible recovery and
  emits a user-visible `progress-blocked` diagnostic first. `[confirmed by code,
  dcp/index.ts; confirmed by test/compress-pruner.test.ts]`
- A successful **partial** auto-compression commit follows the same capacity
  rule: if its exact provider projection is still above input capacity, DCP
  continues through same-pass emergency recovery and otherwise aborts instead of
  treating positive gain as permission to send an oversized request. `[confirmed
  by code, dcp/index.ts; covered by deterministic session-simulation provider
  capacity assertions]`
- Cumulative `compressionProgress.remainingTokens` is progress accounting, not
  an unbounded sizing target for the next automatic rewrite. Candidate sizing
  and `requiredGainTokens` are capped by the current budget requirement; under
  active progress/capacity pressure raw-tail range candidates exclude existing
  `bN` summaries and recover from eligible raw growth instead of repeatedly
  recompressing one old summary plus a tiny new tail. A separate automatic
  block-only consolidation candidate batches physically adjacent summaries so
  independent summaries cannot themselves accumulate until they fill the
  provider window; the candidate never spans raw messages. `[confirmed by code,
  compression-progress.ts, pruner-candidates.ts, dcp/index.ts; confirmed by
  test/dcp-progress-opportunities.test.ts and
  test/dcp-auto-compression-projection.test.ts; journal-replay marathon locked by
  test/dcp-marathon-replay.test.ts; block-only batching locked by
  test/compress-pruner.test.ts and test/dcp-session-sim-e2e.test.ts]`
- A provider request is fail-closed across lifecycle epochs. DCP records the
  session epoch of the last provider-ready `context` projection; if a supported
  journal session reaches `before_provider_request` after the epoch changed but
  before a fresh context projection completed, DCP emits
  `stale-context-projection`/`provider_payload.blocked_stale_projection` and
  aborts (or throws when abort is unavailable) before raw history can be sent.
  `[confirmed by code, dcp/index.ts; confirmed by
  test/dcp-progress-opportunities.test.ts]`
- Locked by `test/dcp-review-regressions.test.ts` ("net budget recovery
  expands an insufficient prefix under the same safety policy") and
  `test/dcp-auto-compression-projection.test.ts`. `[confirmed by tests]`

## Canonical conversation index

`src/dcp/conversation-index.ts`

- Canonical message identity (`canonicalMessageHash`) and the shared index are
  the single source of exact membership; 10 files under `src/dcp/` import the
  module (pruner, compress tool, budget controller, message ids, …).
  `[confirmed by code]`
- Canonical identity is normalized to JSONL-stable value semantics before
  hashing: non-finite numbers become `null`, unsupported array values become
  `null`, unsupported object properties are omitted, and `toJSON()` values are
  honored. Runtime-only `undefined` fields inside `toolResult.details` therefore
  cannot make a valid v2 block fail exact membership solely because the session
  was serialized and reopened. `[confirmed by code, conversation-index.ts;
  confirmed by test/dcp-auto-compression-projection.test.ts]`
- Locked by `test/dcp-conversation-index-generative.test.ts`, whose seeded
  property test checks closure against an independent reference
  implementation, not the production planner against itself.
  `[confirmed by tests]`

## Candidate selection and protected continuity

`src/dcp/pruner-candidates.ts`, `src/dcp/pruner-emergency.ts`,
`src/dcp/protected-continuity.ts`

- Routine candidates pick the **minimal oldest protocol-safe prefix** that
  restores the required budget tokens, always older than the most recent
  `keepRecentTurns` user turns. `[confirmed by code, pruner-candidates.ts:222]`
- When candidate selection is serving active progress/capacity recovery, it can
  exclude already-compressed block placeholders while preserving the same
  retention and provider-evidence rules. Ordinary/non-pressure selection keeps
  block addressability for deliberate consolidation. `[confirmed by code,
  pruner-candidates.ts; confirmed by
  test/dcp-auto-compression-projection.test.ts]`
- Automatic summary consolidation is a separate candidate class: only a batched
  run of physically adjacent active block messages is eligible. Any raw message
  breaks the run, so automatic consolidation cannot silently absorb fresh/raw
  history while reducing block-wrapper overhead. `[confirmed by code,
  pruner-candidates.ts; confirmed by test/compress-pruner.test.ts]`
- Emergency-only ranges exist for marathon single-turn sessions: every tool
  result selected for compression must have completed provider evidence in
  `providerSeenToolIds`; unknown evidence truncates the safe prefix.
  `[confirmed by code, pruner-candidates.ts:239-240, pruner-emergency.ts:160]`
- Locked by `test/dcp-protected-continuity.test.ts`. `[confirmed by tests]`

## Bounded protected-artifact reads

`src/dcp/compression-blocks.ts`

- Sub-agent `result.md` artifacts referenced by protected fragments are read
  through `readBoundedProtectedSubagentArtifact`: awaited fs operations,
  `realpath` confinement to the session cwd (paths outside it throw), and a
  `MAX_PROTECTED_ARTIFACT_BYTES = 50_000` budget enforced **before/during** the
  read (keyed off `record.artifacts?.resultMd`). `[confirmed by code,
  compression-blocks.ts:17,463-512]`

## Recovery rehydration

`src/dcp/recovery.ts`

- `rehydrateToolRecordsFromMessages` rebuilds tool records from raw session
  history when DCP metadata is missing, instead of declaring the data
  unrecoverable. `[confirmed by code, recovery.ts:65]`
- Locked by `test/dcp-recovery.test.ts`. `[confirmed by tests]`

## Deterministic walls

- `test/dcp-fresh-nudge.test.ts` verifies mid-turn reminder delivery through
  locally completed fresh tool results, identical serialized Responses prefixes
  on continuation/retry, failed-send freshness consumption, duplicate-ID refusal,
  equal-timestamp isolation, lifecycle resets, and lower-usage frozen replay.
  A frozen exact anchor remains deliverable on retries without a new freshness
  grant; failed sends cannot trigger the "reminder unavailable" auto-compress
  shortcut. The same test verifies automatic fallback still runs after actual
  completed reminder opportunities exhaust patience.
  Freshness is runtime-only in `src/dcp/fresh-tool-results.ts`; durable anchor
  publication/replay remains journal schema v1. `test/dcp-session-sim-e2e.test.ts`
  uses a real SessionManager/journal to verify tool-reminder delivery and restart
  byte equality, separately from automatic compression. Its report distinguishes
  reminders projected from provider turns that actually send them.
- The opt-in `test/prompt-evals/dcp-reminder-e2e.test.ts` feeds the same scene
  to a real model with alternative tools and no forced `tool_choice`. It requires
  an actual `compress` tool call and executes it through the registered tool,
  checking positive context reduction. This is model-choice plus DCP execution
  coverage, not a full SDK-agent/UI test. It does not retry a behavioral failure.
  Run `npm run test:dcp-reminder-e2e`; override the model with
  `DCP_REMINDER_E2E_MODEL=provider/model`. Missing provider/auth configuration is
  a failing prerequisite when opted in, not a successful or silently skipped
  model-behavior check. Offline suites skip this live case.

- `test/dcp-transaction-faults.test.ts` — fault boundaries above.
- `test/dcp-review-regressions.test.ts` — independent-review regressions:
  config-instance isolation, budget recovery under the same policy, physical
  membership with backwards timestamps, no same-timestamp substitution,
  textSignature refusal in message mode, aborted operations never publish.
- `test/dcp-marathon-replay.test.ts`, `test/dcp-lifecycle-marathon.test.ts` —
  long single-turn replays with sequential rollups, restart and fork
  reconciliation.
- `test/dcp-session-sim-e2e.test.ts` plus
  `test/support/dcp-session-simulator.ts` — deterministic session-level E2E:
  real `SessionManager` JSONL/journal plus the real DCP lifecycle hooks, with only
  the remote model replaced by a scripted provider. It measures raw vs projected
  token occurrences, peak provider context, active-summary count, block-only vs
  mixed block+raw rollups, exact-prefix retention, aborts, journal replay, and
  provider input-capacity violations. This is the efficiency wall for regressions
  that remain functionally correct but make long sessions progressively more
  expensive.
- `test/dcp-shadow-plan.test.ts` — dry-run planning on a detached state clone
  with no persistence or model calls. `[confirmed by tests]`

## Historical disposition

This spec consolidates and supersedes three historical documents:

- `27-dcp-reliability-roadmap.md` — implementation roadmap (2026-09-05) with
  problem registry F01–F15 and target invariants; its stages were implemented,
  then the sidecar persistence layer was removed entirely by the journal
  simplification (former plan 32, commit `cc6fac3`).
- `27-dcp-reliability-evidence.md` — deterministic evidence of the sidecar-era
  pass; its sidecar-specific parts (persistence envelope, `.prev` recovery,
  rollback constraints) describe machinery that no longer exists.
- `27-dcp-review-remediation.md` — fixes after the independent review at
  `7a8042e`.

The defect registries in those documents use inconsistent F-numbering between
themselves, so per-defect closure is recorded there, not here. Current
guarantees are exactly the ones verified above; the originals are preserved in
git history.

## Related files

- `external/pi-tools-suite/src/dcp/state-transaction.ts`
- `external/pi-tools-suite/src/dcp/journal.ts`
- `external/pi-tools-suite/src/dcp/conversation-index.ts`
- `external/pi-tools-suite/src/dcp/auto-compress.ts`
- `external/pi-tools-suite/src/dcp/compression-blocks.ts`
- `external/pi-tools-suite/src/dcp/pruner-candidates.ts`
- `external/pi-tools-suite/src/dcp/shadow-plan.ts`
- `external/pi-tools-suite/src/session-recovery/index.ts`
- `external/pi-tools-suite/test/auto-compress.test.ts`
- `external/pi-tools-suite/test/dcp-transaction-faults.test.ts`
- `external/pi-tools-suite/test/dcp-review-regressions.test.ts`
- `external/pi-tools-suite/test/dcp-journal-lifecycle.test.ts`
- `external/pi-tools-suite/test/dcp-marathon-replay.test.ts`
- `external/pi-tools-suite/test/dcp-lifecycle-marathon.test.ts`
- `external/pi-tools-suite/test/dcp-session-sim-e2e.test.ts`
- `external/pi-tools-suite/test/support/dcp-session-simulator.ts`
- `external/pi-tools-suite/test/dcp-shadow-plan.test.ts`

## Verification

- From `external/pi-tools-suite/`, run the focused DCP wall/replay tests named
  above, `npm run test:dcp-session-sim` for the session-efficiency wall, and
  `bun test test` for the full deterministic suite.
- Canonical from the repo root: `npm run check` and
  `npm run test:tools-suite`; the dedicated session-sim entrypoint is
  `npm run test:dcp-session-sim`.
