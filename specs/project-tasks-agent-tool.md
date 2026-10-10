---
kind: spec
status: active
---

# Saved project tasks: SQLite agent API and slash commands

## Scope

- Project tasks belong to the session cwd; they are **not** the session-local
  `todo` plan. Their only persistent source is `<cwd>/.pi/tasks.sqlite`.
- No legacy compatibility, import or fallback exists for `tasks.jsonc`,
  `tasks.json`, `tasks.d/`, Markdown task lists or old attachment markers.
  Files left by older versions remain untouched and are **never consulted**.
- `project-tasks` is a default-enabled pi-tools-suite module, independent
  of IDX. The `project_tasks` tool and user-invoked `/tasks`/`/task`
  commands use the same validated SQLite storage layer.
- Tasks returned to a model enter that model's context. Reads do not copy
  attachment bytes into context or trigger another model/network call.

## User commands

```text
/tasks list
/tasks list {"status":"todo","priority":"high","type":"bug"}
/task get <id>
/task add {"type":"feature","title":"Fix reconnect","description":"..."}
/task update {"id":"<id>","status":"done"}
/task delete <id>
/task attach <id> <relative-project-file>
```

- Commands run only on explicit invocation by the user. They do not ask the
  model to infer a task mutation. Missing/invalid parameters report usage.
- Add requires a valid type (`bug`, `feature`, `improvement`, `idea`)
  and nonblank title and/or description; new tasks default to `todo` /
  `medium`. Update is a bounded patch, not a document replacement. Delete
  removes only the named row and cascades its attachment references.
- Attach accepts only a regular file within the current project, with a 25 MiB
  size bound; refuses symlink/escaped paths. File bytes are copied once into
  an immutable SHA-256-named blob and associated with the exact task id.
- `/task get` returns the task plus linked attachment **metadata**.
- Task payloads may contain optional `parentId`, `epic`, `relatedTaskIds`,
  `modelRef` and `links`. The agent-facing update tool never exposes these
  structural fields and preserves them on status/title/description patches.
  Deleting a task with remaining child or related-task references is rejected
  under the SQLite writer transaction instead of leaving a broken hierarchy.

## Restricted agent tool

- The model-facing tool is named `project_tasks` and accepts:
  - `list` with optional status/priority/type filters (compact results);
  - `get` with id (full task and attachment metadata);
  - `create` with type and content, **only at an explicit user request**;
  - `update` with id and at least one of status/priority/title/description.
- Tool schema **does not expose delete, bulk modification, reorder, arbitrary
  SQL, project-root override, attachment write, raw file write or storage
  reset**. Unsupported fields are errors. Type, id, links, sessionId and
  createdAt are not editable by this tool.
- Status changes require explicit user confirmation, except the task launch
  prompt can authorize final `done` after verified completion or `failed`
  when the named task cannot be completed. That one-task authorization grants
  no access to other tasks. Report persistence failures; never silently
  create replacement tasks.
- These are restrictions on this tool, not an OS sandbox: a separately
  privileged shell/file tool could still modify SQLite directly if its
  permissions allow it. Agent system guidance must prohibit bypassing the
  task API; stronger guarantees require OS-level capabilities.

## Database contract

Schema v1 in `sqlite_master` plus `PRAGMA user_version=1`:

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE attachments (
  hash TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  size INTEGER NOT NULL
);
CREATE TABLE task_attachments (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  hash TEXT NOT NULL REFERENCES attachments(hash),
  ordinal INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, hash)
);
```

- Each payload is the strict version-one `ProjectTask` JSON object; ids are
  unique, title/description are bounded and nonempty in combination, enum
  values and timestamps are validated. Reads fail closed on invalid schema,
  payload or row identity. A missing database reads as no tasks; only explicit
  create/initialization creates it.
- The optional per-task `parentId`, `epic`, `relatedTaskIds` and `modelRef`
  fields require no table or database-version migration. Referenced task IDs
  must exist; cycles, self-links and duplicate references are prohibited. The
  same constraints are checked again on the committed-candidate task set under
  the writer transaction, preventing a deletion race or stale reference.
- Enable SQLite WAL, foreign keys, and `busy_timeout=5000`; SQLite itself
  coordinates cross-process readers/writers. There is **no custom lock file,
  native-lock binding, lease or lock reclamation**.
- An update/delete operates on **one row** inside `BEGIN IMMEDIATE` with
  `WHERE id=? AND revision=?`; a mismatched revision rejects the change.
  Different rows are independently updated, without serializing a whole task
  document. A successful mutation increments only the selected revision.
- Desktop's existing document-shaped save adapter compares expected vs desired
  to allow exactly one task mutation; it never replaces all database rows.
  A separate user-owned native reordering operation updates one moved task and
  adjusts integer position columns transactionally from the latest committed
  state, without changing other task payloads. The agent tool has no reorder.
  Desktop retains Quick Add, the editor and its attachments, status/priority
  menus, delete confirmation, drag-and-drop and Composer Create task.
- Use normal SQLite transaction, close/cancellation lifetime rules. Fail on
  unsupported versions, symlinks or nonregular database/sidecar files.
  SQLite's `-wal`/`-shm`/`-journal` sidecars are ephemeral: on macOS/APFS,
  `lstat` can race their final unlink and observe an inode with `nlink=0`.
  Treat that as an already-removed file, not as a hard-link attack. Reject
  sidecar `nlink>1` and continue enforcing `nlink===1` for the main database
  and immutable blob files. Desktop, agent storage, and ACP Registry must
  agree on this rule and must not delete or replace live SQLite sidecars.

## Attachment and Registry semantics

- Task descriptions are ordinary text. Metadata and task-to-attachment links
  live in SQLite; no `file://` markers are stored as task attachment truth.
  Blobs are `.pi/task-attachments/<64-character-lowercase-SHA256>`, copied
  immutably with a verified content hash. Sharing is by hash; removing a task
  does not immediately unlink a blob. Optional GC must be explicit and
  reference-aware, not part of task saves.
- Registry pushes use SQLite's online backup for a consistent WAL snapshot and
  normalize/hashes committed task rows plus referenced attachment metadata and
  bytes. Pull imports rows in a guarded SQL transaction; the live database
  inode/WAL are never naively replaced. Registry actions are explicit bulk
  synchronization, **not** part of the restricted agent tool.
- This format is a deliberate clean break. Legacy task files are left alone
  (not parsed, migrated or deleted), and pre-SQLite remote Registry artifacts
  are not treated as current project tasks.

## Evidence and owners

- `external/pi-tools-suite/src/project-tasks/{index,commands,engine,storage,attachments}.ts`
- `external/pi-tools-suite/test/project-tasks.test.ts`
- `external/pi-tools-suite/src/project-search/engine.ts`
- `desktop/src-tauri/src/project_tasks_sqlite.rs`
- `desktop/src-tauri/src/lib.rs`
- `acp/src/registry/{task-database,task-bundle}.ts`
- `acp/test/registry.test.ts`
- [Desktop panel and launch](../docs/desktop-task-manager.md)
