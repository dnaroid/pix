# Resource Registry: project state

## Type

Change

## Lifecycle

Implemented; this is the current project-state registry contract.

## Goal

Synchronize project-scoped tasks, plans, TODO, and workspace state through the
private Git registry without making task attachments depend on machine-specific
absolute paths.

## Scope

- Desktop Registry push/pull/sync for tasks, plans, TODO, workspace and project.
- Project provenance in `.pi/registry.json`.
- Portable synchronization of SQLite task rows and SHA-256 content-addressed
  attachments from `.pi/tasks.sqlite` and `.pi/task-attachments`.
- Pix Desktop local project-state initialization for workspaces that do not yet
  have a `.pi` directory.

## Remote layout

For project key `<key>`, the registry stores:

- `projects/<key>/tasks.sqlite` (transaction-consistent online backup)
- `projects/<key>/task-attachments/<sha256>` for blobs referenced by the
  synchronized SQLite attachment association table
- `projects/<key>/plans/`
- `projects/<key>/TODO.md`
- `projects/<key>/workspace.jsonc`

The Registry SQLite copy is a consistent transport snapshot: neither side
copies a live database's raw bytes without its WAL. Task descriptions contain
plain text, and attachments are related by hash and task id inside SQLite,
not by embedded `file://` or portable text markers. There is no legacy
JSONC/task overlay import or fallback.

## Behavior

- Desktop schedules a background catalog refresh three seconds after ACP is
  ready for the active workspace, without requiring the Registry panel to open.
  Busy operations, Registry actions and project sync defer the request until a
  new quiet three-second interval. Workspace/client changes, disconnection and
  teardown cancel pending timers; reconnect schedules a new load. In-flight
  responses retain the Registry store's workspace/lifecycle stale-response guards.

1. `push tasks` validates the local SQLite v1 schema, task payloads, rows and
   attachment association integrity, then uses SQLite online backup to capture
   a transactionally consistent snapshot (including committed WAL content).
2. Only blob hashes referenced from `task_attachments` participate in the
   Registry artifact. Each referenced blob is verified for safe regular-file
   containment, size and SHA-256; removed references are omitted remotely.
3. `pull tasks` checks remote SQLite schema, rows and blobs; imports rows into
   the existing local database within `BEGIN IMMEDIATE` and copies blobs as
   immutable content-addressed files. It does not rename the live DB inode.
4. Push and pull enforce the project provenance/observed hash for the
   transaction boundary. A concurrent task write cannot silently be turned
   into an all-task Registry replacement; it must be reviewed/retried.
5. The task artifact hash is canonical JSON of sorted task rows (including
   revision/position), attachment metadata and associations plus every linked
   immutable blob's bytes. WAL/SHM file bytes, free pages and SQLite packing
   are excluded. Editing a linked blob produces a checksum error.
6. The remote revision for `tasks` follows both
   `projects/<key>/tasks.sqlite` and `projects/<key>/task-attachments/`, so a
   remote attachment-only change participates in update/conflict detection.
7. The registry Git commit stages the current project's directory in the
   disposable clone. Other project keys and reusable skills/agents are not
   included.
8. Pix Desktop owns one background project-state sync coordinator. A successful
   per-row SQLite task write marks `tasks` dirty; saving `.pi/TODO.md` marks `todo`
   dirty; saving a canonical Markdown plan (`.pi/plans/**/*.md`, excluding
   generated/temporary paths) marks `plans` dirty; successful
   Desktop saves of `.pi/workspace.jsonc` mark `workspace` dirty. The fast sidebar
   Registry poll also reports project artifacts that changed outside those
   Desktop save paths, so agent/external edits enter the same coordinator. Those
   external-change signals also refresh the corresponding local Desktop store
   before sync: `tasks` reloads the SQLite task view, while `plans` and `todo`
   reload the project-document snapshot. A queued signal is discarded if the
   workspace changed before it is applied.
   Canonical changes are determined by the Registry payload, **not directory
   timestamps or SQLite sidecar activity**. The native poll and ACP use the same
   filtering contract: only non-service Markdown files under `.pi/plans/` are
   plan data; skill and agent packages include their authored scripts/assets
   but skip hidden, temporary, backup, lock, log, cache, build and generated
   paths. Examples excluded from Registry dirty detection and publication are
   `.DS_Store`, `*.tmp`, `*.bak`, `*.lock`, `*.log`, `*~`, `.cache/`,
   `node_modules/`, `__pycache__/`, `artifacts/`, `build/`, `dist/`,
   SQLite `-wal`/`-shm`/`-journal` and unrelated `.pi` files. Agent notes with
   no valid agent definition are not standalone Registry resources. The
   unchanged backup-only plan scaffold is not a local Registry plan artifact.
   SQLite task comparison remains a transaction-consistent **logical** hash of
   rows, revisions, ordering and referenced blob content, capturing committed
   WAL changes without hashing sidecar bytes. Unlinked task-attachment blobs
   do not trigger sync. A canonical change is still detected by periodic
   polling even when it originates from an agent or external editor.
   Publishing a plan sends only canonical Markdown; pulling it updates the
   canonical Markdown while preserving local backup/scratch files. A
   scratch-only local plans folder without provenance must never delete a
   different project state's remote plans.
9. Dirty project-state writes are debounced for approximately 900 ms. Repeated
   writes to one artifact collapse into one push, while more than one dirty
   artifact collapses into one project operation. The automatic request is
   `sync-project`, handled directly by the ACP Registry service; it never
   opens confirmation dialogs or emits successful-push notifications. It syncs
   tasks/plans/TODO/workspace and also saves newly discovered Local-only project
   skills/agents under `projects/<key>/skills|agents`. Published resource edits
   and unsafe/conflict/removal states are not automatically pushed. It never
   promotes a resource to Global (see publication/tags spec).
   Untracked remote collisions and changed tracked revisions return actionable
   errors without overwrite; explicit foreground push retains confirmation.
   Initial/refresh snapshots seed safe local-only/local-changes project artifacts
   and Local-only project resources.
   Persistent poll observations neither restart debounce nor clear terminal
   errors, and different artifacts are retained while pending or in flight.
10. Background sync never takes the Desktop foreground-operation lock. Registry
    actions are workspace-scoped: Desktop sends the workspace cwd to ACP, and
    ACP executes filesystem/Git operations directly in its Registry service.
    No Pi runtime or conversation session is created, loaded, or required. A
    blocked sync remains pending and retries on a short idle cadence instead of
    dropping dirty state. While the actual background Registry RPC is in flight,
    Registry-panel actions are locally disabled so a manual Registry command
    cannot overlap it; unrelated Desktop UI remains available.
11. Dirty state is removed from the current batch before an RPC starts. If the
    same or another artifact changes while that RPC is in flight, the new dirty
    state survives and starts another debounced pass after the current pass
    completes.
12. Workspace changes reset coordinator state with a generation guard, so a late
    response from the previous workspace cannot clear or overwrite the new
    workspace's pending/sync UI state.
13. A retryable ACP busy race returns to `pending`. Other thrown background-sync
    failures, including authoritative snapshot errors, become an `error` state
    and retain the dirty artifacts. A later
    local edit or foreground Registry action can retry that retained state.
14. Pix Desktop checks local `.pi` initialization independently from remote
    Registry configuration and ACP session readiness. When `.pi` is absent, the
    Registry panel offers **Initialize project Registry**. The local action
    creates `.pi/tasks.sqlite` with schema v1 and WAL plus
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
    validator accepts `workspace` for `push-project`, `pull-project` and `sync-project`,
    while still rejecting unknown project scopes.
17. A workspace Git repository is optional. When `resourceRegistry.projectKey`
    is not configured, Registry may derive a stable project key from Git
    `remote.origin.url`, but that is only an automatic convenience for
    project-scoped artifacts. If there is no Git origin, reusable skills and
    agents remain fully usable and the Registry snapshot reports one non-fatal
    project-key issue. The user can set a project key explicitly; lack of Git
    must not surface as a duplicate global Registry error. Without a Git origin,
    the interactive key prompt requires a nonempty explicit key and must not
    suggest that leaving it blank will derive one automatically. Interactive
    remote setup gives generic Git URL guidance when no remote is configured,
    rather than presenting an example repository as a usable value.
18. Pix Desktop presents reusable Registry resources as an IDE-style catalog.
    Project artifacts stay in the dedicated project-sync review surface and do
    not appear in the reusable-resource browser. Reusable resources that exist
    in this project appear under **Installed**, regardless of publication;
    remote resources without a local copy appear under **Available**.
    Each card separately shows a **Local** or **Published** badge, with
    synchronization/conflict state shown independently.
    Stale provenance entries with neither a local nor a current
    remote copy do not masquerade as Available entries. Search and resource-
    type filtering apply only within the active catalog section, while existing
    install/update/push/uninstall/remove actions keep their current Registry
    semantics. **Installed** shows project resources and remains available when no
    remote is configured; in that state the snapshot scans local skills/agents
    and exposes only local actions. **Available** is the uninstalled remote catalog and
    prompts for connection when no remote is configured. Project-state
    initialization is likewise independent: an uninitialized tasks/plans
    scaffold does not hide the reusable-resource catalog.
    Routine local project changes display automatic background sync rather
    than a manual review/push prompt; actual conflicts, missing keys, remote
    changes and errors retain review actions and diagnostics.
19. Foreground Registry actions (refresh/install/update/push/pull/uninstall/
    remove) use Registry-local busy state and do not take Pix Desktop's global
    operation-running lock. The rest of the workbench remains interactive while
    Registry Git/filesystem work runs asynchronously in ACP.
    Workspace/client generation guards discard stale completions after
    a workspace switch or lifecycle reset. Registry-local controls may still be
    disabled while their own action is active. Local project initialization and
    reclaimable `.pi` cleanup follow the same rule: they use the Registry
    `actionId`, never the Desktop-global lock.
20. The ACP service returns an authoritative post-action snapshot directly;
    there is no extension widget event, runtime reload, or snapshot-event wait.
    Actions, diffs and their snapshots serialize access to the shared per-process
    disposable checkout and project provenance. Git runs in asynchronous child
    processes without a shell. Registry configuration retains the existing
    `resourceRegistry` JSONC layers and environment overrides for compatibility.
    Registry has no TUI module or `/registry` command.

## Compatibility

- There is no legacy `.pi/tasks.jsonc` or `.pi/tasks.d/` import, migration or
  fallback during ordinary Registry operations. Such files and local migration
  backups are ignored for dirty detection and not published; users retain
  control of their original files.
- SQLite schema v1 and canonical task attachments are the only supported
  Registry task representation. Task descriptions remain plain text; no legacy
  `file://` marker resolution or rebasing occurs.

## Invariants

- Registry attachment names cannot escape the task-attachment directory.
- Registry task attachments must be immutable SHA-256-named regular files;
  symbolic links, hard links and mismatched hashes are rejected.
- Task attachment references exist only in SQLite relations, not in text markers.
- Referenced attachment content participates in provenance hashing. A task push
  removes no-longer-referenced blobs from the remote Git artifact.
- Every successful Desktop task mutation reaches the background sync coordinator
  through the SQLite task save path; failed local persistence never
  schedules a remote push.
- Background project sync is coalesced to one in-flight Registry action. It does
  not force-push through provenance conflicts.
- The sidebar's cheap Registry task check hashes the same normalized task bundle
  as Registry provenance, including referenced attachment bytes, so a completed
  background push can converge back to a clean local indicator.
- Desktop project-state initialization is explicit and idempotent. Its marker is
  the complete scaffold: a regular `.pi/tasks.sqlite` plus project-owned regular
  `.pi/plans/` and `.pi/task-attachments/` directories. A bare `.pi` directory
  or unrelated `.pi/pix.jsonc` is not initialized state. Existing task content
  is never overwritten, and `.pi` plus scaffold subdirectories must be regular
  project-owned directories rather than symbolic links escaping the workspace.
- Initialization inspects an already-existing `tasks.sqlite` before accepting a
  concurrent publication race: it must be a regular file canonically inside `.pi`,
  and its schema version must be compatible.
  An existing symbolic link, directory, or escaping target is an error, never
  an idempotent-success result.
- The Registry panel reports the logical byte size of the current project-owned
  `.pi` tree plus the currently reclaimable generated-junk byte count. Size
  traversal never follows symbolic-link targets; a missing `.pi` is represented
  as absent rather than as an alternate storage layout.
- Total and reclaimable bytes are returned by one native storage inspection so
  the panel does not duplicate full-tree traversal. Desktop bounds local project
  inspection waits to five seconds; a stalled or failed storage inspection ends
  the loading state with a local unavailable/timeout status, and a later Refresh
  starts a new inspection instead of leaving `Checking…` indefinitely.
- Registry cleanup is allowlist-based and never resets project state. The
  canonical top-level project directories are `agents/`, `artifacts/`,
  `plans/`, `search/`, `skills/`, `subagents/`, `task-attachments/`,
  plus ignored legacy `tasks.d/` (preserved but never read).
- Cleanup preserves the canonical `agents/`, `plans/`, `search/`, `skills/`, and
  `task-attachments/` and ignored `tasks.d/` trees, but removes every entry recursively inside
  `.pi/artifacts/` and `.pi/subagents/` while leaving those two container
  directories in place.
- `.pi/search/index.sqlite` is durable universal-search state, not disposable
  output. Manual Clean and TTL cleanup preserve the complete `search/` tree,
  including SQLite WAL/SHM sidecars. Session deletion prunes index rows; it does
  not delete the database. See [Desktop universal search](desktop-universal-search.md).
- Any other regular top-level directory directly under `.pi/` is non-canonical
  and is removed recursively. Top-level regular files are allowlist-based too:
  `TODO.md`, `pi-tools-suite.jsonc`, `pix-desktop.jsonc`, `pix.jsonc`,
  `qa_auth.jsonc`, `registry.json`, `tasks.sqlite`, `tasks.sqlite-wal`,
  `tasks.sqlite-shm`, `tasks.sqlite-journal`, `todo-plan.json`,
  `workspace.jsonc`, and ignored legacy `tasks.jsonc` are preserved;
  other ordinary top-level files (for example
  temporary receipt JSONs) are reclaimable. The existing cleanup of `.DS_Store`
  and stale Pix temporary files still applies, while fresh Pix temp files keep
  their stale-age protection.
- Recursive removal uses no-follow traversal: symbolic-link targets are never
  traversed or deleted. A root `.pi` symbolic link or non-directory is rejected
  rather than followed.
- When Desktop opens an already-initialized project, it starts the same cleanup
  policy in the background with a 72-hour TTL. The project open path does not
  wait for cleanup and the foreground operation lock is not taken.
- TTL cleanup treats each direct child of `.pi/artifacts/` and `.pi/subagents/`,
  each non-canonical top-level file/directory, and the other ordinary cleanup
  targets as one candidate. A candidate is removed only when its own modification
  time and every entry in its subtree are at least 72 hours old. The candidate
  is re-checked immediately before deletion so activity that begins during size
  accounting preserves it.
- Background cleanup is not run against a bare/uninitialized `.pi` directory.
  After it completes, Registry storage state is refreshed only if that project
  is still the active workspace. Manual Clean remains immediate and ignores the
  TTL.
- Desktop TODO and plan saves never bootstrap a missing `.pi`; explicit
  initialization is the only Desktop project-document path that creates it.
  The Desktop saved-task adapter requires a valid existing SQLite database;
  user `/task add` can create one explicitly without bootstrapping Registry.
  Task attachments require an existing task id and immutable blob store.
- Markdown saves write and flush a temporary file through no-follow directory
  handles, then atomically replace the destination entry. A destination symlink
  installed before or during the save is replaced rather than followed.
- Concurrent Desktop initializers use create-or-inspect directories and SQLite
  transactions. A competing initializer preserves the existing database and
  never replaces task rows.

## Related files

- `acp/src/registry/service.ts`
- `acp/src/registry/projects.ts`
- `acp/src/registry/task-bundle.ts`
- `acp/test/registry.test.ts`
- `acp/src/acp/desktop-commands.ts`
- `acp/test/desktop-commands.test.ts`
- `desktop/src-tauri/src/lib.rs`
- `desktop/src/app/registry.svelte.ts`
- `desktop/src/app/registry-startup.ts`
- `desktop/src/app/registry-startup.test.ts`
- `desktop/src/app/desktop-root-effects.svelte.ts`
- `desktop/src/app/registry-store.test.ts`
- `desktop/src/lib/registry.ts`
- `desktop/src/lib/registry-background-sync.ts`
- `desktop/src/lib/registry-project-sync.ts`
- `desktop/src/lib/registry-project-sync.test.ts`
- `desktop/src/components/RegistryPanel.svelte`
- `desktop/src/components/RegistryProjectStatus.svelte`
- `desktop/src/components/RegistryCatalog.svelte`
- `desktop/src/components/RegistryStatusIcon.svelte`
- `desktop/src/app/registry-project-storage.svelte.ts`
- `docs/desktop-task-manager.md`
- `specs/desktop-attachments.md`

## Verification

- ACP `test/registry.test.ts` covers project-state push/pull,
  portable task attachments, attachment-only status changes, stale remote
  attachment removal, conflicts, and direct workspace-scoped operations.
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
  session, local `.pi` size/reclaimable-byte reporting and allowlist-based
  garbage cleanup, background TTL cleanup, stale-workspace lifecycle guards, and
  the Installed/Available separation and Local/Published badges for reusable resources.
  Sidebar tests cover
  pending/syncing/error presentation, initialization/storage wiring and the
  shared animated indicator. Rust coverage verifies that storage
  sizing/cleanup preserves the canonical data trees, empties artifacts/subagents,
  removes non-canonical top-level directories, applies the 72-hour TTL only to
  initialized projects, and does not follow symlink targets. The fast Registry
  check also uses task attachment bytes when comparing the `tasks` project
  artifact.
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
