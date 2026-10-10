---
kind: spec
status: active
---

# Project-wide search for Pi agents

## Goal

Expose the project history and existing repository-index search to the Pi agent
through a single bounded `project_search` tool. Use the same project data
sources and project-owned search-cache tables as Desktop Universal Search,
without duplicating a persistent index or invoking a second answer LLM/Jev.
Authoritative project task/session/Git state remains read-only; explicit
semantic searches may update `.pi/search/index.sqlite` after provider consent.

## Behavior

- `project-search` is a default-enabled module in the bundled pi-tools-suite
  catalog. It registers one `project_search` tool in the main Pix TUI and
  Desktop agent extension runtimes; it is **independent of** the IDX-related
  `repo_*` registration gate. No IDX setup commands, RAG generation or writes
  to canonical task/session/Git data occur. Search-cache writes are limited
  to selected semantic sources at explicit search time, never background work.
- Required `query` is a nonempty string of at most 2,048 characters.
  `sources` optionally selects unique values from `sessions`, `tasks`,
  `commits`, `code`, and `knowledge` (all five by default).
  `limit` is 1–20 (default 10). `indexMode` is `hybrid` (default),
  `semantic`, `lexical`, or `symbol`. It selects the IDX Code/Knowledge mode;
  `hybrid`/`semantic` additionally permit creating and querying missing
  task/session-name/commit vectors under the respective consent and provider
  prerequisites. `lexical` disables **all** embedding and search-cache writes,
  and `symbol` does not enable task/session/commit semantics.
  Optional `projectPath` names an explicit alternate project directory,
  resolved relative to session cwd (also accepting absolute and `~/` paths);
  it does not change session cwd. The project directory must exist.
- Sessions use Pi SDK native session listing for the selected project's
  history, and read only the first user message and most recent completed
  assistant answer (`stopReason: "stop"`) on the active JSONL branch.
  Tool outputs, thinking and abandoned branches are not included in returned
  excerpts. Return native session ID and session file path for follow-up
  navigation. Up to **1,000** sessions are inspected per request, individual
  JSONL files larger than 4 MiB are skipped for excerpt reading, and snippets are
  shortened before delivery. The SDK session listing may internally read
  more JSONL data; there is no new full-transcript index or automatic upload.
  Desktop's existing FTS index is not duplicated: this tool performs a bounded
  on-demand read, independent of Desktop SQLite availability in the TUI.
- Tasks are read from the same `.pi/tasks.sqlite` store used by Desktop Tasks,
  including completed items. Search title, description, stable ID, status,
  type, priority, file/artifact link paths, parent and related task titles/IDs,
  reverse task links, epic flag, associated session ID, model reference and
  attached filenames in the SQL association table. Attachment bytes are not
  read. Task rows are validated individually first, then the entire loaded
  task document is checked for valid hierarchy and related links (not once per
  row). This avoids rejecting valid subtasks whose parent is stored in another
  row. Without separate semantic consent/index the agent's task source remains
  entirely local and lexical. Redirected (symlinked)
  `.pi` directories/database files are rejected. The SQLite schema and task
  payloads are strictly validated; legacy JSONC files are not read. Results use
  `tasks:<id>` identities.
- **Incremental semantics for Tasks and saved Session names**: On an explicit
  `project_search` in `hybrid` or `semantic` mode, reuse existing and fill
  missing vectors in the project-owned `.pi/search/index.sqlite` under
  `pix_task_*` and `pix_session_*`, independently controlled by user-global
  `search.tasksSemanticEnabled` and `search.sessionTitlesEnabled` in
  `~/.config/pi/pix-desktop.jsonc`. These are the *same* consents and vectors
  as Desktop Global Search, not another TUI semantic-index preference or index.
  Task input is precisely the title+description projection capped at 2,000
  characters. Only current task ID + text-content-hash matches are eligible.
  Saved session titles require an authenticated ACP session-map record,
  matching native JSONL path, explicit `namedTitle`, indexed ACP session ID,
  title hash and current Pi `session_info` name. A first-message fallback is
  never treated as an explicitly saved session name. Records changed or
  deleted during provider latency are rechecked and discarded.
- If and only if the appropriate checkbox is explicitly enabled and a saved
  shared `openrouter` API-key credential is available, **missing task title +
  description or explicit session-name vectors** may be generated on demand,
  followed by one query embedding reused for both. Such content and the query
  are sent to OpenRouter and may incur fees. Status, priority, task/session
  IDs, links, model assignments, transcript bodies and attachment metadata or
  bytes are not independently embedded. Existing task descriptions may of
  course contain user-authored sensitive text. Batch size is 16, with up to
  256 new task vectors and 256 explicitly named-session vectors per request;
  the indexing portion has a 40-second ceiling. A further search continues
  incomplete indexing and reports remaining work. SQLite `BEGIN IMMEDIATE`
  owns each bounded embedding batch so concurrent Desktop/agent searches do
  not pay for the same missing vector. Completed batches survive subsequent
  failures, while revoked consent, changed task text or a session rename
  rolls back the current batch. A missing cache is initialized only by an
  explicitly opted-in search. Index identity mismatches fail closed without
  deleting previously paid vectors. No implicit IDX setup, user-config edits,
  shared-credential writes or full-transcript indexing occur.
  `indexMode:"lexical"` (or `symbol` for history) never triggers semantic
  provider calls or indexing. The
  globally saved opt-ins also apply when an agent runs the tool in Pix TUI;
  users should turn them off in Desktop Settings if they want lexical-only
  search by default. The calling agent may still send returned excerpts to
  its own language model as part of normal operation.
- Commits search **HEAD ancestors**, not unrelated branches or all working-tree
  changes. Match subject, author, message, hash and changed file paths; report
  full hash for the existing Git Diff navigation. Results have bounded previews
  and do not include patch contents. Explicit `patch:<literal>` uses Git
  pickaxe on demand (max 50 matches, literal regex-escaped changed lines),
  skipping all non-commit sources. Normal Git metadata lookup examines at most
  **5,000** ancestors per call, with bounded process output and a 15-second
  command deadline. The tool never stores patches. In `hybrid`/`semantic`
  mode, selected HEAD-reachable commits are now **incrementally embedded**
  into Desktop's existing `pix_commit_*` tables with the project's already
  configured IDX provider, knowledge embedding model, prefix, vector dimension
  and identity. Commit subject, author and full message may be sent to the
  configured provider (including OpenRouter), incurring potential costs. Up
  to 256 new commit vectors are created per search in batches of 16 with a
  40-second indexing budget; subsequent searches resume using existing hashes.
  `HEAD` and embedding configuration are rechecked before committing paid
  batches and before publishing matches. Rewritten/unreachable commits are
  excluded from the current results. Missing config/key/provider leaves
  local Git matches intact. This does not create or migrate IDX code indexes.
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
  notices, never raw provider diagnostics. Work is bounded to a 60-second
  overall deadline with cancellation ownership; IDX commands also allow up to
  60 seconds, subject to that shared deadline. The agent receives **one final
  response**, not a stream of early results. Concurrent local and indexed
  source jobs are awaited, including on-demand semantic Tasks/Sessions/Commits when
  eligible; a slow source is omitted only at the deadline or on failure.
  Search returns a relevance-
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

- Local lexical sources never call a network model on their own. After
  independent user opt-in, task/session semantics may upload their **title and
  description or explicit saved name** as well as the search query; commit
  semantics may upload **commit subject, author and message** to the chosen
  IDX provider on an explicit Git search. No transcript bodies, task
  attachments, unrelated task metadata, patches or file contents are sent by
  these semantic sources. `indexMode:"lexical"` is the no-embedding opt-out.
  The **calling agent**
  may nevertheless send returned excerpts to its selected model provider as
  part of the ongoing conversation. Tool descriptions disclose this.
  IDX hybrid search may also send search queries to its already-selected
  embedding provider; lexical mode is the opt-out for embedding calls.
- No new full-transcript index, historical secret index or Git patch index is
  maintained. The tool does not read attachments, execute repository code,
  read or change Git config, or create IDX project setup files. An opted-in
  semantic search may create the project-owned `.pi/search/index.sqlite`
  and its namespace tables, but never changes `.pi/tasks.sqlite`.
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
- `external/pi-tools-suite/src/project-search/semantic.ts`
- `external/pi-tools-suite/src/project-search/semantic-cache.ts`
- `external/pi-tools-suite/src/project-search/semantic-provider.ts`
- `external/pi-tools-suite/src/project-search/semantic-index-writer.ts`
- `external/pi-tools-suite/src/project-search/semantic-task-indexer.ts`
- `external/pi-tools-suite/src/project-search/semantic-session-indexer.ts`
- `external/pi-tools-suite/src/project-search/semantic-commit-indexer.ts`
- `external/pi-tools-suite/src/project-search/semantic-commit-provider.ts`
- `external/pi-tools-suite/src/module-catalog.ts`
- `external/pi-tools-suite/src/index.ts`
- `external/pi-tools-suite/src/repo-discovery/index.ts`
- `external/pi-tools-suite/src/repo-discovery/subagent.ts`
- `external/pi-tools-suite/src/async-subagents/core/child-tools.ts`
- `external/pi-tools-suite/test/evals/coverage-manifest.ts`

## Tests

- `external/pi-tools-suite/test/project-search.test.ts`
- `external/pi-tools-suite/test/project-search-semantic.test.ts`
- `external/pi-tools-suite/test/config.test.ts`
- `external/pi-tools-suite/test/module-loader.test.ts`
- `external/pi-tools-suite/test/evals/extension-contracts.test.ts`
- `external/pi-tools-suite/test/async-subagents/repo-tools.test.ts`
