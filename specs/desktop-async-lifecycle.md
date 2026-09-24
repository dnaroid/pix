# Desktop connection lifecycle and bounded update replay

<!-- markdownlint-disable MD013 -->

## Type

Change.

## Lifecycle

Active implemented contract.

## Goal

Keep Desktop connection teardown authoritative and yield between bounded portions of queued transcript work instead of replaying an entire accumulated backlog in one animation frame.

## Behavior

- Concurrent connection attempts share initialization; a ready client is not replaced by another ordinary connect call. Reconnect first detaches the old client and resets session state before starting its replacement.
- Disposing the connection invalidates pending initialization/reconnect continuations. A late success, failure, or notification cannot open a workspace session, change the active client, or resurrect the connection after disposal.
- An exited client loses callback ownership before session state is reset; trailing events from that client are ignored.
- Each Tauri transport run owns its subscriptions, native process generation, and start/stop promises. Concurrent starts share one operation; a new start on the same transport waits for its previous stop.
- A stop during listener registration cancels the start. Successful subscriptions are released even if another registration rejects, and subscriptions that finish after cancellation release themselves.
- A native start that completes after cancellation is stopped using its exact returned generation. It cannot stop a newer generation. Events buffered before the native generation is known are replayed in order only for the active run's generation.
- Repeated RPC disposal calls wait for the same transport shutdown. Pending requests reject at disposal, and late messages, diagnostics, or asynchronous server-request answers cannot write into a disposed transport.
- Transcript updates preserve enqueue order and are processed in portions of at most 128 updates per animation frame. The remaining backlog is scheduled for later frames; compaction does not copy the whole remaining queue on every frame.
- Prompt-completion timing is retained until the final queued portion for that session has been finalized. Background-only updates do not request scrolling of the active conversation.
- Disconnect resets and cancels queued replay before clearing session state. Forgetting a session discards its already-queued updates without discarding other sessions. Disposing the batcher rejects further enqueues; a reset remains reusable for a replacement connection.
- Lazy tool-result and older-history requests own their in-flight entries by client, workspace, generation, and request identity. An obsolete completion cannot clear a newer request's deduplication entry for the same session/tool key. New generations do not remain blocked by old requests; stale success/failure cannot mutate the active transcript. Already-hydrated tool results are not requested again.
- Closing/deleting a session prunes its older-history cursor and pending history deduplication entries, including background tabs; workspace close/disconnect clears all cursors. A reopened ID cannot inherit a closed tab's cursor or accept a stale history completion.
- Runtime status, DCP stats, and session-usage request generations belong to live per-session owner objects. Forgetting removes that owner and its snapshots/busy flags; an old completion cannot update or clear a reopened ID even if its request counter repeats. Reset invalidates all owners. Closed IDs leave no generation tombstones.
- Runtime session loads use the in-flight request itself as their owner, not a recyclable per-ID generation. Forget/reset (or an externally ready runtime) drops pending ownership; old success or failure cannot mutate a reopened ID, revoke its activity, or report an obsolete error, even with the same client and workspace. Terminal loads release their pending ownership and closed IDs retain no load-generation tombstones.
- Todo/subagent activity accepts only notifications carrying the current opaque attachment owner. Desktop passes an owner in ACP new/fork/load metadata, fresh for each new attachment or reopen (including reattachment to a live Pi runtime); repeated loads within an attachment preserve it. ACP captures that owner when enqueueing each activity envelope. New/fork startup snapshots are staged under bounded pending-request ownership until the response supplies the session ID; failed, canceled, or reset requests discard it. `markReady` preserves the existing owner. A forgotten session drops ownership, so delayed old envelopes cannot repopulate activity even with newer timestamps. ACP retains the most recent Todo and Subagent snapshots for a live runtime and replays them with original timestamps on reattachment. `checkedAt` orders snapshots only within an attachment/channel, never relative to a global close clock; no historical closed-ID metadata is retained.
- A canceled git-review fix-session creation forgets the newly installed runtime/activity owner before awaiting closure of the orphan session, so a reopened ID cannot be forgotten by the old close completion. If direct source restoration after a fork fails, it forgets the opened source owner only while the original history attachment is still current and no replacement runtime became ready; stale failures cannot clear a replacement attachment.

## Non-goals and limits

- A per-frame update-count bound is not a hard wall-clock budget for arbitrary individual updates or DOM rendering.
- Native process ownership, queue bounds, and shutdown are specified separately in `specs/desktop-native-process-lifecycle.md`; session persistence and cross-process file concurrency are outside this contract.
- Already-running native operations are not synchronously cancelled by JavaScript; late completions are either ignored or cleaned up using their captured resource identity.

## Related files

- `desktop/src/app/connection.svelte.ts`
- `desktop/src/app/session-coordinator.ts`
- `desktop/src/app/session-update-batcher.ts`
- `desktop/src/app/session-history.svelte.ts`
- `desktop/src/app/session-activity.svelte.ts`
- `desktop/src/app/session-runtime-status.svelte.ts`
- `desktop/src/app/session-runtime-loading.ts`
- `desktop/src/app/session-tab-closure.ts`
- `desktop/src/lib/tauri-transport.ts`
- `desktop/src/lib/acp-json-rpc.ts`
- `desktop/src/lib/acp-client.ts`
- `acp/src/acp/pix-acp-agent.ts`
- `acp/src/acp/session-state-bridge.ts`
- `specs/desktop-session-parity.md`
- `specs/desktop-workbench-tabs.md`
- `specs/desktop-package-scripts.md`

## Verification

- `desktop/src/app/connection.test.ts` exercises overlapping initialization, reconnect/disposal, stale completion, retries, and post-exit callback ownership.
- `desktop/src/lib/tauri-transport.test.ts` exercises partial subscription failure, cancellation during registration/native start, early event ordering, and serialized restart.
- `desktop/src/lib/acp-json-rpc.test.ts` exercises shared disposal, pending-request rejection, and late incoming-request completion.
- `desktop/src/app/session-update-batcher.test.ts` controls animation frames explicitly and checks multi-frame ordering, completion timing, reset, session removal, and terminal disposal.
- `desktop/src/app/session-history-concurrency.test.ts` controls promise completion order to cover cancel/restart, generation replacement, duplicate hydration, obsolete success/failure, session switches, and old cursor completion racing with a new page request.
- `desktop/src/app/session-runtime-status.test.ts` covers owner replacement, late responses, and bounded closed-session metadata; `desktop/src/app/session-activity.test.ts` and history concurrency tests cover late notifications and cursor pruning.
- `desktop/src/app/session-runtime-loading.test.ts` covers stale success/failure after reset or forget with the same ID/client/workspace, activity retention on stale failure, current-owner failure, and bounded pending metadata across many closed IDs.
- `desktop/src/app/git-assist-workflow.test.ts` covers orphan creation and same-ID reattachment during deferred close; `desktop/src/app/conversation-fork-action.test.ts` covers failed direct source restoration ownership, including same-ID replacement.
- `desktop/src/lib/acp-client.test.ts` and `acp/test/agent.test.ts` cover attachment metadata, startup ownership, and cached activity replay on live-runtime reattachment.
- `npm --prefix desktop test`
- `npm --prefix desktop run check`
- `npm --prefix desktop run build:web`
