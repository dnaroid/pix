# 0072 — Session-native sub-agents without run directories

- Status: accepted
- Recorded: 2026-10-17
- Decided: 2026-10-17
- Owner / approval evidence: user request in the Pi session ("пересмотреть и
  переделать нашу систему субагентов … в идеале для субагента не нужно
  создавать папку запуска и сайдкары, а артефакты он может создавать в
  `.pi/artifacts`") plus structured answers: child session in the standard Pi
  session store; lifecycle state as custom entries in the child session plus
  parent memory/parent-session entries, no sidecars; no migration; new
  features: agentId = session id, retention tied to the parent session,
  per-role `maxTurns`/budget, batch label instead of `runDir`.
- Governing spec: [async-subagents](../../specs/async-subagents.md)
- Replaces / replaced by: none. Changes the disk layout in the governing spec
  stage by stage; [harness artifact storage](../../specs/harness-artifact-storage.md)
  changes in stage 5.

## Context

Every child is already a full persisted Pi session (`pi --mode rpc
--session-dir …`), but it lives inside a project run tree
`.pi/subagents/<run>/<agent>/sessions/`. Around it sit about 20 sidecar files
(`pid`, `exit_code`, `started_at`/`finished_at`, `retry_*`, `stop_*`,
`model_fallback_*`, `launch.json`, `prompt.md`, `result.md/json`,
`progress.jsonl`, `todo-progress.json`, `stderr.log`, `session_file`,
`parent_session`, …) and a locked `registry.json`. Some of this was left over
from the removed no-session mode (removed in stage 1 of this redesign). TUI,
ACP (`pix/subagents/open_session` needs `runDir` + `agentId`) and Desktop all
read the run tree directly.

## Observations and sources

- OpenCode: a child is an ordinary session with `parentID`; its id is the
  `task_id` used for resume; the result returns in `<task_result>`; no run
  directory. Its on-disk layout was not verified (source fetch returned 404).
- Claude Code: child transcripts are `<session>/subagents/agent-<id>.jsonl`
  plus a small `.meta.json`, deleted with the parent session (default 30
  days); role frontmatter carries `maxTurns`, `model`, `tools`.
- Pi SDK (installed version, read-only inspection):
  - `SessionManager.list()`/`listAll()` read only top-level `*.jsonl` of each
    session directory, non-recursively
    (`dist/core/session-manager.js` `listSessionsFromDir` ~594–603,
    `listAll` ~1460–1500). Files in a nested subdirectory never appear in
    resume lists.
  - The session file is flushed lazily: header and custom entries stay in
    memory until the first user or assistant message, then are written
    together (~680–806, `appendCustomEntry` ~901–911).
  - `SessionHeader` has only `type`, `version`, `id`, `timestamp`, `cwd`,
    optional `parentSession`; arbitrary metadata belongs in a `CustomEntry`.
    No CLI `--parent-session` flag; RPC `new_session` accepts `parentSession`.
  - No file locking; migration may rewrite a file. Two writers can race.
  - Pix already treats `parentSession` as fork lineage (TUI fork grouping,
    ACP fork metadata), so reusing it for children would mislabel them as
    forks.
- macOS owned launch (production-wired for Claude-provider children,
  macOS/access-gated) keeps its whole durable ownership record set under the
  per-agent directory (`owned_launch` pointer, `owned-launch/<UUID>/` with
  spec, generation, claim, journals, receipts, retirement proof). Restart
  reconciliation discovers it by scanning `.pi/subagents/<run>/<agent>/`
  (`core/owned-retirement.ts` ~356–405, `core/owned-launch/label.ts` ~67–112).
  The launchd access probe is given the directories it must reach
  (`tools/spawn.ts` ~71–76).

## Decision

1. **Storage.** A child session lives in the project, in a directory named
   after its parent's session id:
   `<cwd>/.pi/subagents/<parentSessionId>/<child>.jsonl`. Keeping children out
   of the global Pi store hides them from every resume list and from usage
   stats (the parent already records their usage) without per-surface
   filters, and gives one directory to delete per parent. Parent ids are
   UUIDs, legacy run directories are timestamp-named, so both coexist under
   `.pi/subagents/` without collision. A parent without a usable id falls back
   to the legacy `<agentDir>/sessions/`. The child's first
   entries are a `subagent_meta` custom entry (role, label, batch, parent
   session id/path, launch spec, prompt). That entry, not the header, is the
   authoritative lineage; the header's `parentSession` stays reserved for
   forks.
2. **Single writer.** Only the child process appends to its JSONL. It records
   lifecycle as `subagent_state` custom entries (started, todo progress,
   outcome incl. structured result and bounded stderr preview). The parent
   keeps live process state (pid, retry timers, stderr tail) in memory and
   records `subagent_spawned`/`subagent_settled` entries in its own session;
   this replaces `registry.json`. When a child dies without writing its
   outcome, the parent records the outcome in its own session only.
3. **Lazy flush.** The child receives its prompt immediately, so metadata is
   flushed with the first user message. Until then the parent's in-memory
   record is the only state, which matches today's planned/queued phase.
4. **Identity.** `agentId` is the child session id and is what `send`/resume
   accept. A short label (`claude-code`) is also accepted when unique within
   the parent session. `runDir` remains an accepted, ignored alias; filters
   use a `batch` label.
5. **Owned launch.** Its ownership records move unchanged in shape to
   `.pi/subagents/<parentSessionId>/owned/<launchId>/`, keyed by a launch id
   the parent generates before spawning and records in `subagent_meta`.
   Reconciliation scans those directories. Background cleanup must never
   remove a parent directory that still holds an unretired owned-launch
   record (to be enforced in stage 3). All invariants stay: keep every generation
   until both exact UUID services are proven absent, atomic `link(2)` claims,
   atomic generation publication before launch, fail closed on missing or
   ambiguous records. The access probe targets the new root.
6. **Artifacts.** Disposable child output (reports, QA evidence) goes to
   `.pi/artifacts/subagents/<batch>-<label>/`. `AGENTS.md`, the artifact
   storage spec and role prompts change together with this step.
7. **Retention and limits.** Desktop background cleanup replaces the 72-hour
   TTL for parent-scoped directories: `.pi/subagents/<parentSessionId>/` is
   kept while the parent session file exists (found via the children's
   `subagent_meta.parentSession` path or the project's default Pi session
   directory) and removed once the parent is gone and the subtree has been
   idle for 24 hours. Unreadable directories and legacy run directories keep
   the 72-hour TTL; manual Clean still empties `.pi/subagents/` immediately.
   Deleting a parent session through ACP `session/delete` reads the parent
   id from its header and removes `.pi/subagents/<parentSessionId>/` at once;
   it refuses non-UUID ids, symlinks and directories that still contain
   `owned/`, and a failure only logs a warning (background cleanup reclaims
   the orphan later). Role frontmatter gains `maxTurns` and a budget.
8. **No migration.** New code does not read `.pi/subagents/`. Old run trees
   stay on disk until removed manually or by existing cleanup.
9. **Delivery in stages**, each with focused tests: (1) remove the no-session
   mode — done; (2) parent-scoped `.pi/subagents/<parentSessionId>/` sessions + `subagent_meta` and parent-based cleanup — done; (3) state in
   session entries + parent index instead of `registry.json` and sidecars;
   (4) one read model in the suite for TUI/ACP/Desktop, `open_session` by
   `agentId`; (5) artifacts in `.pi/artifacts`; (6) cascade delete,
   `maxTurns`/budget, batch; (7) specs and tests. Intermediate stages may keep
   remaining sidecars until the stage that replaces them.

## Alternatives

- Children as top-level sessions with header `parentSession` (pure
  OpenCode style): every resume surface would need a new filter, and existing
  fork grouping would mislabel children; rejected.
- Keep run directories and only trim sidecars: does not remove the run tree or
  the registry the user asked to remove; rejected.
- Claude-style `.meta.json` next to each child transcript: still a sidecar;
  the `subagent_meta` entry carries the same data inside the session.
- Children nested in the standard store
  (`~/.pi/agent/sessions/<cwd>/subagents/<parent stem>/`): hidden from resume
  lists too, but needs usage-stats and ACP special cases, ages outside the
  project, and owned-launch records would need a separate global root;
  replaced by the project-local layout.
- Owned-launch state in `/tmp`: does not survive restart, breaking
  reconciliation; rejected.
- Migrating old run trees: the user chose no migration.

## Consequences

- No project-local run directories or sidecars for new runs; one lifecycle
  source per child (its session) plus the parent's index.
- All consumers (TUI, ACP, Desktop, usage parser, heads-up) must move to the
  shared read model; the change spans four packages and is done in slices.
- Old runs are no longer visible in sub-agent UIs.
- Risk: a child that crashes before its first user message leaves no session
  file; the parent session index must carry enough to report it.
- Child history lives with the project: moving or deleting the project, or
  manual Clean, removes it; parent references must then show the child as
  removed instead of failing.
- A headless parent without a session file keeps its children only for the
  24-hour idle grace.

## Revisit when

- The Pi SDK adds first-class child-session support or recursive listing.
- Pix needs to resume or list children independently of their parent session.
- Owned-launch recovery cannot locate records keyed by launch id after a crash.
