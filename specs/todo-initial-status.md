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

## Verification

Run focused todo and tool-description tests plus suite typecheck. Cover explicit
and omitted statuses, failed-batch atomicity, blocked-work handoff, accurate
creation output and thinking activation/restoration for both creation actions.
