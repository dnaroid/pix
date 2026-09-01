# Session recovery tools

Status: implemented MVP contract (semantic search is intentionally deferred).

## Goal

Let an agent recover the task, recent instructions, file activity, and useful raw
session history after context compaction. Recovery reads the session already
owned by Pi's `SessionManager`; it never opens an arbitrary session path.

## Scope

The `session-recovery` module registers four read-only, headless tools:

- `session_overview` maps a session into stable, bounded sections.
- `session_read_section` renders one section by ID.
- `session_search` performs bounded lexical search over raw entries.
- `session_recovery_context` summarizes deterministic recovery signals.

Every tool defaults to the active root-to-leaf branch. `scope: "all"` includes
abandoned branches through `SessionManager.getEntries()`. Both modes use raw
append-only entries, not `buildContextEntries()`, so content hidden from the
active model context by compaction remains discoverable.

## Contracts

### Sections

A section starts at the first selected entry, a user message, a compaction, or a
branch summary. Its stable ID is derived from the start entry ID. The overview
reports bounded head and tail sections with entry ranges, counts, and compact
role/tool/error/file statistics. Labels are previews, not inferred decisions.

### Reading and search

`session_read_section` requires a section ID produced for the same scope. It
renders message roles and text, tool calls and arguments, tool results,
compaction summaries, and branch summaries with per-entry and total output
limits.

`session_search` is case-insensitive by default and searches message text, tool
arguments/results, custom-message content, and compaction or branch summaries.
It returns entry and section IDs plus bounded snippets. Regex and semantic
search are out of scope for the MVP.

### Recovery context

`session_recovery_context` reports only evidence that can be derived
deterministically: the original and latest user messages, recent tool errors,
unmatched tool calls, read and modified files, the last meaningful action, and
compaction count. It calls errors `recentErrors`; it does not claim that they
remain unresolved. It does not infer decisions. The currently executing
recovery tool call is excluded from unmatched-call reporting.

File activity comes from recognized tool calls and Pi-generated compaction or
branch-summary details. Read and modified paths remain separate, and unknown
tools are not guessed to be mutations.

## Limits and edge cases

- Results use small defaults and hard caps for result count, entry body size,
  and total text size.
- Empty or in-memory sessions return a normal explanatory result.
- Unknown or partially shaped entries are ignored or rendered conservatively.
- Concurrent sibling tool results might not yet be visible when recovery runs.
- A section ID is stable while its start entry ID is stable, but scope changes
  can change section membership.
- Parent-session metadata is reported when Pi exposes it; parent files are not
  traversed.

## Verification

Deterministic tests cover active versus all branches, raw pre-compaction search,
stable section IDs, Unicode case-insensitive search, bounded output, empty
sessions, current-call exclusion, recent errors, file carry-forward details,
and conservative handling of unknown entries. Release verification runs the
suite typecheck/tests/smoke gate, host `npm run check`, and then syncs the suite
with `npm run sync:pi-tools-suite`.

## Evidence

Evidence is recorded by the implementation tests in
`test/session-recovery.test.ts` and the verification commands reported with the
change.
