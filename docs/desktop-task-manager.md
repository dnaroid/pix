---
kind: spec
status: active
---

# Pix Desktop project Tasks — SQLite-only

## Goal

Provide a fully interactive, project-scoped Tasks sidebar: Quick Add, editor,
attachments, status, priority, drag-and-drop, deletion, and task/session launch.
User slash commands and the restricted agent `project_tasks` API are additional
entry points, **not replacements for the UI**. Project tasks are distinct from
session-local todos.

## Persistent source

- Only `<project>/.pi/tasks.sqlite` is authoritative, using SQLite schema v1
  (see [agent/storage contract](../specs/project-tasks-agent-tool.md)).
- `PRAGMA journal_mode=WAL`, `foreign_keys=ON`, and five-second
  `busy_timeout` use SQLite's own transaction/lock management.
- No homemade lock files, advisory leases, Koffi/flock bridge or bulk task
  JSON document replacement.
- A nonexistent database reads as zero tasks; a corrupt/unsupported database
  produces an actionable storage error, never an automatic reset.
- **No legacy support or migration.** `tasks.jsonc`, `tasks.json`,
  `tasks.d/`, and old attachment markers are not authoritative and cannot
  supply tasks. Existing ignored files are not deleted.
- New Registry initialization creates `.pi/tasks.sqlite`, `.pi/plans/` and
  `.pi/task-attachments/`, all project-owned regular entries.

## Tasks sidebar behavior

- The initial activity view is Tasks, with per-workspace remembered view,
  width, and collapsed layout. Groups are fixed in this order:
  **In progress, Todo, Backlog, Done, Failed**.
- Group headers display total counts regardless of filters and expose a
  keyboard-accessible button with `aria-expanded`, `aria-controls`, and
  **visible rotating Lucide chevron** in both states. Done starts collapsed;
  the others start expanded. Collapse state is workspace-local UI preference,
  never persisted in SQLite.
- Compact one-line task cards show type icon/tone, title (or description
  preview for untitled tasks), and compact, labeled indicators for real SQLite
  attachments, related files/tasks, a parent/subtask branch, optional assigned
  model and an epic crown. A linked-files icon replaces the ambiguous bare
  numeric link badge. High/urgent/low priority badges are conditional; medium
  is hidden. Status belongs to the task group. Filters do not change totals.
- Clicking or keyboard-activating a card opens its full editor; the separate
  pencil action was removed. A pointer gesture becomes a drag only once its
  movement exceeds the drag threshold, with click suppression after a real
  drag. Action buttons and menus remain independent of card activation.
- Hover/focus of a subtask highlights its parent with a stronger emphasis and
  fades sibling subtasks. Other tasks remain unaffected. The relationship is
  derived from persisted `parentId`, not inferred from descriptions or titles.
- The task editor displays a parent selector, the top-level Epic flag, linked
  subtasks and general related tasks (including reciprocal backlinks), linked
  project files/artifacts and http(s) URLs, attachment count, and an optional
  `provider/model[:thinking]` assignment. Model selection **reuses** the Desktop
  model/thinking picker, its preferred/visible models, full-catalog `Manage`
  mode, search, remembered effort and per-model effort capabilities. Choosing
  a model and effort writes only the task draft, never the current session's
  configuration; `Apply` must work even when it matches the current session.
  Clearing the task model restores "Use session default". Task Type, Parent,
  Related task, and sidebar type/priority filters use designed Pix dropdowns
  with visible chevrons, search where useful, keyboard navigation, Escape and
  outside dismissal, rather than native OS select menus. The project file-link
  input also uses a Pix-owned searchable suggestion popup instead of a native
  datalist, while continuing to accept manually entered paths and URLs.
  Clicking related tasks navigates to
  their editor; editing links is one-row-only. Linked project paths open in
  the trusted workbench Preview; external links use the safe URL opener.
  Navigating away from changed task fields requires discard confirmation.
- A visible Quick Add composer classifies short tasks through the existing
  `pix/tasks/classify_type` ACP request. The status group **Add** action opens
  the full editor with that status; Composer also has **Create task**.
- Row actions include **Run** for unlinked tasks or **Open session** for linked
  tasks, status/priority controls, and **Delete** with confirmation.
  An unavailable ACP session disables Run/Open without disabling editing.
- Drag-and-drop supports both moving between status groups and ordering
  within a group. The view shows drop placeholders and preserves per-status
  group and filter presentation while dragging.
- An expanded visible panel reloads from native SQLite initially and every
  two seconds. Hidden/collapsed/unmounted panels stop polling. Late reads,
  workspace switches, and teardown use generation guards; failures retain
  the current visible data and surface a retry/error message.
- Each regular UI task save (including session launch) may mutate exactly
  **one** row with revision-based optimistic conflict checking, never replace
  all rows. A dedicated native SQLite drag/reorder transaction recomputes
  positions from committed state and changes only the moved task's content;
  other tasks' order positions may be rebalanced without overwriting payloads
  or invalidating their content revisions.

## Running a saved task

1. If a linked session exists, open it without creating another session or
   emitting another prompt; a stale session is an actionable error.
2. For an unlinked task, create a new ACP session and save only that task's
   `sessionId` and `in-progress` status (unless it is already `done`).
   Start the generated prompt immediately. Preserve an independent unsent
   conversation draft when switching sessions. An optional task `modelRef`
   configures the new session's model and thinking level via the existing ACP
   `newSession` override; when absent, normal session defaults apply. An
   already-linked session opens unchanged and is never silently reconfigured.
3. The launch prompt identifies the task id and explicitly authorizes its
   final `done` (completed and verified) or `failed` (could not complete)
   status via `project_tasks update` without asking a second time. Transient
   retry errors are not terminal failure. Other task/status modifications
   still require explicit user authorization.
4. Query `read_project_task_attachments` from SQLite for that **same task id**.
   Resolve the row's immutable SHA-256 blob with native safe-file validation
   and the attachment permission gate, then submit it through the normal
   transcript attachment pipeline. Descriptions remain plain text; attachment
   paths are not embedded in SQLite task description strings.
5. Errors in saving a final status must be reported; interrupted turns do not
   automatically mark a task failed.

## Attachment semantics

- User command `/task attach <id> <project-relative-file>` copies a verified
  regular file (maximum 25 MiB, no symlink/path escape) into
  `.pi/task-attachments/<sha256>` and records hash, display name, byte count
  and task id association in SQLite. Equal content deduplicates naturally.
- The UI editor's picker/paste pipeline first materializes content-addressed
  blobs, loads current associations by task id, and commits updated task
  fields and attachment associations in **one SQL transaction**. Failed
  association loading disables Save; stale completion cannot clear links.
- Card attachment badges query task association counts in bulk without opening
  or approving the blobs. The full editor still validates and resolves the
  actual files through `read_project_task_attachments` before saving.
- Composer **Create task** attaches selected saved blobs to the new task and
  only clears the draft after the successful task-and-attachment commit.
- References are relational, with foreign keys and `ON DELETE CASCADE`.
  Physical blobs are immutable and not pruned during a save. A future GC
  could remove unreferenced blobs explicitly after proving no references.
- Unsubmitted composer/draft attachments remain separate from saved tasks;
  only an explicit user action attaches them to a newly saved task.

## Task relationships

- The SQLite payload schema v1 remains the same; optional `parentId`, `epic`,
  `relatedTaskIds` and `modelRef` fields extend it without changing the SQL
  table layout. Existing tasks without these fields remain top-level ordinary
  tasks and use the default session model.
- `parentId` references exactly one existing task. Parents must be present,
  and cycles, self-links, dangling task references, duplicate related-task
  IDs and a simultaneous `epic=true` plus `parentId` are rejected.
- `relatedTaskIds` are directional stored links, with reverse relationships
  derived for display so creating a relation never rewrites another task row.
  Deleting a referenced task requires unlinking/reparenting dependents first.
  Validation runs under the SQLite write transaction, not only in the UI;
  agent and slash updates preserve optional fields and reject invalid deletes.
- `links` store project-relative file/artifact paths or regular web URLs;
  unsafe local paths are rejected by the editor. Existing `links` are presented
  as named, clickable rows, not anonymous counts. Attachments remain a separate
  SQLite association table rather than embedded paths in a description.

## Registry interaction and storage safety

- Each successful Desktop task save marks the Registry `tasks` artifact
  dirty for debounced background sync; failures do not schedule a push.
  Agent/slash updates are observed by panel polling and Registry local
  hashing independently of Desktop callbacks.
- Registry exports a committed consistent SQLite snapshot (SQLite online
  backup, including WAL contents), plus referenced content-addressed blobs.
  It hashes canonical task rows/relationships and verified attachment
  bytes, not the physical DB file or temporary WAL/SHM bytes.
- Registry imports into the existing local database **inside a transaction**,
  with provenance/expected-hash conflict checks and without replacing its
  inode. Pull is a deliberate bulk action outside the restricted task API.
- Cleanup preserves `tasks.sqlite`, `tasks.sqlite-wal`,
  `tasks.sqlite-shm`, `task-attachments/`, and durable project state.
  It does not clear live journal sidecars or follow symlinks.
- Reject redirected SQLite files/sidecars, nonregular files, unsupported
  schema versions, invalid task payloads, unsafe blobs and invalid hashes.
  Read errors never authorize data deletion or recreation.
- On macOS/APFS, concurrent SQLite last-close cleanup can expose `-wal` or
  `-shm` metadata with `nlink=0` just after its inode was unlinked. That is
  a normal ephemeral state, **not** a hard link, and must not block Tasks.
  `nlink>1` on a sidecar still rejects an actual hard-link alias, as do
  symlinks and nonregular files. The canonical `.pi/tasks.sqlite` and
  immutable attachment blobs continue to require exactly one link.

## Implementation and verification

- `desktop/src/components/WorkspaceSidebarTasksPanel.svelte`
- `desktop/src/components/TaskFieldSelect.svelte`
- `desktop/src/components/TaskProjectLinkInput.svelte`
- `desktop/src/components/WorkspaceSidebarTaskModelControl.svelte`
- `desktop/src/components/ModelThinkingPicker.svelte`
- `desktop/src/components/WorkspaceSidebar.svelte`
- `desktop/src/app/project-tasks.svelte.ts`
- `desktop/src/app/project-actions.svelte.ts`
- `desktop/src-tauri/src/project_tasks_sqlite.rs`
- `desktop/src-tauri/src/lib.rs`
- `desktop/src/components/WorkspaceSidebarTasksPanel.test.ts`
- `desktop/src/components/WorkspaceSidebar.test.ts`
- `desktop/src/app/project-actions.test.ts`
- `desktop/src-tauri/src/lib.rs` native SQLite/revision/blob/Registry tests

The API restriction does **not** sandbox all OS file tools: independently
privileged code could still open `.pi/tasks.sqlite` directly. The sanctioned
agent interface never grants arbitrary SQL or all-task replacement.
