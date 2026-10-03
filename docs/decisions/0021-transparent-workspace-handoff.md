# 0021 — Transparent workspace handoff

- Status: superseded
- Recorded: 2026-10-03
- Decided: 2026-10-03
- Owner / approval evidence: user approved the proposed host-mediated
  tool-boundary handoff in this conversation ("давай так и сделаем").
- Governing spec: [Conversation workspace](../../specs/workspace.md)
- Replaces / replaced by: replaces only the whole-run waiting policy in
  [0014 — Transactional workspace rebinding](0014-conversation-workspace-rebinding.md).
  Superseded by [0023 — Remove workspace tool](0023-remove-workspace-tool.md).

## Context

Reported by the user: the old two-phase switch causes the assistant to stop and
ask for another prompt. The requested flow is switch, reload, committed result,
then continue the same task. Conversation identity, journal and rollback must
retain decision 0014's guarantees in both TUI and the RPC host.

## Observations and sources

Verified facts:

- Installed Pi SDK 1.0.0 snapshots `Agent.finishTurn` when a run starts; the
  callback can end the tool batch before another model request. A tool's
  `terminate` hint alone requires every result in the batch to terminate.
- `Agent.continue()` is public, but `AgentSession` has no public continuation
  API that includes its post-run/settlement lifecycle. Pix's RPC pause/resume
  adapter already guards and mirrors that lifecycle.
- ACP completes active prompts on `agent_settled`; emitting the source's
  intermediate settlement would prematurely complete the original request.
- Public `SessionManager.appendContextEdit` and `AgentSession.refreshContext`
  project committed tool content without rewriting the append-only raw journal.
- `tests/workspace-handoff.test.ts` exercises the installed SDK with scripted
  no-network streams, including round-trip handoff and cancellation/rollback.

Assumptions and limits: private SDK lifecycle/loadout/queue hooks are still
version-sensitive. Deterministic tests are not interactive UI evidence.

## Decision

Install a guarded lifecycle adapter before prompts start. On a tool-originated
switch, block remaining old-batch tools, stop at the batch boundary, suppress
intermediate settlement and run the existing staged workspace transaction.
Project the committed result (or unchanged cwd plus failure) into future model
context, then continue without adding a synthetic user prompt.

Prime the replacement's first request with its new instruction/tool loadout and
`before_agent_start` hooks. Transfer undelivered steering/follow-up input with
images after durable commit. Release waiting prompts only after continuation is
active. Cancellation during preparation allows commit but suppresses resumption;
closure never resumes a disposed runtime. Direct host/restore requests retain
idle-only transaction behavior.

Queue-transfer correction (2026-10-03): independent oracle review reproduced
lost follow-ups because the installed SDK queue's `peek()` returns only its
head in one-at-a-time mode. Snapshot the complete queues by temporarily using
`all`, then restore the source modes; do not change target delivery policy.
Transfer after the asynchronous source shutdown hook, immediately before
disposal, to include input enqueued while shutdown awaits. Regression tests
cover multiple messages and images in both modes and input during shutdown.
Head-by-head destructive draining was not chosen: a non-destructive snapshot
keeps source input available until target enqueueing has succeeded.

If rollback's runtime apply or host binding throws, close the host and dispose
both owners instead of continuing an uncommitted/partially restored runtime.
Propagate the failure to the active prompt; catch background commit failures
and make notices best-effort. Normal rollback still resumes the retained source.
This fail-closed choice trades availability for ownership safety; tests cover
both failures and waiter release. Revisit it if the SDK adds recoverable,
transactional rollback primitives.

Keep private lifecycle access isolated in
`src/bundled-extensions/workspace/handoff.ts`, with runtime guards and installed-
SDK regression coverage. The transactional snapshot implementation is unchanged.

## Alternatives

- Add only a triggered completion message: rejected because it creates a new
  logical run and permits premature ACP prompt completion.
- Replace inside tool execution: rejected because the source tool/loop is still
  active, making teardown and settlement waits unsafe.
- Keep whole-run waiting: rejected because it requires the extra user prompt
  reported by the user.

## Consequences

The original task can continue transparently across repeated switch/back calls.
Raw tool history still shows provisional `pending`; the completion notice and
future model context show the final result. More private SDK surfaces now need
upgrade scrutiny, including prompt preparation and queued-input storage.

## Revisit when

- Pi provides a public transactional workspace/session continuation API.
- SDK finish-turn, loadout, settlement or queue contracts change.
- Real UI evidence shows premature completion, lost input or stale resources.
