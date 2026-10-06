---
kind: spec
status: active
---

# Temporary Desktop BTW side chat

Rationale: [0055 — Temporary, isolated BTW](../docs/decisions/0055-temporary-btw-side-chat.md).

## Behavior

The composer actions menu opens a right-hand, resizable BTW pane without sending
a model request or moving the primary draft/attachments. `/btw` is an equivalent
opener; `/btw question` sends only to BTW, even while the parent is running or
paused. One ephemeral conversation belongs to each parent runtime. It is not a
fork, worker, task or agent continuation.

Each question streams a tool-less answer using the parent's current completed,
compaction-aware branch projection, previous BTW exchanges and explicitly added
text excerpts. The snapshot does not change during a response. No independent
file reads/search/commands, images, hidden thinking, live partial parent answers
or unfinished tool results are supplied. A fresh request refreshes parent context;
replacement/edits of the underlying context must not silently reuse old BTW
history. A separate model can be selected or the parent's resolved model used at
submission time, without changing that model or implicitly falling back.

Closing the pane only hides it. Switching sessions retains each runtime's own
draft/history and lets its response finish. Stop cancels only BTW. New conversation
cancels BTW and clears its history, draft and excerpts. Closing/replacing the
parent runtime or disconnecting clears the side conversation and cancels work.
Nothing replays on restart. All chat content stays in memory, not session JSONL,
localStorage, settings, feature logs or scratch files. Only numerical usage and
provider/model metadata are durably attributed to the originating session,
even for stale finalized calls.
The request necessarily sends its question and snapshot to the selected provider;
temporary storage in Pix is not a promise about provider-side retention or an
external provider's explicitly enabled debug logging.

Answers can be copied or explicitly inserted as a draft into the owning parent's
empty composer without attachments. No automatic submit, overwrite, parent
queueing, run-state changes, tools or autonomous agent actions are allowed.

## Constraints and failure cases

One provider request per parent runtime; cancellation cannot allow overlap if the
provider ignores abort. Requests/events have explicit runtime/request identity;
late completions cannot populate a replacement runtime or another session.
Question/history/excerpt/context/output sizes and request duration are bounded.
Clipped context is visible as a limitation, not evidence of a bug. Offline mode
and unavailable models fail closed. Error text must not expose prompts or provider
secrets. No background inference from merely opening the pane or switching tabs.

The current limits are 8,000 characters per question; 4 explicitly selected
excerpts of up to 8,000 characters each; 40 side-history messages (20 exchanges)
within 48,000 characters; a conservative serialized parent/question/history budget
of at most 160,000 UTF-8 bytes, reduced for smaller model context windows; at most
4,096 output tokens and 32,000 output characters; and a 75-second deadline.
Completed history is trimmed by whole exchanges; long excerpt text in the newest
exchange is shortened before retention so its question and answer do not disappear.
Per-record tool/prose limits also apply. The UI identifies shortened context.
Context collection is bounded per record and uses a linear serialization budget.
Before retaining any text it selects up to 512 recent projected entries plus
the first and three latest user-constraint entries; omitted history is disclosed.

History is refreshed only on a submitted question. Plain parent appends preserve
side history. Branch changes, context edits and compaction change its context key;
the next question drops obsolete side exchanges and displays a reset indication.
An already submitted response keeps its labelled snapshot. Tree navigation also
cancels the side request. Runtime replacement clears the temporary conversation
immediately through identity-only lifecycle notifications, not a replayed snapshot.

BTW reuses the statusbar's Model + Thinking popup, search, keyboard handling and
Desktop `visibleModels` whitelist. The complete catalogue is exposed only by
Manage; the current BTW model remains visible even for an empty whitelist.
Manage edits the same Desktop visibility preference, not a separate BTW list.
Opening waits for a pending visibility save before reloading the preference.
The popup anchors to BTW's own model button; opening either model popup closes
the other. The parent-only Auto routing action and Set default are not offered.

The selected model/effort pair and per-model BTW effort memory are temporary.
"Same as main session" inherits the parent's resolved model and effort when the
request is accepted. Use main restores inheritance for both. Explicit choices
never mutate the parent's model, effort, defaults or remembered effort profile.
The picker shows only the selected model's supported thinking levels, clamps
staged choices with the shared rules, and remembers applied choices per model
within the side chat. Apply affects subsequent questions, not an active request;
Cancel/Escape discard staged changes. An explicit pair is captured before async
submission preparation so a later UI selection cannot change that request.

The runtime independently validates explicit effort against the actual model.
Unsupported/unknown values fail before inference instead of silently switching
effort. Inherited effort is clamped to the resolved model; non-reasoning models
use off. Off omits the simple-stream reasoning option; every other supported
level is forwarded rather than replaced by minimal. Progress carries the
captured effective effort without overwriting the next question's selection.
Missing credentials/models are errors, not fallback triggers. Inference uses
no tools, retries or cache-retention request; warm-cache pricing is not assumed.

The pane header contains the model/effort selector: its compact button shows the
selected model's display name without a provider prefix and the selected effort,
not the session title or stale response metadata. Inherited selection shows the
current parent model. The popup opens below the header when that side has more
room; Apply updates the header and the next question's pair. A compact reset
button restores main-session inheritance. There is no duplicate selector or
selection-description row above the composer.
The header uses the standard X button to hide the pane without clearing
the conversation. There is no metadata block with context timestamps, record
counts, raw model references or token usage. Context shortening remains a
concise notice inside the conversation only when relevant.
The pane has independent scrolling, keyboard/pointer resizing and Send/Stop.
Enter submits; Shift+Enter inserts a newline; Escape hides the pane and restores
main-composer focus without cancelling the parent. Inner model-picker Escape is
handled before pane closure. Closing/reopening the pane restores its reading
position. The composer menu can open it with an empty draft and while the parent
is running or paused. `/btw` with main attachments fails without discarding them.
The command's send button says "Ask in BTW", not "Queue message".

## Implementation

- `acp/src/btw/contract.ts`
- `acp/src/btw/context.ts`
- `acp/src/btw/service.ts`
- `acp/src/btw/request.ts`
- `acp/src/pi/btw-host.ts`
- `acp/src/pi/pix-rpc-entry.js`
- `acp/src/pi/pi-rpc-client.ts`
- `acp/src/acp/pix-acp-agent.ts`
- `acp/src/acp/slash-commands.ts`
- `desktop/src/lib/acp-client.ts`
- `desktop/src/lib/acp-pix-extensions.ts`
- `desktop/src/app/btw.svelte.ts`
- `desktop/src/app/btw-draft.ts`
- `desktop/src/app/btw-model.ts`
- `desktop/src/app/prompt-submit.ts`
- `desktop/src/app/session-coordinator.ts`
- `desktop/src/components/BtwDock.svelte`
- `desktop/src/components/BtwPane.svelte`
- `desktop/src/components/BtwModelControl.svelte`
- `desktop/src/components/ModelThinkingPicker.svelte`
- `desktop/src/lib/model-picker-popover.ts`
- `desktop/src/components/PromptComposerActionsMenu.svelte`
- `desktop/src/components/PromptComposer.svelte`
- `desktop/src/App.svelte`

## Tests

- `acp/test/btw.test.ts`
- `acp/test/pi-rpc-btw.test.ts`
- `acp/test/agent.test.ts`
- `acp/test/slash-commands.test.ts`
- `desktop/src/app/btw.test.ts`
- `desktop/src/app/btw-model.test.ts`
- `desktop/src/lib/model-picker-popover.test.ts`
- `desktop/src/components/BtwPane.test.ts`
- `desktop/src/app/prompt-submit-btw.test.ts`
- `desktop/scripts/btw-smoke.mjs`
- `desktop/scripts/fixtures/BtwSmoke.svelte`

## Verification

Backend tests exercise real SDK session projections and the real RPC output guard,
but use controlled streams instead of paid provider calls. Cases cover cancelling
an abort-ignoring provider, disposal/rebinding, usage attribution, stale context,
partial tool calls, output validation and non-interference with parent runs.
Desktop tests cover early terminal events before command acknowledgements, session
switch/replacement, history budgets, draft preservation and slash interception.
Model tests cover supported effort values, off, inherited effort snapshots,
invalid/unsupported effort, per-model memory and isolation from parent settings.
`npm --prefix desktop run test:btw` uses real Svelte/browser components with synthetic
model/IPC state, including focus, menu, scrolling, model selection and narrow geometry.
It compares the actual shared main and BTW pickers, including whitelist filtering,
Manage/empty-whitelist behavior, shared preference writes, per-model effort,
popup teardown, Use main and independent request settings.
This is not a native `.app` or live-provider quality evaluation.
