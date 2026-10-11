---
kind: spec
status: active
title: Native repository Code and Knowledge search
---

# Native repository Code and Knowledge search

## Goal / scope

One native Code/Knowledge backend for ordinary Pi/TUI/ACP/Desktop `project_search`,
with no IDX dependency, fallback, command, install/update, panel, or settings. Native
lexical retrieval needs no credentials. Explicit global provider configuration itself
authorizes semantic retrieval for every project and source. Credentials use
`OPENROUTER_API_KEY`, then the shared Pi auth store. This does not migrate or modify pre-existing IDX data.
Persistence/process rationale: [0066](../docs/decisions/0066-native-repository-semantic-search.md),
building on [0065](../docs/decisions/0065-native-repository-search.md). Global authorization:
[0068](../docs/decisions/0068-global-semantic-configuration.md).

## Canonical behavior

- The shared engine lives in the default-enabled bundled tools-suite module and works
  in ordinary Pi without Pix or Desktop registration. Its CLI takes a selected canonical
  workspace path and bounded JSON stdin; both host adapters return the same typed hits:
  kind, id, title, snippet, score, project-relative path, inclusive 1-based start/end lines,
  and optional bounded content. Desktop retains normal navigation, ranking and RAG evidence
  revalidation. The agent retains its federated source/result caps.
  Release payloads include the engine source and its `ignore` parser as a locked root
  production dependency: the standalone CLI must not rely on the checkout's suite-local
  node_modules or a dependency nested inside the SDK.
- Native lexical search has no network work or credential requirement. It refreshes
  `.pi/search/files.sqlite` (and SQLite sidecars). Optional semantics uses a separate
  `.pi/search/file-vectors.sqlite`; existing `.pi/search/index.sqlite`, legacy IDX
  databases/configuration and canonical source files are never migrated or modified.
- Files are enumerated under the selected root, using Git's tracked/unignored file list
  where available and a bounded walker with nested `.gitignore` otherwise. Internal caches,
  `.pi`, `.git`, `.indexer-cli`, dependency/build directories, linked/nonregular files,
  binary/invalid-UTF8 and oversized sources are excluded. Search is not a secret detector;
  eligible tracked text is searchable. Generated text not covered by ignores remains eligible.
- Recognized source/config formats become Code; Markdown/plain documentation formats become
  Knowledge, without mandatory frontmatter. Markdown headings define section boundaries;
  code and large sections use bounded overlapping line chunks. These are not AST symbols.
- FTS5 tokenization normalizes case, Unicode, camel-case and punctuation. User text is
  tokenized and safely quoted rather than interpreted as raw FTS syntax. File/heading terms
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
- Native search has no IDX fallback. Empty results and failures are reported as native
  results/notices; no legacy index is queried.
- Every Pi caller, including async/provider/council children, receives the same
  unrestricted `project_search` schema and execution across sessions, tasks,
  commits, code and knowledge, including `patch:`. Children suppress suite setup
  commands and parent orchestration guidance only. Repository semantic embeddings
  use the same explicitly configured global provider. IDX setup/update commands and
  removed `repo_*` tools are not part of ordinary search.

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
  `.indexer-cli/config.json` or IDX `.env`, migrate settings, or select a provider
  automatically. OpenRouter credentials use `OPENROUTER_API_KEY`, then an API key in
  shared Pi `auth.json` (`PI_CODING_AGENT_DIR`, otherwise `~/.pi/agent`); missing/invalid
  config/key/provider leaves local matches.
  Semantic mode needs saved compatible provider configuration, but neither mode requires
  a `.indexer-cli` directory. Existing IDX configuration is never consulted.
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
  recognized derived task/session/commit/settings vectors and their identity metadata in only
  the current project's `.pi/search/index.sqlite`. It preserves canonical tasks, sessions and
  Git history, settings documents/schema, the commit legacy-import marker, repository
  `.pi/search/file-vectors.sqlite`, and global settings. The next background Settings/Tasks
  synchronization or search-driven indexing of other sources can re-embed and incur charges.
  Busy, redirected, unsafe or unrecognized storage fails closed without committing a
  reset. No automatic provider choice. Child repository tools inherit configuration but do
  not expose this user command.
- `lexical` never embeds. `hybrid` (native default) uses reciprocal-rank fusion of BM25
  and cosine-ranked current chunk vectors; `semantic` uses semantic matches when available,
  falling back visibly to lexical on unavailability. Symbol ranking is unsupported.
  Desktop publishes the lexical stage first and enriches only when the global provider is configured.
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
  HTTP never runs inside SQLite write transactions. Snapshot generation and the exact
  global configuration signature are checked before uploads, after responses and before final
  publication; in-flight work observes revocation via cancellation. Already transmitted
  bytes cannot be recalled. Lost/expired lease owners cannot publish or release successors.
  Failed/cancelled/config-stale enrichment preserves lexical results and uses redacted notices.

## Constraints and failure cases

- Parsing, hashing and synchronous SQLite are in an owned child process, not the UI/main
  event loop. No Desktop session is needed. Workspace/query changes abort the native child
  and suppress late results. Owners close streams/listeners/timers and terminate processes
  on cancellation, timeout, abnormal exit or output overflow.
- Storage rejects redirected directories, symlink/hardlink databases or sidecars, unknown
  native schemas/versions/identities and dangerous triggers without deleting user data.
  Workspace relocation does not silently rewrite index identity. Indexes are disposable
  caches, but automatic destructive repair is outside this slice.
- File enumeration, bytes, chunks, time, output and SQL candidates are bounded. Reaching a
  cap or losing a freshness race must be reported, not called a complete index. This version
  rehashes eligible files on warm search; incremental writes do not imply O(changes) reads.
- File references describe an observed snapshot, not an immutable checkout. Consumers must
  re-read before editing or using evidence. No portable whole-filesystem atomic snapshot or
  defence against a hostile actor replacing ancestor directories at every syscall is promised.
- Knowledge active-spec authority, declaration relationships, dirty/acknowledge review,
  and AST/dependency views are not part of native repository search.

Files with a source line longer than the 8,000-character chunk bound are deliberately
excluded (including removal of any old indexed rows for that file), not treated as a
whole-scan failure. Other eligible files remain searchable.

## Implementation

- `external/pi-tools-suite/src/project-search/native-contract.ts`
- `external/pi-tools-suite/src/project-search/native-engine.mjs`
- `external/pi-tools-suite/src/project-search/native-scan.mjs`
- `external/pi-tools-suite/src/project-search/native-store.mjs`
- `external/pi-tools-suite/src/project-search/native-semantic.mjs`
- `external/pi-tools-suite/src/project-search/native-vector-store.mjs`
- `external/pi-tools-suite/src/project-search/native-embedding-provider.mjs`
- `external/pi-tools-suite/src/project-search/native-embedding-provider.d.mts`
- `external/pi-tools-suite/src/project-search/semantic-command.ts`
- `external/pi-tools-suite/src/project-search/semantic-reset.ts`
- `external/pi-tools-suite/src/project-search/native-cli.mjs`
- `external/pi-tools-suite/src/project-search/native.ts`
- `external/pi-tools-suite/src/project-search/engine.ts`
- `external/pi-tools-suite/src/project-search/index.ts`
- `external/pi-tools-suite/src/module-catalog.ts`
- `external/pi-tools-suite/src/repo-discovery/subagent.ts`
- `desktop/src/lib/native-repository-search.ts`
- `desktop/src/lib/universal-search.ts`
- `desktop/src/components/UniversalSearch.svelte`
- `desktop/src/components/NativeRepositorySemanticConsent.svelte`
- `desktop/src-tauri/src/native_repository_semantic_config.rs`
- `desktop/src-tauri/src/native_project_search.rs`
- `desktop/src-tauri/src/backend_runtime.rs`
- `desktop/src-tauri/src/lib.rs`
- `external/pi-tools-suite/package.json`
- `external/pi-tools-suite/package-lock.json`
- `package.json`
- `package-lock.json`

## Tests

- `external/pi-tools-suite/test/native-project-search.test.ts`
- `external/pi-tools-suite/test/native-semantic-search.test.ts`
- `external/pi-tools-suite/test/native-semantic-command.test.ts`
- `external/pi-tools-suite/test/semantic-reset.test.ts`
- `external/pi-tools-suite/test/tool-descriptions.test.ts`
- `external/pi-tools-suite/test/project-search.test.ts`
- `external/pi-tools-suite/test/async-subagents/repo-tools.test.ts`
- `external/pi-tools-suite/test/async-subagents/provider-child-inventory.test.ts`
- `desktop/src/lib/native-repository-search.test.ts`
- `desktop/src/lib/universal-search.test.ts`
- `desktop/src/components/UniversalSearch.test.ts`
- `desktop/src-tauri/src/native_project_search.rs`
- `desktop/src-tauri/src/backend_runtime.rs`
- `scripts/release/test/native-search.test.mjs`
- `desktop/src-tauri/src/native_repository_semantic_config.rs`

## Verification

Use deterministic no-key/no-IDX fixtures for file/line correctness, incremental deletion,
ignore changes, storage rejection, competing generations and cancellation. Compare identical
queries against existing IDX lexical snapshots without auto-index or paid embeddings; do not
claim semantic parity from that comparison. Run the host `npm run check:ci` gate and report
blocked/incomplete legs. Real Desktop evidence is separate from unit-test success.
Semantic regressions use deterministic injected embeddings/HTTP responses, never paid
requests: no-token-overlap matches, incrementality, model isolation, scope/privacy,
bounded progression, revocation, stale publication, leases and malformed responses.
