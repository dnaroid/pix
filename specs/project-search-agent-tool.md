---
kind: spec
status: active
---

# Project-wide search for Pi agents

## Goal

Expose project history and native repository search to the Pi agent
through a single bounded `project_search` tool. Use the same project data
sources and project-owned search-cache tables as Desktop Universal Search,
without duplicating a persistent index or invoking a second answer LLM/Jev.
Authoritative project task/session/Git state remains read-only; explicit
semantic searches may update source-local SQLite stores under explicit global provider configuration.
Native Code/Knowledge uses disposable `.pi/search/code.sqlite` and `.pi/search/knowledge.sqlite` stores;
see [native repository search](native-repository-search.md) and [0065](../docs/decisions/0065-native-repository-search.md).

## Behavior

- `project-search` is a default-enabled module in the bundled pi-tools-suite
  catalog. It registers one `project_search` tool in ordinary Pi with the suite, the main Pix TUI and
  Desktop agent extension runtimes, without a project-index registration gate.
  No external index setup commands, RAG generation or writes
  to canonical task/session/Git data occur. Search-cache writes are limited
  to selected semantic sources and the native file cache at explicit search time, never background work.
- Required `query` is a nonempty string of at most 2,048 characters.
  `sources` optionally selects unique values from `sessions`, `tasks`,
  `commits`, `code`, and `knowledge` (all five by default).
  `limit` is 1–20 (default 10). `indexMode` is `hybrid` (default),
  `semantic`, or `lexical`. Code and Knowledge always use the native backend.
  `hybrid`/`semantic` additionally permit creating and querying missing
  task/session-name/commit vectors under the shared global provider
  prerequisites. `lexical` disables **all** embedding calls/writes, but not native file-index refresh,
  and a search call never changes configuration.
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
  row. Without valid global semantic configuration the agent's task source remains
  entirely local and lexical. Redirected (symlinked)
  `.pi` directories/database files are rejected. The SQLite schema and task
  payloads are strictly validated; legacy JSONC files are not read. Results use
  `tasks:<id>` identities.
- **Incremental semantics for Tasks and saved Session names**: On an explicit
  `project_search` in `hybrid` or `semantic` mode reuses existing vectors in
  the project-owned source-local history databases under
  `pix_task_*` and `pix_session_*`, using the global
  `~/.config/pi/pi-tools-suite.jsonc` `search.embedding` configuration. These use the
  same provider identity and vectors as Desktop Global Search, without
  another TUI preference, source opt-ins or a duplicate index.
  Task input is precisely the title+description projection capped at 2,000
  characters. Only current task ID + text-content-hash matches are eligible.
  Saved session titles require the current Pi `session_info` name plus matching
  native session header ID and project cwd. Ordinary Pi/TUI names use the native
  session ID without requiring an ACP map. Mapped Desktop sessions additionally
  require an authenticated ACP session-map record, matching native JSONL path,
  explicit `namedTitle`, indexed ACP session ID and title hash. A first-message fallback is
  never treated as an explicitly saved session name. Records changed or
  deleted during provider latency are rechecked and discarded.
- When the global provider is configured and required credentials are available,
  saved task title+description vectors are maintained at session startup and on
  debounced task-store changes (including external writes, WAL changes, creation,
  replacement and deletion). Work drains in bounded batches without waiting for
  a search; unchanged semantic text reuses its vector, including status/link-only
  edits. Workspace lifecycle and provider changes cancel stale work. Disabling
  semantics retains cached vectors and stops new provider calls; failed provider
  work does not spin in an automatic retry loop.
  Task queries rank current matching cached vectors, never initiate missing
  task-document embeddings. Explicit session-name vectors may still be generated
  on demand, followed by one query embedding reused for both. Such content and the query
  are sent to that provider and may incur fees. Status, priority, task/session
  IDs, links, model assignments, transcript bodies and attachment metadata or
  bytes are not independently embedded. Existing task descriptions may of
  course contain user-authored sensitive text. Query-driven session indexing uses
  batches of 16, up to 256 explicitly named-session vectors per request, and a
  40-second indexing ceiling. A further search continues incomplete session
  indexing and reports remaining work. Renewable source claims own each bounded
  embedding batch so concurrent Desktop/agent searches do not pay for the same
  missing vector; SQLite write transactions do not span provider latency. Completed batches survive subsequent
  failures, while removed/changed configuration, changed task text or a session rename
  rolls back the current batch. A missing cache is initialized only by an
  active task synchronization, explicit manual indexing or an explicitly submitted session search with valid configuration.
  Index identity mismatches fail closed without
  deleting previously paid vectors. No implicit external-backend setup, user-config edits,
  shared-credential writes or full-transcript indexing occur.
  `indexMode:"lexical"` never triggers semantic
  provider calls or indexing. The
  global configuration also applies when an agent runs the tool in ordinary Pi or Pix TUI.
  The calling agent may still send returned excerpts to
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
  into Desktop's existing `pix_commit_*` tables using the repository embedding
  configuration and `OPENROUTER_API_KEY`, model, prefix, vector dimension
  and identity. Commit subject, author and full message may be sent to the
  configured provider (including OpenRouter), incurring potential costs. Up
  to 256 new commit vectors are created per search in batches of 16 with a
  40-second indexing budget; subsequent searches resume using existing hashes.
  `HEAD` and embedding configuration are rechecked before committing paid
  batches and before publishing matches. Rewritten/unreachable commits are
  excluded from the current results. Missing config/key/provider leaves
  local Git matches intact. This does not create or migrate legacy code indexes.
- Code and Knowledge default to the shared [native lexical/semantic backend](native-repository-search.md),
  without credentials, incrementally updating the source-local native search stores.
  Results include safe project-relative paths, inclusive line ranges and bounded excerpts.
  No external search setup, fallback, or provider migration is allowed. Native `hybrid`/`semantic`
  may embed scoped chunks and queries only when `~/.config/pi/pi-tools-suite.jsonc`
  contains a valid `search.embedding` object, using the shared provider configuration and
  source-local Code/Knowledge stores.
  Up to 128 new chunks per search are indexed; incomplete coverage is reported and later
  searches resume. Provider failures retain local results with a notice. `lexical` makes
  no embedding calls. Symbol ranking is not supported.
  The suite's `/search-semantic status|configure <embedding JSON>|off` command manages
  the same global configuration in ordinary Pi without Desktop. Configuring it needs
  no separate confirmation; that object itself enables semantics for all sources/projects.
  Desktop's native Settings Search editor saves/removes the same file without ACP.
  Legacy `.pi/search/semantic.json` and Desktop semantic booleans are ignored; credentials
  and caches alone never activate semantics. OpenRouter credentials use
  `OPENROUTER_API_KEY`, then shared Pi auth storage; Ollama requires no key. `pathPrefix` is a safe project-relative
  directory/file scope.
  `maxFiles` (1–50) limits candidates per domain,
  defaulting to three with no inline content or one when `includeContent`
  is enabled. Combined final results remain capped at 20. Native supports
  `dedupeFile`, `excludeTests`, `includeTests`, and `includeContent`; test filters
  are mutually exclusive. `chunkTypes`, `minScore`, `includeImports`,
  `dedupeSymbol`, and `cluster` are not supported tool options.
- Federation isolates missing/unavailable sources with short controlled
  notices, never raw provider diagnostics. Work is bounded to a 60-second
  overall deadline with cancellation ownership. The agent receives **one final
  response**, not a stream of early results. Concurrent local and indexed
  source jobs are awaited, including cached semantic Tasks and on-demand Sessions/Commits when
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
  history before treating them as definitive. Former `repo_context`,
  `repo_inspect`, `repo_audit`, and `repo_search` tools are not registered.
  `project_search` is the sole project retrieval tool; broad contract discovery
  uses appropriate sources and is verified against authoritative files.

## Privacy and security

- Local lexical sources never call a network model on their own. With an
  explicitly configured global provider, task/session semantics may upload their **title and
  description or explicit saved name** as well as the search query; commit
  semantics may upload **commit subject, author and message** to that provider
  on an explicit Git search. No transcript bodies, task
  attachments, unrelated task metadata, patches or file contents are sent by
  these semantic sources. `indexMode:"lexical"` is the no-embedding opt-out.
  The **calling agent**
  may nevertheless send returned excerpts to its selected model provider as
  part of the ongoing conversation. Tool descriptions disclose this.
  The globally configured provider handles permitted semantic requests;
  lexical mode is the opt-out for embedding calls.
- Global semantic configuration applies across projects and sources (including eligible
  code/document chunks, paths/headings and queries) in Desktop/TUI/ACP and ordinary Pi.
  Removing/changing it suppresses stale work; incompatible paid vectors remain local-only.
  History stores remain separately owned; legacy data/settings are not migrated.
- No new full-transcript index, historical secret index or Git patch index is
  maintained. The tool does not read attachments, execute repository code,
  read or change Git config, or create external search setup files. A configured
  semantic search may create the corresponding source-local database
  and its namespace tables, but never changes `.pi/tasks.sqlite`.
- Input schemas bound result counts, paths and request size. Git subprocesses
  run without a shell and without inherited `GIT_*` overrides; external
  errors and secrets are not returned in source notices.
- All callers, including async/provider/council children, receive the same full
  schema and execution. There is no child-only source or query restriction.
  Children suppress suite setup commands and parent orchestration guidance only;
  ordinary work-tool restrictions remain independent.
  Repository embeddings use the shared global configuration and provider.

## Related contracts

- [Desktop Universal Search](desktop-universal-search.md)
- [Native repository discovery](repo-knowledge-agent-workflow.md)
- [Async subagent tool access](async-subagents.md)

## Manual indexing in Pi/TUI

- `/search-index code|knowledge|sessions|tasks|commits` starts document-only
  indexing for that source in the current project, returning immediately so the
  user can inspect status or cancel. `/search-index all` starts these five sources
  independently. Settings is deliberately excluded.
- `/search-index status` (also the no-argument default) reads stored item/vector
  counts without initializing caches or contacting the provider, and reports this
  session's run states. Stored counts are **not** current corpus coverage, freshness
  or model compatibility; other sessions' in-flight runs are not enumerated.
- `/search-index cancel [source|all]` requests cancellation of this session's runs
  (all by default). Same-source starts remain deduplicated until actual settlement,
  including the stopping phase. Session replacement/shutdown cancels owned work,
  waits for settlement and suppresses stale UI updates.
- Manual runs use the existing global provider configuration and may incur charges;
  `/search-semantic` remains the configuration command. There is no dummy query or
  query embedding. Missing provider configuration/credentials yields an incomplete
  result rather than silently installing or changing anything.
- Code/Knowledge use the native document-only subprocess. History writers reuse
  source-local stores and the shared source/provider lease protocol. Manual work
  drains missing vectors in batches of at most 16 without the query-only 128/256
  vector limits or overall search deadline. Provider HTTP and individual Git
  command deadlines remain. Commits page the full pinned HEAD ancestry, checking
  HEAD before/after paid batches. Sessions index eligible explicit saved names,
  never transcript bodies. Tasks use the canonical title/description projection.
- Completed batches survive cancellation/failure; unchanged text reuses paid
  vectors. Explicit reruns reset the interrupted-provider failure budget and
  continue missing work. Identity mismatches remain fail-closed, retaining cached
  vectors. One source failure does not cancel other requested sources.

## Implementation

- `external/pi-tools-suite/src/project-search/index.ts`
- `external/pi-tools-suite/src/project-search/index-command.ts`
- `external/pi-tools-suite/src/project-search/index-runner.ts`
- `external/pi-tools-suite/src/project-search/index-status.ts`
- `external/pi-tools-suite/src/project-search/native.ts`
- `external/pi-tools-suite/src/project-search/source-work.d.mts`
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
- `external/pi-tools-suite/src/repo-discovery/subagent.ts`
- `external/pi-tools-suite/src/async-subagents/core/child-tools.ts`
- `external/pi-tools-suite/test/evals/coverage-manifest.ts`

## Tests

- `external/pi-tools-suite/test/project-search.test.ts`
- `external/pi-tools-suite/test/search-index-command.test.ts`
- `external/pi-tools-suite/test/search-index-runner.test.ts`
- `external/pi-tools-suite/test/native-project-search.test.ts`
- `external/pi-tools-suite/test/project-search-semantic.test.ts`
- `external/pi-tools-suite/test/config.test.ts`
- `external/pi-tools-suite/test/module-loader.test.ts`
- `external/pi-tools-suite/test/evals/extension-contracts.test.ts`
- `external/pi-tools-suite/test/async-subagents/repo-tools.test.ts`
