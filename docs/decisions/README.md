# Decision log

Specifications describe the current contract; decision records explain why a
significant choice was made and when it should be revisited. These Markdown
files are ordinary repository knowledge, searchable subject to idx exclusions.
No new database, document kind, or automatic enforcement is introduced.

## When to write

Record significant architecture, dependency/model choices, consequential
trade-offs, accepted risks, or rejection of a plausible alternative. Do not
create records for routine edits, formatting or mechanical renames. Link an
existing applicable record instead of duplicating it.

The parent writes the rationale while the evidence and user discussion are
available, not after context is lost. Use [TEMPLATE.md](TEMPLATE.md), one file per
decision named `NNNN-short-topic.md`; choose the next unused number and never
overwrite an existing record. Keep the record concise and link supporting
material rather than copying transcripts. Never include credentials or secrets.

## Evidence and authority

Distinguish directly verified facts, user/agent-reported observations, hypotheses
and expectations. Cite repository-relative specs, tests, reports or commits when
available. For conversation-only evidence, identify the discussion and who
reported it; explicitly say if no durable artifact exists. Do not invent links,
measurements, approval or historical motives from the final implementation.

Each record links its governing spec; the spec links back. Before changing a
contract, read relevant decisions and check their status and replacement links.
An accepted record explains the choice but does not replace the current spec.
Conflicts require clarification, not silently choosing historical behavior.

## Lifecycle and review

Statuses: `proposed`, `accepted`, `superseded`, `withdrawn`. Identify the decision
owner/approval evidence and recording date; distinguish retrospective recording
from the date of the original decision when known. Unknown dates remain unknown.

The parent/user owns acceptance and replacement. When the choice changes, write
a new record linking the old one, mark the old `superseded` and link the successor;
retain its original reasoning. Minor factual/link corrections may be annotated,
but do not rewrite past rationale to fit today's outcome. A withdrawn proposal
is retained with its reason. Revisit triggers initiate review, not automatic
status transitions.

At final handoff, give `knowledge-auditor` the decision paths and rationale, plus
the normal behavior summary and exact task-changed paths; state explicitly when
no new decision was needed. The auditor checks completeness and consistency and
escalates missing/ambiguous rationale. It may repair small proven documentation
errors, not invent or approve decisions.

## Records

- [0001 — Subagent coding roles](0001-subagent-coding-roles.md)
- [0002 — Agent-owned decision history](0002-agent-owned-decision-history.md)

Workflow contract: [repository knowledge workflow](../../specs/repo-knowledge-agent-workflow.md).
