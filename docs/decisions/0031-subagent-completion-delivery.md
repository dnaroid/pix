# 0031 — Single-channel subagent completion delivery

- Status: accepted
- Recorded: 2026-10-04
- Decided: 2026-10-04
- Owner / approval evidence: user approved the proposed single-delivery behavior in this task conversation.
- Governing spec: [async-subagents — Parent completion delivery](../../specs/async-subagents.md#parent-completion-delivery)
- Replaces / replaced by: none

## Context

Automatic completion follow-ups wake an idle parent or queue another turn for a
busy parent. A parent intentionally waiting through `wait` or a `spawn` watch can
otherwise receive the same completion both as a tool result and a queued wakeup.

## Observations and sources

The entrypoint previously removed a tracked child before sending its follow-up,
deduplicating callback/watcher reconciliation but not coordinating with polling
tool responses. `polling.ts` returns its last state on timeout or abort; that
snapshot may not contain a completion which occurs immediately afterward.
In-process finality belongs to the retry/fallback callback, not an intermediate
disk receipt. These are source observations, not production incident measurements.

## Decision

Use per-launch, session-scoped in-memory reservations shared by the entrypoint
and `wait`/`spawn`. Defer follow-ups while a relevant tool call is collecting.
Consume only terminal states in its successfully constructed final response,
then release reservations and reconcile synchronously. Abort/error acknowledges
nothing; timeout/fail-fast acknowledges only the completed subset actually
returned. Do not treat progress updates as delivery. Preserve the final-callback
gate when polling in-process launches.

Do not retract already queued follow-ups or add a persistent delivery ledger.
Explicit repeated result/status/wait requests still return the requested state.

## Alternatives

- Suppress notifications whenever any wait runs: rejected because unrelated
  agents/sessions and timeout/abort boundaries would lose notifications.
- Deduplicate only callback vs watcher: existing behavior; it does not cover the
  tool response channel.
- Cancel queued follow-ups afterward: not chosen; reserving before collection
  avoids requiring queue removal or SDK changes.

## Consequences

One pending completion is consumed by a collecting tool response or delivered
as a follow-up. Overlapping calls and agent ID reuse require reference-scoped
reservation bookkeeping. The guarantee is local to the current extension
instance, not crash-consistent delivery across reloads. A long wait can defer a
selected child's notification until the call exits.

## Revisit when

Durable completion replay is required, queued follow-ups must become retractable,
or runtime tool-result acceptance requires an acknowledgement beyond successful
tool execution. Regression coverage is in
`external/pi-tools-suite/test/async-subagents/completion-delivery.test.ts`.
