# Spec: Desktop Project Task Manager

## Type

As-is

## Lifecycle

Active current contract.

## Goal

Provide a project-scoped task list in Pix Desktop and let a saved task start or
reopen work in a Desktop session without conflating project tasks with the
agent's session-local todo list.

## Scope

- A collapsible, resizable left activity sidebar whose project-scoped views
  include `Tasks` and `Project` alongside other workspace views.
- Create, edit, delete, manual status changes, drag reordering, and moving tasks
  between type groups.
- Create an untitled task directly from the normal message composer through its
  overflow menu, carrying the current draft text and attachments without
  sending a prompt.
- Task type (`bug`, `feature`, `improvement`) and status (`backlog`, `todo`,
  `in-progress`, `done`).
- Persisted priority (`low`, `medium`, `high`, `urgent`). New tasks currently
  receive `medium`; priority is not exposed by the current task editor or rows.
- Project-local persistence in `.pi/tasks.jsonc` with a versioned schema.
- Starting an unlinked task in a new ACP session and reopening an already-linked
  session instead of creating a duplicate.
- Task descriptions can contain attachment markers; those attachments are
  resolved when the task prompt is built.

## Non-goals

- Kanban columns, subtasks, dependencies, assignees, due dates, comments, or
  task history.
- Task filtering controls in the current sidebar UI.
- Editing or displaying priority in the current sidebar UI.
- Automatic transition to `done` when an agent turn finishes.
- Synchronizing `.pi/tasks.jsonc` with the agent's session-local todo list.
- Concurrent multi-window file merging.

## Behavior

1. On first use the sidebar starts on `Tasks`; afterward it restores the last
   active sidebar view. It remembers its width/collapsed state locally and keeps
   a compact activity rail available while collapsed.
2. Tasks are grouped by type. Dragging a task reorders it; dropping it into a
   different group also changes its type and updates `updatedAt`.
3. Task rows show the title when present. Untitled tasks use the first line of
   description as their display label, or `Untitled task` when they contain only
   attachments. Rows also show status, session/run action, edit, and delete
   controls. Status uses icon, text, and color rather than color alone.
4. Manual creation through the task editor still requires a non-empty title.
   Tasks start with status `todo` and priority `medium`, and may include
   description text and attachments. Existing untitled composer-captured tasks
   may be edited without inventing a title as long as description content or
   attachments remain.
5. Editing changes title, description, and type. Status is changed separately.
   Existing persisted priority is preserved.
6. `.pi/tasks.jsonc` is authoritative. Missing `.pi`/task storage produces an
   empty version-1 document. JSONC comments and trailing commas are accepted.
7. Only `.pi/tasks.jsonc` is recognized as task storage. Other sibling task
   files are ignored; Pix does not import, migrate, delete, or interpret them.
8. Starting an unlinked task creates/selects a new ACP session, persists its
   session id, changes any non-`done` task to `in-progress`, preserves `done`,
   appends the generated task prompt, and sends it immediately.
9. Starting a linked task opens that session. A stale/missing linked session is
   a recoverable error and does not silently create another session.
10. Task completion remains manual.
11. The normal message composer's vertical-ellipsis menu exposes `Create task`
    whenever the current draft has text, attachments, or active voice input.
    Voice input is finalized first. The resulting task has an empty persisted
    title, type `feature`, status `todo`, priority `medium`, and stores the
    composer text plus attachment markers in its description. The prompt is not
    sent to the agent. Pathless composer images are materialized into
    `.pi/task-attachments` before those markers are written.
12. After composer task persistence succeeds, Pix expands/selects the Tasks
    sidebar view, scrolls the newly created task into view, highlights it, and
    clears the composer only if the draft is still the exact draft that was
    captured for task creation. A failed save or edits made while the save is in
    flight preserve the composer.

## Contracts

- Project file: `.pi/tasks.jsonc`.
- Document shape: optional `$schema`, `version: 1`, and `tasks`.
- Each task has a unique id, string title, type, status, priority, `createdAt`,
  and `updatedAt`; description and `sessionId` are optional. The title may be an
  empty string only when description content is present.
- Unknown fields, duplicate ids, unsupported enum values, completely empty task
  content, malformed timestamps, unsupported versions, and oversized documents
  are rejected.
- The Tauri backend confines task paths to the active workspace, rejects escape
  through `.pi` symlinks, and caps the document at 1 MB.
- Writes validate the complete document, write a same-directory temporary file,
  and replace the target to avoid partial JSONC files.

## Invariants

- Failed validation never replaces the task file.
- Failed persistence restores the previous in-memory task document.
- Composer task creation never clears a newer draft that changed while task
  persistence was in flight.
- Composer attachments are persisted through the same task-description marker
  format used by the task editor, so running the task restores those attachments.
- A task is linked to at most one session.
- Running/reordering/editing is disabled while conflicting task/session work is
  active.
- Dragging between groups changes only ordering/type; other task fields survive.

## Edge cases

- Switching workspaces discards the previous in-memory task view and loads the
  new project's task document.
- Missing storage means no tasks; malformed or empty `.pi/tasks.jsonc` is an error.
- Unsupported sibling task files do not participate in task loading.
- Save, session creation, attachment preparation, and prompt failures remain
  visible and retryable.

## Related files

- `desktop/src/App.svelte`
- `desktop/src/components/PromptComposer.svelte`
- `desktop/src/components/WorkspaceSidebar.svelte`
- `desktop/src/lib/attachments.ts`
- `desktop/src/lib/attachments.test.ts`
- `desktop/src/lib/project-tasks.ts`
- `desktop/src/lib/project-tasks.test.ts`
- `desktop/src-tauri/src/lib.rs`
- `src/schemas/tasks-schema.ts`

## Verification

- `desktop/src/lib/project-tasks.test.ts` covers untitled composer task creation,
  parsing, prompt generation, and drag/reorder semantics.
- `desktop/src/lib/attachments.test.ts` covers data-URL decoding used when a
  pathless composer image is persisted into project task storage.
- Rust tests in `desktop/src-tauri/src/lib.rs` cover missing/read/write/malformed
  JSONC, validation, workspace confinement, and ignoring unsupported task files.
- Run `npm --prefix desktop test`, `npm --prefix desktop run check`, and
  `cargo test --manifest-path desktop/src-tauri/Cargo.toml`.

## Risks / unknowns

- Whole-document writes assume one active writer per project; multi-window merge
  semantics remain out of scope.
- A linked session can be removed outside Pix Desktop and remains linked until
  the user repairs or edits the task.
- Priority remains part of the persisted schema although the current UI does not
  expose priority editing.

## Evidence

- Confirmed by code: `desktop/src/App.svelte`, `PromptComposer.svelte`,
  `WorkspaceSidebar.svelte`, and `desktop/src/lib/project-tasks.ts` implement the
  current task lifecycle and composer capture action.
- Confirmed by code: `desktop/src-tauri/src/lib.rs` owns JSONC persistence,
  validation, confinement, atomic replacement, and ignores unsupported sibling
  task-storage formats.
- Confirmed by tests: project-task unit tests and Tauri task persistence tests.
