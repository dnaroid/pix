# 0026 — Pause-ready adopted continuations

- Status: accepted
- Recorded: 2026-10-03
- Decided: 2026-10-03
- Owner / approval evidence: agent-owned implementation choice for the user's requested fix of disabled Pause after question recovery.
- Governing spec: [Desktop agent pause](../../specs/desktop-agent-pause.md)
- Replaces / replaced by: none

## Context

Extension-originated continuations need a Desktop busy owner so Stop, queueing,
and settlement work, but Pause must be available after the agent starts.

## Observations and sources

- The user reported disabled Pause during automatic continuation after question
  recovery in this task conversation; no durable UI capture is cited here.
- ACP used `resuming` for adopted runs even after `agent_start`; Desktop disables
  Pause in that state. The causal path is in `acp/src/acp/pix-acp-agent.ts`,
  `desktop/src/app/prompt-agent-control.svelte.ts`, and
  `desktop/src/components/PromptComposerActivityRow.svelte`.
- Deterministic coverage lives in `acp/test/agent.test.ts` and
  `desktop/src/app/prompt-agent-control.test.ts`; this is not live UI evidence.

## Decision

Add `running` to the private ACP/Desktop agent-control protocol for already-started
adopted runs. Desktop adopts it as busy without disabling Pause or settling the
owner. Keep `resuming` for startup and keep terminal states responsible for
settlement. Preserve existing normal prompt/Continue behavior.

## Alternatives

- Enable Pause for all `resuming` states: would also enable it before a
  Desktop-initiated continuation starts.
- Publish `idle` after adopting a run: Desktop uses it as a terminal signal and
  could prematurely release ownership and flush queued work.
- Add separate UI flags: duplicates lifecycle meaning across the component prop
  chain instead of fixing the state contract.

## Consequences

Pause availability and busy ownership are independent of startup. ACP and Desktop
must both recognize the added private state, so mixed-version clients may ignore
it. No SDK API or persisted session format changes are required.

## Revisit when

The private protocol gains explicit run-lifecycle metadata, or upstream provides
a supported pause/continuation lifecycle that replaces these states.
