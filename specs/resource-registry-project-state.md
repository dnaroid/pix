# Resource Registry: project state

## Type

Change

## Lifecycle

Implemented; this is the current project-state registry contract.

## Goal

Synchronize project-scoped tasks, plans, and TODO state through the private Git
registry without making task attachments depend on machine-specific absolute
paths.

## Scope

- `/registry push|pull tasks|plans|todo|project`.
- Project provenance in `.pi/registry.json`.
- Portable synchronization of `.pi/tasks.jsonc` together with the regular files
  referenced from `.pi/task-attachments`.

## Remote layout

For project key `<key>`, the registry stores:

- `projects/<key>/tasks.jsonc`
- `projects/<key>/task-attachments/<file>` for task attachments referenced by
  the synchronized task document
- `projects/<key>/plans/`
- `projects/<key>/TODO.md`

The registry copy of `tasks.jsonc` is transport data. Project-owned attachment
markers are rebased from local `file://` URIs to
`pix-task-attachment:<encoded-name>` markers before the file is committed.
Those portable markers are not written to the local project task file.

## Behavior

1. `push tasks` reads `.pi/tasks.jsonc`, identifies attachment markers whose
   files resolve inside `.pi/task-attachments`, and normalizes those markers to
   the registry-only portable form.
2. Only task attachments referenced by the task document are copied to the
   registry. Re-pushing tasks replaces the remote task-attachment set, so files
   no longer referenced by tasks are removed remotely in the same commit.
3. `pull tasks` validates every portable attachment marker and its corresponding
   regular file, copies the remote attachment set into `.pi/task-attachments`,
   and rewrites the markers to `file://` URIs for the destination workspace.
4. Pull prepares the replacement files before swapping the local task file and
   attachment directory. Existing local state is backed up during the swap and
   restored if replacement fails.
5. The logical hash for the `tasks` project artifact includes the normalized
   task source and the bytes of every referenced bundled attachment. Changing an
   attachment therefore makes Registry status report local changes even when
   `tasks.jsonc` itself did not change.
6. The remote revision for `tasks` follows both
   `projects/<key>/tasks.jsonc` and `projects/<key>/task-attachments/`, so a
   remote attachment-only change participates in update/conflict detection.
7. The registry Git commit stages the current project's directory in the
   disposable clone. Other project keys and reusable skills/agents are not
   included.

## Compatibility

- Existing registry task files without `pix-task-attachment:` markers continue
  to synchronize as legacy task files.
- Legacy `file://` markers outside the local project's `.pi/task-attachments`
  are preserved as-is and are not bundled. New Desktop-created task attachments
  are project-owned, so normal new task state uses the portable bundle path.
- JSONC comments/formatting are preserved except for attachment-marker rebasing.

## Invariants

- Registry attachment names cannot escape the task-attachment directory.
- Registry task attachments must be regular files; symbolic links are rejected.
- Portable registry markers never become the persisted local task-marker form.
- Attachment content participates in provenance hashing.
- A tasks push removes stale remote bundled attachments atomically with the Git
  commit that updates the task document.

## Related files

- `external/pi-tools-suite/src/resource-registry/index.ts`
- `external/pi-tools-suite/test/resource-registry.test.ts`
- `desktop/src-tauri/src/lib.rs`
- `docs/desktop-task-manager.md`
- `specs/desktop-attachments.md`

## Verification

- `bun test test/resource-registry.test.ts` covers project-state push/pull,
  portable task attachments, attachment-only status changes, stale remote
  attachment removal, conflicts, and existing project-state/TUI behavior.
- Desktop Rust task persistence tests cover reference-based local attachment
  pruning after successful task-document writes.

## Risks / unknowns

- Legacy tasks that still reference arbitrary external `file://` paths remain
  non-portable until those attachments are re-saved into project task storage.
- Git remains the transport for attachment bytes, so very large or numerous
  task attachments can increase registry repository size over time even after
  current-state files are deleted from the latest tree.

## Evidence

- Confirmed by code: task push builds a normalized task bundle and copies only
  referenced project-owned attachments; task pull materializes the bundle and
  rebases markers to the destination workspace.
- Confirmed by tests: a pushed attachment is stored without the source
  workspace path, pulls into a new local task-attachment path, changes Registry
  status when its bytes change, and is removed remotely when no task references
  it.
