# Spec: DCP emergency current-turn pruning

## Type

Change.

## Goal

Prevent one long active user turn from exhausting the provider context when an
active compression block already covers all older turns and the normal range
and message candidate detectors therefore return nothing.

## Scope

- Emergency context reminders without a normal candidate.
- Persisted emergency-pressure and provider-exposure state.
- Emergency-only same-turn message candidates for old large tool results.
- Deterministic placeholder pruning when reminders are ignored or usage reaches
  the hard emergency threshold.
- Bounded private diagnostics for the decision and pruning result.

## Non-goals

- Summarising the unfinished active turn as one broad range.
- Changing normal multi-turn candidate or auto-compress behavior.
- Setting normal `autoToolPruning.keepRecentTurns` to zero.
- Mutating the raw session transcript; pruning affects provider context only.

## Behavior

1. Above the model-specific emergency threshold, DCP emits and re-applies a
   context reminder even when normal candidates are absent.
2. Emergency-only message suggestions may select old, large, complete
   assistant tool-call/result pairs from the active turn.
3. The newest configured number of complete pairs, results not yet included in
   an accepted provider request, user messages, protected tools/files/tags, and messages
   covered by compression blocks are never emergency candidates.
4. If emergency pressure persists beyond patience, or reaches the configured
   hard context percentage, DCP replaces eligible result bodies with the
   existing pruning placeholder. It processes deterministic oldest-first
   candidates and stops once the target recovery budget is met.
5. The emergency counter resets only after pressure drops below the emergency
   threshold, a successful compression/prune, a context-window change, or a
   session reset.

## Contracts

The shared DCP config gains `strategies.emergencyCurrentTurnPruning` with an
enable flag for same-turn candidates/lossy pruning, hard and target context percentages, patience, recent-pair count,
minimum output size, suggestion cap, and extra protected tools. Missing config
uses safe defaults. Emergency reminders remain active when lossy pruning is
disabled. Sidecars accept missing new fields for backward
compatibility.

Diagnostics use distinct events:

- `context.strong_nudge_without_candidate`
- `compress.auto_blocked_no_candidate`
- `prune.emergency_current_turn`

## Invariants

- User messages are never selected or pruned.
- Tool-call/result structural pairs remain valid because only result content is
  replaced.
- A new result is not pruned before an accepted provider request included it.
- The newest complete pairs and all configured/protected data survive.
- Pruning is deterministic, idempotently accounted, and stops at its budget.

## Related files

- `src/dcp/index.ts`
- `src/dcp/pruner-emergency.ts`
- `src/dcp/pruner-candidates.ts`
- `src/dcp/pruner-tools.ts`
- `src/dcp/config.ts`
- `src/dcp/state.ts`
- `test/compress-pruner.test.ts`
- `test/dcp-state-serialization.test.ts`
- `test/dcp-config.test.ts`

## Verification

Focused regression and safety tests, full suite tests, headless smoke, root
`npm run check`, SDK-pin check, `git diff --check`, and a headless one-turn
reproduction that confirms estimated provider-visible tokens fall before the
model limit.

## Risks / unknowns

Token recovery is estimated from message text, so the exact provider token
count can differ. The hard fallback therefore targets a margin below the
model-specific emergency threshold instead of an exact token boundary.

## Evidence

- Confirmed by current code: normal candidate detectors protect at least the
  latest user turn; reminders and auto-compress are candidate-gated.
- Confirmed by regression test: an active block plus one long turn produces no
  normal candidate at emergency pressure.
- Intended behavior: emergency candidate selection, persistence, fallback, and
  diagnostics described above.
