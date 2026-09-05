# DCP reliability roadmap — deterministic implementation evidence

Date: 2026-09-05

This report records the local, headless implementation state for
`specs/27-dcp-reliability-roadmap.md`. It deliberately separates deterministic
engineering evidence from live provider/model rollout evidence.

## Scope and release state

- Source of truth changed only under `external/pi-tools-suite/` plus host specs.
- Installed SDK contract inspected/tested at `@earendil-works/* 0.85.1`.
- `compress.autoCompress.enabled` remains **false by default**.
- No user configuration was changed.
- No live extension mirror sync, Pi/Pix restart, TUI exercise, paid/model eval,
  or production canary was performed.
- No commit was created by this implementation pass.

The implementation is therefore at **deterministic pre-rollout / release-hold**
stage. Default autonomous summary policy is not being widened by this report.

## Defect closure matrix

| Defect | Deterministic outcome |
| --- | --- |
| F01 | v2 message-body replacement edits only the selected result body; sibling tool results and assistant bytes remain unchanged. Partial parallel-group range selection is rejected/closed. |
| F02 | manual multi-operation compression stages on a working state; late fatal range/persistence failure publishes zero blocks/counters. |
| F03 | auto summary with non-positive full-projection gain is blocked atomically. |
| F04 | deterministic extractive fallback retains explicit decisions, verification failures and next steps rather than only tool-frequency digest. |
| F05 | `keepRecentTurns` with fewer real user turns returns no stale routine candidate. |
| F06 | persistence dedup/queue is keyed per full sidecar path; identical A/B state writes independently. |
| F07 | persistence uses immutable bytes, private temp file + fsync/rename, generation envelope, owner/session epoch checks, `.prev` recovery and cross-process exclusive writer conflict. |
| F08 | HTTP 2xx no longer promotes provider evidence; successful finalized assistant completion is required. |
| F09 | emergency range and output pruning both require completed provider evidence; a later assistant is ordering evidence only. |
| F10 | bounded source manifest includes call id/name, non-secret args/path, result linkage/outcome/exit code; auth + completion + fallback models share one deadline; complete tool groups are chunk boundaries. |
| F11 | internal non-enumerable provenance is authoritative; raw user text containing DCP-like tags remains raw/user authority. |
| F12 | exact dedup requires input + exact output identity + error/success semantics; same read input with changed output is retained. |
| F13 | lifetime tool-call count is monotonic through serialize→restore→serialize; debug-disabled state snapshot is O(1); metrics distinguish emergency eligible sets. |
| F14 | manual mode cannot be widened into autonomous summary creation; emergency safety is not accidentally disabled by routine `autoCandidates`. |
| F15 | one-user-turn replay: 1000 tool groups, 10 useful auto rollups, restart and fork all complete under deterministic oracle checks. |

## Structural / transaction invariants covered

The deterministic suites exercise the roadmap invariants most directly related
to local correctness:

- protocol tool-group closure and no partial parallel-group mutation;
- exact v2 mutation set and signed-assistant byte preservation;
- no fatal partial commit; idempotent retry of the same compress operation;
- positive/budget-sufficient full-projection gain before auto commit;
- stable monotonic IDs across timestamp collisions and repeated projection;
- provider-evidence fail-closed behavior for abort/error/retry/interleaving;
- session-epoch and captured-target protection across awaits;
- durable generation validation/recovery and explicit cross-process conflict;
- protected-fragment dedup across rollups;
- ordinary continuation prefix stability after one intentional rewrite;
- bounded progress or explicit terminal blocked reason under hard capacity.

The new seeded conversation-index property test uses an independent reference
closure implementation rather than comparing the production planner with
itself.

## Deterministic test gates

### Expanded DCP gate

Command from `external/pi-tools-suite/`:

```text
bun test test/compress-pruner.test.ts test/auto-compress.test.ts \
  test/dcp-state-persistence.test.ts test/dcp-state-serialization.test.ts \
  test/dcp-fork-reconciliation.test.ts test/dcp-config.test.ts \
  test/dcp-debug-log.test.ts test/dcp-prompts.test.ts test/compress-ui.test.ts \
  test/dcp-marathon-replay.test.ts test/dcp-conversation-index-generative.test.ts \
  test/dcp-shadow-plan.test.ts
```

Observed after the deterministic E09/E10 shadow slice: **199 pass / 0 fail / 45,908 assertions**.
The seeded generative portion alone exercises **720 random traces** and 44,694
assertions.

### Shadow planner

`test/dcp-shadow-plan.test.ts` and `scripts/dcp-shadow-plan.ts` exercise the
E10 dry-run path. Planning runs on a detached state clone, performs no
persistence/model calls, and leaves live maps/sets/snapshots byte-equivalent.
The synthetic harness demonstrated `repo-over-provider` pressure with an
emergency provider-evidenced candidate while `autoCompress.enabled` remained
false.

### Long replay

`test/dcp-marathon-replay.test.ts` covers:

- one real user turn;
- 1000 tool groups;
- 10 sequential useful auto rollups without a second user boundary;
- positive gain on every commit;
- one active rollup at each checkpoint;
- bounded summary size and no recursive verbatim old-summary expansion;
- preservation of active user constraint/protect marker and live tail;
- serialize→restore projection equality;
- fork inside the newest rollup and deepest-fitting-ancestor reconciliation.

### Full suite

Latest full suite run during the implementation pass:

```text
bun test test
```

Observed: **537 pass / 58 skip / 3 fail / 47,801 assertions** (598 tests across 45 files).
The three failures are the same baseline environment/process-cleanup failures
that were present before DCP changes:

1. todo persistence real Pi e2e duplicate auto-nudge wait;
2. private browser QA hung-stage detached-child cleanup;
3. private browser QA auth-scaffold hung-child cleanup.

No new full-suite failure was introduced by the DCP changes.

### Source typecheck

Canonical `npm run check` could not be executed because this environment has no
Node/npm/mise. As an additional non-canonical source gate, the repository-local
TypeScript compiler was run through Bun:

```text
bun node_modules/typescript/bin/tsc -p tsconfig.source.json
```

It passed after fixing two static-only type findings. This is **not** claimed as
a substitute for the canonical npm/host check.

## Performance evidence

Reproducible script: `external/pi-tools-suite/scripts/dcp-benchmark.ts`.
This measures local DCP projection CPU only; no LLM or filesystem wait is mixed
into the samples.

| Fixture | repetitions | p50 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| 100 messages / ~100 KB text | 40 | 0.350 ms | 0.523 ms | 0.562 ms | 0.623 ms |
| 1000 messages / ~1 MiB text | 30 | 3.663 ms | 7.855 ms | 8.846 ms | 11.029 ms |
| 10000 messages / ~5 MiB text | 12 | 29.683 ms | 32.689 ms | 32.689 ms | 33.484 ms |

The roadmap's provisional 1000-message / 1 MiB p95 target (<50 ms on the agreed
machine) is met on this local machine. This measurement is machine-specific and
is not a production latency claim.

## Persistence / migration / rollback evidence

New sidecars use a versioned envelope containing exact session identity,
generation, revision/payload hash and validated payload. Legacy flat sidecars
remain readable. The first new write over a valid legacy/current generation
stores the old document as `.prev` before publishing the new generation.

Covered failure modes include immutable snapshot after enqueue, two sessions
with identical state, corrupt primary with `.prev` recovery, unrecoverable
corrupt state refusing empty overwrite, wrong session identity, cyclic block
graph, incomplete session ownership scan, paused live session older than seven
days, captured target across session switch, and a real child process holding
the sidecar writer lock.

Rollback constraints:

- stop creation of new automatic blocks by keeping/setting
  `compress.autoCompress.enabled=false`; existing blocks still apply
  deterministically;
- do not delete sidecars/raw session history as a rollback mechanism;
- rollback code must understand v2 block semantics and the generation envelope;
  an older binary with no v2/envelope reader is **not** a safe rollback target;
- a legacy pre-envelope sidecar is retained as `.prev` when migration has such a
  source, but this is recovery data, not permission to run an incompatible old
  binary;
- stale cross-process lock files are fail-closed and require operational review;
  the implementation intentionally does not steal a lock based on wall-clock
  age.

## Provider/cache evidence boundary

Deterministic installed-SDK tests establish that:

- `after_provider_response` occurs before stream consumption and is not a
  completion witness;
- successful finalized assistant completion can promote exactly one
  unambiguous local attempt;
- abort/error and ambiguous interleaving do not promote;
- identical retries coalesce as one opportunity;
- after one intentional v2 rewrite, two ordinary continuations preserve both
  the DCP projected prefix and the installed OpenAI Responses converter prefix.

This does **not** prove every provider backend physically retained/processed the
request, nor does it measure provider cache-hit rate. Ambiguity without request
identity remains fail-closed.

## Summary-quality evidence boundary

Deterministic fixtures prove presence/preservation rules for explicit constraints,
decisions, errors, verification results, next steps and tool-arguments-only
facts. They also prove bounded chunk coverage and model-outage extractive
fallback mechanics.

No live continuation-quality corpus was run. Therefore non-inferiority on real
model task completion, constraint violation rate, invent/repeat-work rate and
provider/model-specific summary quality remains an E09/E10 release gate rather
than a claimed result.

## Checks intentionally not run

- `npm --prefix external/pi-tools-suite run check` — unavailable: npm/Node are
  not installed in this execution environment.
- root `npm run check` / `sync:sdk-pin:check` — same environment limitation.
- `npm run test:prompt-evals*` / live evals — intentionally not run; no
  model-facing prompt text was changed and this implementation session is
  deterministic/headless only.
- live provider canary — not run.
- `npm run sync:pi-tools-suite` — not run; no deployment/mirror mutation. The
  expected live mirror path `~/.pi/agent/extensions/pi-tools-suite` is absent in
  this environment, so there was no source↔mirror drift target to compare.
- Pi/Pix restart — not run.

## Rollout decision

**Hold default autonomous summary policy at the current default (`false`).**
Deterministic engineering gates are strong enough for a pre-rollout candidate,
but the roadmap's live continuation-quality and controlled-canary gates have not
been executed. A later release action should run canonical npm/host checks in a
Node-enabled environment, then explicit disposable-session canaries, mirror
sync/drift verification and restart only with separate deployment approval.
