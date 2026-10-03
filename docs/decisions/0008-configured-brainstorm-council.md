# 0008 — Configured brainstorm council instead of a local skill

- Status: superseded
- Recorded: 2026-10-03
- Decided: 2026-10-03
- Owner / approval evidence: user selected a shared pi-tools-suite extension with
  explicitly configured models, requested the initial roster from the current
  frontier configuration, and explicitly requested removal of the local skill.
- Governing spec: [brainstorm](../../specs/brainstorm.md)
- Replaces / replaced by: no predecessor (the provisional local skill had no decision record); superseded by [0009 — Five-round brainstorm](0009-five-round-brainstorm.md), which retains the extension/explicit-roster choice and replaces the two-round protocol.

## Context

The desired flow collects independent model proposals, cross-critiques them and
has the parent preserve both agreements and dissent in a persistent proposal.
It must not automatically start implementation. A local prompt-only skill was
initially authored, then superseded by the user's extension/configuration choice.

## Observations and sources

- Verified source: [async-subagents](../../specs/async-subagents.md) already owns
  isolated execution, model availability/policy checks, concurrency, usage,
  retries and cancellation. Explicit task models clear fallback candidates.
- Verified configuration at implementation time: the user's frontier list had
  Astra, GLM-5.3, Opus 5.5 and Gemini 3.8 Flash. These references seed the new
  explicit list; they are not a runtime selector or a quality ranking.
- User direction is conversation evidence. No live council quality/cost
  comparison or paid evaluation was conducted for this choice.

## Decision

Add a shared module and `/brainstorm` entrypoint, with a separate
`brainstorm.models` roster, two bounded rounds and parent synthesis. Reuse the
existing subagent tool through SDK nested execution, not a second process runner.
Use the research role with read-only tools and no model fallback. Persist brief,
discussion, pending/final proposal and status manifest; reject finalization of
incomplete runs. Remove the provisional local skill rather than maintaining two
potentially divergent entrypoints.

## Alternatives

- Keep only the local skill: rejected by the user's extension choice; it would
  leave roster selection and orchestration more dependent on prompt adherence.
- Re-select frontier models each invocation: rejected by the user's preference
  for explicit configuration. Frontier-role changes must not silently alter a
  council's participants or spend.
- Implement a separate child-process runner: unnecessary duplication of existing
  lifecycle, policy and accounting responsibilities.
- Iterative debate until unanimity: not selected; bounded critique preserves
  dissent and gives a predictable baseline run count, not forced agreement.

## Consequences

The workflow and roster are reproducible at the configuration level. Provider
availability remains a prerequisite, and one unavailable participant fails the
council rather than silently substituting another. Two rounds increase cost and
latency; comparison quality and prompt adherence remain unverified with live
models. Parent synthesis is explicit and does not authorize implementation.

## Revisit when

Live evidence shows missing diversity, repeated availability failures, excessive
cost/latency, weak critique, or demand for resumable rounds. Update the explicit
roster deliberately, and benchmark before adding automatic judges or more rounds.
