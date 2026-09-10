# Desktop user-message actions

<!-- markdownlint-disable MD013 -->

## Type

Change.

## Lifecycle

Active implemented contract.

## Goal

Pix Desktop exposes the same four user-message actions as the TUI without adding a second editing model or using repository-wide Git state for workspace rollback. Undo must remain safe when several Pix sessions share one project directory and mutate files concurrently.

## Menu contract

- A Desktop user message exposes exactly four actions: **Copy message**, **Fork**, **Fork in new tab**, and **Undo changes**. No additional message actions are part of this contract. `[confirmed by code: desktop/src/components/TranscriptPane.svelte]`
- The menu is available from the user bubble's context menu and from an ellipsis button shown on hover/focus. It renders as a viewport-fixed overlay outside transcript-entry paint containment, flips above the anchor when there is not enough room below, and stays above the composer/chrome instead of being clipped by transcript scrolling. Each of the four actions has a dedicated icon. Escape, transcript scrolling/resizing, or an outside click closes it. `[confirmed by code: desktop/src/components/TranscriptPane.svelte]`
- Copy remains available for renderer-only user rows. Fork and Undo actions require a real Pi user session entry and are disabled while the active session is busy. `[confirmed by code]`
- Newly submitted Desktop rows are associated with Pi entries by comparing current-branch user entry IDs before and after the serialized prompt. Extension/builtin commands that create no Pi user entry are marked renderer-only. Historical rows resolve against the ordered current branch rather than by message text, so repeated identical prompts remain unambiguous. `[confirmed by code: desktop/src/App.svelte, acp/src/acp/pix-acp-agent.ts]`

## Copy and fork behavior

- **Copy message** copies the full selected message. Session-backed rows use the existing ACP host clipboard path; renderer-only rows use the Desktop browser clipboard. `[confirmed by code]`
- **Fork** forks at the selected Pi user entry and replaces the currently open source session, matching the existing Desktop `/fork` behavior. `[confirmed by code: desktop/src/App.svelte]`
- **Fork in new tab** uses the same Pi `session/fork` primitive but keeps the source ACP session/tab open and activates the new fork. `[confirmed by code]`

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
- A workspace conflict does not undo the already-completed session rewind. Desktop reports a warning, reloads the rewound transcript, and restores the selected user text into the composer. `[confirmed by code: desktop/src/App.svelte]`

## TUI and legacy compatibility

- New TUI mutations continue to use the existing in-process/external undo index and are also appended as hidden session mutation entries. This makes a TUI-created session undoable later from Desktop without changing TUI menu semantics. `[confirmed by code: src/app/workspace/workspace-actions-controller.ts]`
- Desktop never writes the shared legacy undo index. For an older TUI session that has no session mutation entry for a user turn, the Desktop bridge reads that user's legacy index entry as a compatibility fallback. Session mutation entries win when present, preventing duplicate application. `[confirmed by code: src/bundled-extensions/workspace-undo/index.ts]` `[confirmed by tests: tests/workspace-undo-extension.test.ts]`

## Concurrency guarantees

- Parallel Desktop sessions can record mutations independently because their primary mutation journal lives in each Pi session JSONL branch rather than a shared Desktop mutation file. `[confirmed by code]`
- Undo is optimistic and conflict-safe, not a lock over the workspace: another session may continue editing. If its edit changes the expected post-mutation file state before this session reverts, this session refuses to overwrite that newer content. `[confirmed by tests: tests/workspace-undo-extension.test.ts]`
- Session lifecycle scoping remains independent per ACP session. Copy/Fork/Undo requests validate the target against the current active branch before acting. `[confirmed by code: acp/src/acp/pix-acp-agent.ts]`

## Non-goals

- Adding Edit, Retry, Create task, Delete message, or any other new context-menu command.
- Repository-level rollback based on Git HEAD, index, status, stash, or branch state.
- Merging or automatically resolving concurrent edits made by another session.
- Restoring image attachments into the composer after Undo; the selected text is restored and attachments are cleared.

## Related files

- `desktop/src/components/TranscriptPane.svelte`
- `desktop/src/App.svelte`
- `desktop/src/lib/acp-client.ts`
- `desktop/src/lib/transcript.ts`
- `desktop/src-tauri/src/lib.rs`
- `acp/src/acp/desktop-commands.ts`
- `acp/src/acp/pix-acp-agent.ts`
- `acp/src/config.ts`
- `acp/src/main.ts`
- `src/bundled-extensions/workspace-undo/index.ts`
- `src/app/workspace/workspace-actions-controller.ts`
- `src/app/workspace/workspace-undo.ts`
- `src/app/session/session-history.ts`

## Verification

- `tests/workspace-undo-extension.test.ts` covers session mutation recording, tool-start ownership, conflict refusal against a later parallel edit, and legacy TUI index fallback.
- `tests/workspace-undo.test.ts` covers patch/write rollback, changed-file refusal, path confinement, and transactional rollback after a later failure.
- `tests/workspace-actions-controller.test.ts` verifies TUI mutations also append portable hidden session entries.
- `tests/session-history.test.ts` verifies hidden workspace-mutation entries do not render in TUI history.
- `acp/test/agent.test.ts` covers current-branch entry lookup, duplicate prompt text, abandoned branches, private bridge gating, and Copy/Undo ACP behavior.
- `desktop/src/lib/acp-client.test.ts` covers Desktop private RPC shapes; `desktop/src/lib/transcript.test.ts` covers binding optimistic rows to Pi entries or renderer-only state.
- Root, ACP, Desktop TypeScript/Svelte checks and Rust compilation must remain green.
