---
kind: spec
status: active
---

# Todo initial status and blocked-work handoff

## Behavior

`create` and each `batch_create` item honor an explicit valid `status`; omitted
status defaults to `pending`. Creation output and returned snapshots describe the
committed status. A task created `in_progress` needs no second activation call.
With todo thinking enabled, initially active tasks capture the prior thinking
level and restore it when no active task remains, just like update activation.

Prompt guidance keeps exactly one current task `in_progress`. Failed or blocked
work stays active while being resolved. Before switching to independent work,
move the blocked item to `pending`, record its blocker (dependency IDs or a
description for external blockers), and activate only the new current item.
Do not mark blocked work completed. User-input waits and out-of-scope work use
`deferred`. This is guidance, not an enforced single-active-task restriction.

Model-facing guidance keeps todo text concise for create/update and batch items:
subjects and active forms are short action phrases. Descriptions are optional
when the subject suffices; otherwise they use 1–2 short sentences for essential
scope, acceptance criteria, or the current blocker/next action. Replace stale
details instead of accumulating history. Reports, logs, path inventories and
context-recovery narratives belong in the final response or linked artifacts,
not task descriptions; a path or identifier needed to act remains appropriate.
Change descriptions only for changed scope, criteria, blocker or next action,
or an explicitly requested brief checkpoint. Blocked updates preserve acceptance
criteria and replace obsolete details with the current blocker and next action.
Completion normally sends only action, id and status (id/status per batch item),
without expanding descriptions into results reports. If the user requests a stop
after creation, do not make cosmetic updates or apply background results.
This is prompt guidance, not truncation or a schema length limit; persistence
and rendering remain unchanged.

## Constraints and failure cases

Invalid initial status is rejected, including open-shape batch items. Failed
batch creation commits nothing, including when `replace: true`. Existing
dependency validation, transitions, persistence, replay and automatic clearing
remain unchanged; there is no new blocked status.

## Implementation

- `external/pi-tools-suite/src/todo/state/invariants.ts`
- `external/pi-tools-suite/src/todo/state/state-reducer.ts`
- `external/pi-tools-suite/src/todo/tool/types.ts`
- `external/pi-tools-suite/src/todo/tool/response-envelope.ts`
- `external/pi-tools-suite/src/todo/index.ts`
- `external/pi-tools-suite/src/tool-descriptions.ts`

## Tests

- `external/pi-tools-suite/test/todo.test.ts`
- `external/pi-tools-suite/test/tool-descriptions.test.ts`
- `external/pi-tools-suite/test/evals/todo-conciseness.ts`
- `external/pi-tools-suite/test/evals/todo-prompt-snapshots.ts`
- `external/pi-tools-suite/test/evals/run-todo-paired.ts`
- `external/pi-tools-suite/test/evals/todo-conciseness.test.ts`

## Verification

Run focused todo and tool-description tests plus suite typecheck. Cover explicit
and omitted statuses, failed-batch atomicity, blocked-work handoff, accurate
creation output and thinking activation/restoration for both creation actions.
The todo-conciseness live slice checks creation, supplied verification updates,
user-approval blocking, and completion; deterministic positive/negative controls
test its text budgets, preserved criteria/blockers and successful-call evidence.

The paired runner freezes the preceding brief and current strengthened prompt
variants without changing working source or runtime guards. It alternates pair
order in fresh sessions/fixtures and reports text brevity independently from
lifecycle correctness. Equivalent successful test checkpoints include complete
nonzero test ratios; failed, pending, unrun or negated checkpoints must not pass.
Results remain a small supplied-facts sample, not evidence of real test execution
or statistical superiority. See `external/pi-tools-suite/docs/evals.md`.

Initial plan replacement on an empty fixture is equivalent to ordinary creation;
later replacement of a tracked plan fails the lifecycle gate. Finalized retained
events can be rescored without model calls, preserving original raw assertions
and recording the final scorer/hash. Incomplete live reports cannot be rescored.
Criterion checks accept equivalent negative duplicate-charge wording, not merely
the literal `no duplicate charge`; mentioning duplicate charges alone is not enough.
