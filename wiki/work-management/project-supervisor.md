---
kind: spec
status: active
---

# Project supervisor

**Status: implemented; manual acceptance pending.** This page is the contract
for the project supervisor accepted in
[0077](../decisions/0077-project-supervisor-session.md). Every item of the
project plan `.pi/plans/project-supervisor.md` (phases 0–3) is implemented and
covered by focused automated tests: the supervisor session with `status`/`read`,
debounced wakes, the pinned supervisor tab, the mandate header block, manual
handover and take back, the mutating ops `start`, `send`, `answer`, `cancel`,
`close` (with completion guards), `reopen` and `escalate`, the worker preamble,
startup reconciliation, user takeover and `conflict` events. The manual Desktop
acceptance runs from the plan's definitions of done have not been carried out.

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
- One active supervisor conversation per project (canonical workspace).
  **Open Project Supervisor** opens that conversation. In the command palette,
  **New Project Supervisor Conversation** starts without the previous chat
  context. In the active supervisor conversation, a bare `/new` runs the same
  fresh-conversation action; in ordinary sessions `/new` still opens a session
  start tab. `/new_tab` is unchanged. Existing gates apply: a `/new` sent while
  the current turn is running is ignored. If the previous supervisor tab is
  open, the new conversation replaces it instead of leaving two tabs. The
  previous conversation remains in history and no longer controls the project.
  The previous conversation must be idle (no running turn, pending
  dialog, streaming or compaction); otherwise the command is refused and
  nothing changes.
- A new conversation keeps the saved mandate (including pause and budget
  state and any budget hold), worker ownership, rework counts, escalations,
  ledger, and queued worker wakes. It does not stop or restart workers. Wakes
  queued in the old conversation are copied to the new one, and the old copies
  are removed after the switch. A late restore of an unconsumed digest from a
  retired conversation is applied to the current one; a digest prompt sent to a
  retired conversation is refused.
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
  editing other tasks, commits, or actions on unmanaged sessions. Its project-setup writes apply only to the supervisor's own project (see [Project setup](#project-setup)).
- Mandate fields, with defaults:
  - `maxConcurrent`: 5 managed sessions with a turn in flight;
  - `maxReworkRounds`: 5 follow-ups per item after its first completed turn;
  - `budgetTokens`: optional ceiling over a rolling 24 hours, using assistant
    `usage.totalTokens` (including cache reads and writes) from the supervisor
    conversation and sessions currently in `managed` mode. Saved former
    supervisor conversations contribute only the usage incurred before they
    were replaced, within the same rolling window. Manual, closed and released
    workers are excluded. Provider cost is never the limit. When the ceiling is
    absent, no budget check runs;
  - `stalledAfterMinutes`: 15 by default, allowed 5–60 (see `stalled`);
  - `workerModelRef`: optional default for plan and prompt sessions (an explicit
    `start` `modelRef` overrides it; tasks keep their saved `modelRef`);
  - free-text `policy`: what to escalate, priorities, areas not to touch.
- Reaching a limit escalates; it never triggers a silent retry. Changing the
  mandate takes effect on the supervisor's next action; actions already started
  are not undone.

## Mandate UI

- A compact block in the supervisor session header shows state (active or
  paused), a one-click **Pause**/**Resume**, running sessions, rework rounds
  used, and rolling token usage against the ceiling (or "no limit" without
  one). **Edit mandate** opens the mandate form. The mandate is stored in
  `.pi/supervisor/`.
- **Budget hold** indicates that a wake was blocked. **Resume wakes** (or
  **Resume** while paused) rechecks current usage; raising or clearing the
  ceiling can also release the hold. Ordinary pause still blocks wakes.

## Pause

- A **Pause supervisor** control in the supervisor session and status bar
  stops all new supervisor actions immediately: no starts, sends, cancels,
  answers or closures. Worker turns already in flight continue. Events keep
  accumulating, and the supervisor may still report while paused.
- Resume re-reads current state before acting. It does not replay commands
  issued before the pause.

## Managed sessions and handover

- Ownership lives in the project supervisor registry, not in session names or
  titles. A registry entry has `mode: managed | manual`. ACP reports it as
  `_meta["pix.supervisorManaged"]` in `session/list`; Desktop reads only that
  marker.
- **Automatic marker:** `start` registers the launched session as `managed`
  with `briefed: true` (`acp/src/acp/supervisor-actions.ts`, registry update
  after `runtime.launch`). No separate marker write is needed; the marker
  follows the registry entry.
- **Hand Over to Supervisor** (`pix/supervisor/handover`, `supervised: true`)
  requires a registered supervisor. An existing entry flips to `managed`;
  otherwise a `{ item: prompt, mode: managed, reworkRounds: 0 }` entry is
  created without `briefed`. Sub-agent sessions and the supervisor itself are
  refused.
- Registry entries also carry `origin: started | handed_over`. `start` marks
  the session `started`; handover marks it `handed_over`; `reopen` restores
  the origin from the closed ledger entry. Only `started` workers are eligible
  for the automatic tab close below.
- **Take Back from Supervisor** (`supervised: false`) removes the registry entry.
- Desktop shows the supervision header above the conversation only for a
  registered session (`managed` or `manual`). An ordinary session gets no
  header; **Hand Over to Supervisor** is offered there only in the session tab
  context menu.
- `start`, `close` and `reopen` change the registry, so ACP sends
  `pix/session/catalog_changed` after each of them; the tab marker and header
  follow the refreshed catalog without a click.
- Both run under the project supervisor lock and are idempotent: a call that
  changes nothing writes no ledger entry. A change appends `handed_over` or
  `released` to the ledger only. Neither emits a supervisor event nor wakes the
  supervisor.
- When the user sends a message into a managed session, it switches to
  `manual` atomically, before that message is dispatched. The ledger gets
  `manual_takeover`, and the supervisor gets that event and wakes. It must not
  send there until the user releases it. Supervisor sends that race with the
  takeover are rejected, not queued.
- The `close` op removes the session from the registry and journals `closed`.
  With `outcome=done` and origin `started`, ACP also asks Desktop, via
  `pix/supervisor/close_tab`, to close that worker's tab. This is best-effort:
  Desktop closes only an open, idle tab in the same workspace and keeps the
  saved conversation (so `reopen` still works). Failures only log. A `failed`
  outcome and handed-over sessions never auto-close.
  Deleting a managed session unregisters it and journals `closed_by_user`, with
  no wake. The task's status is not changed automatically.

## Supervisor tool

One tool, `supervisor`, registered only in the supervisor session on Desktop
hosts. It calls ACP through a correlated request bridge modelled on
`pix/tasks/run`. Operations:

| op | effect |
|---|---|
| `status` | Mandate, pause state, limits used, managed sessions with item, mode, run state, last stop reason, plan progress and rework count. |
| `read` | A bounded digest of one managed session: last user/assistant turns, final report, pending questionnaires, tool errors, touched files. For managed sessions only, pending questionnaires expose each live `questionId` with its questions and choice values. Never a full transcript. |
| `start` | Exactly one of `{taskId}` / `{planPath}` / `{text}`, plus optional `modelRef`. Desktop launches it in the window showing that project, through the same Tasks Run / Plan run path (prompts get a new session), with the worker rules prepended; ACP then registers the session `managed`. Model: explicit `modelRef`, else the task's saved model, else `workerModelRef` for plans and prompts. Enforces `maxConcurrent`; a task or plan that is already registered is refused, and Desktop refuses a task already linked to a session. |
| `send` | `{sessionId, text, kind: rework or note}`. Uses the normal ACP queue: steering while busy, a new turn while idle. `rework` counts against `maxReworkRounds`. `kind=answer` is refused; use `answer`. |
| `answer` | `{sessionId, questionId, authority: mandate or user, rationale, selections}`. Answers a live questionnaire of a managed session; see *Worker questions*. |
| `cancel` | Cancels the managed session's current turn. |
| `close` | `{sessionId, outcome: done or failed, summary}`. Runs the completion guards, sets the task status, journals the evidence and unregisters the session. |
| `reopen` | Restores a closed item to `in-progress` and re-registers its session. Refused if that session was deleted; run the item again with `start`. |
| `escalate` | Records a decision needed from the user; the supervisor asks in its reply. Include `{sessionId, questionId}` for a worker questionnaire. A generic escalation is cleared by the next `send`; a questionnaire escalation is not. Allowed while paused. |
| `registry-list` | Read-only. Searches the project's registry for skills and agents (`{filter?}`). See [Project setup](#project-setup). |
| `registry-install` | `{resourceType: skill or agent, name}`. Installs one resource after its own Desktop confirmation. Mandate required. |
| `registry-update` | Same fields. Updates one tracked resource after its own Desktop confirmation. Mandate required. |
| `launch-list` | Read-only. Lists the project's Launch Commands with ids and revisions. |
| `launch-add` | `{name, command}`. Adds a Launch Command. Mandate and a user-prompted turn required. Never runs it. |
| `launch-edit` | `{commandId, revision, name?, command?}`. Edits one Launch Command whose revision still matches. Mandate and a user-prompted turn required. |

Each mutating op checks, inside ACP and atomically: the supervisor is not
paused, the session is managed and in `managed` mode, limits allow the action,
and the request belongs to the current supervisor runtime (stale replies after
a runtime replacement are dropped).

## Project setup

Setup ops change only the supervisor's own project (the session cwd). They go
through the same `supervisor` tool and ACP request bridge as the ops above.
They are not `project_tasks` edits.

- **Caller and host:** ACP accepts setup only from a `pix-desktop` client during
  an active supervisor turn, and only for the registry's current
  `supervisorSessionId` in the current runtime. Duplicate request ids are refused.
- **Reads:** `registry-list` and `launch-list` need only the caller check above.
- **Writes:** `registry-install`, `registry-update`, `launch-add` and
  `launch-edit` also need the mandate enabled and not paused. Otherwise they fail
  with "Enable and resume the supervisor before changing project settings".
  `launch-add` and `launch-edit` also need a user-prompted supervisor turn
  (`pix-acp-agent.ts`); the tool description adds that settings change only when
  the user asks.
- **Registry search:** `registry-list` refreshes the registry, excludes
  `project`-type entries, matches `filter` against name, type, description and
  tags, returns at most 100 items, truncates descriptions to 300 characters and
  offers only install and update actions.
- **Registry install and update:** each resource needs its own Desktop
  confirmation. A host without a UI refuses with "Registry changes require
  confirmation in Pix Desktop". Declining gives "Registry change was not
  approved". The dialog shows type, name, project path, registry remote
  (credentials and query stripped), branch, scope (Project(key) or Global) and
  revision. Install refuses an existing local copy. Update needs a tracked entry
  from the same publication and refuses local changes unless the local copy
  matches the tracked or source hash. After approval the proof is re-checked under
  the supervisor exclusive operation and the registry cache lock. A changed proof
  or local hash aborts the write. Agent companion directory conflicts are refused.
  Setup never publishes, removes or overwrites local changes.
- **Launch Commands:** `launch-list` returns ids and revisions. `launch-add`
  appends `{name, command}` with a generated id. `launch-edit` needs the revision
  of the current entry (sha256 over id, name and command). A mismatch fails with
  "Launch Command changed or was removed; use launch-list and review before
  editing". Writes run under the workspace config write lock, are re-checked
  before commit and keep JSONC comments and unrelated fields. Commands are never
  run. See [Desktop package scripts](../desktop/integrations/desktop-package-scripts.md).
- **Desktop refresh:** a successful write sends `supervisor:setup-saved` with
  `{cwd, section}`. Desktop refreshes Launch Commands (`launch`) or the Registry
  (`registry`) only in the window whose workspace matches `cwd`. When ACP
  aborts a pending confirmation, `supervisor:setup-confirmation-cancelled`
  dismisses only that form.
- **Timeout:** ACP expires setup requests after 5 minutes. The Pi bridge has
  a 5-second grace period to receive that response before its fallback fires.

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
- `conflict` — another managed session in the same project edited the same file (below);
- `manual_takeover` — a user message took a managed session. `handed_over`,
  `released`, `closed` and `closed_by_user` are ledger entries only; they never
  wake the supervisor.

Events are coalesced per supervisor with a short debounce. An idle supervisor
gets one wake turn with one digest. A busy supervisor gets the digest as a
single queued follow-up that later events update rather than multiply. Pause
holds wakes but keeps the digest current. Before queuing a digest, and again
before Desktop automatically takes a queued digest, ACP checks the current
budget. If usage is at or above the ceiling, or accounting is unavailable,
it holds the digest, keeps coalescing events and escalates without a model
turn. Window expiry or a change in membership alone does not release a hold.
An explicit **Resume**, raise or clear releases it only if usage is below the
ceiling or no ceiling remains. This gate applies only to automatic wakes, not
to `start`, `send` or user prompts.

The digest is filtered against the project registry whenever it is composed or
rewritten, including queued digests that are being replaced. Only sessions in
`managed` mode are kept. The supervisor's own events and sessions that are no
longer registered are dropped. A session in `manual` mode keeps only its
`manual_takeover` line, and only while it stays registered. The 20-session limit
applies after this filtering. The filter affects wake digests only; the general
event monitor and the ledger are unchanged.

When a session leaves the registry (`close`, **Take Back from Supervisor** or
deleting the session), ACP withdraws it from the waker on the same ordered
per-project chain as digest delivery: its pending events are dropped, and its
lines are removed from a digest that is still queued in the supervisor session.
A queued digest left with no sessions is removed. A digest the supervisor has
already taken is never re-queued; the next digest starts fresh. The withdrawal
re-reads the registry when it runs, so a session handed over again in the
meantime keeps its new events.

A `conflict` line is kept only while both sessions are still `managed` and
their touch snapshots still match the ones that produced it. Conflict-only
wakes use the same debounce, pause and queue as other events. A digest shows at
most ten conflict details per worker, and one per retained pair and path.

## Completion guards

`close outcome=done` is refused unless all of the following hold:

1. the last turn ended with stop reason `end_turn`, and no turn is in flight;
2. no question is pending;
3. if a plan is linked, its saved checklist is readable, has `total > 0` and
   no unchecked items. A session with no linked plan passes this guard. The
   plan is the one recorded for the session's plan launch, or else the
   registered plan item;
4. the final assistant message contains a verification section (what was
   checked, and how).

A failed plan lookup is a refusal (`could not determine whether a plan is
linked`), not proof that no plan exists. A refusal returns the failing guards;
the supervisor sends rework or escalates. The ledger stores the evidence for every closure: turn id, stop
reason, plan progress, touched files and report excerpt. `failed` needs a
summary but no guards. Closures can be reverted with `reopen`.

## Worker rules and shared working tree

- Managed sessions get a preamble in their launch/handover prompt: no commits,
  no destructive git (`checkout`, `reset`, `stash`, `clean`, branch switches),
  no repository-wide formatting or mass rewrites, run only checks relevant to
  their scope, and expect other sessions' uncommitted changes in the tree.
- ACP tracks the files each managed session touches through successful
  `write`, `edit` and `apply_patch` calls. For `apply_patch` it takes every
  Add/Update/Delete header and both sides of a move (or the `---`/`+++`
  headers of a unified diff), plus the tool's reported `changedFiles`. When two different managed sessions in the same
  project touch the same path, the supervisor gets a `conflict` event. The
  supervisor's own session is excluded. Calls made inside `codemode` count too:
  the SDK emits them as ordinary `tool_execution_*` events with
  `parentToolCallId`. Writes made through shell commands are not tracked; this
  is a known gap, not a guarantee.
- Only the user commits. The supervisor may report which files belong to
  which item.

## Worker questions

The supervisor answers technical questions that fit the mandate policy. It
escalates product, risky, destructive or out-of-mandate questions to the user
and replies with the user's decision. The ledger records each answer and its
rationale.

- `read` lists the live questionnaires of managed workers with their
  `questionId`, questions and choice values.
- `answer` requires the mandate enabled and not paused, a `managed` session and
  a `questionId` that is still pending. Stale or repeated ids are rejected.
  `selections` need exactly one entry per question, with choice values (not
  labels) and the selection limits from `read`. ACP writes the encoded answer
  to the worker's pending editor request, not to the queue. It then dismisses
  the matching Desktop dialog.
- `authority=mandate` is the supervisor's own classification that the question
  is routine and within the saved policy. The tool instructions guide that
  judgement; ACP does not verify it. An unresolved questionnaire escalation
  blocks `mandate` answers for that session, even if the old ID is stale.
- Out-of-mandate questions are escalated with `escalate` and the `questionId`,
  and the worker keeps waiting. `authority=user` is accepted only for that
  escalated question, and only after a user message in the supervisor session
  that arrived after the escalation. If the worker asks again with a new ID,
  escalate that ID and obtain a new reply. The `rationale` states the user's decision.
- Each answer is journaled as `answered` with its authority, rationale and
  selections. A legacy `send kind=answer` is refused.

## State and lifetime

- The managed-session registry, mandate, pause state and ledger are ACP-owned
  durable project state under `.pi/supervisor/`. Registry/project cleanup must
  preserve that directory as canonical state.
- Plan-run records live in ACP-owned `.pi/plan-launches.json`
  (`pix/plans/launches`, see [Work plans](registry/desktop-registry-plans.md)),
  so the supervisor and Desktop read the same outcomes (phase 0, done).
- The per-session event source exists (phase 0, done): ACP
  `acp/src/acp/session-events.ts` emits `settled` (stop reason + files
  changed by successful write/edit/apply_patch calls), `question`, `error`
  (model/compaction/run/process), `stalled` and `checklist` to in-process
  subscribers (`PixAcpAgent.subscribeSessionEvents`). Session retirement emits
  nothing and disposes the observer's timer. Touched files are kept per session
  id across runtime replacement and dropped on session delete. Conflict detection
  runs in `acp/src/acp/supervisor-wake.ts` from successful write/edit/apply_patch
  completions (`file_changed`, which is not a lifecycle status). Conflict
  history is in memory: it survives runtime replacement but not an adapter
  restart, and keeps at most 500 recent paths per worker, dropping the oldest. A worker's
  path history expires when it leaves managed registration. `manual_takeover` is
  emitted by ACP (phase 2, below).
- The storage layer exists (phase 0, done): `acp/src/acp/supervisor-store.ts`
  keeps `.pi/supervisor/mandate.json`, `registry.json` (atomic temp+rename,
  serialized per project, bounded to 200 sessions) and append-only
  `ledger.jsonl` (torn lines skipped). Invalid mandate fields fall back to
  defaults, never to wider limits; a malformed pause flag reads as paused.
  Desktop cleanup treats `.pi/supervisor/` as canonical.
- The supervisor session and read-only tool exist (phase 1, done).
  Desktop's command palette entry **Open Project Supervisor** calls ACP
  `pix/supervisor/open` (`acp/src/acp/supervisor-contract.ts`). Concurrent
  opens share one operation and a reopen returns the registered session. The
  new-conversation command uses `fresh: true`: ACP prepares a blank runtime
  with a new session ID, copies any queued wakes, then switches the active ID
  in `registry.json` and records the old ID in `previousSupervisors`. The
  open response returns `previousSessionId`; Desktop replaces that open tab
  with the new session and closes the old tab's runtime without deleting its
  saved history or changing other tabs. If preparation fails or rotation is
  refused, the previous conversation and tab stay in place. A recorded but
  missing session is journaled (`supervisor-missing`) and replaced by a new
  one. Other ACP clients are refused. `session/list` marks the session with
  `_meta["pix.supervisor"]`, and Desktop shows a radar icon on its row.
  Deleting the supervisor or a managed session unregisters it and journals
  `closed_by_user`.
- ACP loads `acp/src/extensions/supervisor.ts` with `PIX_SUPERVISOR_BRIDGE=1`
  only when preparing or loading the supervisor for a Pix Desktop client.
  `acp/src/pi/supervisor-host.js` installs the correlated bridge only under
  that variable; requests carry random per-runtime ids, time out after 60 s,
  and a replaced runtime gets no reply. ACP also rejects requests from any
  session that is not the registered supervisor. `status` lists managed
  sessions and, in this observer phase, up to 20 other recent project
  sessions (excluding sub-agent viewers). Each entry includes the linked task,
  run state, last lifecycle event and plan progress. `read` returns a bounded
  digest built from the live runtime or the saved transcript's current branch
  (`acp/src/acp/supervisor-service.ts`).
- Mutating ops exist (phase 2, partial): `acp/src/acp/supervisor-actions.ts`
  runs `send`, `answer`, `cancel`, `close` and `escalate` under the per-project
  supervisor lock that takeover, handover and mandate changes share, and
  re-checks inside it that the caller is still the registered supervisor.
  Everything except `escalate` needs the mandate enabled (default off) and not
  paused, a registry entry in `managed` mode and an open session. `send`
  (`rework`/`note`) steers a streaming session or queues a turn in its
  Desktop auto queue as `[Supervisor <kind>] text`; `rework` counts against
  `maxReworkRounds`, and a send that would start a turn counts against
  `maxConcurrent`. `close done` is refused (ledger `close_refused`) unless no
  turn is in flight, the last stop reason is `end_turn`, no question is
  pending, any linked plan is readable, non-empty and fully checked (a failed
  lookup refuses) and the final report has a verification section; on success ACP writes the task status in
  `.pi/tasks.sqlite` (`supervisor-tasks.ts`), then unregisters the session and
  journals `closed` with evidence (including the item, rework count and origin). After a `done` close of a `started` session, ACP requests the best-effort tab close (`pix/supervisor/close_tab`, see Managed sessions and handover); `reopen` restores the stored origin.
  `reopen` reverts a supervisor closure from that ledger entry: the session
  must still exist and not be registered; it is registered `managed` again with
  its item and rework count, and the task returns to `in-progress`
  (ledger `reopened`). `escalate` works while paused and marks the item as
  waiting for the user. The first supervisor `send` to a session prepends the
  worker rules (`SUPERVISOR_WORKER_PREAMBLE`) and marks the entry `briefed`.
  `start` runs under the same lock: it refuses an already registered task or
  plan and a full `maxConcurrent`, then sends Desktop `pix/supervisor/start`
  `{requestId, cwd, sourceSessionId, item, modelRef?}` through the supervisor
  session's client. The model is the explicit `modelRef`, else the task's
  saved model for tasks, else `workerModelRef` for plans and prompts. Desktop
  launches only in the window showing that project and when no other launch is
  preparing; it refuses a task already linked to a session (use `reopen` or a
  handover). It prepends `SUPERVISOR_WORKER_PREAMBLE` to the launch prompt
  (so ACP does not treat it as a user takeover) and replies with the new
  session id once the prompt is dispatched. ACP checks that the session
  belongs to the project, registers it `managed` and `briefed`, and journals
  `started`. After 50 s ACP gives up and sends `pix/tasks/run_cancel` with the
  same request id; a failed or timed-out start may still have launched, so the
  supervisor checks `status` before retrying.
- A user message into a `managed` session (prompt or queued message) switches
  it to `manual` under the same lock before dispatch, drops supervisor
  messages still queued there, journals `manual_takeover` and wakes the
  supervisor; messages the supervisor itself queued are recognized and do not
  count. Handover registers sessions as `managed`.
- Desktop-only `pix/supervisor/mandate` reads (`{cwd}`) or patches
  (`{cwd, patch}`) the mandate and returns it with live counters (`managed`,
  `manual`, `running`, `reworkRounds`, optional `budgetUsedTokens`) and
  `budgetHeld: true` during a budget stop; ACP clamps limits and journals
  `mandate_changed`. Desktop shows a compact block above the supervisor
  transcript (`SupervisorMandateBar.svelte`, store
  `desktop/src/app/supervisor-mandate.svelte.ts`, polled every 5 s while
  visible): state Off/Active/Paused, counters, **Set up** when disabled,
  **Pause**/**Resume** and **Edit mandate** (`SupervisorMandateDialog.svelte`:
  enable, parallel sessions 1–20, rework rounds 0–50, stalled 5–60 min,
  token budget, default worker model, policy). The default worker model applies to plans and
  prompts when `start` does not specify a model. Choose a model and supported
  effort in the shared Desktop picker, then save the mandate. Reset the field
  and save to use the session default. In the RPC patch, `workerModelRef: null`
  clears the saved value, omission leaves it unchanged, and responses include
  `workerModelRef` only when saved. The RPC accepts up to 512 characters and
  trims surrounding whitespace before saving. For `budgetTokens`, omission
  keeps the ceiling, `null` clears it, and a positive integer is capped at
  `Number.MAX_SAFE_INTEGER`. Clearing the budget field in Desktop sends `null`.
  A configured ceiling with unavailable usage is shown as such, not as zero.
- Debounced wakes exist (phase 1): `acp/src/acp/supervisor-wake.ts` coalesces
  worker events per project for 5 s into one `[Supervisor digest]` text (one
  line per session, newest event per type, at most 20 sessions; the
  supervisor's own events and non-managed sessions are filtered out, see
  Events and digests). ACP puts it into the supervisor
  session's Desktop auto queue, so an idle supervisor runs it as one wake turn
  and a busy one after its current turn. While that item is still queued,
  later digests rewrite it in place instead of adding items; the check runs
  after the queue load, so an item Desktop has just taken is never rewritten.
  Pause keeps events pending without waking. Events that arrive while the
  supervisor runtime is not loaded stay pending until the next event. Only Pix
  Desktop clients get wakes; adapter dispose clears the timers.
- `acp/src/acp/supervisor-budget.ts` caches rolling usage points from mapped
  Pi JSONL files, reusing unchanged logs and parsing only appended lines when
  they grow. Fork-copied entries count once. The budget hold is saved per
  supervisor in `.pi/supervisor/budget-hold.json`; restarting ACP does not
  resume wakes. A hold stays in force after `fresh: true` rotates the
  conversation, because it is matched against the current and retired
  conversations of the project. Debounced events not yet queued live only in the adapter.
  A digest already in the saved Desktop auto queue is checked again at take.
  If Desktop returns an unconsumed digest to the queue, it keeps its wake ID
  and goes through that check again instead of becoming a steering message.
- The macOS app menu (first submenu) has **Open Project Supervisor**, placed
  after **Arrange windows**. It emits `pix-open-supervisor` to the focused Pix
  window, or else the first visible one (`desktop/src-tauri/src/supervisor_menu.rs`).
  That window's frontend (`desktop/src/app/supervisor-session.ts`,
  `listenSupervisorMenu` and `handleSupervisorMenu` in `App.svelte`) runs the
  palette command `session.supervisor` for its own workspace, with the same
  availability rule. A click before the project is ready (startup, workspace
  switch, running session mutation) shows an info notice instead of being
  dropped silently.
- Startup reconciliation exists (`acp/src/acp/supervisor-reconcile.ts`): when
  the supervisor runtime first starts in an ACP lifetime, each registered
  session without a turn in flight is checked against its saved transcript.
  A branch ending in a user message, tool result or `toolUse` assistant
  message becomes an `interrupted` event; a session missing from the session
  map becomes `missing`. Both go to the digest and the ledger (`reconciled`);
  nothing is resumed, replaced or unregistered automatically. The supervisor
  continues an interrupted session with `send rework` (a rework round).
- Write the supervisor's continuity state (ledger cursor, open escalations) as
  session custom entries as well, so compaction does not lose it.

## Diagnostics

Refused actions, guard failures, bridge errors, reconciliation mismatches and
budget stops go to the existing diagnostic logger (see
[logging](../operations/logging.md)). A budget stop records one project-level
`budget_exceeded` ledger entry and one warning per hold. It appears in the
supervisor mandate bar, not as a message to the supervisor model.

## Verification scenarios

- Mutating ops are rejected when paused, for unmanaged/manual sessions, beyond
  `maxConcurrent`/`maxReworkRounds`, and from a replaced runtime.
- A user message into a managed session wins against a concurrent supervisor
  `send`: the session ends up in `manual`, and the supervisor send is rejected.
- Events from several workers produce one wake. A busy supervisor gets one
  coalesced follow-up. Teardown releases timers and subscriptions.
- At the token ceiling a new or queued digest does not wake the supervisor.
  A held digest stays current, does not resume on window expiry alone, and is
  delivered once after explicit release when not paused.
- `close done` is refused for each failing guard and succeeds when all hold.
  A session with no linked plan closes without one; a failed plan lookup is
  refused. The ledger contains the evidence.
- A restart with a mid-turn worker yields an `interrupted` event and no
  duplicate session.
- Worker sessions do not expose the `supervisor` tool or mandate text.
- Setup ops: writes are refused when paused or disabled, and `launch-add` and
  `launch-edit` are refused outside a user-prompted turn. A stale `launch-edit`
  revision is refused without writing. A registry install or update without
  confirmation writes nothing.
- Two managed sessions that successfully write the same path produce one
  `conflict` per pair and path in the digest. A `manual` session, the
  supervisor's own session, a worker that left registration and a shell-only
  write produce no conflict.

## Resolved questions (2026-11-17)

- Status authority: only `supervisor close`, no `project_tasks` exception.
- Mandate UI: header block in the supervisor session.
- Budget unit: tokens over a rolling 24 hours.
- `stalled`: 15 minutes of inactivity excluding tool-call time, configurable
  5–60 minutes, notify-only.
