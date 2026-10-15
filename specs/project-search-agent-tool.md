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
Search indexing writes selected metadata-only diagnostics to the **shared Pix
JSONL logger** at `~/.config/pi/logs/` (`search.index` module). The old
`.pi/artifacts/search-diagnostics-*/events.jsonl` writer is retired: no search
code opens an independent diagnostic file. Each host uses the in-process Pix
sink; standalone Pi remains functional when that optional sink is absent.
Normal starts, per-session successful/empty passes, cancellation and five-second
provider-wait heartbeats are not written. Failed and incomplete index passes
include bounded counts (checked/skipped sessions, discovered/cached chunks,
saved vectors, provider calls), elapsed duration, fixed execution phase and
allowlisted error type/OS/SQLite code. A successful pass that saved vectors is
`debug`-only. Skipped transcripts emit a rate-limited warning with a fixed
reason and safe code; raw session IDs, file paths, parent/child IDs, provider
messages, prompts and document text never enter these events. The separate
user-requested manual result retains existing bounded skip details for the
current action, without building a Desktop Activity history.

Background session synchronization normally rechecks cross-host inactivity after
30 seconds. If a worker throws or finishes with an operationally incomplete
index (e.g. an unreadable transcript), periodic recovery backs off to 2, 4, 8,
then at most 15 minutes instead of retrying every 30 seconds. Deferred or
not-yet-mature sessions do not trigger failure backoff. A fresh session or
source change can trigger a debounced earlier retry; explicit manual
Index/Continue is unaffected. Generic background-worker errors generate
`search:background-failed` (warn), tagged with a fixed phase, error category
and allowlisted OS/SQLite code; repeated causes are coalesced for five minutes
with a suppressed count. Per-session failures use the same safe categories
without including session IDs. Ordinary cancellations, including a deliberate
change to the enabled search sources, are not warnings. Invalid or unreadable
source policies remain operational failures.

The background idle-session selection reads activity/lease metadata in one
SQLite connection per candidate sweep instead of reopening the source database
for each session. This metadata snapshot only filters candidates: immediately
before provider requests and final publication, current activity and source
policy are rechecked. Manual TUI/CLI session indexing first reconciles public
transcript metadata and chunks, then authenticates and embeds explicit saved
names against that updated index. A cold first pass must not silently omit
saved-name vectors and require a second Continue to populate them.


- `project-search` is a default-enabled module in the bundled pi-tools-suite
  catalog. It registers one `project_search` tool in ordinary Pi with the suite, the main Pix TUI and
  Desktop agent extension runtimes, without a project-index registration gate.
  No external index setup commands, RAG generation or writes
  to canonical task/session/Git data occur. Search-cache writes are limited
  to source-local caches. Tasks and public session messages also synchronize in the background.
- Required `query` is a nonempty string of at most 2,048 characters.
  Project-local source selection is shared with Desktop through
  `.pi/search-sources.json` (version 1, full boolean `enabled` map). A missing
  file enables **Code only** among the five project sources; malformed or unsafe policy fails
  closed. The tool's available-source description, prompt guidance and parameter
  schema track the enabled sources dynamically. `sources` optionally selects
  unique enabled values from `sessions`, `tasks`, `commits`, `code`, and
  `knowledge` (all enabled tool sources by default, initially Code only).
  Settings is a Desktop-only source, never a tool parameter choice. Explicit
  requests for disabled sources are skipped without dispatch. Disabling a source cancels/rejects stale work and
  retains its caches for reuse if re-enabled. Global embedding configuration
  remains unchanged and cannot override project selection.
  `limit` is 1–20 (default 10). `indexMode` is `hybrid` (default),
  `semantic`, or `lexical`. Code and Knowledge always use the native backend.
  `hybrid`/`semantic` additionally permit querying maintained task/session-name/session-message
  vectors and bounded creation/querying of commit and native repository vectors under
  the shared global provider prerequisites and project source policy. Task/session
  queries never backfill missing document vectors. `lexical` disables **all** embedding calls/writes, but not native file-index refresh,
  and a search call never changes configuration.
  Optional `projectPath` names an explicit alternate project directory,
  resolved relative to session cwd (also accepting absolute and `~/` paths);
  it does not change session cwd. The project directory must exist.
- Session queries use the local SQLite index only: cached titles/snippets plus
  lexical/semantic public-message chunks. They do not discover sessions by
  reading JSONL on the query path. Freshness validation is stat-only; a changed
  or missing file is excluded until eligible background indexing refreshes its
  cache. Existing caches without the indexed-file/range records require a
  background index backfill; queries do not fall back to scanning transcripts.
  Chunk byte offsets/lengths address the serialized JSONL message record, while
  text start/end offsets are UTF-16 positions in sanitized projected text.
  Cached sanitized snippets provide result text, so no query-time range reader
  is required. In addition to saved titles and first/final excerpts, search covers
  public user/assistant text on the last persisted parent-linked JSONL branch.
  Tool outputs, thinking, attachments and abandoned branches are excluded.
  `pix-html` fences and their `html-sandbox` alias count as attachments in both
  user and assistant text: remove the fence/source before chunking, embedding and
  first/final excerpt extraction. Keep surrounding prose, ordinary code fences,
  nested Markdown examples and inline mentions. Unclosed attachment fences exclude
  the remaining message text. Attachment-only messages preserve ancestry but have
  no chunks; UTF-16 offsets refer to the projected text. Desktop RAG uses this same
  projection before evidence budgeting. Canonical transcripts are never rewritten.
  Projection-versioned revisions refresh existing cached text on synchronization;
  live retrieval cannot reuse removed chunks, while unchanged prose hashes reuse
  compatible paid vectors.
  Native header ID and project cwd authenticate each file; unsafe/corrupt files
  fail closed. Message chunks are UTF-16-safe, at most 1,600 characters, with
  message ID, role, order and offsets. Up to **1,000** sessions are inspected per
  query; full-message reading skips files over 64 MiB or records whose combined
  public text exceeds 1,048,576 UTF-16 characters (never truncated). Large JSONL
  records containing images, thinking or tool data are parsed fully in a cancellable
  worker (30-second deadline per large record), retaining only ancestry and public text; the excluded
  payload is not indexed or embedded. Small records parse locally. Malformed JSON,
  worker failures/timeouts, cycles and missing parents still fail closed. Missing
  parents are never repaired by assuming the preceding physical line is the parent.
  Results remain session-level with native ID/path and a bounded matching snippet.
  Local lexical retrieval does not require a database or provider. The common
  chunk/vector namespace in `.pi/search/sessions.sqlite` is shared with Desktop,
  not duplicated into a TUI-only store.
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
- **Incremental semantics for Tasks, Session names and public messages**: An explicit
  `project_search` in `hybrid` or `semantic` mode reuses existing vectors in
  the project-owned source-local history databases under
  `pix_task_*`, `pix_session_*` and session-chunk tables, using the global
  `~/.config/pi/pi-tools-suite.jsonc` `search.embedding` configuration. These use the
  same provider identity and vectors as Desktop Global Search, without
  another TUI-only preference or duplicate index. The shared project source-selection
  policy still applies independently of global embedding authorization.
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
  task-document embeddings. Session queries likewise rank existing title/message
  vectors without generating missing document vectors; one query embedding is
  reused across eligible sources. Indexed session content and the query
  are sent to that provider and may incur fees. Status, priority, task/session
  IDs, links, model assignments and attachment metadata or
  bytes are not independently embedded. Existing task descriptions may of
  course contain user-authored sensitive text. Automatic and manual session indexing
  use batches of at most 16. Renewable source claims own each bounded
  embedding batch so concurrent Desktop/agent searches do not pay for the same
  missing vector; SQLite write transactions do not span provider latency. Completed batches survive subsequent
  failures, while removed/changed configuration, changed task text or a session rename
  rolls back the current batch. A missing cache is initialized only by an
  active task synchronization, eligible idle-session synchronization or explicit
  manual indexing with valid configuration.
  Index identity mismatches fail closed without
  deleting previously paid vectors. No implicit external-backend setup, user-config edits,
  shared-credential writes occur.
  `indexMode:"lexical"` never triggers semantic
  provider calls or indexing. The
  global configuration also applies when an agent runs the tool in ordinary Pi or Pix TUI.
  The calling agent may still send returned excerpts to
  its own language model as part of normal operation.
- All production session discovery (search, manual and background) admits a
  session only at least **24 hours from creation**. Creation time is the native
  filename timestamp, else a bounded imported-session header timestamp, then
  filesystem birthtime; modification time is never an age fallback. Young entries
  retain only minimal age metadata and are not hydrated for title/body. Automatic
  saved-title and public-message indexing additionally waits for **one hour of
  inactivity per session**. Transcript modification time and persisted runtime
  activity determine eligibility; new activity restarts only that session's delay.
  A running agent blocks its session, with renewable cross-host running leases.
  Startup resumes from persisted activity rather than starting a fresh hour;
  metadata-only checks run approximately every 30 seconds. Automatic discovery
  uses directory/file metadata and a bounded 16 KiB native identity header read
  for new or changed files, not SDK full-transcript listing. Unchanged files reuse
  their header cache; title/body hydration occurs only after idle revision selection.
  The shared source's exhausted retry budget pauses discovery until Continue;
  a budget exhausted during a sweep stops the remaining candidates.
  Other idle sessions
  remain eligible while one session is active. Existing matching cached vectors
  remain searchable during the delay; queries do not bypass it or initiate
  document embeddings. Manual `/search-index sessions` bypasses the idle delay
  only, not the 24-hour creation minimum. Mature-file changes use directory events
  coalesced into dirty paths, bootstrap plus bounded five-minute missed-event
  reconciliation, and maturity deadlines that admit sessions even without events.
  One-shot CLI discovery fully reconciles. Optional ACP snapshot requests can
  warm the digest from a bounded 1.5-second session snapshot; ACP reconnect falls
  back to native metadata. Source digests cover mature file revisions and mature
  mapped title/id aliases. Session-index logical revision is trigger-maintained
  and commit-coupled across title, metadata, chunk and vector content tables; work
  heartbeat, FTS, WAL and VACUUM changes do not affect it. Legacy caches remain
  read-only during status, with a bounded metadata fingerprint until a writer
  installs tracking. Shared CLI/Desktop receipts use the updated fingerprint;
  old receipts require a new pass.
  A configured provider authorizes upload of both
  existing and new public text, including unnamed sessions. Tool/thinking/image
  blocks are excluded. Shared source leases and model/content hashes prevent
  duplicate paid chunk work across hosts; revisions and authorization are checked
  again after provider latency, including idle eligibility before publication.
  Automatic/manual indexing drains work in batches of 16.
  Failed unchanged background revisions do not spin; `/search-index sessions` explicitly
  continues it. Configuration removal, session replacement and shutdown
  invalidate old work. These caches do not modify canonical JSONL files.
- Session background sweeps persist one successful **start-time watermark** in
  `pix_session_sweep` inside `.pi/search/sessions.sqlite`, not a per-file manifest.
  Only a fully successful title/chunk pass advances it; failed, cancelled,
  unreadable or deferred work cannot be certified by suppressing its retry.
  After restart, automatic selection skips old unchanged transcript bodies using
  file mtime/ctime, activity, mapped-title update time and the creation + 24-hour
  admission deadline, with a two-second conservative timestamp overlap.
  Discovery/query candidate lists remain complete; only indexing work is filtered.
  Metadata enumeration, bounded identity headers and eligibility checks still run.
  The checkpoint is bound to embedding identity and logical cache incarnation/revision;
  mismatch or a backwards clock forces a full eligible sweep. Partial cache writes
  may invalidate the prior cutoff, conservatively requiring another sweep.
  Manual Index/Continue remains a full repair path and seeds the same watermark
  only on full success. One pending mature session can hold back the whole scalar
  watermark; successful unchanged attempts are reused in memory meanwhile.
- Native Code/Knowledge search failures report source-specific notices without
  suggesting that an external backend or repository-index setup is required.
  Semantic Tasks with no matching indexed vectors remain pending for manual
  indexing; a query never backfills task documents.
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
  `maxFiles` (1–50) limits distinct returned native files per domain at the final
  result stage; candidate chunks remain available through ranking/reranking,
  defaulting to three with no inline content or one when `includeContent`
  is enabled. Combined final results remain capped at 20. Native supports
  `dedupeFile`, `excludeTests`, `includeTests`, and `includeContent`; test filters
  are mutually exclusive. `chunkTypes`, `minScore`, `includeImports`,
  `dedupeSymbol`, and `cluster` are not supported tool options.
- Optional global `search.rerankerModel` enables one shared rerank of up to 100
  source-balanced Sessions/Tasks/Commits/Code/Knowledge candidates for nonlexical searches,
  before native per-domain caps and the final result limit. Settings are not included.
  History sends bounded titles/snippets, not whole sessions or diffs. Pure lexical requests
  remain local; provider failure retains original ranking with a redacted notice.
  See [reranking safeguards](native-repository-search.md#optional-reranking).
- Federation isolates missing/unavailable sources with short controlled
  notices, never raw provider diagnostics. Work is bounded to a 60-second
  retrieval deadline with cancellation ownership, plus bounded reranker preparation/finalization
  when configured. The agent receives **one final
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
  explicitly configured global provider, task/session semantics may upload task **title and
  description**, explicit saved session names and public user/assistant session-message text,
  as well as the search query; commit
  semantics may upload **commit subject, author and message** to that provider
  on an explicit Git search. Tool outputs, thinking blocks, attachments, unrelated
  task metadata, patches or file contents are not sent by
  these semantic sources. `indexMode:"lexical"` is the no-embedding opt-out.
  The **calling agent**
  may nevertheless send returned excerpts to its selected model provider as
  part of the ongoing conversation. Tool descriptions disclose this.
  The globally configured provider handles permitted semantic requests;
  lexical mode is the opt-out for embedding calls.
- Global Settings search is a Desktop-only source backed by
  `~/.config/pi/search/settings.sqlite`; the headless `project_search` tool does
  not expose Settings. Its enable flag is shared across projects, defaults true,
  and is stored separately in `settings-enabled.json`. Settings catalogue values
  are never indexed; only the authored metadata catalogue is eligible for the
  shared index. Settings run coordination is global, while this tool's other five
  source caches and manual-run records remain project-local. Compatible schema-2
  legacy project Settings vectors may be imported only in an owned transaction
  after configured identity validation; read-only legacy stores are never changed
  or deleted, incompatible identity/schema is skipped, and corrupt compatible
  data aborts atomically. Global Settings vectors persist by content hash across
  catalogue versions, with retrieval filtered against each caller's authored
  catalogue.
- Global semantic configuration applies across projects and sources (including eligible
  code/document chunks, paths/headings and queries) in Desktop/TUI/ACP and ordinary Pi.
  Removing/changing it suppresses stale work; incompatible paid vectors remain local-only.
  History stores remain separately owned; no legacy data is migrated except the
  compatible project-local schema-2 Settings-vector import described above.
- No new full-transcript index, historical secret index or Git patch index is
  maintained. The tool does not read attachments, execute repository code,
  read or change Git config, or create external search setup files. A configured
  semantic search may create the corresponding source-local database
  and its namespace tables, but never changes `.pi/tasks.sqlite`.
- Input schemas bound result counts, paths and request size. Git subprocesses
  run without a shell and without inherited `GIT_*` overrides; external
  errors and secrets are not returned in source notices.
- All callers, including async/provider/council children, receive the same full
  schema and execution, subject to the same project-enabled source choices; the
  schema does not expose disabled sources. There is no additional child-only
  source or query restriction.
  Children suppress suite setup commands and parent orchestration guidance only;
  ordinary work-tool restrictions remain independent.
  Repository embeddings use the shared global configuration and provider.

## Related contracts

- [Desktop Universal Search](desktop-universal-search.md)
- [Native repository discovery](repo-knowledge-agent-workflow.md)
- [Async subagent tool access](async-subagents.md)

## Manual indexing in Pi/TUI

For a standalone shell (no Desktop or running Pi session), use
`npm run search:index -- <status|check|index|continue|stop> [source|all] [--project PATH]`
from the checkout. This separate controller supports all six sources, including
Settings, and shares manual run results/freshness with Desktop through
  project-local manual-run records in `.pi/search/manual-runs.sqlite` (Settings
  run records and source-work coordination are global). Index/continue require an explicit target and
may incur configured provider charges; `all` runs enabled sources sequentially.
Status/check are local read-only diagnostics. `enable <source>` and
`disable <source>` explicitly change the existing project source policy without
indexing. See [standalone control](desktop-search-index-status.md#standalone-control)
for cancellation, lease, exit-code and freshness semantics. The session-owned
slash commands below retain their existing lifetime and parallel behavior.

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
  HEAD before/after paid batches. Sessions index eligible explicit saved names and
  projected public user/assistant message chunks, never tool outputs, thinking or
  attachment bodies. Tasks use the canonical title/description projection.
- Completed batches survive cancellation/failure; unchanged text reuses paid
  vectors. Explicit reruns reset the interrupted-provider failure budget and
  continue missing work. Identity mismatches remain fail-closed, retaining cached
  vectors. Session indexing includes public user/assistant message chunks as well
  as eligible saved names; its stored item count is not current transcript coverage.
  One source failure does not cancel other requested sources.

## Implementation

- `external/pi-tools-suite/src/project-search/session-index-progress.mjs`
- `external/pi-tools-suite/src/project-search/session-read-cache.mjs`
- `external/pi-tools-suite/src/project-search/native-ranking.mjs`
- `external/pi-tools-suite/src/project-search/reranker-documents.mjs`
- `external/pi-tools-suite/src/project-search/session-index-progress.d.mts`
- `external/pi-tools-suite/src/project-search/session-chunks.mjs`
- `acp/src/search/session-index-progress.js`
- `acp/src/search/session-index-progress.d.ts`
- `acp/src/search/session-chunks.js`
- `acp/src/search/session-chunks.d.ts`
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

- `acp/test/session-index-progress.test.ts`
- `acp/test/session-chunks.test.ts`
- `external/pi-tools-suite/test/project-search.test.ts`
- `external/pi-tools-suite/test/search-index-command.test.ts`
- `external/pi-tools-suite/test/search-index-runner.test.ts`
- `external/pi-tools-suite/test/native-project-search.test.ts`
- `external/pi-tools-suite/test/project-search-semantic.test.ts`
- `external/pi-tools-suite/test/config.test.ts`
- `external/pi-tools-suite/test/module-loader.test.ts`
- `external/pi-tools-suite/test/evals/extension-contracts.test.ts`
- `external/pi-tools-suite/test/async-subagents/repo-tools.test.ts`
