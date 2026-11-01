# Persist todo clear in session replay

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Keep live todo state authoritative after pix reloads or resumes the current session branch.

## Scope

- Record slash-command todo mutations as hidden custom session snapshots.
- Record end-of-turn optimistic todo completion and its automatic clear as a hidden custom session snapshot.
- Replay the latest valid snapshot across both `todo` tool results and todo custom entries.
- Cover `/todos-clear`, `/todos clear`, and `/todos-scope` command mutations.

## Non-goals

- Changing project-level `<project>/.pi/todo-plan.json` persistence semantics.
- Adding todo snapshots to model context or the visible transcript.
- Rewriting existing session files.

## Behavior

- A successful slash-command mutation appends a hidden todo-state custom entry after updating live state.
- An internal optimistic completion appends the resulting state after automatic completed-task cleanup. If this empties the live plan, reopening the session must replay that empty snapshot instead of an earlier in-progress `todo` tool result.
- Desktop's private `pix/session/clear_todos` action invokes that same `/todos-clear` handler directly, so it has identical hidden snapshot persistence and state publication without adding a slash command or user message to the transcript.
- Session replay remains last-write-wins in branch order.
- A valid custom snapshot supersedes earlier `todo` tool results; malformed or unrelated custom entries are ignored.
- Existing sessions without custom snapshots continue to replay from `todo` tool results.

## Verification

- Replay regression test with an older non-empty tool result followed by an empty clear snapshot.
- Slash-command tests assert that clear and scope append the expected custom snapshots.
- Optimistic-completion tests assert that the internally cleared state is appended for replay.
- pi-tools-suite deterministic check and host check.

## Risks / unknowns

- Tree navigation intentionally follows branch-local ordering; a clear entry outside the selected branch must not affect that branch.

## Evidence

- Confirmed by code: before this change, replay only recognized `todo` tool-result messages.
- Confirmed by SDK types: `appendEntry()` creates a custom session entry excluded from model context specifically for extension state persistence.
- Confirmed by tests: targeted todo replay/clear tests and the suite/host checks
  pass; avoid treating historical aggregate test counts as part of the contract.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"1111db58915a0bb10064b61d791fd4fc306c5588eb9fccbd831bdfb13a55ce20","checkedAt":"2026-10-31T00:19:47.551Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":56,"reportLanguage":"ru"} -->
