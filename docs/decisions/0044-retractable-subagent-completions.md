# 0044 — Retractable parent completion delivery

- Status: accepted
- Recorded: 2026-10-04
- Decided: 2026-10-04
- Owner / approval evidence: user approved prevention of duplicate final reports and requested implementation in this task conversation.
- Governing spec: [async-subagents — Parent completion delivery](../../specs/async-subagents.md#parent-completion-delivery)
- Replaces / replaced by: supersedes [0031](0031-subagent-completion-delivery.md)

## Context

A completion placed in the SDK follow-up queue cannot be retracted by the
extension if the parent subsequently reads the result and finishes its answer.
Wait/watch reservations alone do not cover direct result retrieval or a full
artifact read after completion has already been queued.

## Observations and sources

The user-supplied session ending in `01a1090b-c884-70da-a7cc-728952e7ccc5`
was inspected during this conversation: the parent read the audit artifact,
issued a final answer, then received a completion follow-up and produced a
second answer saying the audit was already accounted for. This was a second
model turn, not duplicate rendering.

Installed SDK 1.0.2 exposes `agent_before_settle` custom-message drafts and a
continuation flag after automatic work, plus `ctx.isIdle()`. Its streaming
`sendCustomMessage` immediately delegates follow-ups to the agent queue.
Those are source observations, not an assumption that SDK queues are cancellable.

## Decision

Keep busy-parent completions in the extension-owned live-launch map until the
pre-settlement boundary. Revalidate session ownership, final callback state and
collection reservations there, then deliver unconsumed completions as one
boundary continuation. Retain idle wakeups and watcher recovery for late arrivals.

Extend existing session/launch-scoped collection reservations with successful
`result` tool receipts and full registered `result.md` reads. Capture the final
state before execution; compare final status/exit code and, for artifact reads,
the complete returned text with the bounded artifact before and after execution.
Do not acknowledge partial, changed, failed, aborted or nonterminal reads.
Inspect final `tool_execution_end` evidence after every `tool_result` transform,
not an intermediate hook's view that a later extension can truncate or reject.
Clear outstanding read reservations on session replacement/shutdown.

## Alternatives

- Suppress all notifications after a final answer: rejected; genuinely new late
  results and failures still require attention.
- Ask the model not to answer twice: rejected as the primary fix; it still incurs
  a duplicate provider request and does not arbitrate consumption.
- Modify private SDK queues: rejected; public settlement APIs suffice without
  coupling the suite to runtime internals.
- Persist a completion ledger or aggregate multi-page reads: outside this scope.

## Consequences

Busy-parent notifications can wait until settlement, but can be consumed by a
later collecting tool without an extra report. Full artifact reads add bounded
asynchronous IO. Result acknowledgement remains evidence of successful tool
execution, not proof of model comprehension or outer-script output. Explicit
repeated retrieval still works. Guarantees remain per extension instance; this
does not provide crash-consistent replay or retract messages already delivered.

## Revisit when

Durable replay, multi-page artifact acknowledgement, outer-script delivery
acceptance, or cancellation after boundary commitment becomes a requirement.
Regression coverage lives in
`external/pi-tools-suite/test/async-subagents/completion-delivery.test.ts`.
