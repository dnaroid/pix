---
kind: spec
status: active
---

# Conversation workspace — tool removed

## Behavior

Pix TUI and Pix Desktop do not provide the bundled `workspace` tool.
The former `current`, `switch` and `back` actions, return stack, transactional
runtime rebinding and transparent model continuation are removed.

Ordinary project opening, session operations, context reload and workspace undo
are unchanged. Legacy `workspace` state envelopes do not mutate ACP session cwd,
the translator, persisted session-map records or Desktop catalog cwd. Historical
`pix.workspace` journal entries remain untouched, but are no longer restored by
a workspace host. Running processes must restart to unload the removed tool.

See [the removal decision](../docs/decisions/0023-remove-workspace-tool.md), which
supersedes the [rebinding](../docs/decisions/0014-conversation-workspace-rebinding.md)
and [handoff](../docs/decisions/0021-transparent-workspace-handoff.md) decisions.

## Implementation

- `src/app/runtime.ts`
- `src/app/app.ts`
- `src/app/session/session-lifecycle-controller.ts`
- `acp/src/pi/pix-rpc-entry.js`
- `acp/src/acp/pix-acp-agent.ts`
- `acp/src/acp/session-state-bridge.ts`
- `acp/src/acp/session-map.ts`
- `desktop/src/app/session-coordinator.ts`
- `desktop/src/app/desktop-session-orchestration.ts`

## Tests

- `tests/bundled-question-extension.test.ts`
- `tests/session-lifecycle-controller.test.ts`
- `acp/test/agent.test.ts`
- `acp/test/session-state-bridge.test.ts`
- `desktop/src/app/session-coordinator.test.ts`

## Verification

Root, ACP and Desktop typechecks plus targeted bundled extension, session
lifecycle and state bridge/coordinator regressions. These checks do not claim
interactive UI QA.
