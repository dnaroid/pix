# 0014 — Transactional conversation workspace rebinding

- Status: superseded
- Recorded: 2026-10-03
- Decided: 2026-10-03
- Owner / approval evidence: coding assistant implementation choice for the
  requested conversation-preserving workspace tool; no separate user approval
  of the private SDK adapter is claimed.
- Governing spec: [Conversation workspace](../../specs/workspace.md)
- Replaces / replaced by: the whole-run waiting policy is superseded by
  [0021 — Transparent workspace handoff](0021-transparent-workspace-handoff.md).
  The entire decision is superseded by [0023 — Remove workspace tool](0023-remove-workspace-tool.md).

## Context

Changing a conversation's cwd must reload directory-specific resources without
losing its identity, transcript or return stack. It must not replace a session
while its own workspace tool or remaining agent run is executing. Pix TUI and
the Pix RPC process used by Desktop need the same behavior; plain pi is excluded.

## Observations and sources

Verified evidence:

- The installed Pi SDK 1.0.0 `AgentSessionRuntime.switchSession` tears down the
  current session before creating the new runtime. Its public API does not
  provide a prepare/commit workspace transaction. Source at investigation time:
  `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session-runtime.js`.
- Pix can recreate cwd-bound services through its existing runtime factory in
  `src/app/runtime.ts`; RPC also owns an `AgentSessionRuntime` and a host rebind
  callback.
- `tests/workspace.test.ts` covers staged prepare/bind failures, settlement and
  prompt gating, full journal/leaf preservation and actual SDK resource reload.

Assumptions and limits:

- Private SDK hooks are version-sensitive even with runtime shape guards.
- Journal isolation cannot roll back external side effects from extension
  startup. No interactive UI evidence is asserted by this decision.

## Decision

Queue cwd replacement until the source session's entire run settles. Gate new
prompts while the transaction is pending and redirect them to its result.

This original waiting policy is historical: decision 0021 stops tool-originated
runs at the tool-batch boundary and continues on the replacement automatically.
The transaction and rollback rules below still apply.

Isolate the full session journal and selected leaf, create fresh services for
the target cwd, apply/bind the candidate, then persist a branch-visible cwd/stack
marker. Retain the old session until binding and persistence succeed. Restore
it on pre-commit failure; dispose stale candidates and both owners as needed
when the host closes. Post-commit notification failures never undo the commit.

Keep the guarded private runtime adapter in
`src/bundled-extensions/workspace/host.ts` and the persistence interposition in
`src/bundled-extensions/workspace/snapshot.ts`. Reuse the same host in TUI and
RPC. Propagate committed state through ACP to only the matching Desktop
conversation; do not mutate process-wide cwd or project-wide Desktop state.

## Alternatives

- Use public `switchSession`: rejected because prepare failure would already
  have invalidated the source runtime.
- Change cwd in place without resource replacement: rejected because handlers,
  instructions, skills and tools could retain the old directory's resources.
- Replace immediately inside the tool: rejected because the executing tool and
  remaining run still belong to the old session.
- Start a new conversation: rejected because preserving identity/history is
  the requested behavior.

## Consequences

Workspace switching retains conversation continuity and supports rollback of
candidate journal writes. The tool returns before the target becomes effective,
so pending vs committed cwd must remain explicit. Supporting the adapter adds
SDK upgrade scrutiny and lifecycle/journal regression tests. The old extension
resources are temporarily retained during preparation/binding.

## Revisit when

- Pi exposes public transactional session/workspace rebinding or persistence.
- SDK runtime/persistence hooks change, or upgrade regressions fail.
- Extension external side effects require a stronger lifecycle contract.
- Real UI evidence reveals confusion around pending/committed workspace state.
