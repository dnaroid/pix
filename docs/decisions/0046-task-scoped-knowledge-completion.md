# 0046 — Task-scoped knowledge audit completion

- Status: accepted
- Recorded / decided: 2026-10-05
- Owner / approval evidence: user approved the task/global separation in this
  conversation with “да, сделай это”.
- Governing specs: [repository knowledge workflow](../../specs/repo-knowledge-agent-workflow.md),
  [todo finalization reminder](../../specs/todo-repo-knowledge-finalization.md)
- Replaces / replaced by: none; clarifies completion without replacing the
  decision-history policy in [0002](0002-agent-owned-decision-history.md).

## Context

Parallel agents share a project-wide knowledge dirty signal, but each owns only
its supplied task changes. Completion must not depend on unrelated work.

## Observations and sources

- User-reported in this conversation: an agent's audit todo often remains open
  after its own review because other agents keep the knowledge base dirty. No
  durable incident artifact or measured frequency was supplied.
- Verified in [todo/index.ts](../../external/pi-tools-suite/src/todo/index.ts):
  the finalization reminder is advisory; it does not run `idx` or gate completion.
- The prior auditor wording already recognized that a remaining global `yes`
  could be unrelated, but parent/catalog/todo instructions did not explicitly
  separate todo completion from global cleanliness. Model compliance remains
  instruction-based, not a runtime guarantee.

## Decision

Return task audit passed/blocked independently from global dirty yes/no/unknown.
Close the audit todo when task evidence, genuinely affected specs, required
dependency coverage and eligible acknowledgments are complete. Report residual
global dirtiness/errors separately; an unclassified `yes` alone is not a blocker
and cannot be attributed to other agents without evidence. Preserve blockers
for missing task coverage, drift and edits to reviewed specs/dependencies,
including shared files. Never acknowledge unrelated specs or claim the whole
knowledge base is clean merely because one task passed.

Apply this to the auditor, parent catalog, repo-audit fallback and todo reminder.
Keep Desktop's project-wide dirty indicator and global AI review unchanged.

## Alternatives

- Require global `no`: couples independent tasks and can prevent completion
  indefinitely while other agents work.
- Bulk-acknowledge to clear `yes`: would certify unreviewed work.
- Ignore all remaining dirtiness or concurrent edits: hides missing task
  evidence and stale reviews of shared dependencies.
- Introduce task receipt storage/new idx commands: unnecessary for this
  instruction-level issue; would require a separate CLI/concurrency contract.

## Consequences

Expected: independent tasks can finish without waiting for global cleanliness.
Residual global state stays visible and unresolved task evidence still blocks
success. Deterministic tests verify instruction delivery and advisory todo
behavior; they cannot prove every model will comply. Existing acknowledgment
commands do not introduce new atomic cross-agent snapshot guarantees here.

## Revisit when

Models still conflate verdicts, shared-dependency races cannot be resolved with
re-review, or task-local machine-readable receipts become necessary.
