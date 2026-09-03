# Spec: Desktop Project Task Manager

## Type

Change

## Goal

Add a project-scoped task list to Pix Desktop in a persistent left sidebar and
allow a saved task to start work immediately in a new session tab.

## Scope

- A collapsible, resizable left sidebar with `Tasks` and `Project` tabs.
- A compact task list with create, edit, delete, filtering, and manual status
  changes.
- Task type (`bug`, `feature`, `improvement`), status (`backlog`, `todo`,
  `in-progress`, `done`), and priority (`low`, `medium`, `high`, `urgent`).
- Project-local persistence in `.pi/tasks.json` with a versioned schema.
- Starting a task in a new ACP session, automatically sending a generated
  prompt, marking the task in progress, and storing the new session id.
- Opening an already-linked session instead of creating a duplicate.

## Non-goals

- Kanban, drag and drop, subtasks, dependencies, assignees, due dates,
  comments, or task history.
- Automatic transition to `done` when an agent turn finishes.
- Synchronizing the project task file with the agent's session-local todo list.
- Concurrent multi-window file merging.

## Behavior

1. The sidebar is visible below the title/session chrome, starts on `Tasks`,
   remembers its width and collapsed state locally, and preserves the main
   session workspace at narrow window sizes.
2. Task rows show a title, type, status, priority, and actions. Status and
   priority are communicated by a Lucide icon, text, and color so meaning never
   depends on color alone. `done` is green, `in-progress` is yellow, and idle
   states are neutral; all colors support light and dark themes.
3. Creating or editing validates a non-empty title. A description is optional.
4. Filters affect only the visible list and do not modify persisted ordering.
5. A missing `.pi/tasks.json` is treated as an empty version-1 document.
6. Starting an unlinked task creates and selects a new ACP session, persists
   its id and `in-progress` status, appends the generated user prompt to the
   transcript, and sends it immediately.
7. Starting a linked task loads that session. A missing/stale linked session is
   reported as a recoverable error and does not silently create another one.
8. Task completion remains manual.

## Contracts

- Project file: `.pi/tasks.json` containing `{ version: 1, tasks: [...] }`.
- Every task has a unique id, title, type, status, priority, `createdAt`, and
  `updatedAt`; description and `sessionId` may be omitted.
- Tauri exposes narrow read/write commands for this one file. Workspace paths
  are validated and `.pi` symlinks may not escape the workspace.
- The webview sends a complete validated document on each mutation. Writes use
  a same-directory temporary file and replacement to avoid partial JSON.

## Invariants

- The task document version must be supported before it is displayed or saved.
- Duplicate ids, unknown enum values, empty titles, and malformed timestamps
  are rejected.
- A task is linked to at most one session in this MVP.
- Starting a task is disabled while another prompt/session operation is active.
- A failed save does not leave the UI claiming a task state that was not
  persisted.

## Edge cases

- Switching workspaces discards the previous workspace's in-memory task view
  and loads the new project file.
- Empty and missing files have distinct behavior: missing means no tasks;
  malformed or empty JSON is an error.
- Save, session creation, and prompt failures remain visible and retryable.
- Collapsing the sidebar keeps its tab rail available; choosing a tab expands
  it.

## Related files

- `desktop/src/App.svelte`
- `desktop/src/components/`
- `desktop/src/lib/`
- `desktop/src/styles.css`
- `desktop/src-tauri/src/lib.rs`

## Verification

- Unit tests for task parsing, validation, filtering, prompt generation, and
  sidebar preference parsing.
- Rust tests for missing/read/write/malformed files and workspace escape.
- `npm --prefix desktop test`
- `npm --prefix desktop run check`
- `npm --prefix desktop run build:web`
- `cargo test --manifest-path desktop/src-tauri/Cargo.toml`

## Risks / unknowns

- Whole-document writes assume one active desktop writer per project.
- A linked session may later be removed outside Pix Desktop; the first version
  reports this rather than automatically unlinking it.
- Windows replacement semantics may require a fallback around replacing an
  existing task file while retaining best-effort crash safety.

## Evidence

- Confirmed by code: desktop session creation/loading and prompt submission are
  orchestrated in `desktop/src/App.svelte` through `AcpClient`.
- Confirmed by code: Tauri already validates workspace-contained project file
  reads in `desktop/src-tauri/src/lib.rs`.
- Confirmed by tests: session tab ordering and ACP request behavior have focused
  Vitest coverage under `desktop/src/lib/`.
- Confirmed by docs: `DESIGN.md` specifies a compact persistent sidebar,
  semantic theme roles, Lucide icons, and non-color status cues.
- Implemented: `.pi/tasks.json` now has an explicit version-1 contract and
  rejects unsupported versions rather than guessing a migration.
- Verified by tests: all 82 desktop Vitest tests and all 8 Rust tests pass;
  Svelte/TypeScript checks report no errors or warnings.
- Verified visually: browser QA covered clean preference state, resize/collapse,
  tabs, filters, and semantic colors in light/dark themes.
- Verified natively: actual Tauri UI/backend CRUD, Run, persisted linkage,
  Open session without duplication, and delete cleanup all passed.
