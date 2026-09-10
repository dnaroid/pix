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
- Rejected attempts are memoized per state + source key (epoch +
  `canonicalMessageHash` of the source messages) so the same rejected source
  is not retried. `[confirmed by code, auto-compress-budget.ts:10,30-32]`
- Once a model-backed auto-compression attempt fails, later automatic attempts
  in that live session skip model summarizers and use deterministic extraction;
  this prevents a growing autonomous tool loop from paying the same model
  summary timeout repeatedly. `[confirmed by code, dcp/index.ts]`
- At capacity, a failed exact auto-compression attempt falls through to the
  bounded emergency current-turn pruning floor before abort/handoff. DCP aborts
  only when the projected context still cannot fit after eligible recovery and
  emits a user-visible `progress-blocked` diagnostic first. `[confirmed by code,
  dcp/index.ts; confirmed by test/compress-pruner.test.ts]`
- Locked by `test/dcp-review-regressions.test.ts` ("net budget recovery
  expands an insufficient prefix under the same safety policy") and
  `test/dcp-auto-compression-projection.test.ts`. `[confirmed by tests]`

## Canonical conversation index

`src/dcp/conversation-index.ts`

- Canonical message identity (`canonicalMessageHash`) and the shared index are
  the single source of exact membership; 10 files under `src/dcp/` import the
  module (pruner, compress tool, budget controller, message ids, …).
  `[confirmed by code]`
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

- `test/dcp-transaction-faults.test.ts` — fault boundaries above.
- `test/dcp-review-regressions.test.ts` — independent-review regressions:
  config-instance isolation, budget recovery under the same policy, physical
  membership with backwards timestamps, no same-timestamp substitution,
  textSignature refusal in message mode, aborted operations never publish.
- `test/dcp-marathon-replay.test.ts`, `test/dcp-lifecycle-marathon.test.ts` —
  long single-turn replays with sequential rollups, restart and fork
  reconciliation.
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
- `external/pi-tools-suite/test/dcp-transaction-faults.test.ts`
- `external/pi-tools-suite/test/dcp-review-regressions.test.ts`
- `external/pi-tools-suite/test/dcp-journal-lifecycle.test.ts`
- `external/pi-tools-suite/test/dcp-marathon-replay.test.ts`
- `external/pi-tools-suite/test/dcp-lifecycle-marathon.test.ts`
- `external/pi-tools-suite/test/dcp-shadow-plan.test.ts`

## Verification

- From `external/pi-tools-suite/`, run the focused DCP wall/replay tests named
  above and `bun test test` for the full deterministic suite.
- Canonical from the repo root: `npm run check` and
  `npm run test:tools-suite`.
