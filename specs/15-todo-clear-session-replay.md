# Spec: Persist todo clear in session replay

## Type

Change

## Goal

Keep todos cleared after pix reloads or resumes the current session branch.

## Scope

- Record slash-command todo mutations as hidden custom session snapshots.
- Replay the latest valid snapshot across both `todo` tool results and todo custom entries.
- Cover `/todos-clear`, `/todos clear`, and `/todos-scope` command mutations.

## Non-goals

- Changing project-level `.pi/todo-plan.json` persistence semantics.
- Adding todo snapshots to model context or the visible transcript.
- Rewriting existing session files.

## Behavior

- A successful slash-command mutation appends a hidden todo-state custom entry after updating live state.
- Session replay remains last-write-wins in branch order.
- A valid custom snapshot supersedes earlier `todo` tool results; malformed or unrelated custom entries are ignored.
- Existing sessions without custom snapshots continue to replay from `todo` tool results.

## Related files

- `external/pi-tools-suite/src/todo/state/replay.ts`
- `external/pi-tools-suite/src/todo/todo.ts`
- `external/pi-tools-suite/test/todo.test.ts`

## Verification

- Replay regression test with an older non-empty tool result followed by an empty clear snapshot.
- Slash-command tests assert that clear and scope append the expected custom snapshots.
- pi-tools-suite deterministic check and host check.

## Risks / unknowns

- Tree navigation intentionally follows branch-local ordering; a clear entry outside the selected branch must not affect that branch.

## Evidence

- Confirmed by code: before this change, replay only recognized `todo` tool-result messages.
- Confirmed by SDK types: `appendEntry()` creates a custom session entry excluded from model context specifically for extension state persistence.
- Confirmed by tests: targeted todo tests pass (40 tests), the pi-tools-suite check passes (415 passed, 36 skipped live evaluations), and the host check passes (955 tests).
