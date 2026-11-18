# 0077 — Project supervisor session on autopilot

- Status: accepted (design direction; phase 0 and partial phase 1 implemented: supervisor session with read-only status/read tool; autopilot not implemented)
- Recorded: 2026-11-17
- Decided: 2026-11-17
- Owner / approval evidence: user request in Pi session
  `01a1eb2d-aed1-70e2-b025-7173e63d491c` ("хочу сделать сессию/супервайзер по
  проекту … агент должен оркестрировать остальные сессии, выполнять
  запланированные планы, таски, закрывать завершенные или продолжать
  дорабатывать") plus structured answers in the same session: full autopilot
  within limits; manages its own and explicitly handed-over sessions; worker
  report plus plan checklist as the completion criterion; N parallel sessions
  in one working tree; Desktop-open lifetime only; only the user commits;
  supervisor answers worker questions within its mandate; defaults of 5
  parallel sessions and 5 rework rounds; strong model; ADR + spec + plan.
  The ACP/Desktop responsibility split below is an agent proposal not
  separately reviewed by the user.
- Governing spec: [Project supervisor](../work-management/project-supervisor.md)
- Replaces / replaced by: none. Related: [0019](0019-desktop-persistent-council-sessions.md)
  and [0071](0071-brainstorm-skill-on-subagents.md) (council session hosting
  and its removal), [0072](0072-session-native-subagents.md) (sub-agents),
  [0064](0064-sqlite-project-tasks.md) (task authorization).

## Context

The user wants one chat per project that drives the other sessions: starts
saved tasks and plans, monitors them, sends rework and closes finished work.
Today an agent can launch a task session (`project_tasks run`) but cannot see
whether it finished, read its outcome, send it follow-ups or close it without
an explicit user request for every action.

## Observations and sources

- Verified in source: `project_tasks run` goes through a per-runtime host bridge
  (`acp/src/pi/task-run-host.js`) → ACP `pix/tasks/run` client request
  (`acp/src/acp/task-run-bridge.ts`) → Desktop `onTaskRun`, which reuses the
  sidebar Tasks Run action. The receipt arrives when the prompt is sent, not
  on completion.
- Verified: ACP sees every session's lifecycle (`agent_start`,
  `agent_settled`, stop reasons) and already accepts queued/steering messages
  for busy sessions (`pix/session/queue_message`).
- Verified: plan-run status (Running/Failed/Interrupted/Done) is kept only in
  Desktop `localStorage` (`pix.desktop.planLaunches:<workspace>`), so an agent
  cannot read it. (2026-11-17, phase 0: moved to ACP-owned
  `.pi/plan-launches.json`, see [Work plans](../work-management/registry/desktop-registry-plans.md).)
- Verified: the council's ACP host and loopback capability (0019) were deleted
  by 0071; no generic agent-to-session control channel exists today.
- The SDK extension context cannot create native Pix sessions; ACP owns their
  lifecycle (0019 observation, still applicable).
- Cost, latency and the reliability of worker self-reports are expectations,
  not measurements.

## Decision

- A pinned **supervisor session** per project, using a configurable strong
  model, receives only supervisor tools and the mandate. Worker sessions never
  inherit them.
- **Autopilot within limits.** Enabling the supervisor and saving its mandate
  is the user's standing authorization to start, rework, cancel and mark saved
  tasks done/failed. This replaces per-action confirmation only in the
  supervisor session. Hard limits: 5 concurrent managed sessions, 5 rework
  rounds per item, a budget. When a limit is reached, the supervisor escalates
  instead of retrying. A Pause control stops all new supervisor actions.
- **Scope:** sessions the supervisor started, plus sessions the user hands over
  explicitly. Writing into a managed session switches it to manual mode until
  the user releases it.
- **Completion:** worker final report plus saved plan checklist, behind
  deterministic guards: final stop reason `end_turn`, no unchecked plan items,
  no pending question, and a report section listing what was verified. Every
  closure is journaled with its evidence and can be reopened.
- **Shared working tree:** managed sessions run in the project tree in
  parallel. They follow rules injected into their prompt: no commits, no
  destructive git, no repository-wide formatting. ACP detects file overlap
  between managed sessions and reports it as a `conflict` event. Only the user
  commits.
- **Worker questions** are answered by the supervisor when they are technical
  and within the mandate. Product, risky or out-of-mandate questions are
  escalated to the user.
- **Lifetime:** runs only while Desktop has the project open. On startup it
  reconciles its ledger against tasks, plans and session state.
- **Responsibility split (agent proposal):** a deterministic engine in ACP
  owns events, digests, the managed-session registry, limits, the ledger and
  conflict detection. Desktop keeps executing session creation through its
  existing Tasks/Plans Run actions, reached through a bridge modelled on
  `pix/tasks/run`. The LLM only decides, based on digests.

## Alternatives

- **Suggest-only or confirm-to-close modes:** offered; the user chose full
  autopilot. Suggest-only remains reachable through Pause.
- **Manage all project sessions:** rejected. Too easy to interfere with the
  user's manual work.
- **Independent verification on every closure:** rejected for cost. Guards
  plus a reopenable journal are the mitigation.
- **One active task at a time, or a git worktree per session:** rejected.
  Serial is too slow; worktrees need a merge stage and are a separate project.
- **Background operation without Desktop:** rejected as much harder (a second
  host, crash recovery, dual-ownership protection).
- **Supervisor as a sub-agent or skill only:** sub-agents are not the user's
  task/plan sessions and cannot be handed over; a skill has no event source.
- **Worker or supervisor commits:** rejected; with a shared tree, changes
  cannot be attributed per task reliably.

## Consequences

- The project gets a chat-shaped control surface. ACP gains a new component
  with lifecycle, persistence and cancellation responsibilities.
- Self-reports can be wrong; an incorrectly closed task is detected later, not
  prevented. Five parallel sessions in one tree will sometimes break each
  other's builds or tests. Conflict events reduce, but do not eliminate, this.
- Each wake is a strong-model turn; digests and debounce bound, but do not
  fix, the cost.
- The project-tasks authorization rule gains an explicit, scoped exception
  that must stay out of worker sessions.

## Revisit when

Wrong closures or rework loops are observed in practice; same-tree conflicts
become frequent enough to justify worktrees; cost per wake is unacceptable; or
the user needs the supervisor to run while Desktop is closed.
