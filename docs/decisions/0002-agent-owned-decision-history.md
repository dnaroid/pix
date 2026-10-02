# 0002 — Agent-owned decision history

- Status: accepted
- Recorded / decided: 2026-10-02
- Owner / approval evidence: user accepted the proposed Markdown decision log
  in this conversation with “ок, давай реализуем это”.
- Governing spec: [repository knowledge workflow](../../specs/repo-knowledge-agent-workflow.md)
- Replaces / replaced by: none

## Context

The preceding subagent-role change preserved the policy and caveats, but not
the concrete reported observations behind the decision. The user requested
durable memory of reasons, not just current behavior.

## Observations and sources

- The gap was identified in this conversation; [0001](0001-subagent-coding-roles.md)
  now records the reported evidence and its limitations retrospectively.
- Existing [knowledge workflow](../../specs/repo-knowledge-agent-workflow.md)
  supports indexed Markdown and a parent-owned reasoning/final-auditor split.
- The user accepted a lightweight template, recording/reading rules and auditor
  checks. No empirical claim that agents will always comply has been made.

## Decision

Keep current contracts in specs and significant rationale in one Markdown file
per decision under `docs/decisions/`. Link both ways, attribute evidence and
preserve old reasoning through explicit supersession. Inject reading/recording
guidance into the parent's repo-aware tool instructions. The parent records
decisions while context is available; the knowledge auditor checks them and
escalates missing rationale without inventing or approving decisions.

## Alternatives

- Specs alone: insufficient to preserve historical reasons independently of
  changing contracts.
- Separate database, UI or new idx document kind: unnecessary for the initial
  requirement because ordinary Markdown is already searchable.
- Reconstruct reasons automatically from code at audit time: rejected because
  implementation cannot establish the actual rationale or rejected alternatives.
- Require records for every edit: rejected to avoid noise from trivial changes.

## Consequences

Low infrastructure cost and reviewable history; a small documentation/handoff
burden for significant choices. Compliance is instruction-based, not a runtime
guarantee. Repo-aware guidance is not guaranteed outside initialized projects;
retrieval remains subject to indexing/exclusions. Evidence must remain honest
even when the only source is an attributed conversation.

## Revisit when

Agents repeatedly omit significant records, stale statuses/links cause mistaken
changes, or decision volume makes ordinary retrieval insufficient. Consider
structural validation or stronger workflow gates then, without claiming that
syntax checks can validate the truth of a rationale.
