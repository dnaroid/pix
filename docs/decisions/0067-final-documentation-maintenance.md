# 0067 — Final documentation maintenance without knowledge-state gates

- Status: accepted
- Recorded: 2026-10-11
- Decided: 2026-10-11
- Owner / approval evidence: user requested keeping `knowledge-auditor` before
  completion to update documentation while abolishing knowledge-base dirtiness
  from this workflow, in the current conversation.
- Governing specs: [repository workflow](../../specs/repo-knowledge-agent-workflow.md),
  [todo completion](../../specs/todo-repo-knowledge-finalization.md)
- Replaces: [0046 — Task-scoped knowledge audit completion](0046-task-scoped-knowledge-completion.md)

## Context

The prior workflow required dirty checks, review receipts and exhaustive declared
dependency coverage even for bounded implementation tasks. The user rejected that
ritual but explicitly retained the final documentation specialist.

## Observations and sources

The prior contract is preserved in 0046. The role and todo completion hook enforced
its model-facing instructions. The user's preference above is conversation evidence,
not a measured claim about documentation quality or runtime savings.

## Decision

Keep the final `knowledge-auditor` handoff to update task-affected documentation.
Read relevant source/tests, make small proven documentation repairs, and return
substantial or ambiguous discrepancies to the parent. Remove dirty-state checks,
acknowledgment, index refreshes and exhaustive dependency traversal from this role
and routine completion guidance. The role does not require an initialized index.
Todo has no knowledge reminder hook. Optional repository retrieval and explicit
Desktop knowledge-management features are unchanged.

## Alternatives

- Retain the prior receipt-based workflow: rejected by the user as an unnecessary
  completion ritual.
- Remove the final specialist entirely: considered in the preceding proposal;
  the user explicitly chose to retain documentation maintenance.

## Consequences

Review focuses on actual documentation correctness, without a global-clean claim.
Coverage is deliberately task-scoped, not exhaustive certification of every linked
dependency; broader unrelated drift can remain undiscovered. The parent still owns
uncertain product decisions and documentation blockers.

## Revisit when

Repeated concrete documentation regressions show a gap in task-scoped review, or an
explicit compliance requirement calls for separately scoped review receipts.
