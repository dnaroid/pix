# 0055 — Temporary, isolated BTW side chat

- Status: accepted
- Recorded / decided: 2026-10-05
- Owner / approval evidence: user chose context-only/no-tools mode, temporary
  history and composer ellipsis-menu entry, then requested implementation in this
  conversation. No durable transcript artifact is available.
- Governing spec: [Temporary Desktop BTW](../../specs/desktop-btw.md)

## Context

A side question should explain work without entering the parent's prompt queue,
changing its paused/running state, or creating a second task. The former Session
inspector was removed; BTW is not a restoration of that activity pane. Existing
ModelRuntime streaming and the narrow private RPC-control path supply the model
and credentials without another worker/runtime. These are implementation
observations, not a claim that all provider behavior is identical.

## Decision

Keep one memory-only side conversation per parent runtime. Desktop owns history
and drafts; the runtime prepares a bounded canonical context snapshot and owns
one independent abortable inference. ACP forwards correlated transient events,
not transcript messages or replayable activity snapshots. Only fixed-purpose usage
metadata is persisted to the original session manager.

Opening/hiding the right-hand pane never invokes the model. Questions refresh
completed parent context but the snapshot stays fixed during each response.
Explicit excerpts are data, not permission to invoke tools. Follow-up history is
discarded when its underlying context is replaced. Model choice belongs to BTW
only. Copy/insert is an explicit user action; insertion is draft-only and requires
the correct empty main composer with no attachments.

Cancel/timeout does not release the physical request slot until its provider
settles. Reload/rebind cannot start another request over an abort-ignoring one.
Late results may still contribute usage but cannot restore deleted side memory.

## Alternatives

- Full subagent/fork: creates tools, execution and persistence semantics the user
  explicitly did not choose.
- Reuse parent prompt/queue: risks interruption and contaminates the main history.
- Durable side history: rejected by the user for this iteration.
- Use rendered transcript DOM as context: misses canonical edits/compaction and
  makes presentation the source of truth.
- Reuse the observer controller: its cadence, notices and default-to-silence policy
  are unrelated to an explicit multi-turn side question.

## Consequences and revisit conditions

BTW's model/effort control reuses the statusbar picker and Desktop visibility
preference instead of an unfiltered settings selector. Explicit model/effort
choices remain temporary and side-local; Use main restores inheritance of both.
Only an explicit Manage action saves shared visibility. BTW offers no parent
default-setting action. The runtime validates supported effort per model and
captures it per request instead of hard-coding minimal reasoning.

The request pays for its own bounded context; warm-cache savings are not assumed.
The temporary conversation is deliberately lost on parent runtime closure or app
disconnect. A text answer is not independent verification of the workspace.
Revisit persistence, read-only tools, a general side-inference API or parallel
topics only with an explicit new product requirement and corresponding
lifecycle tests.

Evidence: `acp/test/btw.test.ts`, `acp/test/pi-rpc-btw.test.ts`,
`desktop/src/app/btw.test.ts`, `desktop/scripts/btw-smoke.mjs`.
