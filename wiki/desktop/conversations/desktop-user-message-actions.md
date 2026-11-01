# Desktop user-message actions

<!-- markdownlint-disable MD013 -->

## Type

Change.

## Lifecycle

Active implemented contract.

## Goal

Pix Desktop exposes five user-message actions, including Edit and resend, without adding a second editing model or using repository-wide Git state for workspace rollback. Edit rewinds session history only; it must never revert workspace files or consult the mutation journal. Undo must remain safe when several Pix sessions share one project directory and mutate files concurrently.

## Menu contract

- A Desktop user message exposes exactly five actions: **Copy message**, **Fork**, **Fork in new tab**, **Undo changes**, and **Edit and resend**. `[confirmed by code: desktop/src/components/TranscriptPane.svelte, desktop/src/components/transcript-user-message-menu-controller.svelte.ts]`
- The menu is available from the user bubble's context menu and from an ellipsis button shown on hover/focus. It renders as a viewport-fixed overlay outside transcript-entry paint containment, flips above the anchor when there is not enough room below, and stays above the composer/chrome instead of being clipped by transcript scrolling. Each action has a dedicated icon. Opening focuses the first enabled command; ArrowUp/ArrowDown, Home/End, and printable-key type-ahead navigate enabled commands; Escape closes the menu and restores its invoker when available. Tab, transcript scrolling/resizing, or an outside click dismisses it without trapping focus. `[confirmed by code: desktop/src/components/transcript-user-message-menu-controller.svelte.ts]`
- Copy remains available for renderer-only user rows. Fork, Edit, and Undo require a real Pi user session entry. Fork (replace source), Edit, and Undo are idle-only; **Fork in new tab** remains available while the source prompt is running. Session-backed mutations require a ready runtime and no history loading or active-session mutation. Automatic/deferred queued prompts block source mutations, but do not make the transcript appear to be running. Work in another session does not disable an idle session's Edit. `[confirmed by code: desktop/src/app/desktop-workbench-prop-builders.ts, desktop/src/components/transcript-user-message-menu-controller.svelte.ts]`
- Right-click on selected text or an external link delegates to the text/link context menu instead of opening the whole-message actions. The ellipsis always remains a route to those actions, and right-click without a text/link context still opens them. This precedence is defined in `wiki/desktop/workbench/desktop-context-menus.md` and exercised by `desktop/scripts/context-menu-smoke.mjs`.
- Newly submitted Desktop rows are associated with the first new Pi user entry by comparing current-branch user entry IDs before and after the serialized prompt; later steering/follow-up entries must not replace that binding. Stale prompt generations or replaced clients cannot bind rows. Extension/builtin commands that create no Pi user entry are marked renderer-only. Historical rows carry their persisted entry ID in `replay-entry:<id>` on both initial and older history pages and on full live-branch history. Message actions use this identity, never prompt text or a visible-row/branch-length offset. Rows without a proven entry ID fail closed and ask the user to wait for prompt settlement or reload. `[confirmed by code: desktop/src/app/prompt-run-lifecycle.svelte.ts, desktop/src/app/user-message-context-actions.ts, acp/src/acp/pix-acp-agent.ts]`

## Copy and fork behavior

- **Copy message** copies the full selected message. Session-backed rows use the existing ACP host clipboard path; renderer-only rows use the Desktop browser clipboard. `[confirmed by code]`
- **Fork** forks at the selected Pi user entry and replaces the currently open source session, matching the existing Desktop `/fork` behavior. `[confirmed by code: desktop/src/app/conversation-fork-action.ts]`
- **Fork in new tab** uses the same Pi `session/fork` primitive but keeps the source ACP session/tab open and activates the new fork. `[confirmed by code]`
- Forking into a new tab does not cancel or forget the source run. It snapshots the latest source transcript and preserves the source composer text/attachments; the new composer receives the selected Pi user text without source attachments. Later source events remain scoped to the source tab. A stale fork response after client/workspace/session replacement discards the created fork without changing the new selection. Sessions share the project filesystem; this is not worktree isolation. `[confirmed by code]`

## Edit and resend behavior

- **Edit** loads the exact selected Pi user entry into the **main composer**, just like Fork's composer prefill; it never opens a popup editor or attachment-confirmation dialog. Original images and files are retained and removable through ordinary composer controls. Normal composer attachment additions remain available. Desktop shows an inline editing indicator and **Cancel edit**; TUI shows an editing status. `[confirmed by code: desktop/src/app/composer-message-edit.svelte.ts, desktop/src/components/PromptComposer.svelte, src/app/workspace/workspace-actions-controller.ts]`
- Selecting and editing a message do not change session history or files. **Cancel edit** / Escape restores the pre-edit composer text and attachments, without navigation. Pending edits are scoped to their source draft/session; switching tabs never sends an edit into another session. `[confirmed by tests: desktop/src/app/composer-message-edit.test.ts, tests/user-message-edit.test.ts]`
- Desktop Edit selection, Cancel, and Send share operation/history guards and a source-session prompt/automatic-or-deferred-queue guard. A prompt running in another session must not silently suppress these actions. The message menu likewise gates mutations on the selected runtime being ready, operation/history state, and that session's prompt/automatic-or-deferred queue state; queue blocking does not alter the transcript's displayed running/history state. `[confirmed by code: desktop/src/App.svelte, desktop/src/app/composer-message-edit.svelte.ts, desktop/src/app/desktop-workbench-prop-builders.ts, desktop/src/components/TranscriptPane.svelte]` `[confirmed by tests: desktop/src/app/composer-message-edit.test.ts, desktop/src/app/desktop-workbench-prop-builders.test.ts, desktop/src/components/transcript-user-message-menu-controller.test.ts]`
- Ordinary **Send** / TUI Enter prepares the edited composer text and remaining attachments, then rewinds and resends in the **same session** from the selected user entry's parent. The old branch remains in the session tree. Successful Send clears the submitted composer draft (but does not erase newer typing during async navigation); no separate confirmation is required. Defer and composer Fork are unavailable while editing. Slash-looking edited text is sent as the edited message, not dispatched as a local composer command. `[confirmed by code]`
- Edit rejects stale session/branch scope, queued prompts, and a busy session. It never invokes Undo, applies workspace mutations, or reads the workspace mutation journal. `[confirmed by code]` `[confirmed by tests: desktop/src/app/user-message-edit-actions.test.ts]`
- Once rewind commits, a later tab switch or refresh/resend failure retires the pending edit instead of allowing another rewind against its old target. Edited input is kept when it was not sent. Desktop refreshes the source session's history cache without replacing another tab's transcript; TUI also retires edits when cancelled/rejected navigation has already moved the branch. Navigation cancelled before any branch change keeps the edit pending. `[confirmed by tests: desktop/src/app/composer-message-edit.test.ts, tests/user-message-edit.test.ts]`
- Desktop and TUI **Edit and resend** use parent-entry navigation and retain the old tree. A user entry that is itself the current tree leaf cannot be edited until the session has a later entry; Pi navigation otherwise treats that target as a no-op. After navigation, rewind success allows a contiguous suffix of context-neutral custom entries appended by session-tree handlers, but only when each entry's parent lineage reaches the selected message's parent. Missing, cyclic, unrelated, or context-bearing entries fail closed. This accounts for diagnostic metadata appended after SDK navigation without retrying an already-completed rewind. `[confirmed by code: src/app/session/message-edit-rewind.ts, src/app/workspace/user-message-edit.ts, src/bundled-extensions/workspace-undo/index.ts]` `[confirmed by tests: tests/message-edit-rewind.test.ts, tests/user-message-edit.test.ts, tests/workspace-undo-extension.test.ts]`
- Desktop can recover a rewind that committed before its RPC reported an error. For **rewind only**, ACP may forward the exact persisted inactive user entry ID to the private bridge. The bridge returns success without navigation only when its live leaf is that user's parent or a contiguous custom-entry suffix reaching that parent. New messages, summaries, unrelated ancestry, missing entries, or cycles reject recovery. This exception never uses prompt-text matching, restores an inactive branch, or rolls back workspace files; busy/queued and bridge-availability checks still apply. `[confirmed by code: acp/src/acp/pix-acp-agent.ts, src/bundled-extensions/workspace-undo/index.ts]` `[confirmed by tests: acp/test/agent.test.ts, tests/workspace-undo-extension.test.ts]`

## Undo changes contract

- **Undo changes** is idle-only and targets a concrete Pi user entry on the active branch. It never chooses a target by comparing prompt text. `[confirmed by code: acp/src/acp/pix-acp-agent.ts]`
- Desktop ACP children load the bundled `workspace-undo` extension. Its private command is not advertised in the Desktop slash-command catalog, and ACP verifies that the bridge command exists before invoking it so the private command text can never fall through as a model prompt. `[confirmed by code: src/bundled-extensions/workspace-undo/index.ts, acp/src/acp/pix-acp-agent.ts, desktop/src-tauri/src/lib.rs]`
- Mutation ownership is captured at `tool_execution_start`, matching the TUI. A steering/follow-up user message that arrives before the tool finishes cannot steal ownership of an already-running mutation. `[confirmed by code]` `[confirmed by tests: tests/workspace-undo-extension.test.ts]`
- `Write` captures the previous file content before execution. Completed supported mutation tools are normalized through the shared `workspaceMutationFromToolExecution` helper. Each recorded mutation is appended as hidden `pix-workspace-mutation` session metadata with its owning user entry ID. `[confirmed by code: src/app/workspace/workspace-undo.ts, src/bundled-extensions/workspace-undo/index.ts]`
- The mutation metadata is session/branch data, not an LLM message. TUI history rendering explicitly hides it; Pi custom session entries are not model-context messages. `[confirmed by code: src/app/session/session-history.ts]`
- Undo first computes the selected-and-later active-branch mutation plan, then calls Pi `navigateTree(targetEntryId)`, then applies only those recorded workspace mutations in reverse order through the shared `revertWorkspaceMutations`. `[confirmed by code]`
- Undo does **not** run `git reset`, `git restore`, `git checkout`, reset the index, or infer ownership from the repository working tree. The existing shared patch reverter may invoke `git apply --check` / `git apply --reverse` only as a patch-application engine for a previously recorded mutation. `[confirmed by code: src/app/workspace/workspace-undo.ts]`
- A recorded `Write` is reverted only when the current file content exactly matches the content left by that mutation. A changed file is treated as a conflict and is not overwritten. Patch mutations are similarly checked before application. `[confirmed by code]` `[confirmed by tests: tests/workspace-undo-extension.test.ts, tests/workspace-undo.test.ts]`
- If earlier mutations in the same undo have already been reverted when a later mutation conflicts, the shared reverter reapplies those earlier mutations so the workspace is not left in a partially undone state. `[confirmed by code]` `[confirmed by tests: tests/workspace-undo.test.ts]`
- A workspace conflict does not undo the already-completed session rewind. Desktop reports a warning, reloads the rewound transcript, and restores the selected user text into the composer. `[confirmed by code: desktop/src/app/user-message-context-actions.ts]`

## TUI and legacy compatibility

- New TUI mutations continue to use the existing in-process/external undo index and are also appended as hidden session mutation entries. This makes a TUI-created session undoable later from Desktop without changing TUI menu semantics. `[confirmed by code: src/app/workspace/workspace-actions-controller.ts]`
- Desktop never writes the shared legacy undo index. For an older TUI session that has no session mutation entry for a user turn, the Desktop bridge reads that user's legacy index entry as a compatibility fallback. Session mutation entries win when present, preventing duplicate application. `[confirmed by code: src/bundled-extensions/workspace-undo/index.ts]` `[confirmed by tests: tests/workspace-undo-extension.test.ts]`

## Concurrency guarantees

- Parallel Desktop sessions can record mutations independently because their primary mutation journal lives in each Pi session JSONL branch rather than a shared Desktop mutation file. `[confirmed by code]`
- Undo is optimistic and conflict-safe, not a lock over the workspace: another session may continue editing. If its edit changes the expected post-mutation file state before this session reverts, this session refuses to overwrite that newer content. `[confirmed by tests: tests/workspace-undo-extension.test.ts]`
- Session lifecycle scoping remains independent per ACP session. Copy/Fork/Undo require an active-branch target. Edit normally does too; only the history-only rewind bridge can authorize the exact persisted-ID recovery described above against its live parent lineage. `[confirmed by code: acp/src/acp/pix-acp-agent.ts, src/bundled-extensions/workspace-undo/index.ts]`

## Non-goals
- Transactional rollback after an accepted edit: if navigation succeeds but the session is switched or resend fails, the branch can remain rewound. The original entries remain in the session tree; stale completion must never submit into the replacement session.

- Adding Retry, Create task, Delete message, or any other new context-menu command.
- Repository-level rollback based on Git HEAD, index, status, stash, or branch state.
- Merging or automatically resolving concurrent edits made by another session.
- Restoring image attachments into the composer after Undo; the selected text is restored and attachments are cleared.

## Verification

- Running-source preservation, latest transcript/composer ownership, late source updates, stale fork cleanup, and unchanged replacement/history/mutation gates. regression checks cover running-session action permissions, runtime readiness and renderer-only rejection. regression checks cover selected-session automatic/deferred queue guards without altering transcript activity.
- Exact persisted/bound entry selection with duplicate text, hidden entries and an in-flight user, plus fail-closed unbound/legacy rows. regression checks cover first-new-entry binding with steering and stale binding rejection.
- Composer prefill, preparation, removable attachments, draft restoration, ordinary Send, cancelled navigation and stale scope. Composer tests also cover Edit/Cancel/Send while another session runs and rejection while the selected session, operation or history is busy. regression checks cover TUI main-composer cancellation, Send, exact branch navigation and preservation of the old tree.
- Session mutation recording, tool-start ownership, conflict refusal against a later parallel edit, legacy TUI index fallback, and committed-rewind recovery without another navigation, including a real SDK acknowledgement-failure regression and rejection after new context.
- Patch/write rollback, changed-file refusal, path confinement, and transactional rollback after a later failure.
- TUI mutations also append portable hidden session entries.
- Hidden workspace-mutation entries do not render in TUI history.
- Current-branch entry lookup, duplicate prompt text, abandoned branches, private bridge gating, Copy/Undo ACP behavior, and exact persisted-ID rewind retries with busy/queued guards and authoritative bridge rejection.
- Desktop private RPC shapes; regression checks cover binding optimistic rows to Pi entries or renderer-only state.
- Root, ACP, Desktop TypeScript/Svelte checks and Rust compilation must remain green.

## Decisions

- [Identity-only Desktop message actions](../../decisions/0018-desktop-message-action-identity.md)

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"45340573f8a59041a50fae8b89d94d12cbabcf0cd8045fbeb2f126956bce2c12","checkedAt":"2026-10-31T00:40:47.046Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":65,"reportLanguage":"ru"} -->
