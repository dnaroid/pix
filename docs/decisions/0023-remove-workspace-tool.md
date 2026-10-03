# 0023 — Remove workspace tool

- Status: accepted
- Recorded: 2026-10-03
- Decided: 2026-10-03
- Owner / approval evidence: user explicitly requested removal in this conversation.
- Governing spec: [Conversation workspace](../../specs/workspace.md)
- Replaces / replaced by: supersedes [0014](0014-conversation-workspace-rebinding.md) and [0021](0021-transparent-workspace-handoff.md).

## Context

The user reports that the workspace tool does not work as intended and asks to
remove it. This report is conversation-only; no specific reproduced failure or
UI evidence is claimed.

## Observations and sources

The implementation registered the bundled tool in TUI and RPC, installed private
SDK transaction/handoff adapters and propagated committed cwd through ACP and
Desktop. Historical decisions 0014 and 0021 document these mechanisms.

## Decision

Remove the tool, its bundled extension, host adapters and cwd propagation wiring.
Preserve ordinary project opening, session lifecycle, reload, and workspace undo.
Legacy workspace state notifications must not mutate conversation cwd. Existing
journal entries are retained as history, without automatic cwd restoration.

## Alternatives

Repairing the handoff or hiding only the tool was not selected: the user requested
removal, not another implementation of conversation rebinding.

## Consequences

Agents cannot switch/back the active conversation through a workspace tool.
Removing its private SDK interposition reduces lifecycle complexity. Already
running processes need to restart to drop the loaded extension.

## Revisit when

The user explicitly requests this feature again and a supported, verifiable
runtime rebinding mechanism is available.
