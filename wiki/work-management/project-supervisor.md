---
kind: spec
status: proposal
---

# Project supervisor (planned)

**Status: proposal — not implemented.** This page is the target contract for
the project supervisor accepted in
[0077](../decisions/0077-project-supervisor-session.md). Nothing below exists
in the product yet. The staged rollout is tracked in the project plan
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
  - set `done`/`failed` on tasks behind managed sessions.
- This is a scoped exception to the per-action confirmation rule in
  [project tasks](tasks/project-tasks-agent-tool.md). Worker sessions never
  inherit it, and it never authorizes creating or deleting saved tasks, editing
  other tasks, commits, or actions on unmanaged sessions.
- Mandate fields, with defaults:
  - `maxConcurrent`: 5 managed sessions with a turn in flight;
  - `maxReworkRounds`: 5 follow-ups per item after its first completed turn;
  - `budget`: optional token/cost ceiling per day; when absent, no budget
    check runs and the UI says so;
  - `workerModelRef`: optional default for prompt sessions (tasks keep their
    saved `modelRef`);
  - free-text `policy`: what to escalate, priorities, areas not to touch.
- Reaching a limit escalates; it never triggers a silent retry. Changing the
  mandate takes effect on the supervisor's next action; actions already started
  are not undone.

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
- `stalled` — no activity during a turn for a configurable period;
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
- Plan-run records (today Desktop `localStorage`
  `pix.desktop.planLaunches:<workspace>`, see
  [Work plans](registry/desktop-registry-plans.md)) move into ACP-owned state
  so the supervisor and Desktop read the same outcomes.
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

## Open questions

- Mandate UI: a supervisor-session panel or the settings page.
- Whether the budget is measured in tokens or provider cost, given uneven
  provider usage reporting.
- `stalled` threshold default.
