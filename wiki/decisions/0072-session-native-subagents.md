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
  features: `agentId` as a launch identifier mapped to Pi-assigned child session UUID, retention tied to the parent session,
  per-role `maxTurns`/budget, batch label instead of `runDir`.
- Governing spec: [async-subagents](../tools/agents/async-subagents.md)
- Replaces / replaced by: none. Changes the disk layout in the governing spec
  stage by stage; [harness artifact storage](../operations/harness-artifact-storage.md)
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
  reconciliation discovers it by scanning
  `.pi/subagents/<parentSessionId>/owned/<batch>/<agentId>/`
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
   `.pi/subagents/` without collision. Headless parents without a stable host
   session key use process-local state; with a stable key they use the journal
   described under Consequences. Child metadata is a `subagent_meta` custom
   entry containing `version`, `agentId`, `batch`, `runDir`, `cwd`, optional `subagentType`, `parentSession`, `parentSessionId` and `scope`; it does not contain the launch task or prompt.
   That entry, not the header, is the
   authoritative lineage; the header's `parentSession` stays reserved for
   forks.
2. **Single writer.** Only the child process appends to its JSONL. The parent
   persists lifecycle patches as `pi-tools-suite:subagent` custom entries in
   its own session, folded in order. Live process state (handles, activity,
   full result text and stderr tail) remains in memory. This replaces
   `registry.json`; child death outcomes are recorded by the parent.
3. **Lazy flush.** The child receives its prompt immediately, so metadata is
   flushed with the first user message. Until then the parent's in-memory
   record is the only state, which matches today's planned/queued phase.
4. **Identity.** `agentId` is the launch identifier (commonly `task.id`) accepted by `send`/resume, not the Pi session id. Pi assigns the child-session UUID; the parent records the session file reported in RPC events, and `subagent_meta` maps that session to `agentId`. A run key identifies `(scope, batch)` but is not a directory;
   `runDir` is the compatibility input alias for a batch. An `agentId` without
   a batch resolves to the latest-launched matching record in scope.
5. **Owned launch.** Its ownership records move unchanged in shape to
   `.pi/subagents/<parentSessionId>/owned/<batch>/<agentId>/<launchId>/`,
   beneath an owned base created only for owned launches. Reconciliation scans
   those directories. Background cleanup must never remove a parent directory
   that still holds an unretired owned-launch record. All invariants stay: keep every generation
   until both exact UUID services are proven absent, atomic `link(2)` claims,
   atomic generation publication before launch, fail closed on missing or
   ambiguous records. The access probe targets the new root.
6. **Artifacts.** Disposable UI-QA/browser workspace output goes to
   `.pi/artifacts/subagents/<batch>-<agentId>/`. `AGENTS.md`, the artifact
   storage spec and role-prompt guidance should stay aligned with this target;
   see stage 5 below for implementation status.
7. **Retention and limits.** Desktop background cleanup replaces the 72-hour
   TTL for parent-scoped directories: `.pi/subagents/<parentSessionId>/` is
   kept while the parent session file exists (found via the children's
   `subagent_meta.parentSession` path or the project's default Pi session
   directory) and removed once the parent is gone and the subtree has been
   idle for 24 hours. Unreadable directories and legacy run directories keep
   the 72-hour TTL; manual Clean immediately removes ordinary subagent state
   but preserves `owned/` launch records until retirement.
   Deleting a parent session through ACP `session/delete` reads the parent
   id from its header and removes `.pi/subagents/<parentSessionId>/` at once;
   it refuses non-UUID ids, symlinks and directories that still contain
   `owned/`, and a failure only logs a warning (background cleanup reclaims
   the orphan later). Role frontmatter `maxTurns` and budget support remains a
   planned design item, not implemented behavior.
8. **No migration.** New code does not read legacy run trees or sidecars;
   legacy run directories are ignored by session-native readers and may be
   removed by explicit cleanup or Desktop cleanup.
9. **Delivery in stages**, each with focused tests: (1) remove the no-session
   mode — done; (2) parent-scoped `.pi/subagents/<parentSessionId>/` sessions +
   `subagent_meta` and parent-based cleanup — done; (3) state in session entries
   + parent index instead of `registry.json` and sidecars — implemented; (4) one
   read model in the suite for TUI/ACP/Desktop, `open_session` by `agentId` —
   implemented; (5) artifacts in `.pi/artifacts` — the UI-QA/browser workspace
   path is implemented, but role-prompt path cleanup remains incomplete; (6)
   cascade delete is implemented, while `maxTurns`/budget and new batch filters
   are not implemented; (7) specs and tests are updated alongside implemented
   behavior, not evidence that the remaining design items shipped. The behavior
   described above is the accepted target design; unimplemented items are not
   part of the current runtime contract.

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
- TUI, ACP and Desktop use the shared session-native read model. Legacy run
  directories are ignored by new readers and are not migrated.
- Risk: a child that crashes before its first user message leaves no session
  file; the parent session index must carry enough to report it.
- Child history lives with the project: moving or deleting the project, or
  manual Clean, removes it except protected owned-launch records; parent
  references must then show the child as removed instead of failing.
- Headless calls with a stable host session key use a deterministic UUID scope
   and append-only `.pi/subagents/<scope>/headless-parent.jsonl` journal, so
   separate calls can recover the parent index. Without a key, parent state is
   process-local and is not recoverable by a later headless process. Journal
   read errors and journals over 32 MiB fail closed with a redacted diagnostic;
   they are not silently treated as empty state. Headless cold `send`, like
   `spawn`, uses a detached broker to retain process ownership through the final
   completion receipt. Interactive `/sub-open` refuses nonterminal children to
   preserve the single-writer transcript contract. Planned and retry-pending
   records may include an optional runtime `ownerPid`; external readers treat
   those states as live only while that owner process is alive. Launch clears
   the field, and scheduling a retry refreshes it to the current runtime PID.
   A queued relaunch refreshes only `stopRequested` from durable parent entries
   (including a fresh headless-journal read) before launch and after awaited
   owned-provider preflight; cancellation prevents spawning. This does not add
   cross-process compare-and-swap for competing cold sends, or resume timers
   lost in a runtime crash.

## Revisit when

- The Pi SDK adds first-class child-session support or recursive listing.
- Pix needs to resume or list children independently of their parent session.
- Owned-launch recovery cannot locate records keyed by launch id after a crash.
