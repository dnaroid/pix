---
kind: spec
status: active
---

# DCP protected continuity

## Behavior

DCP separates raw-result deletion safety, explicit exact pins, and semantic
continuity. Unknown effects are treated conservatively: DCP cannot safely
classify every extension tool. Results that need continuity get facts-oriented
receipts/digests, while ordinary observations and runtime progress are left for
semantic summaries rather than copied into the ledger.

When a continuity-worthy tool result enters a compression block, DCP keeps a
bounded, deterministic action receipt/digest, not a verbatim transcript:

- explicit prompt/user protections remain exact;
- outputs explicitly pinned by `compress.protectedTools` or matching
  `protectedFilePatterns` remain exact; these are empty by default;
- action receipts preserve source tool/call identity, outcome (including
  `UNKNOWN` where an effect cannot be established), relevant paths, status and
  available log/run/code-version references;
- simple test/build digests are explicitly historical observations, not current
  verification; observations and todo/result progress are not retained as
  append-only event history, because their conclusions belong in semantic
  summaries;
- there is no hardcoded verbatim-tool list or smaller-of-verbatim rule. The
  separate raw-deletion guard protects effects that lack a replacement fact.

The raw Pi session remains the exact historical source. Compression continuity
is working memory for the next provider request, not a second archival copy.
Recovery rehydrates raw tool-result text byte-for-byte like live capture,
including empty/whitespace results and adjacent text parts; it does not add
presentation separators.

Repeated safe inspections can be superseded where the newest result is enough;
test/build runs are not latest-run-wins because they may cover different code
revisions. Mutations, unknown commands and effects are never safely treated as
repeatable observations.

New blocks store semantic summary core separately from `protectedFragments`.
Provider projection renders the core plus the continuity ledger. Legacy v2
blocks with an inline ledger remain readable; a later roll-up or maintenance
repack extracts their semantic core and re-applies the current continuity
policy without mutating the published old block.

Tool continuity has a block-wide provider-visible byte budget. The default is
16 KiB and can be overridden with
`dcp.compress.maxProtectedToolContinuityBytes`. Actionable failures and mutation
receipts preserve their required minimum text (`minimumText`) while optional
evidence may be removed. For simple test/build digests the floor includes the
execution outcome, parsed counts and parser caveats when available, plus a
bounded diagnostic excerpt (up to 768 characters); the full compact parsed
output is not retained. Up to the first two parsed diagnostics are included
within that total bound, with an explicit omitted-diagnostic count and a
recover-source instruction when more exist; if no parsed diagnostics exist,
bounded error evidence is the fallback. This floor survives budgeting and
journal replay; if the floors exceed the budget, compression fails closed. There is no
anonymous overflow aggregate and no silent loss of action identity or outcome.

Under compression pressure, candidate sizing uses estimated recoverable tokens
after protected-continuity retention rather than treating all source tokens as
recoverable. A single oversized active legacy block may be selected for a
deterministic continuity repack even though normal block consolidation requires
multiple adjacent blocks. Repack preserves the prior semantic summary core and
does not invoke a summarizer model.

## Constraints and failure cases

- Inherited tool continuity is re-normalized only when its `tool:<callId>`
  provenance resolves to a current `ToolRecord`. Missing provenance keeps the
  persisted fragment unchanged; legacy fragments without representation
  provenance cannot be reshaped speculatively.
- Pin ownership is released only through a replacement block covering the
  sources; a missing source record cannot be silently downgraded to an
  unpinned/optional fragment.
- Expanded artifact pins carry policy-v3 owner call ID and raw-output hash
  provenance. A replacement can release one only when the owner record's raw
  output hash verifies and current configuration no longer pins that output;
  missing, legacy, or mismatched provenance remains retained.
- If a fragment already records a raw `sourceHash` and the current tool record
  resolves to a different raw-output hash, DCP keeps the persisted fragment
  rather than rebinding evidence to a different execution.
- Legacy fragments without representation metadata are exact until safe
  re-normalization succeeds.
- Explicit pins are exact. `protectedTools` and `protectedFilePatterns` replace
  earlier values (including model-override layers); an explicit empty list
  releases those pins. They are separate from the conservative guard against
  deleting an effect without a replacement fact.
- If exact pins or required action-fact safety floors exceed the configured
  block-wide budget, compression fails closed instead of truncating or
  aggregating them. When eligible policy-v3 receipt minimums alone would
  overflow it, DCP may replace those receipts with one compact policy-v4
  reference to their source identities; explicit pins and unproven legacy
  records stay inline.
- A reference reuses the original session JSONL, not a second archive. Its
  source addresses are raw tool-call identity proofs or immutable non-reference
  journal leaves. Recovery uses `session action=read entry_id="dcp:bN"` on the
  active branch and bounded `nextCursor` pages. Changed/missing sources fail
  closed as UNKNOWN; recovered actions must not be blindly repeated, and
  historical tests are not current verification.
- Continuity maintenance does not become a model-visible suggestion. When
  `autoCompress` is disabled, repack/consolidation candidates must not suppress
  independent emergency range/body-pruning analysis.
- Automatic repack still uses the normal DCP transaction, exact-membership,
  owner/cancellation, persistence, and positive full-provider-projection gain
  checks. A maintenance candidate is not authority to bypass those checks.
- Published journal blocks remain immutable. A successful repack publishes a
  new block and soft-deactivates the covered old block.

## Verification

The protected-continuity tests cover mutation/shell receipt shaping,
exact opt-in pins, fail-closed action-fact floors, inherited legacy
re-normalization, block-wide budgeting, retention-aware candidate
sizing, deterministic single-block repack, and a 296-fragment coding-marathon
fixture modeled on the observed long-session failure mode.

The session token-efficiency evaluator replays DCP journal `blockStates` and
uses the same deterministic repack preview as runtime code, so a saved session
can be compared without modifying its JSONL. Full DCP marathon/lifecycle tests
continue to verify restart, exact membership, provider evidence, cancellation,
and bounded long-session behavior.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"388112e19a79431444ac06d39d8e89c9bea9aada1e753e6af79ae3607b9e3c70","checkedAt":"2026-10-31T01:23:43.990Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":51,"reportLanguage":"ru"} -->
