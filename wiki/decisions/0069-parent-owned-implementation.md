# 0069 — Parent-owned implementation and a smaller role pool

- Status: accepted
- Recorded: 2026-10-11
- Decided: 2026-10-11
- Owner / approval evidence: user approved tighter delegation after discussing
  duplicated context/cost and explicitly selected removal of both bundled
  `implement` and `delivery-review` in this task conversation.
- Governing spec: [async-subagents](../tools/agents/async-subagents.md),
  [parent-first routing](../tools/agents/parent-first-subagent-routing.md)
- Replaces / replaced by: supersedes [0001](0001-subagent-coding-roles.md)

## Context

A default implementation worker encourages paying for both parent discovery and
worker rediscovery. The prior policy allowed substantial independent parallel
work without requiring evidence that the handoff itself was useful. Separate
delivery review overlapped focused research and the parent's integration role.

## Observations and sources

- **Verified configuration:** the former bundled pool included `implement`
  (Luna then Sol), `implement-core` (Sol), `mechanical` (GLM), and a separate
  `delivery-review`. See the historical [0001](0001-subagent-coding-roles.md).
- **User concern, not measured result:** duplicated context and coordination can
  erase savings from lower worker token prices. No matched cost or capability
  benchmark was supplied; removing roles does not prove a cost reduction.
- **Current executable contracts:** [policy](../../external/pi-tools-suite/src/async-subagents/core/agent-strategy.ts),
  [retirement tests](../../external/pi-tools-suite/test/async-subagents/retired-roles.test.ts),
  [model candidates](../../external/pi-tools-suite/test/async-subagents/model-pools.test.ts),
  and [selection evals](../../external/pi-tools-suite/test/evals/delegation-policy.ts).

## Decision

The parent implements by default. Code handoff requires explicit user delegation,
a concrete capability gap in the implementation itself, or sufficiently large
prescribed mechanical work with deterministic checks and expected net savings.
Architecture uncertainty gets a bounded read-only oracle opinion first when
needed; that opinion is not permission to transfer implementation. Size,
parallelism, token price, and model tier alone are not grounds.

Remove bundled `implement` and `delivery-review`, without aliases or deletion of
project-local roles. Keep seven roles: `implement-core`, `mechanical`, `research`,
`verify`, `ui-qa`, `oracle`, and `knowledge-auditor`. Readiness evidence review
uses `research`; the parent owns the final decision. Existing mandatory real UI
QA, complex architectural review, and final documentation gates remain intact.
Model candidates for retained roles do not change.

## Alternatives

- Keep `implement` as an explicitly requested general coder: not selected by the
  user; the remaining `implement-core` can cover explicit implementation requests.
- Keep `delivery-review`: not selected; focused evidence review fits `research`
  without creating a second general review role or transferring release authority.
- Delegate whenever work is parallelizable: rejected because reduced wall time
  does not establish lower total cost or a capability advantage.

## Consequences

The default catalog is smaller. Old explicit role names fail unless locally
defined, so callers must use the effective catalog. Explicit ordinary coding
handoffs now use Sol through `implement-core`, which may cost more than Luna;
avoiding unnecessary handoffs, not universally cheaper workers, is the goal.
Savings remain an expectation, not a measured outcome. Prompt guidance cannot
enforce a capability assessment or automatically price coordination overhead.
Lazy session-context references were discussed but are not implemented here.

## Revisit when

Comparable completed tasks establish total cost per accepted verified change,
including duplicate context, briefing, failures, review, rework and integration,
or demonstrate recurring needs not covered by the remaining roles. Reconsider
if explicit Sol handoffs outweigh the savings from keeping ordinary work local.
