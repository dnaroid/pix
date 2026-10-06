# 0050 — Bounded global AI knowledge cleanup

- Status: accepted
- Recorded / decided: 2026-10-05
- Owner / approval evidence: user clarified that Desktop AI review must make the
  knowledge base clean, then approved implementation with escalation so the
  session does not work forever. The two-pass budget is the implementing agent's
  bounded policy choice, not a separately user-selected numeric limit.
- Governing spec: [Desktop IDX panel](../../specs/desktop-idx-panel.md)
- Replaces / replaced by: none; complements the distinct
  [task-scoped audit completion](0046-task-scoped-knowledge-completion.md) policy.

## Context

Desktop's AI review starts a new session for global knowledge maintenance.
Unlike a task audit, its objective is global cleanliness. Parallel edits can
prevent that objective from being reached safely in one session.

## Observations and sources

- [The existing prompt](../../desktop/src/app/project-actions.svelte.ts) checked
  dirty state and prohibited false clean claims, but lacked an explicit pass
  limit, escalation/resumption policy and distinction from task-audit success.
- User requirement in this conversation: global cleanliness remains the goal;
  escalate rather than run forever. No durable incident log or measured
  convergence data was supplied.

## Decision

Set global success to a complete exit-0 final dirty check returning `no`.
Allow one initial pass plus at most one corrective pass for known, safe,
unblocked gaps. Stop early on success and escalate immediately on blockers;
otherwise escalate at the limit. Report remaining state and a concrete next
user action, defer the global cleanup todo and end autonomous work until the
user explicitly resumes. No polling, delegated retry loops or new sessions to
bypass the limit. Do not acknowledge actively changing dependencies or force
cleanliness by certifying unreviewed work.

This changes the generated prompt and its contract tests, not the UI session
lifecycle, task-scoped audit policy, CLI or runtime timeout enforcement.

## Alternatives

- Loop until global `no`: unbounded during parallel edits or persistent errors.
- Count task review success as global cleanup success: misstates the objective.
- One pass only: omits a bounded opportunity to repair identified residual gaps.
- Add a runtime watchdog: requires separate cancellation/session semantics;
  not needed for this requested prompt-level escalation policy.

## Consequences

Global cleanup can end blocked instead of clean; its useful completed review
remains visible. The cap bounds review passes, not execution time or individual
tool calls. Tests verify the exact dispatched prompt, not model compliance.

## Revisit when

Observed sessions ignore escalation, a hard runtime budget is required, or
real convergence evidence supports a different corrective-pass limit.
