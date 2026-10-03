# 0018 — Identity-only Desktop message actions

- Status: accepted
- Recorded: 2026-10-03
- Decided: 2026-10-03
- Owner / approval evidence: implementation choice for the reported wrong-message Desktop fork bug; no separate user approval is claimed.
- Governing spec: [Desktop user-message actions](../../specs/desktop-user-message-actions.md)
- Replaces / replaced by: none

## Context and evidence

Desktop previously resolved unbound rows using the difference between current-branch user count and visible user count. Hidden/empty entries, older pages and newly persisted prompts can invalidate that positional correspondence. The initial persisted history also discarded available entry keys, while older pages retained them. Prompt settlement selected the last newly added user entry, which can be a steering message rather than the submitted prompt.

Evidence comes from `desktop/src/app/user-message-context-actions.ts`, `desktop/src/app/prompt-run-lifecycle.svelte.ts`, and `acp/src/acp/pix-acp-agent.ts`, with regression coverage in their task-scoped tests. The diagnosis is code-based; this decision does not claim interactive reproduction of the intermittent report.

## Decision and scope

Preserve persisted entry IDs on all Desktop history pages and full live-branch message history. Copy/Fork/Undo resolve only explicit optimistic-row bindings or persisted replay identities. Refuse unresolved rows instead of guessing from order or text. Bind a serialized submitted prompt to the first newly appended user entry, not later steering/follow-up entries, and reject obsolete generation/client completions.

## Alternatives

- Retain offset matching with extra count checks: rejected because equal counts do not establish identity.
- Match text: rejected because duplicate prompts and attachment-only messages are valid.
- Add a new prompt-acknowledgement protocol: deferred; it could provide bindings earlier but is not needed to remove unsafe historical guessing.

## Consequences and limits

An optimistic row has no actionable entry until binding completes; an older unkeyed payload must be reloaded. Historical keyed messages remain actionable while a source prompt runs. This favors an explicit error over a destructive action at the wrong turn. First-new-entry binding relies on the existing serialized prompt producing its user entry before steering/follow-up entries; extensions that synthesize unrelated user entries may require an explicit acknowledgement protocol.

## Revisit when

- The prompt protocol supplies the submitted entry ID directly.
- Extensions can prepend unrelated user entries before the submitted prompt.
- Legacy unkeyed history must remain actionable without reload.
