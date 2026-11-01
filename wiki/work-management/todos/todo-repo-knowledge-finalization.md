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

## Verification

- Todo tests cover `update` and `batch_update` without knowledge reminders in
  indexed projects, absence outside indexed projects, and final completion/clear.
- Repo-discovery tests no longer register or expect a post-mutation knowledge hook.
- `npm run typecheck -- --pretty false`
- `git diff --check`

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"88768a1691527376181b66839facec535996c165e33ffa70734945ef19e8ddd9","checkedAt":"2026-10-31T00:18:33.412Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":61,"reportLanguage":"ru"} -->
