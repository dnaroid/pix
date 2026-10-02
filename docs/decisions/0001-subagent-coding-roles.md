# 0001 — Separate default, core and mechanical subagent coding

- Status: accepted
- Recorded: 2026-10-02 (retrospective)
- Decided: 2026-10-01, in the preceding subagent-role change discussion
- Owner / approval evidence: user requested the Luna/Sol/GLM split and selected
  the common pi-tools-suite rather than project-local overrides.
- Governing spec: [async-subagents](../../specs/async-subagents.md)
- Replaces / replaced by: none

## Context

The previous default implementer used GLM-5.3 followed by Sol. We needed a
bounded coding policy that reduces unaccepted migration work without sending
every task to Sol. The orchestration itself also needed earlier verification.

## Observations and sources

- **Reported observations:** the user-provided assessment at the start of this
  session described GLM repeatedly leaving migrations unfinished after timeouts,
  introducing incompatible interfaces/type errors and sometimes weakening tests
  instead of preserving regression meaning. It also acknowledged orchestration
  responsibility: migration scopes were too broad and checks too late. These
  are attributed reports, not a controlled benchmark; original migration
  diffs/logs were not attached to this record.
- **Reported review evidence:** the same assessment stated that Luna found a
  lost hidden-blocker check and weakened tests. This is useful review evidence,
  not proof of implementation quality on equivalently sized tasks.
- **Verified policy sources:** [role definitions](../../external/pi-tools-suite/src/async-subagents/agents/),
  [candidate contracts](../../external/pi-tools-suite/test/async-subagents/model-pools.test.ts)
  and [routing eval](../../external/pi-tools-suite/test/prompt-evals/async-routing-e2e.test.ts).
  These cover configuration/routing, not comparative coding quality or cost.
- **Limits:** no matched implementation benchmark or accepted-work cost dataset
  was established. Timeout alone does not demonstrate model weakness.

## Decision

In the bundled suite, use Luna as default `implement` coder with Sol as the
availability/quota fallback; use Sol-only `implement-core` for complex core
changes and ambiguous bugs, and GLM-5.3-only `mechanical` for small prescribed
behavior-preserving edits with deterministic checks. Code/delivery review uses
Sol, without a GLM fallback. Existing review visibility gates remain intact.

Research, verify, UI QA, docs-only knowledge auditing and cross-vendor oracle
policies remain separate and unchanged. This is not a global ban on GLM.
Project overrides retain their normal precedence.

Require coherent migration slices, early affected typechecks and regressions,
preserved negative/hidden-blocker checks and honest partial-work handoffs.
Prompt instructions do not guarantee checkpointing or rollback after timeout.

## Alternatives

- Keep GLM as default coder: not chosen because of the reported unaccepted
  migration work and regression weakening; retain it for narrow mechanical work.
- Use Sol for all implementation: not chosen because the available evidence
  did not establish that its additional cost was justified for ordinary tasks.
- Treat Luna's review success as proof of coding superiority: rejected as an
  unsupported inference. Luna-first is a starting policy to evaluate.
- Only change model names: insufficient; broad scopes and late verification
  were also implicated, so the policy includes orchestration safeguards.

## Consequences

Expected benefit: clearer task boundaries and less risky migration/review
assignment. Sol-only roles lose automatic alternative-model availability.
Luna's comparative implementation quality and total cost remain uncertain.
Parents must inspect partial diffs after timeouts rather than accepting them
or blindly retrying on a stronger model.

## Revisit when

Comparable bounded tasks provide evidence on accepted verified changes, failed
attempts, review findings, rework, total cost and latency. Reconsider if Luna
repeatedly needs costly repairs, Sol's total accepted-work cost is better, or
GLM demonstrates reliable semantic work under the same scope/check discipline.
Do not change policy from token price or isolated timeout counts alone.
