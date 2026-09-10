# Desktop agent pause and continuation

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Give Pix Desktop the same turn-boundary pause/continue workflow as the TUI and expose continuation when an agent run stops at another resumable boundary such as the configured turn/request limit.

## Scope

- Show a pause control next to Desktop's stop control while an agent run is active.
- Pause only after the current agent turn has completed; do not abort an in-flight tool batch.
- Show a continue control when the session is paused or an idle transcript is otherwise resumable.
- Continue the same Pi agent transcript without inserting an artificial user message.
- Keep the control state scoped to the owning Desktop session.

## Behavior

- While a normal Desktop prompt or continuation is running, the composer shows Pause and Stop controls together.
- Pause changes the session to `pause-requested` immediately and becomes disabled until Pi reaches the next turn boundary or the run finishes naturally.
- A successful turn-boundary pause changes the session to `paused`; once the prompt request settles, the composer shows Continue instead of Pause/Stop.
- When a run becomes idle with a non-assistant transcript tail or queued Pi message, Desktop reports `continuable`. This covers turn/request-limit stops that leave Pi at a resumable boundary.
- A normal completed assistant response is `idle` and does not show Continue.
- Explicit Stop/cancel clears the continuation affordance; cancellation is not treated as pause.
- Desktop's deferred/auto queue does not consume another message while the session is `pause-requested`, `paused`, `continuable`, or `resuming`; advancing past those boundaries requires Continue or a new explicit user prompt.
- Continue invokes `Agent.continue()` through the Pix RPC shim and then uses Pi's normal post-run retry, compaction, queue-draining, and settlement bookkeeping.
- While continuation is active, Desktop treats the session as running, so Stop can cancel it and Pause can be requested again after the resumed run starts.
- Loading, importing, or switching a live session recomputes whether its current transcript is resumable. A previously paused boundary may therefore rehydrate as the equivalent `continuable` state rather than preserving the in-memory `paused` label.

## Protocol bridge

- Desktop uses the private `pix/session/agent_control` ACP request with `state`, `pause`, and `continue` actions.
- ACP publishes session-scoped state changes over the existing private `pix/session-state` notification on the `agent-control` channel.
- The default ACP Pi entry is a thin Pix RPC shim around the pinned Pi RPC runtime. It intercepts private control messages before they can enter the transcript and implements the TUI pause algorithm with `Agent.shouldStopAfterTurn` and `Agent.continue()`.
- Explicit `PIX_ACP_PI_ENTRY` overrides remain supported, but a replacement entry must implement the Pix control shim for Desktop pause/continue to work.

## Related files

- `src/app/session/agent-pause-controller.ts`
- `acp/src/pi/pix-rpc-entry.js`
- `acp/src/pi/pi-rpc-client.ts`
- `acp/src/acp/desktop-commands.ts`
- `acp/src/acp/pix-acp-agent.ts`
- `desktop/src/lib/agent-control.ts`
- `desktop/src/lib/acp-client.ts`
- `desktop/src/App.svelte`
- `desktop/src/components/PromptComposer.svelte`

## Verification

- ACP tests cover pause-requested to paused state and generic resumable-stop to continuation flow.
- Desktop tests cover the private ACP control request and session-state parsing.
- ACP typecheck/tests/stdio smoke and Desktop Svelte/TypeScript checks pass.

## Risks / compatibility

- The turn-boundary implementation intentionally relies on private `AgentSession` bookkeeping because the pinned Pi RPC API does not expose pause/continue. The shim validates the expected private surface and must be reviewed when the Pi SDK is upgraded.
- Provider `max_tokens` responses that end on an assistant message are not considered resumable by `Agent.continue()` and therefore do not show Continue; the resumable limit case is the agent-loop turn/request boundary that leaves a user/tool-result tail or queued message.
