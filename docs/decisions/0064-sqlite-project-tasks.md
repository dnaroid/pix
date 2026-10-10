# 0064 — SQLite-only project tasks with restricted mutations

- Status: accepted
- Recorded: 2026-10-10
- Decided: 2026-10-10
- Owner / approval evidence: user chose SQLite for the Tasks panel and
  explicitly rejected legacy-format support or migrations.
- Governing specs: [Desktop Tasks](../desktop-task-manager.md) and
  [agent task tool](../../specs/project-tasks-agent-tool.md).
- Replaces: [0063 — Kernel-owned task-file exclusion](0063-task-file-kernel-lock.md).

## Problem

An agent and Desktop previously rewrote a shared JSONC task document. The
operation could overwrite unrelated tasks and required an interoperable
cross-process lock module (native Koffi and Rust kernel file locks). Separately,
path-based attachment markers made ownership and Registry transport cumbersome.

## Decision

- A single project-local `.pi/tasks.sqlite` database (schema v1) is the only
  source of saved tasks. Older `tasks.jsonc`/`tasks.d` files are never read,
  imported or migrated. To avoid destructive cleanup, ignored user-owned
  files remain untouched.
- SQLite WAL, foreign keys and bounded busy timeout replace all custom
  cross-process task lock files, native bindings and lock-cleanup logic.
- Last-close cleanup may unlink `-wal`/`-shm` while another reader inspects
  their metadata. APFS can then report `nlink=0`; this is not a hard link.
  All three readers (Desktop Rust, agent storage and ACP Registry) accept
  this transient unlinked sidecar state while still rejecting real sidecar
  hard links (`nlink>1`), symlinks, and hard links to the canonical DB.
- Task state is represented by one validated JSON payload **per database row**,
  a monotonically increasing per-task revision and a stable task id. The
  restricted API uses one-row transactions and rejects stale revisions.
- The agent tool exposes list/get/create/update, with strict patch fields and
  consent guidance. User-invoked `/task delete` and `/task attach` are not
  accessible through that tool. **The Desktop UI remains fully interactive:**
  create/edit/delete, status, priority, Quick Add, drag-and-drop, Composer task
  capture and attachment management are preserved. Only the restricted tool
  cannot delete/reorder.
- Task attachments are immutable SHA-256 blobs, related by task id and hash in
  SQLite; descriptions do not contain owned file references.
- Registry synchronizes a consistent SQL snapshot and linked blobs. It never
  byte-copies an active SQLite database without its WAL or mutates the local
  database through whole-file replacement. A pull is an explicit bulk
  synchronization operation, distinct from the agent's task-level tool.

## Consequences

Independent task updates no longer overwrite one another. SQLite still uses
native OS locks internally, but their lifetime and concurrency semantics are
managed by SQLite rather than handwritten application protocols.

The clean break intentionally means that old tasks are **not visible** until
the user recreates them explicitly in SQLite; the old files remain on disk
without automatic deletion. An agent with unrestricted filesystem access
could bypass this tool; preventing every form of direct write requires
independent OS capability/sandbox restrictions, not only a restricted API.

## Validation

- Task-tool tests: single-row updates, conflicts, deletion restrictions,
  immutable blob associations, explicit slash commands, no legacy fallback.
- Desktop Rust tests: schema initialization, per-task changes, no-follow
  storage checks, attachment integrity and Registry indicator.
- ACP Registry tests: SQLite push/pull, attachment content, provenance.
- Desktop UI tests: full CRUD controls, task drag, filters, run and session
  reopening. Rust tests cover task-only mutation, atomic attachment links and
  position rebalancing without overwriting unrelated content.
