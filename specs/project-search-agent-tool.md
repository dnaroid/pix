---
kind: spec
status: active
---

# Project-wide search for Pi agents

## Goal

Expose the project history and existing repository-index search to the Pi agent
through a single bounded, read-only `project_search` tool. Use the same project
data sources as Desktop Universal Search without recreating a second persistent
index or inserting a second LLM/Jev step into agent work.

## Behavior

- `project-search` is a default-enabled module in the bundled pi-tools-suite
  catalog. It registers one `project_search` tool in the main Pix TUI and
  Desktop agent extension runtimes; it is **independent of** the IDX-related
  `repo_*` registration gate. No setup commands, implicit index creation,
  RAG generation, or workspace mutations occur.
- Required `query` is a nonempty string of at most 2,048 characters.
  `sources` optionally selects unique values from `sessions`, `tasks`,
  `commits`, `code`, and `knowledge` (all five by default).
  `limit` is 1–20 (default 10). `indexMode` is `hybrid` (default),
  `semantic`, `lexical`, or `symbol`, applied only to IDX Code/Knowledge.
  Optional `projectPath` names an explicit alternate project directory,
  resolved relative to session cwd (also accepting absolute and `~/` paths);
  it does not change session cwd. The project directory must exist.
- Sessions use Pi SDK native session listing for the selected project's
  history, and read only the first user message and most recent completed
  assistant answer (`stopReason: "stop"`) on the active JSONL branch.
  Tool outputs, thinking and abandoned branches are not included in returned
  excerpts. Return native session ID and session file path for follow-up
  navigation. Up to 100 session files are inspected, individual JSONL files
  larger than 2 MiB are skipped for excerpt reading, and source snippets are
  shortened before delivery. The SDK session listing may internally read
  more JSONL data; there is no new full-transcript index or automatic upload.
  Desktop's existing FTS index is not duplicated: this tool performs a bounded
  on-demand read, independent of Desktop SQLite availability in the TUI.
- Tasks are read from the same `.pi/tasks.jsonc` store used by Desktop Tasks,
  including completed items. Search title, description, stable ID, status,
  type and priority. Attachment bytes are not read. Redirected (symlinked)
  `.pi` directories/task files are rejected. The task file is size-bounded;
  parsing is JSONC-compatible. Results use `tasks:<id>` identities.
- Commits search **HEAD ancestors**, not unrelated branches or all working-tree
  changes. Match subject, author, message, hash and changed file paths; report
  full hash for the existing Git Diff navigation. Results have bounded previews
  and do not include patch contents. Explicit `patch:<literal>` uses Git
  pickaxe on demand (max 50 matches, literal regex-escaped changed lines),
  skipping all non-commit sources. Normal Git metadata lookup examines at most
  1,000 ancestors per call, with bounded process output and an 8-second
  command deadline. The tool never stores patches or creates embeddings for
  commit history.
- Code and Knowledge federate existing `idx search` with separate `code`
  and `document` domains, reusing the project's saved IDX provider/index.
  Results include safe project-relative file path, line range and a bounded
  snippet. No automatic `idx init`, provider migration, or indexing is
  allowed. If the IDX executable or project-local `.indexer-cli` directory
  is missing, only Code/Knowledge are skipped with a notice; local sources
  still work. `indexMode:"hybrid"` may send the query to the configured
  embedding provider, as may `semantic`; `indexMode:"lexical"` avoids
  those provider calls. `pathPrefix` is an IDX-only safe project-relative
  directory/file scope. `maxFiles` (1–50) limits candidates per IDX domain,
  defaulting to three with no inline content or one when `includeContent`
  is enabled. Combined final results remain capped at 20. Other strongly typed
  IDX flags are `chunkTypes`
  (`types/api/impl/tests/imports`), `minScore` (0–1), `includeImports`,
  `dedupeFile`, `dedupeSymbol`, `cluster`, `excludeTests`, `includeTests`,
  and `includeContent`; test-inclusion and exclusion are mutually
  exclusive. Invalid or option-like paths, duplicate chunk types, invalid
  numbers and conflicting flags are rejected before IDX execution.
  Native Compact's old raw-argv search wrapper is not exposed.
- Federation isolates missing/unavailable sources with short controlled
  notices, never raw provider diagnostics. Work is bounded to an 18-second
  overall deadline with cancellation ownership. Search returns a relevance-
  ordered, deduplicated list with a maximum of 20 results, plus source-specific
  notices. Output includes readable source IDs and structured details
  (`path`, `startLine`, `endLine`, `hash`, `sessionId`, `taskId`)
  so the agent can read and cite authoritative evidence afterward. Output text
  is capped at 12,000 characters. An empty or partial search is not evidence
  that a historical claim is false.
- Calls use the invoking agent's model as the synthesizer. `project_search`
  itself does not call JEV, run RAG or invoke any second answer model.
  The agent must verify search hits against original code, documents or
  history before treating them as definitive. `repo_context` remains the
  first choice for broad spec/behavior context; `project_search` is the
  sole focused code/document lookup tool. The previous `repo_search` tool
  is not registered.

## Privacy and security

- Local sources never call a network model on their own. The **calling agent**
  may nevertheless send returned excerpts to its selected model provider as
  part of the ongoing conversation. Tool descriptions disclose this.
  IDX hybrid search may also send search queries to its already-selected
  embedding provider; lexical mode is the opt-out for embedding calls.
- No new full-transcript index, historical secret index or Git patch index is
  maintained. The tool does not read attachments, execute repository code,
  read or change Git config, or create project setup files.
- Input schemas bound result counts, paths and request size. Git subprocesses
  run without a shell and without inherited `GIT_*` overrides; external
  errors and secrets are not returned in source notices.
- The main bundled extension exposes all five sources. Indexed async
  subagent children replace `repo_search` with `project_search` but may
  request **Code and Knowledge only** (defaulting to those two sources).
  Child entrypoint and call boundary reject sessions, tasks, commits, and
  `patch:` searches, preserving the pre-existing child access scope. A
  child without existing IDX prerequisites does not register project
  search. Broadening child access to private project history would need
  separate authorization.

## Related contracts

- [Desktop Universal Search](desktop-universal-search.md)
- [Indexed repository discovery](repo-knowledge-agent-workflow.md)
- [Async subagent tool access](async-subagents.md)

## Implementation

- `external/pi-tools-suite/src/project-search/index.ts`
- `external/pi-tools-suite/src/project-search/engine.ts`
- `external/pi-tools-suite/src/module-catalog.ts`
- `external/pi-tools-suite/src/index.ts`
- `external/pi-tools-suite/src/repo-discovery/index.ts`
- `external/pi-tools-suite/src/repo-discovery/subagent.ts`
- `external/pi-tools-suite/src/async-subagents/core/child-tools.ts`
- `external/pi-tools-suite/test/evals/coverage-manifest.ts`

## Tests

- `external/pi-tools-suite/test/project-search.test.ts`
- `external/pi-tools-suite/test/config.test.ts`
- `external/pi-tools-suite/test/module-loader.test.ts`
- `external/pi-tools-suite/test/evals/extension-contracts.test.ts`
- `external/pi-tools-suite/test/async-subagents/repo-tools.test.ts`
