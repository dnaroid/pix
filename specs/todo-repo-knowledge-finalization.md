# Todo repo knowledge finalization reminder

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Keep repo-knowledge maintenance as a low-noise completion safeguard instead of attaching repeated reminders to file mutations.

## Scope

- Apply only when the current project is repo-aware: `.indexer-cli` exists and an executable `idx` is available on `PATH`.
- When a successful todo completion leaves exactly one active todo (`pending` or `in_progress`), append one compact reminder to reconcile affected specs and repo knowledge before completing that final todo.
- Support both `update` and `batch_update` completion mutations.
- Keep the reminder advisory: mechanical or non-behavioral changes may be skipped.

## Non-goals

- Blocking todo completion on repo-knowledge state.
- Running `idx`, impact analysis, or semantic search automatically from the todo hook.
- Inspecting changed files or spec relations on each file mutation.
- Emitting repo-knowledge reminders from `write`, `edit`, `apply_patch`, or other mutation tool results.

## Behavior

- Todo remains the finalization boundary: the reminder appears after an earlier todo is completed and before the remaining final active todo is closed.
- Projects without repo-aware availability receive no repo-knowledge todo reminder.
- The reminder does not replace the normal `repo_knowledge` prompt guidance; it is a last-stage safeguard when the agent reaches the final report step.
- File mutations themselves carry no repo-knowledge checkpoint text.

## Related files

- `external/pi-tools-suite/src/todo/index.ts`
- `external/pi-tools-suite/src/todo/todo.ts`
- `external/pi-tools-suite/src/repo-discovery/index.ts`
- `external/pi-tools-suite/test/todo.test.ts`
- `external/pi-tools-suite/test/repo-discovery.test.ts`
- `external/pi-tools-suite/README.md`

## Verification

- Todo lifecycle tests cover reminder delivery in a repo-aware project and absence outside repo-aware mode.
- Repo-discovery tests no longer register or expect a post-mutation knowledge hook.
- `bun test test/todo.test.ts test/repo-discovery.test.ts`
- `npm run typecheck -- --pretty false`
- `git diff --check`
