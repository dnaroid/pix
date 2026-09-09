# Session recovery tools

Status: implemented MVP contract (semantic search is intentionally deferred).

## Type

As-is

## Lifecycle

Active implemented contract.

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
reports bounded section pages with entry ranges, counts, and compact
role/tool/error/file statistics. When more sections exist it returns an opaque
`nextCursor`; continuing with that cursor resumes after the last delivered
section. Labels are previews, not inferred decisions.

### Reading and search

`session_read_section` accepts either a section ID produced for the same scope or
one exact raw `entry_id`. Direct entry reads avoid scanning from the start of a
section and are useful when overview/search already identified the exact entry.
Without a continuation cursor, callers must pass exactly one of `section_id` or
`entry_id`.

The reader renders message roles/text, tool calls/arguments, tool results,
compaction summaries, and branch summaries with per-entry and total output
limits. Long entry bodies and multi-entry pages return an opaque `nextCursor`;
passing that cursor continues at the exact entry/body offset and must use the
same scope.

`session_search` is case-insensitive by default and searches message text, tool
arguments/results, custom-message content, and compaction or branch summaries.
It returns entry and section IDs plus bounded snippets. Search pages use an
opaque cursor bound to scope, query, and case-sensitivity. Regex and semantic
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
- Overview, read, and search pagination use opaque validated cursors; a cursor
  from another scope/query or a stale section is rejected rather than guessed.
- Empty or in-memory sessions return a normal explanatory result.
- Unknown or partially shaped entries are ignored or rendered conservatively.
- Concurrent sibling tool results might not yet be visible when recovery runs.
- A section ID is stable while its start entry ID is stable, but scope changes
  can change section membership.
- Parent-session metadata is reported when Pi exposes it; parent files are not
  traversed.

## Related files

- `external/pi-tools-suite/src/session-recovery/index.ts`
- `external/pi-tools-suite/src/tool-descriptions.ts`
- `external/pi-tools-suite/test/session-recovery.test.ts`

## Verification

Deterministic tests cover active versus all branches, raw pre-compaction search,
stable section IDs, overview/search pagination, direct late-entry reads,
continued long bodies, Unicode case-insensitive search, bounded output, empty
sessions, DCP-control filtering, current-call exclusion, recent errors, file
carry-forward details, and conservative handling of unknown entries. Release
verification runs the suite typecheck/tests/smoke gate and host checks.

## Evidence

Evidence is recorded by
`external/pi-tools-suite/test/session-recovery.test.ts` and the implementation
in `external/pi-tools-suite/src/session-recovery/index.ts`.
