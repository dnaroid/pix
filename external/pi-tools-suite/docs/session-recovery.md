---
kind: spec
status: active
---

# Session tool

Status: implemented MVP contract (semantic search is intentionally deferred).

## Type

As-is

## Lifecycle

Active implemented contract.

## Behavior

The default-on `session` module registers one headless tool, `session`, with
required `action`: `name`, `overview`, `read`, `search`, or `recovery`. It is
available directly and as `tools.session(...)` in codemode using the same flat
schema and dispatcher. No old tool aliases or old module-key migrations are
provided. Disable the entire tool with the `session` module key; old
`session-name`/`session-recovery` keys do not control it.

`action: "name"` reads the current title when `name` is omitted or blank, or
sets a trimmed title through Pi's session API. Use it for explicit renames,
opaque first prompts once understood, or when the title no longer fits; ordinary
first prompts are automatically named. History actions never rename a session.

The other four actions let an agent recover the task, recent instructions, file
activity, and useful raw session history after compaction.

## Goal

Let an agent recover the task, recent instructions, file activity, and useful raw
session history after context compaction. Recovery reads the session already
owned by Pi's `SessionManager`; it never opens an arbitrary session path.

## Scope

The history actions are read-only:

- `session action=overview` maps a session into stable, bounded sections.
- `session action=read` renders one section or exact entry by ID.
- `session action=search` performs bounded lexical search over raw entries.
- `session action=recovery` summarizes deterministic recovery signals.

Every history action defaults to the active root-to-leaf branch. `scope: "all"` includes
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

`session action=read` accepts either a section ID produced for the same scope or
one exact raw `entry_id`. Direct entry reads avoid scanning from the start of a
section and are useful when overview/search already identified the exact entry.
Without a continuation cursor, callers must pass exactly one of `section_id` or
`entry_id`.

The reader renders message roles/text, tool calls/arguments, tool results,
compaction summaries, and branch summaries with per-entry and total output
limits. Long entry bodies and multi-entry pages return an opaque `nextCursor`;
passing that cursor continues at the exact entry/body offset and must use the
same scope.

`session action=search` is case-insensitive by default and searches message text, tool
arguments/results, custom-message content, and compaction or branch summaries.
It returns entry and section IDs plus bounded snippets. Search pages use an
opaque cursor bound to scope, query, and case-sensitivity. Regex and semantic
search are out of scope for the MVP.

### Recovery context

`session action=recovery` reports only evidence that can be derived
deterministically: the original and latest user messages, recent tool errors,
unmatched tool calls, read and modified files, the last meaningful action, and
compaction count. It calls errors `recentErrors`; it does not claim that they
remain unresolved. It does not infer decisions. The currently executing
recovery tool call is excluded from unmatched-call reporting.

File activity comes from recognized tool calls and Pi-generated compaction or
branch-summary details. Read and modified paths remain separate, and unknown
tools are not guessed to be mutations.

## Constraints and failure cases

- Start unknown lost-context recovery with `overview`, then inspect IDs with
  `read`. Use `search` when a reliable literal phrase is known. `recovery` is a
  convenience only after the overview; historical errors are not asserted to be
  unresolved.
- Action is required. The dispatcher rejects unknown actions, wrong types,
  out-of-schema bounds, unknown fields and fields belonging to another action
  before touching the session. `search` requires a nonblank query.
- DCP regret recognizes only `session` history
  actions (`overview`, `read`, `search`, `recovery`). Title reads and renames
  (`name`) are excluded; old tool names are not classified.

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

## Implementation

- `external/pi-tools-suite/src/session/index.ts`
- `external/pi-tools-suite/src/session/actions.ts`
- `external/pi-tools-suite/src/session/parameters.ts`
- `external/pi-tools-suite/src/session-name/index.ts`
- `external/pi-tools-suite/src/session-recovery/index.ts`
- `external/pi-tools-suite/src/module-catalog.ts`
- `external/pi-tools-suite/src/tool-descriptions.ts`
- `external/pi-tools-suite/src/dcp/regret-signals.ts`

## Tests

- `external/pi-tools-suite/test/session.test.ts`
- `external/pi-tools-suite/test/session-name.test.ts`
- `external/pi-tools-suite/test/session-recovery.test.ts`
- `external/pi-tools-suite/test/config.test.ts`
- `external/pi-tools-suite/test/codemode-sdk.test.ts`
- `external/pi-tools-suite/test/dcp-session-sim-e2e.test.ts`
- `external/pi-tools-suite/test/tool-descriptions.test.ts`
- `external/pi-tools-suite/test/evals/extension-contracts.test.ts`
- `external/pi-tools-suite/test/evals/session-cases.ts`
- `external/pi-tools-suite/test/evals/session-cases.test.ts`
- `external/pi-tools-suite/test/evals/coverage-manifest.ts`
- `external/pi-tools-suite/test/tool-selection-e2e.test.ts`

## Verification

The live session eval slice covers all five actions with separate title read
and rename scenarios. It checks action/argument selection, ordered successful
results, overview before read/recovery and known-literal search without an
overview preflight. These current-session scenarios are not a pre-compaction
hidden-fact recovery benchmark; see `docs/evals.md` for the command and limits.

Deterministic tests cover active versus all branches, raw pre-compaction search,
stable section IDs, overview/search pagination, direct late-entry reads,
continued long bodies, Unicode case-insensitive search, bounded output, empty
sessions, DCP-control filtering, current-call exclusion, recent errors, file
carry-forward details, conservative handling of unknown entries, action dispatch
validation, real SDK codemode calls, and name exclusion from recovery accounting. Release
verification runs the suite typecheck/tests/smoke gate and host checks.

## Evidence

Evidence is recorded by
`external/pi-tools-suite/test/session-recovery.test.ts` and the implementation
in `external/pi-tools-suite/src/session-recovery/index.ts`.
