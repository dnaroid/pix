# Resource Registry: project state

## Type

Change

## Lifecycle

Implemented; this is the current project-state registry contract.

## Goal

Synchronize project-scoped tasks, plans, TODO, and workspace state through the private Git
registry without making task attachments depend on machine-specific absolute
paths.

## Scope

- `/registry push|pull tasks|plans|todo|workspace|project`.
- Project provenance in `.pi/registry.json`.
- Portable synchronization of `.pi/tasks.jsonc` together with the regular files
  referenced from `.pi/task-attachments`.
- Pix Desktop local project-state initialization for workspaces that do not yet
  have a `.pi` directory.

## Remote layout

For project key `<key>`, the registry stores:

- `projects/<key>/tasks.jsonc`
- `projects/<key>/task-attachments/<file>` for task attachments referenced by
  the synchronized task document
- `projects/<key>/plans/`
- `projects/<key>/TODO.md`
- `projects/<key>/workspace.jsonc`

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
8. Pix Desktop owns one background project-state sync coordinator. A successful
   task-document write marks `tasks` dirty; saving `.pi/TODO.md` marks `todo`
   dirty; saving a file under `.pi/plans/` marks `plans` dirty; successful
   Desktop saves of `.pi/workspace.jsonc` mark `workspace` dirty. The fast sidebar
   Registry poll also reports project artifacts that changed outside those
   Desktop save paths, so agent/external edits enter the same coordinator.
9. Dirty project-state writes are debounced for approximately 900 ms. Repeated
   writes to one artifact collapse into one push, while more than one dirty
   artifact collapses into one `push project` operation.
10. Background sync never takes the Desktop foreground-operation lock. Because
    the current ACP Registry bridge executes the private action through the
    owning session, the coordinator waits until that session is runtime-ready,
    not prompting, not loading history, and not executing another Registry or
    foreground operation. A blocked sync remains pending and retries on a short
    idle cadence instead of dropping dirty state. While the actual background
    Registry RPC is in flight, Registry-panel actions are locally disabled so a
    manual Registry command cannot overlap it; unrelated Desktop UI remains
    available.
11. Dirty state is removed from the current batch before an RPC starts. If the
    same or another artifact changes while that RPC is in flight, the new dirty
    state survives and starts another debounced pass after the current pass
    completes.
12. Workspace changes reset coordinator state with a generation guard, so a late
    response from the previous workspace cannot clear or overwrite the new
    workspace's pending/sync UI state.
13. A retryable ACP busy race returns to `pending`. Other thrown background-sync
    failures become an `error` state and retain the dirty artifacts. A later
    local edit or foreground Registry action can retry that retained state.
14. Pix Desktop checks local `.pi` initialization independently from remote
    Registry configuration and ACP session readiness. When `.pi` is absent, the
    Registry panel offers **Initialize project Registry**. The local action
    creates `.pi/tasks.jsonc` as an empty version-one task document plus
    `.pi/plans/` and `.pi/task-attachments/`, then reloads project tasks and
    documents. Remote Registry setup remains a separate action.
15. Saving a TODO or plan never creates a missing `.pi` directory. Those
    project-document writes require the explicit local initialization action,
    so a document edit cannot silently create incomplete Registry state.
16. `.pi/workspace.jsonc` is a project artifact with the same project-key,
    provenance, status, conflict confirmation, and push/pull semantics as TODO;
    its remote path is `projects/<key>/workspace.jsonc`. Pulling it refreshes
    Desktop project settings; switching back to the scripts panel loads the
    pulled launch commands. The whole file is synchronized without redaction:
    do not put credentials or private shell arguments in it unless the private
    Registry remote is trusted to hold them. The Desktop ACP Registry request
    validator accepts `workspace` for both `push-project` and `pull-project`,
    while still rejecting unknown project scopes.

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
- Every successful Desktop task mutation reaches the background sync coordinator
  through the centralized task-document save path; failed local persistence never
  schedules a remote push.
- Background project sync is coalesced to one in-flight Registry action. It does
  not force-push through provenance conflicts.
- The sidebar's cheap Registry task check hashes the same normalized task bundle
  as Registry provenance, including referenced attachment bytes, so a completed
  background push can converge back to a clean local indicator.
- Desktop project-state initialization is explicit and idempotent. Its marker is
  the complete scaffold: a regular `.pi/tasks.jsonc` plus project-owned regular
  `.pi/plans/` and `.pi/task-attachments/` directories. A bare `.pi` directory
  or unrelated `.pi/pix.jsonc` is not initialized state. Existing task content
  is never overwritten, and `.pi` plus scaffold subdirectories must be regular
  project-owned directories rather than symbolic links escaping the workspace.
- Initialization inspects an already-existing `tasks.jsonc` before accepting a
  concurrent publish race: it must be a regular file canonically inside `.pi`.
  An existing symbolic link, directory, or escaping target is an error, never
  an idempotent-success result.
- Desktop TODO and plan saves never bootstrap a missing `.pi`; explicit
  initialization is the only Desktop project-document path that creates it.
  Task-document and task-attachment saves likewise require the complete
  explicit-initialization scaffold.
- Markdown saves write and flush a temporary file through no-follow directory
  handles, then atomically replace the destination entry. A destination symlink
  installed before or during the save is replaced rather than followed.
- Concurrent Desktop initializers use create-or-inspect directory operations and
  publish the task skeleton only after it is fully written and flushed. A
  competing initializer preserves the already-published task document; it never
  observes or accepts a partially written final file.

## Related files

- `external/pi-tools-suite/src/resource-registry/index.ts`
- `external/pi-tools-suite/test/resource-registry.test.ts`
- `acp/src/acp/desktop-commands.ts`
- `acp/test/desktop-commands.test.ts`
- `desktop/src-tauri/src/lib.rs`
- `desktop/src/app/registry.svelte.ts`
- `desktop/src/app/registry-store.test.ts`
- `desktop/src/lib/registry.ts`
- `desktop/src/lib/registry-background-sync.ts`
- `desktop/src/components/RegistryPanel.svelte`
- `docs/desktop-task-manager.md`
- `specs/desktop-attachments.md`

## Verification

- `bun test test/resource-registry.test.ts` covers project-state push/pull,
  portable task attachments, attachment-only status changes, stale remote
  attachment removal, conflicts, and existing project-state/TUI behavior.
- Desktop Rust task persistence tests cover reference-based local attachment
  pruning after successful task-document writes, idempotent `.pi` skeleton
  initialization without overwriting an existing task document, concurrent
  initialization with atomic task-skeleton publication, rejection of bare
  `.pi`/`.pi/pix.jsonc` initialization bypasses and nonregular scaffold races,
  Unix symlink/nonregular scaffold rejection, symlink-safe Markdown replacement,
  and document saves that require explicit initialization.
- Desktop coordinator tests cover debounce, scope coalescing, busy deferral,
  changes during an in-flight push, retained error state, and foreground-lock
  independence.
- Registry store/panel tests cover local initialization without a ready ACP
  session and workspace-lifecycle guards. Sidebar tests cover
  pending/syncing/error presentation, initialization wiring and the shared
  animated indicator. Rust coverage verifies that the fast Registry check uses
  task attachment bytes when comparing the `tasks` project artifact.
- ACP Desktop command tests cover `workspace` push/pull request validation and
  rejection of unknown scopes before the Registry RPC is dispatched.

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
