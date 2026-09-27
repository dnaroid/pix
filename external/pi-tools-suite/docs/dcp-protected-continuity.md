---
kind: spec
status: active
---

# DCP protected continuity

## Behavior

DCP treats pruning protection and compression continuity as separate policies.
A tool result may be protected from generic pruning without requiring its full
delivered output to remain in every future compressed prompt.

When a protected tool result enters a compression block, DCP keeps the smallest
safe deterministic representation:

- explicit prompt/user protections remain exact;
- outputs protected by `protectedFilePatterns` remain exact;
- protected subagent recovery artifacts remain exact;
- known mutation tools such as `apply_patch`, `write`, and `edit` may retain a
  bounded receipt containing outcome, changed files, producer summary,
  actionable failure evidence, and raw-output identity;
- shell inspection/test output may retain the existing bounded digest;
- shell mutation/compound/unknown output may retain a bounded receipt with the
  command, conservative classification, outcome, bounded evidence, and
  raw-output identity;
- any digest or receipt is used only when it is smaller than the verbatim
  representation;
- unknown protected non-shell tools remain exact unless they acquire a typed
  continuity policy.

The raw Pi session remains the exact historical source. Compression continuity
is working memory for the next provider request, not a second archival copy.

New blocks store semantic summary core separately from `protectedFragments`.
Provider projection renders the core plus the continuity ledger. Legacy v2
blocks with an inline ledger remain readable; a later roll-up or maintenance
repack extracts their semantic core and re-applies the current continuity
policy without mutating the published old block.

Tool continuity has a block-wide provider-visible byte budget. The default is
64 KiB and can be overridden with
`dcp.compress.maxProtectedToolContinuityBytes`. Actionable failures and mutation
receipts are retained ahead of ordinary shaped evidence. Shaped overflow is
replaced by a deterministic aggregate containing counts, tool classes, source
bytes, changed-file hints, and a manifest hash. Exact fragments are never
silently dropped to satisfy the budget.

Under compression pressure, candidate sizing uses estimated recoverable tokens
after protected-continuity retention rather than treating all source tokens as
recoverable. A single oversized active legacy block may be selected for a
deterministic continuity repack even though normal block consolidation requires
multiple adjacent blocks. Repack preserves the prior semantic summary core and
does not invoke a summarizer model.

## Constraints and failure cases

- Inherited tool continuity is re-normalized only when its `tool:<callId>`
  provenance resolves to a current `ToolRecord`. Missing provenance keeps the
  persisted fragment unchanged.
- If a fragment already records a raw `sourceHash` and the current tool record
  resolves to a different raw-output hash, DCP keeps the persisted fragment
  rather than rebinding evidence to a different execution.
- Legacy fragments without representation metadata are exact until safe
  re-normalization succeeds.
- If exact tool continuity alone exceeds the configured block-wide budget,
  compression fails closed instead of truncating or aggregating exact text.
- Continuity maintenance does not become a model-visible suggestion. When
  `autoCompress` is disabled, repack/consolidation candidates must not suppress
  independent emergency range/body-pruning analysis.
- Automatic repack still uses the normal DCP transaction, exact-membership,
  owner/cancellation, persistence, and positive full-provider-projection gain
  checks. A maintenance candidate is not authority to bypass those checks.
- Published journal blocks remain immutable. A successful repack publishes a
  new block and soft-deactivates the covered old block.

## Implementation

- `external/pi-tools-suite/src/dcp/protected-continuity.ts`
- `external/pi-tools-suite/src/dcp/compression-blocks.ts`
- `external/pi-tools-suite/src/dcp/pruner-candidates.ts`
- `external/pi-tools-suite/src/dcp/auto-compress.ts`
- `external/pi-tools-suite/src/dcp/index.ts`
- `external/pi-tools-suite/src/dcp/pruner-compression-blocks.ts`
- `external/pi-tools-suite/src/dcp/state.ts`
- `external/pi-tools-suite/src/dcp/journal.ts`
- `external/pi-tools-suite/src/dcp/config.ts`
- `external/pi-tools-suite/src/dcp/defaults.ts`

## Tests

- `external/pi-tools-suite/test/dcp-protected-continuity.test.ts`
- `external/pi-tools-suite/test/dcp-protected-continuity-marathon.test.ts`
- `external/pi-tools-suite/test/dcp-manual-progress.test.ts`
- `external/pi-tools-suite/test/compress-pruner.test.ts`
- `external/pi-tools-suite/test/dcp-marathon-replay.test.ts`
- `external/pi-tools-suite/test/dcp-lifecycle-marathon.test.ts`
- `external/pi-tools-suite/test/evals/session-token-efficiency.test.ts`

## Verification

The protected-continuity tests cover mutation/shell receipt shaping,
smaller-of-verbatim behavior, fail-closed exact evidence, inherited legacy
re-normalization, block-wide budgeting/aggregation, retention-aware candidate
sizing, deterministic single-block repack, and a 296-fragment coding-marathon
fixture modeled on the observed long-session failure mode.

The session token-efficiency evaluator replays DCP journal `blockStates` and
uses the same deterministic repack preview as runtime code, so a saved session
can be compared without modifying its JSONL. Full DCP marathon/lifecycle tests
continue to verify restart, exact membership, provider evidence, cancellation,
and bounded long-session behavior.
