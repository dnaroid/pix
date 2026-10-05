---
kind: spec
status: active
---

# Todo repo knowledge finalization reminder

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Keep repo-knowledge maintenance as a low-noise completion safeguard instead of attaching repeated reminders to file mutations.

## Scope

- Apply only when the current project is initialized for repo knowledge:
  `.indexer-cli` exists at the resolved project root. The reminder/role
  visibility does not additionally require an executable `idx`.
- When a successful todo completion leaves exactly one active todo (`pending`
  or `in_progress`), append one compact reminder to delegate the final
  task-scoped knowledge pass to `knowledge-auditor`, with a concise
  behavior/result summary and the exact project-relative task-changed paths.
  The reminder requires obtaining the result and resolving task-related
  escalations/unreviewed specs or reporting blockers and remaining dirty state;
  spawning alone is not completion.
- Close the knowledge-audit todo once task-scoped review is complete. A global
  `idx knowledge dirty` result of `yes` alone must not keep it open; report that
  global state separately without asserting an unverified cause. Task-related
  drift, missing coverage and shared-spec/dependency edits still require
  resolution. Never acknowledge unrelated specs to force global cleanliness.
- Support both `update` and `batch_update` completion mutations.
- Keep the reminder advisory at the todo layer; the auditor itself decides
  whether the audit is no-impact, safely repairable, or needs escalation.

## Non-goals

- Blocking todo completion on repo-knowledge state.
- Running `idx`, spawning the auditor, impact analysis, or semantic search
  automatically from the todo hook.
- Inspecting changed files or spec relations on each file mutation.
- Emitting repo-knowledge reminders from `write`, `edit`, `apply_patch`, or other mutation tool results.

## Behavior

- Todo remains the finalization boundary: the reminder appears after an earlier todo is completed and before the remaining final active todo is closed.
- Projects without `.indexer-cli/` receive no repo-knowledge todo reminder.
- The reminder is a last-stage handoff safeguard: the parent performs the
  actual `knowledge-auditor` spawn. If the child cannot run `idx`, it reports
  the blocker rather than installing or initializing anything.
- File mutations themselves carry no repo-knowledge checkpoint text.
- The reminder distinguishes task completion from project-wide cleanliness;
  it does not require other parallel agents to finish unrelated work.

## Decision history

- [0046 — Task-scoped knowledge audit completion](../docs/decisions/0046-task-scoped-knowledge-completion.md).

## Implementation

- `external/pi-tools-suite/src/todo/index.ts`
- `external/pi-tools-suite/src/todo/todo.ts`
- `external/pi-tools-suite/src/repo-discovery/index.ts`
- `external/pi-tools-suite/README.md`

## Tests

- `external/pi-tools-suite/test/todo.test.ts`
- `external/pi-tools-suite/test/repo-discovery.test.ts`

## Verification

- Todo lifecycle tests cover reminder delivery in a repo-aware project and absence outside repo-aware mode.
- Reminder tests cover independent task/global verdict guidance and final todo
  completion without a project-wide knowledge check.
- Repo-discovery tests no longer register or expect a post-mutation knowledge hook.
- `bun test test/todo.test.ts test/repo-discovery.test.ts`
- `npm run typecheck -- --pretty false`
- `git diff --check`
