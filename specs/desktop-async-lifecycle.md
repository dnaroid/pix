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

## Non-goals and limits

- A per-frame update-count bound is not a hard wall-clock budget for arbitrary individual updates or DOM rendering.
- Native process protocols, thread scheduling, session persistence, and cross-process file concurrency are unchanged.
- Already-running native operations are not synchronously cancelled by JavaScript; late completions are either ignored or cleaned up using their captured resource identity.

## Related files

- `desktop/src/app/connection.svelte.ts`
- `desktop/src/app/session-coordinator.ts`
- `desktop/src/app/session-update-batcher.ts`
- `desktop/src/app/session-history.svelte.ts`
- `desktop/src/lib/tauri-transport.ts`
- `desktop/src/lib/acp-json-rpc.ts`
- `specs/desktop-session-parity.md`
- `specs/desktop-workbench-tabs.md`
- `specs/desktop-package-scripts.md`

## Verification

- `desktop/src/app/connection.test.ts` exercises overlapping initialization, reconnect/disposal, stale completion, retries, and post-exit callback ownership.
- `desktop/src/lib/tauri-transport.test.ts` exercises partial subscription failure, cancellation during registration/native start, early event ordering, and serialized restart.
- `desktop/src/lib/acp-json-rpc.test.ts` exercises shared disposal, pending-request rejection, and late incoming-request completion.
- `desktop/src/app/session-update-batcher.test.ts` controls animation frames explicitly and checks multi-frame ordering, completion timing, reset, session removal, and terminal disposal.
- `desktop/src/app/session-history-concurrency.test.ts` controls promise completion order to cover cancel/restart, generation replacement, duplicate hydration, obsolete success/failure, session switches, and old cursor completion racing with a new page request.
- `npm --prefix desktop test`
- `npm --prefix desktop run check`
- `npm --prefix desktop run build:web`
