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

[0035 — Background queued forks](../../decisions/0035-background-queued-forks.md).

## Verification

Focused Desktop/ACP tests, Desktop check and web build, ACP typecheck. Boundary,
source isolation, attachments, cancellation, failure and stale completion must
be tested deterministically; static checks are not live Desktop QA evidence.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"ff6c094e91d38a267c49325a8d0ba24d16d7f750547d2e26db2d50e06d758f8e","checkedAt":"2026-10-31T00:41:07.227Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":64,"reportLanguage":"ru"} -->
