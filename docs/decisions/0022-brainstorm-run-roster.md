# 0022 — Run-only council roster and effort

- Status: accepted
- Recorded: 2026-10-03
- Decided: 2026-10-03
- Owner / approval evidence: the user chose extra `provider/model:effort`
  arguments before launch rather than a UI picker, then requested implementation.
  Conversation-only evidence; no separate durable transcript artifact is cited.
- Governing spec: [brainstorm](../../specs/brainstorm.md)
- Replaces / replaced by: none; extends [0017](0017-brainstorm-v4-protocol-storage.md)
  with an opt-in run override. Configured default selection remains unchanged.

## Context

The user wants to choose cheaper participants for council tests without editing
the default roster. The five-round lifecycle and persistent Desktop sessions
already retain a configuration snapshot.

## Observations and sources

The existing workflow snapshots roster and thinking before paid work, and review
loads that snapshot. [Run-model regressions](../../external/pi-tools-suite/test/brainstorm/run-models.test.ts)
exercise that path in both execution modes. Cheaper testing is the intended use,
not a measured cost/quality claim; no paid run validates this change.

## Decision

Add leading `--models provider/model:effort,...` and a corresponding optional
`models` array on tool `run`. Require effort on each entry to avoid accidentally
inheriting expensive exact/bare-model defaults. Keep 2–6 distinct exact models,
order, no substitution, and existing availability/auth policies. Merge into a
defensive copy; save the effective config in the existing manifest. Reject roster
arguments on review/finalize. Keep explicit quorum policy rather than silently
lowering it for smaller rosters. The parent forwards the user's override; this
does not authorize the parent to choose a different council on its own.

## Alternatives

- A UI picker: not chosen; the user selected command arguments.
- Editing config before tests: changes unrelated future councils.
- Mid-run roster changes: would break same-participant critique/revision lineage.

## Consequences

No new manifest format, settings schema or Desktop control is needed. Explicit
efforts are more verbose but predictable. Slash-to-tool forwarding still relies
on the parent following instructions. Provider support and cost are not inferred
from syntax. An incompatible explicit quorum remains an actionable error.

## Revisit when

Live use shows roster-forwarding errors, demand for a picker, or frequent quorum
configuration friction. Revisit only with evidence, not automatic fallback.
