# 0059 — Private todos for every subagent role

- Status: accepted
- Recorded: 2026-10-06
- Decided: 2026-10-06
- Owner / approval evidence: user requested todo for all roles in this conversation,
  then explicitly included `frontier-review` and all roles in the folder.
  No separate durable conversation artifact is cited.
- Governing spec: [Async subagents](../../specs/async-subagents.md)
- Replaces / replaced by: the todo-only empty-selection rule is superseded by
  [0060](0060-subagent-read-only-repo-tools.md), which also allows gated repo
  queries. The private-todo architecture remains in force; original rationale
  below is retained as history.

## Context

Children disable ordinary extension discovery. The parent previously owned the
only planning tool. All workers now need local planning without mutating the
parent's list or enabling recursive delegation.

## Observations and sources

Verified: [spawn](../../external/pi-tools-suite/src/async-subagents/core/spawn.ts)
loads an explicit extension allowlist. The ordinary
[todo entrypoint](../../external/pi-tools-suite/src/todo/index.ts) loads a shared
project persistence file and parent-specific thinking, UI and follow-up hooks.
The installed SDK enforces CLI tool restrictions on extension tools too;
[inventory tests](../../external/pi-tools-suite/test/async-subagents/provider-child-inventory.test.ts)
exercise actual offline child startup without model calls.

## Decision

Load a lean todo entrypoint at the common child launch boundary, independent of
role name or visibility. Reuse normal todo actions and session-scoped state, but
never project persistence or parent workflow hooks. Add todo to explicit CLI
allowlists; translate empty/no-tool selections to todo-only. Excluding todo is
not supported for children; other exclusions remain intact. Preserve unfinished
work across in-process compaction and optional session branch snapshots.
Each retry/attempt gets a fresh list. Parent-only tools remain denied.

## Alternatives

- Per-role edits would omit future or hidden roles and duplicate policy.
- Loading the full todo module would expose shared persistence and parent hooks.
- A shared parent plan would let parallel workers overwrite each other's state.

## Consequences

All roles can plan locally; explicitly tool-less roles now have a planning-only
exception. No-session children retain their list only for the child lifetime.
Todos do not automatically appear in the parent's list or final summary; workers
must report blockers. No additional model turn is scheduled by todo hooks.

## Revisit when

Parent-side aggregation is requested, child sessions gain interactive navigation,
or SDK changes affect extension allowlists, branch replay or compaction events.
