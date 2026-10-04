---
kind: spec
status: active
---

# Desktop queued send to fork

## Behavior

- The composer actions menu offers **Send to fork** for a nonempty text or
  attachment draft in an existing ready session, including a running session.
- This is a separate `fork` queue type. Acceptance clears the captured composer
  draft; the source transcript and SDK steering/follow-up queues never receive it.
- An idle session forks immediately. A running session waits for the next safe
  steering-equivalent turn boundary, after assistant/tool results have persisted,
  rather than waiting for the entire agent run. The fork contains the current
  branch through that boundary, not history before the last user message.
- The fork opens as a new **background** conversation tab and submits the captured
  text and attachments there. Neither the active tab nor its draft/focus changes.
  The source keeps running independently.
- Pending fork rows are visibly distinguished and support Cancel and Move to
  editor. Send immediately is disabled: it must never send into the source or
  interrupt it. Multiple requests create separate forks.
- ACP owns the pending queue and exact boundary capture. Once the child is
  created, its payload uses the existing persistent auto queue and normal
  Desktop prompt lifecycle. Fork ancestry remains native Pi session metadata.

## Constraints and failure cases

- Composer-only draft tabs, editor/question modes, empty drafts and unready
  sessions do not offer an enabled fork send. Attachment preparation finishes
  before admission. Navigation during preparation cancels that admission.
- Rejected submissions restore an unchanged empty composer when it still owns
  the draft; they must not overwrite newer input or another conversation.
- Snapshot/creation failure retains the source queue item for editing/canceling
  and reports an error; it must not spin an automatic retry loop.
- Failed edit/cancel or child auto-queue consumption writes retain the payload
  for retry. Reopening a source waits for its retiring fork work to restore the
  durable queue before hydrating it; stale owners cannot overwrite a new owner.
- Closing/replacing the source invalidates pending creation. Client/workspace
  replacement and history reset invalidate background adoption. A late load
  cannot resurrect a closed fork or steal the active conversation.
- Background history is primed before enabling the child's queue drain, without
  canceling active-session hydration; lazy history and pagination are retained.
- No TUI composer change is included. Pending queues are not a promise of
  autonomous execution while Desktop is disconnected.

## Decision

[0035 — Background queued forks](../docs/decisions/0035-background-queued-forks.md).

## Implementation

- `acp/src/acp/pix-acp-agent.ts`
- `acp/src/acp/desktop-commands.ts`
- `acp/src/acp/queue-store.ts`
- `acp/src/acp/desktop-fork-queue.ts`
- `acp/src/acp/desktop-fork-snapshot.ts`
- `acp/src/acp/desktop-fork-snapshot-worker.js`
- `acp/src/pi/pi-rpc-client.ts`
- `acp/src/pi/pix-rpc-entry.js`
- `desktop/src/components/PromptComposer.svelte`
- `desktop/src/components/PromptComposerActionsMenu.svelte`
- `desktop/src/components/QueuedMessagesPanel.svelte`
- `desktop/src/app/prompt-queue-actions.svelte.ts`
- `desktop/src/app/background-fork.ts`
- `desktop/src/app/session-history.svelte.ts`
- `desktop/src/app/connection.svelte.ts`
- `desktop/src/app/desktop-connection-services.ts`
- `desktop/src/app/desktop-prompt-action-services.ts`
- `desktop/src/app/desktop-workbench-prop-builders.ts`
- `desktop/src/App.svelte`
- `desktop/src/lib/acp-client.ts`
- `desktop/src/lib/acp-client-types.ts`
- `desktop/src/lib/acp-pix-extensions.ts`
- `desktop/src/lib/acp-response-parsers.ts`

## Tests

- `desktop/src/app/background-fork.test.ts`
- `desktop/src/app/prompt-queue-actions.test.ts`
- `desktop/src/app/session-history.test.ts`
- `desktop/src/lib/acp-client.test.ts`
- `desktop/src/components/QueuedMessagesPanel.test.ts`
- `acp/test/agent.test.ts`
- `acp/test/queue-store.test.ts`
- `acp/test/desktop-commands.test.ts`
- `acp/test/desktop-fork-queue.test.ts`
- `acp/test/desktop-fork-snapshot.test.ts`
- `acp/test/pix-rpc-entry.test.ts`

## Verification

Focused Desktop/ACP tests, Desktop check and web build, ACP typecheck. Boundary,
source isolation, attachments, cancellation, failure and stale completion must
be tested deterministically; static checks are not live Desktop QA evidence.
