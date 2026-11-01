---
kind: spec
status: active
title: Native repository Code and Knowledge search
---

# Native repository Code and Knowledge search

## Goal / scope

One native Code/Knowledge backend for ordinary Pi/TUI/ACP/Desktop `project_search`,
with no external-backend dependency, fallback, command, install/update, panel, or settings. Native
lexical retrieval needs no credentials. Explicit global provider configuration itself
authorizes semantic retrieval for every project and source. Credentials use
`OPENROUTER_API_KEY`, then the shared Pi auth store. Existing legacy configuration is not migrated or modified.
Repository semantic/commit embeddings use this credential path; do not read
unrelated legacy configuration or migrate providers as part of a search task.
Persistence/process rationale: [0066](../decisions/0066-native-repository-semantic-search.md),
building on [0065](../decisions/0065-native-repository-search.md). Global authorization:
[0068](../decisions/0068-global-semantic-configuration.md). Source ownership and
uncertain-work recovery: [0070](../decisions/0070-search-source-work-recovery.md).

Desktop [Wiki contradiction checks](../desktop/workbench/desktop-project-wiki.md#contradiction-checks)
reuse this engine in hybrid mode, scoped to Knowledge and the selected project's
configured Wiki. Their separate sessionless contradiction judge uses verified
source passages after retrieval and independent `knowledgeCheck.modelRef` /
`knowledgeCheck.thinking` settings, not Search RAG preferences. The Wiki spec defines the save/report flow,
completion rules and budgets; ordinary native retrieval keeps its existing
source/provider configuration and performs no answer generation.

## Canonical behavior

- The shared engine lives in the default-enabled bundled tools-suite module and works
  in ordinary Pi without Pix or Desktop registration. Its CLI takes a selected canonical
  workspace path and bounded JSON stdin; both host adapters return the same typed hits:
  kind, id, title, snippet, score, project-relative path, inclusive 1-based start/end lines,
  and optional bounded content. Desktop retains normal navigation, ranking and RAG evidence
  revalidation. The agent retains its federated source/result caps.
  The optional `status.completeForSelection` distinguishes successful snapshot
  and configured retrieval-stage completion from ordinary candidate/output caps;
  existing `status.complete` retains its conservative meaning. `limitNotices`
  identifies benign selection-limit messages while retaining them in `notices`
  for existing clients. Stale scans, generation changes, incomplete semantics and
  configured-reranker failures cannot produce a true selection-completion flag.
  Release payloads include the engine source and its `ignore` parser as a locked root
  production dependency: the standalone CLI must not rely on the checkout's suite-local
  node_modules or a dependency nested inside the SDK.
- Native lexical search has no network work or credential requirement. Code and Knowledge
  refresh separate `.pi/search/code.sqlite` and `.pi/search/knowledge.sqlite` stores
  (and SQLite sidecars); semantic vectors are published in those same source-local stores.
  The six source databases are `code.sqlite`, `knowledge.sqlite`, `settings.sqlite`,
  `sessions.sqlite`, `tasks.sqlite` and `git-commits.sqlite`. Legacy `index.sqlite`,
  `files.sqlite`, `file-vectors.sqlite` and `commits.sqlite` are not imported, migrated,
  or used as fallbacks. On first use, only those four legacy database files and their
  SQLite sidecars are physically removed from this project; the six source databases
  are preserved. The shared Settings writer validates/creates only its global
  `~/.config/pi/search` ancestor directories and never scaffolds project `.pi` directories.
  Schema-1 Settings configuration is rejected without mutation.
- Files are enumerated under the selected root, using Git's tracked/unignored file list
  where available and a bounded walker with nested `.gitignore` otherwise. Internal caches,
  `.pi`, `.git`, `.indexer-cli` (protected legacy-data exclusion), dependency/build directories, linked/nonregular files,
  binary/invalid-UTF8 and oversized sources are excluded. Search is not a secret detector;
  eligible tracked text is searchable. Generated text not covered by ignores remains eligible.
- Recognized source/config formats become Code; Markdown/plain documentation formats become
  Knowledge, without mandatory frontmatter. Markdown headings define section boundaries;
  code and large sections use bounded overlapping line chunks. These are not AST symbols.
  Godot `.gd`, `.tscn`, `.tres`, `.godot`, `.gdshader`, and `.gdshaderinc` files are Code;
  the generated `.godot/` cache directory is excluded even when not ignored by Git.
- The global suite config `~/.config/pi/pi-tools-suite.jsonc` accepts optional
  `search.codeExtensions` and `search.knowledgeExtensions` arrays (at most 128 entries
  each). When present, each list completely replaces that category's built-in list;
  there are no automatic filename special cases. An explicit empty list disables that
  category, while an omitted list uses built-in defaults. Each entry is a simple suffix of
  1–32 letters/digits/underscore/plus/hyphen, starting with a letter/digit, with an
  optional leading dot. Case and dots are normalized; duplicates within a source are
  harmless. Paths, globs and compound suffixes are not supported. Cross-source
  overlap between the effective Code and Knowledge lists is an actionable configuration
  error, not a precedence rule. Invalid/unsafe settings retain the previous local snapshot
  without publication.
  Project-local config does not override these lists. All ignore, binary, size and
  link exclusions still apply. Changes take effect on the next explicit search/index
  scan: newly eligible files are added, removed suffixes disappear, and moving a
  custom suffix between sources rechunks unchanged bytes. Reordering equivalent
  lists does not cause rechunking. A mid-scan classification change prevents publication.
  Saving lists alone does not scan, clear purchased vectors or trigger embeddings.
- FTS5 tokenization normalizes case, Unicode, camel-case and punctuation. User text is
  tokenized and safely quoted rather than interpreted as raw FTS syntax. Identifier and
  camel/snake-case phrase candidates are reserved before broad prefix matches; retrieval
  considers the first chunk from each file before alternate chunks. File/heading terms
  carry extra BM25 weight. Stable path/line ties, source filters, test filters, file dedupe,
  `pathPrefix` and bounded excerpts are supported.
- Explicit searches scan/hash current eligible files but rechunk and rewrite only changed
  hashes. Deleted/renamed/ignored files disappear in the next successful publication.
  There is no watcher, automatic provider setup or background embedding daemon.
- Each process reads a generation snapshot, scans without a writer lock, then publishes
  a short atomic SQLite transaction only if that generation still matches. A losing scanner
  must not overwrite a newer generation. Incomplete scans retain the prior snapshot and
  return freshness/completeness notices; no partial scan purges prior valid rows.
  Unchanged files use exact stored chunk counts, including Markdown heading splits;
  chunk-budget overflow retains searchable prior rows rather than failing publication.
  Paths observed missing during reads, including ignore files, are rechecked before
  marking the scan complete; delete/recreate races invalidate freshness.
- Native search has no external fallback. Empty results and failures are reported as native
  results/notices; no legacy index is queried.
- Every Pi caller, including async/provider/council children, receives the same
  unrestricted `project_search` schema and execution across sessions, tasks,
  commits, code and knowledge, including `patch:`. Children suppress suite setup
  commands and parent orchestration guidance only. Repository semantic embeddings
  use the same explicitly configured global provider. Removed `repo_*` tools are not
  part of ordinary search.

## Optional reranking

- The canonical global suite JSONC accepts optional `search.rerankerModel`, an OpenRouter
  reranker model ID (for example `voyageai/rerank-3-lite`). Empty/omitted or invalid values
  disable it. Project overrides, an API key alone, and legacy config do not enable it.
  Desktop's **Reranker model** field edits this same global draft and uses its normal Save;
  clearing the field removes the key. New default configs document it without enabling uploads.
- Saving a nonempty model authorizes sending the query and bounded eligible Code/Knowledge
  text plus Sessions/Tasks/Commits titles and snippets across projects in Pi/TUI/ACP/Desktop. Charges may
  apply. Credentials use `OPENROUTER_API_KEY`, then shared Pi auth. This permission is
  independent of `search.embedding`: hybrid/semantic queries can rerank local candidates
  without embeddings. Removing embeddings does not disable a separately configured reranker.
  Settings are excluded from remote reranking.
- Pure lexical agent/native queries and document indexing never invoke reranking.
  Desktop publishes local results first, then optionally reranks the merged selected
  Sessions/Tasks/Commits/Code/Knowledge results after all source operations complete,
  including late source replies. Embedding configuration is not required for this pass.
  `project_search` hybrid/semantic queries likewise use one shared pass before final limits.
  Up to 100 source-balanced candidates are sent once to
  `https://openrouter.ai/api/v1/rerank`. History uploads contain only titles (512 characters)
  and snippets (4096), never full sessions or diffs; native candidate content is capped
  at 7500 characters. Provider documents remain capped at 8192 UTF-8 bytes each, while
  the query plus all documents share a 32,000-byte UTF-8 budget. Native documents use
  query-focused excerpts and avoid duplicate path/title headers. Each candidate shares
  the remaining batch budget equally; truncated prefixes never split UTF-8 code points.
  Code and prose with explicit identifiers, numeric anchors or acronyms retain contiguous
  windows. Other prose uses extractive passages covering the whole question, or representative
  sentences when there is no literal overlap. Selected sentences retain source order and
  mark omissions with an ellipsis; this is not an answer-generation step.
  Knowledge documents may include an explicit leading `Document status:` label from the
  same hash-verified file used by freshness preflight. Only recognized leading `Status:`
  metadata is used (first 32 lines, before a level-two-or-deeper heading, excluding fenced
  examples); paths and incidental prose never imply status. The label shares the existing
  byte budget, does not filter archived documents and adds no index schema or separate scan.
  In-flight file changes still reject the ranking. Federated history that
  cannot be verified during preflight stays in local results but is excluded from the
  remote pool; verifiable candidates may still rerank with a partial notice. Revocation,
  cancellation or stale sent-pool validation falls back to local order.
  Candidate filters, deduplication and source policy apply before upload; native per-domain
  caps and the requested final result limit apply after reranking. Returned relevance order
  is preserved rather than re-sorted by local BM25. Desktop Settings retain their local slots.
  Standalone native requests retain their Code/Knowledge pass; federated callers set
  `skipRerank` and carry native freshness context to avoid double provider calls. Content upload does not
  depend on `includeContent`; that flag controls only the returned payload.
- Reranking has a four-second verification/slot/transport budget, bounded response size, no redirected
  provider requests and strict index/score validation. Missing credentials, timeout,
  provider errors and malformed responses retain original ranking with a redacted notice.
  Global provider concurrency slots span transport lifetime. Source policy, configured
  model, history source snapshots, native generation and current candidate bytes are checked around network work;
  stale snapshots are not reranked, changed context rejects late ranking, caller cancellation
  rejects the search. Periodic configuration/policy/generation checks cancel in-flight work;
  no native SQLite handle is retained across reranker transport. History snapshots are
  captured before retrieval and rechecked before upload and after transport. Desktop bounds
  preparation to four seconds and the final request to 4.5 seconds, discarding late replies
  even when an adapter ignores cancellation. CLI/Tauri `rerank` input is capped at 4 MiB
  for bounded Unicode documents; other operations retain their 16 KiB input cap.

## Optional semantic retrieval

- The sole provider configuration is `~/.config/pi/pi-tools-suite.jsonc` (`HOME`, then
  the operating-system home). Its valid explicit `search.embedding` object authorizes **all**
  sources/projects in ordinary Pi, TUI, ACP and Desktop. There are no separate project,
  task, session or settings opt-ins. Missing, malformed, oversized or redirected config
  fails closed to local retrieval. A key or existing vector cache alone does not enable
  semantics. Legacy project config and Desktop consent booleans are ignored, not migrated.
  JSONC comments and unrelated suite settings are preserved. Project suite overrides and
  the former standalone `semantic-search.json` do not authorize semantics and are not migrated.
  Removing the embedding object disables globally and cancels stale work, retaining caches.
  Saving configuration discloses upload/cost scope: eligible code/document chunks, paths,
  headings, queries, task title/descriptions, saved session names, commit metadata and
  settings metadata. Conversation bodies/attachments are not embedded. This is not a
  secret-detection guarantee; already transmitted bytes cannot be recalled.
- Read the optional `search.embedding` object in the global file: `embeddingProvider`,
  `embeddingModel`, optional `knowledgeEmbeddingModel`, `vectorSize`, `ollamaBaseUrl`,
  and `knowledgeEmbeddingQueryPrefix` / `knowledgeEmbeddingDocumentPrefix`. Do not read
  legacy `.indexer-cli/config.json` or `.env`; do not migrate settings or select a provider
  automatically. OpenRouter credentials use `OPENROUTER_API_KEY`, then an API key in
  shared Pi `auth.json` (`PI_CODING_AGENT_DIR`, otherwise `~/.pi/agent`); missing/invalid
  config/key/provider leaves local matches.
  Semantic mode needs saved compatible provider configuration, but neither mode requires
  a legacy `.indexer-cli` directory. Legacy configuration is never consulted.
- `/search-semantic status|configure <embedding JSON>|off|reset-history` is a suite user command in
  ordinary Pi and Pix TUI. `configure` saves the explicitly supplied provider/model/dimension
  and displays the upload/cost disclosure without another consent question. Desktop offers
  equivalent configuration under Tools Suite → Search, using the existing suite draft and
  top Save button, without requiring ACP. The provider uses a custom selector. Search
  indices → Configure in Settings opens and focuses the Embedding model field, including
  when the settings file loads asynchronously. Status never reads credentials or
  contacts a provider. Atomic writes preserve unknown fields and comments, use a shared
  non-stealable writer lock, and reject malformed/oversized/redirected storage rather than
  repairing it. `off` removes the embedding object and retains vectors. `reset-history` is an
  explicit user-only recovery action for incompatible preserved history caches: it clears
  recognized derived task/session/commit vectors and their identity metadata in only
  the current project's source-local history databases. It does not reset the shared
  all-project Settings cache. It preserves canonical tasks, sessions and Git history,
  settings documents/schema, repository `code.sqlite` and `knowledge.sqlite`, and global
  Settings vectors. The next background Tasks
  synchronization or search-driven indexing of other sources can re-embed and incur charges.
  Busy, redirected, unsafe or unrecognized storage fails closed without committing a
  reset. No automatic provider choice. Child repository tools inherit configuration but do
  not expose this user command.
- `lexical` never embeds. `hybrid` (native default) uses reciprocal-rank fusion of BM25
  and cosine-ranked current chunk vectors; `semantic` uses semantic matches when available,
  falling back visibly to lexical on unavailability. Symbol ranking is unsupported.
  Code/Knowledge semantic candidates require raw cosine similarity **>= 0.25** before
  test-file ranking penalties and RRF. This fixed retrieval threshold does not filter
  BM25 matches or require reindexing; cached vectors use the same threshold. The fused
  RRF score is not a cosine similarity.
  When configured, the optional reranker replaces final hit scores with relevance scores.
  Desktop publishes the lexical stage first and enriches when global embeddings or a reranker are configured.
  The agent awaits its one bounded final response. Pure retrieval uses no answer LLM.
- On explicit search, embed at most 128 missing scoped chunks in batches of 16, shared
  across nonempty domains. Each request is bounded to eight seconds; enrichment has a
  22-second budget and stays within the overall native request deadline. Partial coverage
  is reported with indexed/total counts; later searches resume. There is no claim that a
  large repository becomes fully semantic after one search. Path/source/test exclusions
  constrain uploads as well as matches. Document input is bounded to 8192 characters before
  the saved prefix. Query vectors are reused when input and configuration are unchanged.
- Cache identities include provider, endpoint, model, dimensions and prefixes. Document
  input hashes include paths/headings/content. Only current lexical-snapshot chunks may
  match: deleted/renamed/changed/ignored content cannot retain old references after refresh.
  Unreferenced paid vectors are retained, not silently erased; model changes get separate
  identities. The cache is bounded to 50,000 vectors and 256 MiB; exhaustion is visible and
  never triggers destructive repair or automatic purchased-vector eviction.
- Expiring, token-owned per-identity leases prevent concurrent provider publishers.
  Native vector identity leases expire after 60 seconds and renew when less than
  30 seconds remain; expired or replaced tokens cannot renew or publish.
  Source and provider leases renew every 30 seconds with a 90-second expiry. HTTP never runs
  inside SQLite write transactions. A same-database publication fence validates ownership
  when each short transaction commits; lost ownership cannot be renewed or used to publish,
  and this does not provide atomic commits across source-local databases. A queued source
  keeps renewing its claim and rechecks it after acquiring a provider slot. Cancellation
  retains claims/slots until the tracked transport actually settles. After two failed or
  interrupted network attempts (the initial attempt plus one automatic retry), work requires
  explicit Continue; success resets the failure count. Continue clears the exhausted budget
  before reconciliation. A failed-work cooldown limits immediate retries, but a crash after
  transmission can still cause duplicate provider billing. A separate global provider-work
  database coordinates at most four valid local leases across projects/processes; after a
  crash or partition this cannot prove the count of remote provider executions. Snapshot
  generation and the exact
  global configuration signature are checked before uploads, after responses and before final
  publication; in-flight work observes revocation via cancellation. Already transmitted
  bytes cannot be recalled. Lost/expired lease owners cannot publish or release successors.
  Failed/cancelled/config-stale enrichment preserves lexical results and uses redacted notices.

## Constraints and failure cases

- Parsing, hashing and synchronous SQLite are in an owned child process, not the UI/main
  event loop. No Desktop session is needed. Workspace/query changes abort the native child
  and suppress late results. In Desktop, closing the owning window or quitting the app
  also cancels native search/indexing children (see
  [native process lifecycle](../architecture/desktop-native-process-lifecycle.md)). Owners close streams/listeners/timers and terminate processes
  on cancellation, timeout, abnormal exit or output overflow.
- Storage rejects redirected directories, symlink/hardlink databases or sidecars, unknown
  native schemas/versions/identities and dangerous triggers without deleting user data.
  Workspace relocation does not silently rewrite index identity. Indexes are disposable
  caches, but automatic destructive repair is outside this slice.
- File enumeration, bytes, chunks, time, output and SQL candidates are bounded. Reaching a
  cap or losing a freshness race must be reported, not called a complete index. This version
  rehashes eligible files on warm search; incremental writes do not imply O(changes) reads.
- Explicit manual indexing is separate from search-driven enrichment: it drains all
  eligible missing documents in batches of at most 16, with no overall 128-document cap
  or overall native CLI/Rust/semantic timeout. Per-HTTP-request timeouts, cancellation
  and storage safety bounds remain. Search-driven Code/Knowledge uploads retain the shared
  128-chunk cap and search deadlines.
- File references describe an observed snapshot, not an immutable checkout. Consumers must
  re-read before editing or using evidence. No portable whole-filesystem atomic snapshot or
  defence against a hostile actor replacing ancestor directories at every syscall is promised.
- Knowledge active-spec authority, declaration relationships, dirty/acknowledge review,
  and AST/dependency views are not part of native repository search.

Files with a source line longer than the 8,000-character chunk bound are deliberately
excluded (including removal of any old indexed rows for that file), not treated as a
whole-scan failure. Other eligible files remain searchable.

## Verification

Use deterministic no-key fixtures for file/line correctness, incremental deletion,
ignore changes, storage rejection, competing generations and cancellation. Run the host `npm run check:ci` gate and report
blocked/incomplete legs. Real Desktop evidence is separate from unit-test success.
Semantic regressions use deterministic injected embeddings/HTTP responses, never paid
requests: no-token-overlap matches, incrementality, model isolation, scope/privacy,
bounded progression, revocation, stale publication, leases and malformed responses.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"c3e5ad3aac99dc163f77db4c074b2747dfb689a01294deccb9b7ba54a00a620f","checkedAt":"2026-10-31T11:02:15.399Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":62,"reportLanguage":"ru"} -->
