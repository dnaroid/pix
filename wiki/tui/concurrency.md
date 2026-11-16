# Spec: Application concurrency and lifecycle safety

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Keep tab, session, editor, extension UI, persistence, and shutdown work bound to
the state that started it, without blocking normal terminal interaction.

## Scope

- Tab/session activation, replacement, close, fork, restore, and history loading.
- Input submission, queued messages, paste, voice, prompt enhancement, and editor restoration.
- Extension UI callbacks, persisted tab snapshots, terminal input decoding, and shutdown.

## Non-goals

- Changing the persisted tabs or session JSONL formats.
- Making intentionally full-history SDK operations lazy when the SDK exposes only a synchronous API.
- Changing extension-facing UI semantics beyond preventing inactive scopes from editing the active tab.

## Behavior

- An async continuation may mutate visible state only while its captured tab, runtime, session, and operation generation still own that state.
- A prompt captured in one tab is submitted or queued only for that tab's captured session. If ownership is lost before dispatch, the prompt is restored instead of rerouted.
- Deferred paste, voice, and extension UI completion target their originating tab or are discarded after that scope is removed.
- Restoring a tab draft does not enter another tab's undo history and cannot silently overwrite input typed after activation started.
- Tab lifecycle mutations are mutually exclusive. Failed activation rolls back or disposes newly created/displaced runtimes.
- Persisted tab snapshots are written in invocation order with unique temporary files.
- Replacement/history work is cancelled when runtime, session, tab, or generation changes.
- Terminal byte chunks preserve split UTF-8 sequences and batch printable-input rendering.
- While following the bottom of the history window, a streamed entry slides the visible window by at most one entry instead of rebuilding it; only the new and the dropped entry lose cached viewport layout. If the visible window no longer matches the expected history slice, it falls back to the full rebuild.
- The interactive `!!` shell command's "Press Enter to return to pix" wait resolves on input `data`, `end`, `close`, or `error`, removes all its listeners on settlement, and returns immediately when stdin is already not readable.
- Shutdown detaches input before awaiting cleanup and applies one bounded cleanup deadline before forced exit.
- SIGTERM and SIGHUP (SIGTERM only on win32) run the same bounded shutdown: the terminal is restored synchronously, drafts are saved, runtimes are disposed under the existing deadline, `process:signal_shutdown` is logged, and the process exits with 128 + signal number. Termination handlers are removed once shutdown starts, so a repeated signal uses Node's default termination.
- Lazy older-history loading re-checks cancellation after its awaited external disk read. If ownership was lost, the consumed batch is stashed in the loader and applied on the next owner-driven `loadOlder` without re-reading; it is never prepended into another tab. `hasOlder()` reports the stashed batch.
- Before history attach, the caller's load generation controls cancellation. After attach, the lazy loader stays live while it is the controller's current older-history loader for the same runtime (including a tab restored from its cached view), and is cancelled while another tab owns the view. Exhaustion clears only that load's loader.
- Auto-scroll timers for mouse selection are unref'd and cleared through the mouse controller's `dispose()` during app stop.

## Invariants

- One runtime has at most one owning tab, and replacing that ownership disposes or explicitly transfers the displaced runtime.
- Only the active tab's scope can mutate the shared editor and visible conversation.
- Timers and subscriptions verify runtime ownership before mutation.
- No stale persistence snapshot can replace a newer completed snapshot.
- A lazy older-history loader mutates the visible conversation only while it is its runtime's current loader; a batch read while ownership was lost is retained, not dropped or reassigned.
- A memory-watchdog report that is in flight across `stop()` never arms a synchronous heap snapshot.

## Edge cases

- Switching tabs while draft persistence, session replacement, history loading, paste, voice, or custom UI is pending.
- Closing or forking while another tab lifecycle operation is pending.
- Paste terminators and Enter arriving in the same terminal chunk.
- Multibyte UTF-8 split across terminal chunks.
- Quit during startup tab restoration or stalled runtime disposal.
- Older-history disk read completing after the owning tab was switched away.
- Restoring a cached tab view while its lazy older-history loader is still in use by another tab.
- SIGTERM/SIGHUP arriving during shutdown, or a second signal after shutdown began.
- Memory-watchdog `stop()` while a report is awaiting its deferred snapshot.

## Verification

- Deterministic deferred-promise tests for tab/session identity after every relevant `await`.
- Regression tests for cross-tab submit/paste/UI completion and non-history draft restoration.
- Chunked UTF-8 and large printable-input tests.
- Deterministic tests for the follow-mode history slide and layout invalidation (`tests/session-event-controller.test.ts`, "slides a followed history window by one entry...") and for the return-key wait's settle, listener cleanup, and closed-input handling (`tests/shell-command.test.ts`, "returns to pix on input, end, close or error..." and "does not wait on an already closed input").
- Deterministic tests for older-history stash/re-apply (`tests/session-history.test.ts`), lazy loader ownership across tab restore and cancellation (`tests/session-event-controller.test.ts`), signal shutdown and handler removal (`tests/terminal-controller.test.ts`), and watchdog `stop()` generation handling (`tests/memory-watchdog.test.ts`).
- `npm run check`, `npm run build:pix`, and `git diff --check`.

## Risks / unknowns

- SDK session hydration and append APIs are synchronous; eliminating those stalls may require an upstream SDK API or worker/process boundary.
- Deepgram voice finalization must stay bounded, and shutdown must use the
  immediate voice-dispose path rather than spend the global cleanup deadline
  waiting for speech-to-text final results.

## Evidence

- Confirmed by the pre-change audit: shared editor/runtime state was read after asynchronous boundaries in the related files.
- Confirmed by regression tests: audit probes reproduced cross-tab submit, deferred paste, undo leakage, and render amplification before the fixes.
- Unknown: acceptable upstream design for asynchronous SDK session hydration.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"e0089ac1e420422637d039b94c1471582b3c5f178999388c6db73e38451e55e6","checkedAt":"2026-11-16T16:57:48.618Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":64,"reportLanguage":"ru"} -->
