---
kind: spec
status: proposal
---

# Project supervisor (planned)

**Status: partially implemented.** This page is the target contract for
the project supervisor accepted in
[0077](../decisions/0077-project-supervisor-session.md). Implemented so far:
phase 0, the supervisor session with read-only `status`/`read`, debounced wakes,
the pinned supervisor tab and manual handover (`pix/supervisor/handover`);
the autopilot (mutating supervisor ops) is not. See *State and lifetime*. The staged rollout is tracked in the project plan
`.pi/plans/project-supervisor.md`.

[Work management](index.md)

## Purpose

One pinned conversation per project. The user writes goals and decisions
there. The supervisor agent starts saved tasks and plans in separate sessions,
watches them, sends rework, answers routine worker questions and closes
finished work. It escalates to the user only when it hits a limit or a
decision outside its mandate.

## Scope

- Pix Desktop only, and only while the project window is open. Standalone TUI,
  headless/MCP and sub-agent runtimes do not get supervisor tools.
- One supervisor session per project (canonical workspace). Starting another
  one opens the existing session.
- Workers are ordinary native ACP sessions, not sub-agents. They stay visible
  in the session list and can be opened by the user.
- Out of scope: background operation without Desktop, git worktrees, commits,
  cross-project orchestration, and supervisor-created saved tasks or plans
  (the existing explicit-request rules still apply to those).

## Terms

- **Managed session:** a session in the supervisor's registry, either started
  by the supervisor or handed over by the user.
- **Item:** the unit of work behind a managed session: a saved task, a saved
  plan, or a free-form prompt.
- **Mandate:** the user-saved standing authorization and limits (below).
- **Ledger:** an append-only record of supervisor actions and their evidence.
- **Digest:** a bounded summary of worker events that wakes the supervisor.

## Mandate and authorization

- The user enables the supervisor and saves a mandate. The saved mandate is
  the user's explicit standing authorization, inside the supervisor session
  only, to:
  - run saved tasks and plans, and start prompt sessions;
  - send follow-ups, rework and answers to managed sessions;
  - cancel managed turns;
  - set `done`/`failed` on tasks behind managed sessions, only through
    `supervisor close`.
- The [project tasks](tasks/project-tasks-agent-tool.md) confirmation rule
  gets no exception. Status changes of managed tasks happen only through
  `supervisor close`, whose guards and ledger entry are enforced in ACP code,
  not by prompt wording. The `project_tasks` description gains one sentence:
  "Task status changes made by the supervisor tool under a saved mandate are
  not project_tasks updates; inside the supervisor session use supervisor
  close, never project_tasks update, for managed tasks." Worker sessions never
  get the mandate, and it never authorizes creating or deleting saved tasks,
  editing other tasks, commits, or actions on unmanaged sessions.
- Mandate fields, with defaults:
  - `maxConcurrent`: 5 managed sessions with a turn in flight;
  - `maxReworkRounds`: 5 follow-ups per item after its first completed turn;
  - `budget`: optional ceiling in tokens over a rolling 24 hours, counting
    the supervisor and its managed sessions; provider cost is shown for
    reference where reported but is never the limit. When absent, no budget
    check runs and the UI says so;
  - `stalledAfterMinutes`: 15 by default, allowed 5–60 (see `stalled`);
  - `workerModelRef`: optional default for prompt sessions (tasks keep their
    saved `modelRef`);
  - free-text `policy`: what to escalate, priorities, areas not to touch.
- Reaching a limit escalates; it never triggers a silent retry. Changing the
  mandate takes effect on the supervisor's next action; actions already started
  are not undone.

## Mandate UI

- A compact block in the supervisor session header shows state (active or
  paused), a one-click **Pause**/**Resume**, counters (running sessions,
  rework rounds used, budget used) and **Edit mandate**, which opens the
  mandate form. The mandate is stored in `.pi/supervisor/`.

## Pause

- A **Pause supervisor** control in the supervisor session and status bar
  stops all new supervisor actions immediately: no starts, sends, cancels,
  answers or closures. Worker turns already in flight continue. Events keep
  accumulating, and the supervisor may still report while paused.
- Resume re-reads current state before acting. It does not replay commands
  issued before the pause.

## Managed sessions and handover

- Each session record in ACP carries `managedBy: <supervisorSessionId>` and
  `mode: managed | manual`. These are explicit metadata; names and titles are
  presentation only.
- **Hand over / Take back** actions on a session row and in the session view
  change ownership. Handing over a busy session is allowed; the supervisor
  receives it as an event.
- When the user sends a message into a managed session, it switches to
  `manual` atomically, before that message is dispatched. The supervisor gets
  `manual_takeover` and must not send there until the user releases it.
  Supervisor sends that race with the takeover are rejected, not queued.
- Closing or deleting a managed session removes it from the registry and
  journals the event. The task's status is not changed automatically.

## Supervisor tool

One tool, `supervisor`, registered only in the supervisor session on Desktop
hosts. It calls ACP through a correlated request bridge modelled on
`pix/tasks/run`. Operations:

| op | effect |
|---|---|
| `status` | Mandate, pause state, limits used, managed sessions with item, mode, run state, last stop reason, plan progress and rework count. |
| `read` | A bounded digest of one managed session: last user/assistant turns, final report, pending question, tool errors, touched files. Never a full transcript. |
| `start` | `{task}` / `{plan}` / `{prompt, modelRef?}`. Uses the existing Desktop Tasks Run / Plans Run actions, or a new session for a prompt, then registers the session. Enforces `maxConcurrent`. |
| `send` | `{sessionId, text, kind: rework or answer or note}`. Uses the normal ACP queue: steering while busy, a new turn while idle. `rework` counts against `maxReworkRounds`. |
| `answer` | Answers a pending `question` in a managed session with the chosen option(s) or custom text. |
| `cancel` | Cancels the managed session's current turn. |
| `close` | `{sessionId, outcome: done or failed, summary}`. Runs the completion guards, sets the task status, journals the evidence and unregisters the session. |
| `reopen` | Restores a closed item to `in-progress` and re-registers its session, or starts a resume session. |
| `escalate` | Posts a structured request to the user in the supervisor session and marks the item `waiting-user`. |

Each mutating op checks, inside ACP and atomically: the supervisor is not
paused, the session is managed and in `managed` mode, limits allow the action,
and the request belongs to the current supervisor runtime (stale replies after
a runtime replacement are dropped).

## Events and digests

ACP derives events from session lifecycle it already observes. No LLM is
involved.

- `settled` — turn finished, with stop reason;
- `question` — a worker is waiting on `question`;
- `error` — prompt or runtime error;
- `stalled` — no session activity during a turn for `stalledAfterMinutes`
  (default 15). Time inside a running tool call does not count; the tool's own
  timeout bounds it. Waiting for the user is `question`, not `stalled`.
  `stalled` only notifies the supervisor; it never cancels the turn;
- `checklist` — the linked plan's saved progress changed;
- `conflict` — another managed session edited the same file (below);
- `manual_takeover` / `released` / `handed_over` / `closed_by_user`.

Events are coalesced per supervisor with a short debounce. An idle supervisor
gets one wake turn with one digest. A busy supervisor gets the digest as a
single queued follow-up that later events update rather than multiply. Pause
holds wakes but keeps the digest current. A wake that would exceed the budget
escalates instead.

## Completion guards

`close outcome=done` is refused unless all of the following hold:

1. the last turn ended with stop reason `end_turn`, and no turn is in flight;
2. no question is pending;
3. a linked plan exists and its saved checklist has `total > 0` and no
   unchecked items;
4. the final assistant message contains a verification section (what was
   checked, and how).

A refusal returns the failing guards; the supervisor sends rework or
escalates. The ledger stores the evidence for every closure: turn id, stop
reason, plan progress, touched files and report excerpt. `failed` needs a
summary but no guards. Closures can be reverted with `reopen`.

## Worker rules and shared working tree

- Managed sessions get a preamble in their launch/handover prompt: no commits,
  no destructive git (`checkout`, `reset`, `stash`, `clean`, branch switches),
  no repository-wide formatting or mass rewrites, run only checks relevant to
  their scope, and expect other sessions' uncommitted changes in the tree.
- ACP tracks the files each managed session touches through write/edit tool
  calls. Overlapping paths between two managed sessions raise `conflict`.
  Writes made through shell commands are not detected; this is a known gap,
  not a guarantee.
- Only the user commits. The supervisor may report which files belong to
  which item.

## Worker questions

The supervisor answers technical questions that fit the mandate policy. It
escalates product, risky, destructive or out-of-mandate questions to the user
and replies with the user's decision. The ledger records each answer and its
rationale.

## State and lifetime

- The managed-session registry, mandate, pause state and ledger are ACP-owned
  durable project state under `.pi/supervisor/`. Registry/project cleanup must
  preserve that directory as canonical state.
- Plan-run records live in ACP-owned `.pi/plan-launches.json`
  (`pix/plans/launches`, see [Work plans](registry/desktop-registry-plans.md)),
  so the supervisor and Desktop read the same outcomes (phase 0, done).
- The per-session event source exists (phase 0, done): ACP
  `acp/src/acp/session-events.ts` emits `settled` (stop reason + files
  changed by successful write/edit calls), `question`, `error`
  (model/compaction/run/process), `stalled` and `checklist` to in-process
  subscribers (`PixAcpAgent.subscribeSessionEvents`). Session retirement emits
  nothing and disposes the observer's timer. Touched files are kept per session
  id across runtime replacement and dropped on session delete. The handover,
  takeover and `conflict` events are still phase 2–3 work.
- The storage layer exists (phase 0, done): `acp/src/acp/supervisor-store.ts`
  keeps `.pi/supervisor/mandate.json`, `registry.json` (atomic temp+rename,
  serialized per project, bounded to 200 sessions) and append-only
  `ledger.jsonl` (torn lines skipped). Invalid mandate fields fall back to
  defaults, never to wider limits; a malformed pause flag reads as paused.
  Desktop cleanup treats `.pi/supervisor/` as canonical.
- The supervisor session and read-only tool exist (phase 1, partial).
  Desktop's command palette entry **Open Project Supervisor** calls ACP
  `pix/supervisor/open` (`acp/src/acp/supervisor-contract.ts`). ACP records
  the session id in `registry.json` before spawning, so concurrent opens
  share one session, and a reopen returns the existing session. A recorded but
  missing session is journaled (`supervisor-missing`) and replaced by a new
  one. Other ACP clients are refused. `session/list` marks the session with
  `_meta["pix.supervisor"]`, and Desktop shows a radar icon on its row.
  Deleting the supervisor or a managed session unregisters it and journals
  `closed_by_user`.
- ACP loads `acp/src/extensions/supervisor.ts` with `PIX_SUPERVISOR_BRIDGE=1`
  only into the registered supervisor session of a Pix Desktop client.
  `acp/src/pi/supervisor-host.js` installs the correlated bridge only under
  that variable; requests carry random per-runtime ids, time out after 60 s,
  and a replaced runtime gets no reply. ACP also rejects requests from any
  session that is not the registered supervisor. `status` lists managed
  sessions and, in this observer phase, up to 20 other recent project
  sessions (excluding sub-agent viewers). Each entry includes the linked task,
  run state, last lifecycle event and plan progress. `read` returns a bounded
  digest built from the live runtime or the saved transcript's current branch
  (`acp/src/acp/supervisor-service.ts`). Mutating ops are still to come.
- Debounced wakes exist (phase 1): `acp/src/acp/supervisor-wake.ts` coalesces
  worker events per project for 5 s into one `[Supervisor digest]` text (one
  line per session, newest event per type, at most 20 sessions; the
  supervisor's own events are ignored). ACP puts it into the supervisor
  session's Desktop auto queue, so an idle supervisor runs it as one wake turn
  and a busy one after its current turn. While that item is still queued,
  later digests rewrite it in place instead of adding items; the check runs
  after the queue load, so an item Desktop has just taken is never rewritten.
  Pause keeps events pending without waking. Events that arrive while the
  supervisor runtime is not loaded stay pending until the next event. Only Pix
  Desktop clients get wakes; adapter dispose clears the timers.
- The macOS app menu (first submenu) has **Open Project Supervisor**, placed
  after **Arrange windows**. It emits `pix-open-supervisor` to the focused Pix
  window, or else the first visible one (`desktop/src-tauri/src/supervisor_menu.rs`).
  That window's frontend (`desktop/src/app/supervisor-session.ts`,
  `listenSupervisorMenu` and `handleSupervisorMenu` in `App.svelte`) runs the
  palette command `session.supervisor` for its own workspace, with the same
  availability rule. A click before the project is ready (startup, workspace
  switch, running session mutation) shows an info notice instead of being
  dropped silently.
- On Desktop start, ACP reconciles the registry against saved tasks, plans and
  session state. Sessions interrupted by quitting become `interrupted`
  events. The supervisor may resume them through the existing Resume flow; this
  counts as a rework round. Missing sessions are reported and are never
  silently replaced.
- Write the supervisor's continuity state (ledger cursor, open escalations) as
  session custom entries as well, so compaction does not lose it.

## Diagnostics

Refused actions, guard failures, bridge errors, reconciliation mismatches and
budget stops go to the existing diagnostic logger (see
[logging](../operations/logging.md)), as well as appearing in the supervisor
session.

## Verification scenarios

- Mutating ops are rejected when paused, for unmanaged/manual sessions, beyond
  `maxConcurrent`/`maxReworkRounds`, and from a replaced runtime.
- A user message into a managed session wins against a concurrent supervisor
  `send`: the session ends up in `manual`, and the supervisor send is rejected.
- Events from several workers produce one wake. A busy supervisor gets one
  coalesced follow-up. Teardown releases timers and subscriptions.
- `close done` is refused for each failing guard and succeeds when all hold.
  The ledger contains the evidence.
- A restart with a mid-turn worker yields an `interrupted` event and no
  duplicate session.
- Worker sessions do not expose the `supervisor` tool or mandate text.

## Resolved questions (2026-11-17)

- Status authority: only `supervisor close`, no `project_tasks` exception.
- Mandate UI: header block in the supervisor session.
- Budget unit: tokens over a rolling 24 hours.
- `stalled`: 15 minutes of inactivity excluding tool-call time, configurable
  5–60 minutes, notify-only.
