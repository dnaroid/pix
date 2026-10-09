---
kind: spec
status: active
---

# Desktop universal search

## Behavior

Desktop's UI retrieves and navigates these sources independently of the
headless `project_search` agent tool. Both read the same canonical task,
session and Git stores and existing IDX code/document index; the agent tool
provides compact evidence and IDs for the calling agent, without RAG inference
or a separate persistent index. See
[project-wide agent search](project-search-agent-tool.md).

- Desktop provides one current-project dialog, opened from the titlebar or
  Cmd+Shift+F (Ctrl+Shift+F on non-macOS hosts). Settings, Sessions, Tasks, Commits,
  Code and Knowledge are independently selectable. Results use a shared local
  field-weighted BM25 ranking over retrieved, deduplicated candidates, not fixed
  source interleaving or comparison of unrelated vector/IDX scores. BM25 uses
  positive Robertson IDF, term-frequency saturation and field-length normalization
  (k1=1.2, b=0.75), with title scores weighted 3× relative to metadata.
  Exact titles win score ties. Case, punctuation, identifier word boundaries, ё/е,
  a small Russian inflection heuristic and English plurals are normalized. A
  bounded
  authored technical vocabulary maps Russian autocomplete variants (including
  «авто-пополнение») and English "auto completion" to the same `autocomplete`
  concept, without matching unrelated Auto routing/thinking. Common query
  stop words and conversational query framing are ignored when possible (unless
  the query contains only stop words).
  Metadata hits matching less than half of distinct meaningful terms are dropped.
  Authored setting synonyms, task IDs, commit changed-file paths and commit
  hash prefixes (at least seven hex digits) remain searchable. Code/Knowledge
  requests include IDX's existing
  matched-content excerpts, bounded before use in local BM25 and previews.
  Missing/truncated IDX excerpts remain opaque candidates below lexical matches,
  as are opt-in semantic settings candidates, first/final session-excerpt
  matches, and semantic/full-message/patch commit candidates without visible
  lexical evidence. Length-delimited IDX body output
  is never parsed as new result headers.
  Source-local rank only breaks
  lexical ties; results remain capped at 60. Reranking adds no provider calls or
  on-demand file reads. Only Code/Knowledge retrieval uses the normalized technical
  concept as its query (one call per selected IDX domain); settings and sessions
  retain the original query. No general machine translation or extra source
  discovery is attempted.
- Search runs only on Search or Enter in the input. Typing/changing types cancels
  stale requests and clears results but never runs a query. Empty queries do not
  search. Activating a result is separate from submitting a query.
- Search modes are **Auto** (the default), **Search**, and **RAG**.
  Search remains the existing direct source lookup without an intent classifier.
  Auto calls the private ACP `pix/search/intent` method **only after an explicit
  search submission** (never while typing). The stateless classifier uses
  OpenRouter Decisions API and `~typesafe/jev-latest` with a single constrained
  `search | ask` choice. Only the entered query is sent; no workspace path,
  source results, transcripts, snippets or files are included in the request.
  Auto has a visible OpenRouter/cost disclosure and requires a saved OpenRouter
  credential. It does not inherit semantic-settings/session-title consents.
  No other model-routing tiers or provider fallback models are used.
  Jev is bounded to five seconds, uses no result cache, and missing credentials,
  invalid answers, provider failures or timeouts select Search, with a visible
  fallback notice. Explicit `patch:` searches skip Jev and remain Search.
  Query edits, filter/mode changes, dialog close, workspace/client replacement,
  and new submissions invalidate old decisions and cancel in-flight requests.
  If Jev chooses Search, existing source search runs unchanged. If it chooses
  Ask, RAG starts immediately inside the dialog. Manual RAG bypasses Jev.
  The selected mode is held in window-only memory; a new workspace defaults
  to Auto, with no automatic search or generation on reopen.
- RAG retrieves from the existing selected Search sources (Settings, Sessions,
  Tasks, Commits, Code and Knowledge), reusing IDX hybrid retrieval, the local
  session excerpt FTS and commit metadata/semantics. Source ranking reuses the
  existing unified BM25 order, capped at 12 evidence items with at most four
  from each category. No duplicate vector index or full transcript/diff index
  is created. Code/Knowledge source files are reread by the ACP backend with
  realpath, regular-file and symlink checks, project-root containment, bounded
  file sizes (2 MiB), and cited line windows. Session evidence comes from the
  local first/final FTS excerpt index; commit messages are reread only for
  HEAD-reachable commits. Other source types use bounded search-result metadata.
  Unavailable/unsafe files are omitted; empty evidence does not invoke an LLM.
  Retrieved source content and the question are explicitly sent to the chosen
  model provider for RAG generation, separately from the Jev query-only intent
  classification and semantic-index consents. Provider charges may apply.
- Generation runs in an isolated temporary Pi SDK ModelRuntime, without
  creating a Pi/ACP conversation/session or mutating project state. The private
  Desktop-only `pix/search/rag` request carries bounded evidence references,
  and `pix/search/rag_delta` sends incremental text and the exact set of
  verified source IDs; request IDs prevent cross-query notification leaks.
  Source excerpts are untrusted data in the model prompt. The model must cite
  only supplied evidence as [1], [2], etc., and report missing evidence
  instead of inventing facts. The output is displayed as Markdown in the
  existing search dialog with inline clickable citations and a source list.
  Each source reuses the same navigation as a normal Search hit (code line,
  knowledge line, commit diff, session, task or setting). Unknown citation
  numbers are inert. Generation supports cancellation and an owned 90-second
  deadline; stale completion after close/edit/filter/project change is ignored.
  A provider error displays an opaque message, never raw provider secrets.
- Desktop user settings at `search.ragModelRef` and `search.ragThinking` own
  the independent answer model and reasoning effort. Empty model reference
  means the normal Desktop default model; effort defaults to medium and supports
  Off, Minimal, Low, Medium, High, Extra High and Max. The structured Assistant
  settings use the existing catalog-backed model selector and a thinking-level
  selector. These settings are distinct from modelRouting/Auto, semantic-search
  consent flags and the currently active conversation model. Search mode and
  RAG generation do not automatically change the user's conversation.
- The dialog uses a compact input/filter/results layout. A persistent live
  footer spinner and `Searching…` label remain while the initial request or any
  late source is pending, including alongside partial results. Result-region
  busy semantics cover both states. Technical index/ranking/status information,
  real source warnings and provider/cost disclosures remain accessible in a
  collapsed `Search details` section with an explicit rotating Lucide chevron.
  The six result-type filter chips and the `Search settings` action live inside
  this disclosure, not in always-visible toolbar/footer rows. A redundant
  `Current project` label is not shown; the dialog is already project-scoped.
  The mode switcher remains always visible and says only `Auto / Search / RAG`,
  while the technical Jev/provider disclosure remains in the expanded details.
  The disclosure's long content remains scrollable without clipping.
  Timeout notices are not repeated as
  warnings. IDX's routine `WARN no-results` suggestion is treated as an empty
  result, not a provider failure or a UI warning. Completed empty searches remain
  distinct from pending/error states.
- Result rows have visibly different pointer-hover, keyboard-focus and active-row
  treatments using semantic theme colors in light and dark modes. No result is
  preselected on a fresh search; Arrow Down/Up selects the first/last row when
  needed. Pointer hover uses a fully rounded, inset outline and category badge
  contrast rather than a protruding left border. Keyboard focus remains visible,
  disabled rows do not highlight, and reduced motion disables transitions.
- An on-screen microphone provides voice query input through the existing
  [Deepgram transport](deepgram-voice-input.md), using Desktop's configured
  model/language and short-lived native token. Audio is sent to Deepgram; the
  permanent key stays native. Interim text is shown separately; final text
  replaces the input selection with normalized spacing, bounded to 2048
  characters without discarding other query text. Stopping the microphone does
  not search automatically. Explicit Search/Enter waits for finalization before
  submitting. Manual editing, filter changes, scope/client replacement and
  close/unmount cancel recording ownership and ignore late callbacks, caret
  updates, focus and submission. Unsupported capture environments omit the
  microphone; permission/configuration errors remain visible. F5 remains
  composer-only under [0062](../docs/decisions/0062-macos-dictation-key.md).
- Closing/reopening retains query, selected types and completed results in the
  current window, without resubmitting. Workspace or ACP-client replacement clears
  this memory. Closing cancels pending work; an interrupted query retains its input
  but must be explicitly submitted again. Nothing is persisted to disk.
- Tasks search reads the same `.pi/tasks.jsonc` document as the Tasks panel and
  locally matches labels, descriptions, IDs, type, status and priority across all
  tasks (including done). Attachment contents are not read. Selection verifies
  the stable task ID still exists in storage, then reveals it in Tasks; it never
  runs or edits the task. If the panel has not loaded a newly added external task,
  selection asks to refresh Tasks rather than overwriting its current document.
  The reveal/scroll operation rechecks workspace, connection and navigation
  ownership after rendering so a cancelled or superseded selection cannot scroll
  a different project's panel.
- Commits search examines metadata for all ancestors of current HEAD, with no
  30-commit window; it does not enumerate unrelated branches. The dedicated
  `git_search_history` command leaves Source Control's 30-item history unchanged.
  History examination and candidate selection run off the UI thread, returning
  a bounded candidate list rather than serializing the whole history to the UI.
  Fast native lexical matching covers subjects, full hashes and authors;
  selecting either a native or hybrid commit hit opens Source Control and
  the workbench Git Diff tab with that exact commit's read-only patch,
  hash, subject, author and date. The transient search dialog closes only
  after a valid commit diff is loaded. A separate ACP source performs
  full-corpus BM25 plus semantic search over commit messages and metadata,
  including non-literal matches. Changed-file paths (up to 256 paths / 32 KiB
  per commit) enter local BM25 and previews, but not embedding inputs or hashes.
  Previously paid vectors remain reusable; durable commit metadata refreshes
  even when the content hash is unchanged. Hybrid results supersede duplicate
  native hits without losing semantic eligibility, regardless of arrival order.
  Search providers do not read diffs or mutate Git. Selection uses a separate
  bounded, read-only native diff lookup; it rejects stale/non-HEAD-reachable
  commit objects and cannot check out or modify the working tree. Root commits
  and merges display their changes, with large patches visibly truncated.
  Navigating to a newer search result, closing the dialog, or switching
  projects invalidates a pending older commit reveal. Tasks-only searches never invoke
  ACP, IDX or providers. Missing Git or
  malformed task storage reports a source-specific error without hiding other hits.
- Explicit `patch:<literal>` with Commits selected uses a read-only Git
  pickaxe (`git log -G`, with the literal regex-escaped) over HEAD-reachable
  changed lines. The scan is bounded to 50 matches and 8 seconds. Other
  sources/native commit lookup are skipped. Patches are never embedded,
  indexed or uploaded; returned commits open through the existing verified
  read-only diff viewer. A missing ACP connection is reported, not silently
  treated as no matches.
- Commit history count is not capped. Hybrid indexing bounds individual Git fields to
  64 KiB, and semantic document input to 8,192 characters including the saved
  prefix and metadata; unusually large commit messages can therefore be truncated.
- Hybrid commits use the existing project's saved IDX embedding provider and
  knowledge embedding model, dimensions and prefixes; Desktop never switches the
  provider, runs IDX setup or alters the code/knowledge index. The selected
  provider may receive commit messages/metadata and search queries. The dialog
  discloses that the first search may index the entire current HEAD history and
  incur provider costs. This is separate from the settings-only semantic opt-in;
  that preference does not authorize other settings or session-history uploads.
  Commit data and vectors live in the shared durable
  `.pi/search/index.sqlite`, in the namespaced `pix_commit_meta`,
  `pix_commit_documents`, and `pix_commit_vectors` tables. They reuse unchanged
  commit hashes, content and compatible vectors across restarts and append new
  commits. Reachability filtering excludes commits no longer on current HEAD.
  Provider/model/dimension/prefix identity fences incompatible vectors; the
  settings and commits vector tables may use distinct dimensions/encodings.
  A pre-unification `.pi/search/commits.sqlite` is imported transactionally,
  idempotently, and without provider calls; the legacy file is never unlinked or
  modified by migration. Existing settings data is not rewritten by the import.
  A changed incompatible embedding identity is never mixed with existing vectors.
  Missing config/key/provider retains local BM25 results and durable caches.
  SQLite ownership precedes paid batches so concurrent searches cannot
  independently pay for the same missing documents.
  Contention is bounded; cancellation preserves committed batches and does not
  evict live owners or delete the index. Query/filter edits and closing cancel
  provider work and invalidate late publication. Session transcripts, task
  attachments, diffs and file contents are never sent by this source. Provider
  failures are opaque and credential-free; native/local hits remain available.
- Settings search uses authored labels, descriptions and synonyms, never
  configured values, credentials or unrelated settings files. A result opens
  its exact section and focuses its stable field ID.
- Sessions search is local lexical lookup of the current project's session-list
  titles, deduplicated by stable session ID. The existing listing's display
  title (named title or first-message fallback) is used. On explicit session
  queries, the search also incrementally indexes **only** the first user
  message and last completed assistant reply on the active parent-linked
  JSONL branch. Pi SDK `stopReason: "stop"` marks completed assistant
  messages; tool calls (`toolUse`), errors, interruptions, tool results, and
  inactive branches are not treated as final answers. The indexed text is
  bounded to 4,096 / 6,144 characters for first/final respectively. Oversized
  message lines (over 1 MiB) and sessions (over 64 MiB) are skipped.
  A local SQLite FTS5 index in `pix_session_boundary_*` tables in
  `.pi/search/index.sqlite` matches query terms without embedding or
  uploading messages. Per-file size/mtime fingerprints skip unchanged JSONL.
  Changed, deleted and unmapped sessions are reconciled on later searches;
  no per-message results or automatic background full-history indexing exist.
  Sessions without a listing title are skipped. Queries observe renames/deletions.
  Selecting a result opens/activates and hydrates that session, without paging
  to or guessing a particular message. First/final excerpt retrieval remains
  lexical and independent of the separate consent for semantic title search.
- Explicitly saved session names may also be semantically indexed with a
  **separate**, Desktop-wide opt-in (`search.sessionTitlesEnabled`, default
  false). Names obtained from `session_info` that are identical to the first
  user message remain local lexical fallback; only authenticated named titles
  are eligible. The session-map entry retains this title provenance so the
  search layer cannot accidentally embed the first-message display fallback.
  Sessions without an eligible name never produce an embedding, and no
  conversation history, message bodies, attachment names/contents, transcripts,
  or branch histories are read or sent by this index.
  Explicit names are synchronized locally to the dedicated
  `pix_session_meta`, `pix_session_titles` and `pix_session_vectors`
  tables inside `.pi/search/index.sqlite`. Rename/delete reconciliation removes
  stale title rows and unused vectors; repeated identical names share the same
  content-hashed embedding. A name change cannot use a stale vector belonging
  to the old title. Provider work occurs only with independent consent and a
  valid OpenRouter key, is batched and serialized behind SQLite write ownership,
  and can be canceled on revocation or project replacement. Background
  indexing can continue after a query, while local lexical hits remain usable
  immediately. Only the same pinned settings embedding model, 1024 float32
  dimensions, is supported; session metadata is separate from settings/commit
  model identity. Incompatible metadata fails closed instead of deleting
  previously paid vectors.
- Session histories are never classified with JEV or embedded. There is no
  per-message progress/count, message-filter option, or background **full**
  history scan. Only bounded first/final excerpts are parsed locally on a
  changed-session search; tool bodies are never parsed into the index.
  Obsolete `messageFilterEnabled` writes are rejected; legacy config keys are
  ignored. Opening search polls cheap status without discovering transcripts
  or rerunning queries.
- Code/Knowledge require installed, initialized current-project IDX and explicitly
  use hybrid mode for both code and document domains. The CLI uses each domain's
  project-configured embedding provider; Desktop never switches it or runs setup.
  Hybrid queries can auto-update the index and send indexed chunks and queries to
  that provider. This is separate from opt-in semantic settings search; the dialog
  discloses the hybrid provider/index-refresh behavior. There is no verified
  hybrid-without-auto-index flag in the installed CLI. CLI lexical fallback
  warnings are shown as bounded, redacted source notices, not hidden success.
  IDX returns bounded matched content for both domains to enable content-aware
  reranking without extra reads of project source files.
  Invocations are serialized per workspace, including across superseded
  searches: cancellation returns promptly but retains ownership until an already
  invoked native operation finishes. Different projects remain independent.
  Transient lock failures are retried at most twice with cancellable backoff;
  persistent contention reports IDX busy/try again, without deleting locks.
  Other errors retain bounded, redacted diagnostics. Local results survive.
  Explicit IDX panel maintenance/search is unchanged.
- Semantic settings search is explicit Desktop-wide opt-in, off by default.
  Only authored settings metadata and settings-search queries may be sent to
  OpenRouter by this consent; it never authorizes session names. With session
  name consent off, sessions-only requests make no provider calls even if
  settings consent is enabled. With name consent on, session-name embeddings and
  explicitly submitted session search queries may be sent to OpenRouter. The
  session-name opt-in does not enable settings semantic search. Sole embedding model:
  perplexity/pplx-embed-v1-0.6b. The exact response identity
  pplx-embed-v1-0.6b is also accepted; request/durable metadata stay qualified.
  Other/missing identities are invalid; both aliases use strict float/base64
  vector validation. Preferences display the fixed model/provider in read-only
  rows and use a masked, write-only shared OpenRouter key input. Desktop config
  contains only the separate consent flags, never the key. Missing consent,
  key or provider leaves local lexical lookup usable.
- ACP semantic-consent changes and native Desktop config saves share bounded
  interprocess ownership over read/compare/edit/publication. Paused writers are
  never evicted based on lock age; crash leftovers fail closed until their owners
  are confirmed stopped. See [user-config editing](desktop-user-config-editing.md).
- The project-owned `.pi/search/index.sqlite` is the canonical, shared,
  non-disposable Pix vector database for every global-search domain. Its
  existing `metadata`, `documents` and `vectors` tables remain settings-only
  (schema 2); other Pix sources use a `pix_<domain>_` table namespace, so
  adding commit data cannot pass through settings-only schema guards.
  The IDX code/document database is *not* migrated or modified here.
  A future integration must coexist with IDX's `vec_chunks`, `vector_meta`,
  `snapshots`, `chunks`, `files`, `knowledge_chunks`, and related sqlite-vec
  tables, preserve embedding dimensions and project/snapshot identity, and
  avoid table/index names used by Pix. Code/knowledge remain served by IDX
  until such an integration is separately designed and approved.
  Session title vectors use `pix_session_*`, while the text-only first/final
  excerpts use separate `pix_session_boundary_*` SQLite FTS5 tables. No
  session message/body embeddings are created; those would need separate
  future authorization. IDX's database remains independent.
  The settings schema's first activation migration remains limited to its
  own tables and must not clear any other domain's data.
  The original settings-schema migration was introduced to replace a legacy
  message-body index:
  First activation migrates locally even without consent/key: removes old
  message documents, their unreferenced vectors and all filter decisions, retaining
  authored settings and their valid vectors. Session files are never changed.
  Migration is transactional/idempotent; schema guards reject obsolete writers
  resetting it or adding message documents while an older Desktop is still alive.
  Transient migration contention retains a separate warning and retries on later
  requests/status polls, even with semantic search off; local title results remain
  available. Consent changes cannot hide an unfinished migration.
  SQLite secure_delete applies to removed rows, but this is not a forensic-erasure
  guarantee for old snapshots/backups/sidecars. Restart is required to replace
  already-running obsolete frontend/ACP code; it is not forced with a live draft.
- Settings hashes/vectors and model metadata survive restarts and reuse unchanged
  content. SQLite/in-process writer queues acquire ownership before paid settings
  batches, use bounded contention waits and do not reset/unlink the database.
  The canonical search/ tree, its WAL/SHM sidecars, and any retained legacy
  databases or local backup files in that tree survive manual Clean and
  background TTL; no cleanup action may delete or reset the canonical database.

## Constraints and failure cases

- Desktop-only feature, scoped/labeled to the current project; not TUI global
  search. Session title *results* are computed from the current local session
  map; explicitly named titles and their opt-in vectors plus bounded local
  first/final excerpts may persist to project storage. Full-message and
  provider-backed conversation indexes remain forbidden.
  Auth and distinct semantic consents remain Desktop-wide.
- Sources fail independently. Disconnected ACP retains authored settings lookup;
  missing/busy IDX does not suppress settings/session results. Request failures
  never imply a disconnected backend. Unexpected exceptions stay opaque; known
  source failures are credential-free. Aborts publish no failure notices.
- Initial source waiting is bounded to 20 seconds, including overview/queue
  waiting and both sequential IDX domains together. Completed sources publish
  immediately, including each IDX domain. Slow sources keep working and may
  append/rerank results in the same open, current submission; a pending notice
  replaces endless blocking and is removed when that source completes. Authored
  settings fallback is available while its backend is pending and is replaced by
  the completed response. Failed sources retain their own warnings without
  hiding other results. Successful empty searches show `No results.` only when
  no sources remain pending; warnings/errors and still-pending empty searches
  are distinguished. Published snapshots are immutable. Query/filter edits,
  resubmission, workspace/client replacement or closing invalidate all old updates.
  Closing retains partial hits but removes pending indicators; reopening requires
  explicit resubmission to search again, never silently resumes cancelled sources.
  Commit indexing RPC has no ordinary 30-second client timeout; query/dialog
  lifecycle cancellation owns its transport. UI deadlines do not cancel source work, release serialization ownership, or
  kill/delete active native index work. Native/provider operational limits remain
  independent of this initial-wait limit.
- Title discovery has a cancellable 15-second deadline and is serialized to avoid
  concurrent session-map mutation. Mixed semantic requests revalidate titles after
  asynchronous provider work, including provider failure or revocation; rediscovery
  failures cross ACP as controlled reasons rather than publishing stale titles.
  Merging a captured native listing validates file presence under the map lock and
  preserves a more recent mapped rename; completed deletions cannot be resurrected
  by that listing. Missing session files are excluded from title hits.
- Workspace/client replacement, cancellation, revocation and disposal invalidate
  stale work. Dialog requests/listeners/timers are released on teardown; stale
  navigation cannot close a later dialog. Session activation checks workspace,
  connection and active session after asynchronous boundaries.
- File hits accept only safe project-relative formatter headers and ranges;
  opening validates that the file still exists.
- Deterministic tests need no paid requests. These reversible search extensions
  do not introduce a new durable decision. Existing stable session/message
  identity rationale: [0018 — Desktop message action identity](../docs/decisions/0018-desktop-message-action-identity.md).
  Cleanup scope: [Registry project state](resource-registry-project-state.md).

## Implementation

- `acp/src/search/contract.ts`
- `acp/src/search/commit-contract.ts`
- `acp/src/search/commit-corpus.ts`
- `acp/src/search/commit-provider.ts`
- `acp/src/search/commit-service.ts`
- `acp/src/search/commit-worker.ts`
- `acp/src/search/bounded.ts`
- `acp/src/search/config.ts`
- `acp/src/search/documents.ts`
- `acp/src/search/session-titles.ts`
- `acp/src/search/intent.ts`
- `acp/src/search/rag-contract.ts`
- `acp/src/search/rag-request.ts`
- `acp/src/search/rag-evidence.ts`
- `acp/src/search/rag-service.ts`
- `acp/src/acp/openrouter-jev.ts`
- `acp/src/search/session-boundary-reader.ts`
- `acp/src/search/session-boundary-index.ts`
- `acp/src/search/session-boundary-service.ts`
- `acp/src/search/session-boundary-paths.ts`
- `acp/src/search/embeddings.ts`
- `acp/src/search/index-store.ts`
- `acp/src/search/request.ts`
- `acp/src/search/service.ts`
- `acp/src/acp/pix-acp-agent.ts`
- `acp/src/acp/session-map.ts`
- `acp/src/pi/pi-rpc-client.ts`
- `acp/src/pi/pix-rpc-entry.js`
- `desktop/src/lib/acp-client.ts`
- `desktop/src/lib/universal-search.ts`
- `desktop/src/lib/search-intent-controller.ts`
- `desktop/src/lib/search-rag.ts`
- `desktop/src/lib/search-source-deadline.ts`
- `desktop/src/lib/search-relevance.ts`
- `desktop/src/lib/search-query.ts`
- `desktop/src/lib/search-bm25.ts`
- `desktop/src/lib/project-search.ts`
- `desktop/src/lib/project-tasks.ts`
- `desktop/src/lib/git-workflow.ts`
- `desktop/src/app/project-tasks.svelte.ts`
- `desktop/src/components/WorkspaceSidebarTasksPanel.svelte`
- `desktop/src-tauri/src/git_operations.rs`
- `desktop/src/lib/search-dialog-memory.ts`
- `desktop/src/lib/snapshot-search-queue.ts`
- `desktop/src/lib/search-dialog-controller.ts`
- `desktop/src/lib/search-voice-controller.ts`
- `desktop/src/lib/deepgram.ts`
- `desktop/src/lib/settings-search-catalog.ts`
- `desktop/src/app/search-navigation.ts`
- `desktop/src/components/UniversalSearch.svelte`
- `desktop/src/components/DesktopTitlebar.svelte`
- `desktop/src/components/DesktopSidebar.svelte`
- `desktop/src/components/WorkspaceSidebar.svelte`
- `desktop/src/components/SettingsPanel.svelte`
- `desktop/src/components/settings/SettingsFieldRow.svelte`
- `desktop/src/components/settings/SettingsSearchPreferences.svelte`
- `desktop/src/components/settings/SettingsConfigEditor.svelte`
- `src/schemas/pix-desktop-schema.ts`
- `schemas/pix-desktop.json`
- `desktop/src/App.svelte`
- `desktop/src-tauri/src/idx_snapshot_search.rs`
- `desktop/src-tauri/src/lib.rs`

## Tests

- `tests/pix-desktop-search-schema.test.ts`
- `acp/test/search.test.ts`
- `acp/test/search-intent.test.ts`
- `acp/test/search-rag.test.ts`
- `acp/test/commit-search.test.ts`
- `acp/test/search-preferences.test.ts`
- `acp/test/agent.test.ts`
- `acp/test/session-map.test.ts`
- `acp/test/pix-rpc-entry.test.ts`
- `desktop/src/lib/universal-search.test.ts`
- `desktop/src/lib/search-intent-controller.test.ts`
- `desktop/src/lib/search-rag.test.ts`
- `desktop/src/lib/acp-client.test.ts`
- `desktop/src/lib/search-source-deadline.test.ts`
- `desktop/src/lib/search-relevance.test.ts`
- `desktop/src/lib/search-query.test.ts`
- `desktop/src/lib/search-bm25.test.ts`
- `desktop/src/lib/project-search.test.ts`
- `desktop/src/lib/search-dialog-memory.test.ts`
- `desktop/src/lib/snapshot-search-queue.test.ts`
- `desktop/src/lib/search-dialog-controller.test.ts`
- `desktop/src/lib/search-voice-controller.test.ts`
- `desktop/src/lib/deepgram.test.ts`
- `desktop/src/app/search-navigation.test.ts`
- `desktop/src/components/UniversalSearch.test.ts`
- `desktop/src/components/WorkspaceSidebar.test.ts`
- `desktop/src/lib/settings-search-catalog.test.ts`
- `desktop/src/components/DesktopModalDialogs.test.ts`
- `desktop/src/components/DesktopVisualRegressions.test.ts`
- `desktop/src-tauri/src/idx_snapshot_search.rs`
- `desktop/src-tauri/src/lib.rs`

## Verification

Run Desktop typecheck and focused search/queue/navigation/settings/modal tests,
ACP typecheck/build/search/agent tests and schema generation/tests. Cover title
boost, Robertson IDF, saturation, length normalization, explicit hybrid mode in
both native domains, bounded/redacted fallback notices, and serialized IDX aborts.
Also cover title deduplication/scope/renames/deletions, no transcript reads/provider calls for
sessions, transactional cleanup/settings-vector preservation/old-writer fencing,
restart/hash reuse, contention, cancellation, revocation and stale completion.
Real macOS QA checks explicit submit, Sessions labels, settings/file/session
activation and busy IDX fallback, task reveal, commit metadata, and close/reopen
retention. Cover completed versus interrupted retention, scope/client changes,
source isolation, task deletion, and stale task-navigation completions.
Deterministic checks do not claim live UI QA.
Full-message BM25 matches survive frontend ranking when the visible metadata
snippet contains no query terms; native and hybrid hits share one commit-hash ID.
 Commit-index directories, database and SQLite sidecars reject symlink redirects
 before opening the database or embedding; local BM25 remains usable.
 RAG regression tests cover source reference validation and navigation identity,
 strict source file containment, excluded symlinks, untrusted retrieval excerpts,
 user-profile model/effort selection, no-evidence model skipping, incremental ACP
 notifications, late-update isolation, and cancelled/failed model streams.
