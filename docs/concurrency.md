# Spec: Application concurrency and lifecycle safety

## Type

Change

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
- Shutdown detaches input before awaiting cleanup and applies one bounded cleanup deadline before forced exit.

## Invariants

- One runtime has at most one owning tab, and replacing that ownership disposes or explicitly transfers the displaced runtime.
- Only the active tab's scope can mutate the shared editor and visible conversation.
- Timers and subscriptions verify runtime ownership before mutation.
- No stale persistence snapshot can replace a newer completed snapshot.

## Edge cases

- Switching tabs while draft persistence, session replacement, history loading, paste, voice, or custom UI is pending.
- Closing or forking while another tab lifecycle operation is pending.
- Paste terminators and Enter arriving in the same terminal chunk.
- Multibyte UTF-8 split across terminal chunks.
- Quit during startup tab restoration or stalled runtime disposal.

## Related files

- `src/app/session/tabs-controller.ts`
- `src/app/session/session-lifecycle-controller.ts`
- `src/app/input/`
- `src/app/extensions/extension-ui-controller.ts`
- `src/app/terminal/terminal-controller.ts`
- `src/input-editor.ts`

## Verification

- Deterministic deferred-promise tests for tab/session identity after every relevant `await`.
- Regression tests for cross-tab submit/paste/UI completion and non-history draft restoration.
- Chunked UTF-8 and large printable-input tests.
- `npm run check`, `npm run build:pix`, and `git diff --check`.

## Risks / unknowns

- SDK session hydration and append APIs are synchronous; eliminating those stalls may require an upstream SDK API or worker/process boundary.
- Voice model inference may require a dedicated worker to become fully non-blocking.

## Evidence

- Confirmed by the pre-change audit: shared editor/runtime state was read after asynchronous boundaries in the related files.
- Confirmed by regression tests: audit probes reproduced cross-tab submit, deferred paste, undo leakage, and render amplification before the fixes.
- Unknown: acceptable upstream design for asynchronous SDK session hydration.
