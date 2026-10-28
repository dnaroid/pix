---
kind: spec
status: active
---

# Todo completion without knowledge-state reminders

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Keep todo completion independent of repository-knowledge state. Final documentation
maintenance belongs to the parent/subagent workflow, not todo result hooks.

## Scope and behavior

- Neither `update` nor `batch_update` completion appends a knowledge-audit,
  dirty-state or acknowledgment reminder, including in initialized projects.
- Closing the final todo remains independent of repository search and documentation receipts.
- Todo lifecycle, reporting reminders, persistence and automatic clearing of
  completed plans are unchanged.
- File mutation results likewise have no knowledge checkpoint hook.
- Before finishing implementation work, the parent still runs the available
  documentation specialist according to
  [the repository workflow](../../search/repo-knowledge-agent-workflow.md). This is not a todo
  runtime action or knowledge-state gate.

## Non-goals

- Changing repository retrieval behavior.
- Running external search services, reading specs or spawning subagents from todo mutations.
- Changing explicit Desktop knowledge-management commands.

## Decision history

- [0067 — Final documentation maintenance without knowledge-state gates](../../decisions/0067-final-documentation-maintenance.md).
- Historical: [0046 — Task-scoped knowledge audit completion](../../decisions/0046-task-scoped-knowledge-completion.md).

## Implementation

- `external/pi-tools-suite/src/todo/index.ts`
- `external/pi-tools-suite/src/todo/todo.ts`
- `external/pi-tools-suite/src/tool-descriptions.ts`
- `wiki/tools/suite.md`

## Tests

- `external/pi-tools-suite/test/todo.test.ts`
- `external/pi-tools-suite/test/tool-descriptions.test.ts`

## Verification

- Todo tests cover `update` and `batch_update` without knowledge reminders in
  indexed projects, absence outside indexed projects, and final completion/clear.
- Repo-discovery tests no longer register or expect a post-mutation knowledge hook.
- `bun test test/todo.test.ts test/tool-descriptions.test.ts`
- `npm run typecheck -- --pretty false`
- `git diff --check`
