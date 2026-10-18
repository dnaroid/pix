---
kind: spec
status: active
---

# Desktop universal search

## Behavior

Desktop's UI retrieves and navigates these sources independently of the
headless `project_search` agent tool. Both read the same canonical task,
session and Git stores and the native Code/Knowledge engine; the agent tool
provides compact evidence and IDs for the calling agent, without RAG inference
or a separate persistent index. Queries reuse maintained task, saved-session-name
and public-message vectors and may embed the bounded query under the explicit
global embedding configuration and project source policy. Task/session documents
are maintained by authorized background/manual indexing, not query backfill.
It also incrementally populates current Git commit metadata/message
vectors using the suite-owned configured embedding provider and the shared
`pix_commit_*` tables. Unlike Desktop's progressively updated UI, the agent
tool waits for
the selected sources (up to 60 seconds) and returns one combined response. See
[project-wide agent search](project-search-agent-tool.md).

- Source ownership and uncertain-work recovery are specified in
  [decision 0070](../docs/decisions/0070-search-source-work-recovery.md).
- The five non-Settings source selections in the Search indexes panel are project-local and control both indexing
  and search. Universal Search exposes only enabled-source filters and excludes
  disabled sources from retrieval; disabling a source cancels owned work and
  suppresses stale results. Selection is shared through `.pi/search-sources.json`;
  caches are retained and reused if a source is re-enabled. Missing policy enables
  Code only among these five sources; the on-disk map still requires all six booleans,
  including the ignored legacy Settings boolean. Settings has a separate global enabled
  flag, default true. An unreadable global Settings preference fails closed for the
  complete aggregate policy (all sources unavailable until repaired); malformed or unsafe
  project policy also fails closed. Embedding
  configuration remains global and does not override project selection. Initial
  selection inspection is bounded to five seconds; timeout or invalid policy fails
  closed with a visible notice. Policy refresh runs every three seconds after the
  previous read settles, and source results are discarded when cancelled,
  superseded, or based on an obsolete policy revision.
- Submitted inline Settings/Sessions searches read the same project policy before
  dispatch; they do not substitute the missing-policy defaults for an enabled
  project. Disabled sources produce a notice without dispatch. Local typeahead
  remains navigation over already displayed settings metadata or saved titles,
  not document indexing or a semantic provider request.
- Desktop provides one current-project dialog, opened from the titlebar or
  Cmd+Shift+F (Ctrl+Shift+F on non-macOS hosts). Settings, Sessions, Tasks, Commits,
  Code and Knowledge are independently selectable. Results use a shared local
  field-weighted BM25 ranking over retrieved, deduplicated candidates, not fixed
  source interleaving or comparison of unrelated vector scores. BM25 uses
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
  requests include native bounded content for local BM25 and previews.
  Missing/truncated excerpts remain opaque candidates below lexical matches,
  as are configured semantic settings/task candidates, first/final session-excerpt
  matches, and semantic/full-message/patch commit candidates without visible
  lexical evidence.
  Source-local rank only breaks
  lexical ties; results remain capped at 60. This local ranking adds no provider calls or
  on-demand file reads. Only Code/Knowledge retrieval uses the normalized technical
  concept as its query (one shared native request for the selected domains); settings and sessions
  retain the original query. No general machine translation or extra source
  discovery is attempted.
- Optional global `search.rerankerModel` adds one remote pass over up to 100
  source-balanced Sessions/Tasks/Commits/Code/Knowledge candidates after all source
  operations finish, including late replies; local results remain visible while waiting.
  Settings are excluded and keep their locally ranked slots. The final relevance order
  is not re-sorted by BM25 and is capped at 60. Native retrieval skips its internal pass
  to avoid double reranking. History uploads only bounded titles/snippets, not full
  sessions or diffs; config/policy/history/native freshness checks fence upload and
  publication. Timeout/error keeps local ranking, and cancellation discards late replies.
  See [reranking safeguards](native-repository-search.md#optional-reranking).
- Search runs only on Search or Enter in the input. Typing/changing types cancels
  stale requests and clears results but never runs a query. Empty queries do not
  search. Activating a result is separate from submitting a query.
- Search modes are **Auto** (the default), **Search**, and **RAG**.
  Search remains the existing direct source lookup without an intent classifier.
  Auto calls the private ACP `pix/search/intent` method **only after an explicit
  search submission** (never while typing). The stateless classifier uses
  OpenRouter Decisions API and `~typesafe/jev-latest` by default, with an optional
  OpenRouter model override in Desktop `search.intentModelRef` (empty selects
  Jev). This preference is also used by the quick-task type classifier, independently
  of `search.ragModelRef` and `search.ragThinking`. The search intent request
  makes a single constrained `search | ask` choice. Only the entered query is sent; no workspace path,
  source results, transcripts, snippets or files are included in the request.
  Auto has a visible OpenRouter/cost disclosure and requires a saved OpenRouter
  credential. It is independent of semantic embedding configuration.
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
  Tasks, Commits, Code and Knowledge), reusing native lexical repository retrieval, the local
  session excerpt FTS and commit metadata/semantics. Source ranking reuses the
  current unified order (local BM25 or completed optional reranking), capped at 12 evidence items with at most four
  from each category. No duplicate vector index or full transcript/diff index
  is created. Code/Knowledge source files are reread by the ACP backend with
  realpath, regular-file and symlink checks, project-root containment, bounded
  file sizes (2 MiB), and cited line windows. Session evidence is reread from the
  authenticated canonical transcript, starting one message before the matched
  message through the last persisted branch head (or the whole branch when no
  message anchor exists). It preserves chronology and short user reversals.
  Missing/stale message anchors never fall back to client snippets. If the entire
  suffix cannot fit the remaining 30,000-character total / 28,000-character
  session budget, generation fails explicitly rather than dropping late turns.
  Commit messages are reread only for
  HEAD-reachable commits. Other source types use bounded search-result metadata.
  Unavailable/unsafe files are omitted; empty evidence does not invoke an LLM.
  Retrieved source content and the question are explicitly sent to the chosen
  model provider for RAG generation, separately from the Jev query-only intent
  classification and semantic-index configuration. Provider charges may apply.
- Generation runs in an isolated temporary Pi SDK ModelRuntime, without
  creating a Pi/ACP conversation/session or mutating project state. The private
  Desktop-only `pix/search/rag` request carries bounded evidence references,
  and `pix/search/rag_delta` sends validated text and the exact set of
  verified source IDs; request IDs prevent cross-query notification leaks.
  Source excerpts are untrusted data in the model prompt. The model must cite
  only supplied evidence as `[1]`, `[2]`, etc., and report missing evidence
  instead of inventing facts. Generation buffers text until citation syntax and
  bounds are checked and session revisions are revalidated. Missing, malformed or
  out-of-range references fail closed before answer text is exposed. This checks
  citation syntax/source identity, not semantic entailment. The prompt distinguishes
  proposals, authorization, promises, reported execution and independently verified
  outcomes; assistant reports are not filesystem proof. The output is displayed as Markdown in the
  existing search dialog with inline clickable citations and a source list.
  Each source reuses the same navigation as a normal Search hit (code line,
  knowledge line, commit diff, session, task or setting). Unknown citation
  numbers are inert. Generation supports cancellation and an owned 90-second
  deadline; stale completion after close/edit/filter/project change is ignored.
  RAG failures display the complete originating error message as plain text,
  including provider stream errors and backend validation/configuration failures,
  rather than an opaque availability notice. Line breaks are preserved and long
  messages wrap without truncation. Stack traces and arbitrary request/auth objects
  are not serialized for display. Cancellation and stale-request suppression remain unchanged.
- Desktop user settings at `search.ragModelRef` and `search.ragThinking` own
  the independent answer model and reasoning effort. Empty model reference
  means the normal Desktop default model; effort defaults to medium and supports
  Off, Minimal, Low, Medium, High, Extra High and Max. The structured Assistant
  settings use the existing catalog-backed model selector and a thinking-level
  selector. These settings are distinct from modelRouting/Auto, semantic-search
  embedding configuration and the currently active conversation model. Search mode and
  RAG generation do not automatically change the user's conversation.
- The dialog uses a compact input/filter/results layout. A persistent live
  footer spinner and `Searching…` label remain while the initial request or any
  late source is pending, including alongside partial results. Result-region
  busy semantics cover both states. Real source warnings, a compact semantic
  configuration status and brief provider/cost disclosures remain accessible in a
  collapsed `Search details` section with an explicit rotating Lucide chevron.
  The six result-type filter chips and the `Search settings` action live inside
  this disclosure, not in always-visible toolbar/footer rows. This is the only
  settings action in the dialog; the semantic status does not repeat it.
  Static implementation explanations (ranking, index mechanics, vector dimensions,
  query syntax and healthy backend diagnostics) are not shown here. A redundant
  `Current project` label is not shown; the dialog is already project-scoped.
  The mode switcher remains always visible and says only `Auto / Search / RAG`,
  with a short query/excerpt transmission notice for Auto/RAG. Expanded details
  disclose embedding-provider transmission/costs when configured and microphone
  transmission when supported. Warnings remain scrollable without clipping.
  Timeout notices are not repeated as
  warnings. Completed empty searches remain
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
- Tasks search reads the same `.pi/tasks.sqlite` rows as the Tasks panel and
  locally matches labels, descriptions, IDs, type, status, priority, links to
  project files/artifacts, parent task ID/title, related task IDs/titles in
  both directions, epic flag, assigned model/effort and associated `sessionId`
  across all tasks (including done). Linked attachment **names** are read from
  the SQLite association table in one background native query. File contents,
  attachment blobs and session contents are never searched as part of Tasks.
  Selection verifies
  the stable task ID still exists in storage, then reveals it in Tasks; it never
  runs or edits the task. If the panel has not loaded a newly added external task,
  selection asks to refresh Tasks rather than overwriting its current document.
  The reveal/scroll operation rechecks workspace, connection and navigation
  ownership after rendering so a cancelled or superseded selection cannot scroll
  a different project's panel.
- Task semantics use the global embedding configuration without a
  task-specific toggle. While the workspace is connected, bootstrap and task-store
  changes index task documents in the background, independently of searches.
  Enabling/changing the global provider resynchronizes the workspace. Queries
  rank existing document vectors and may send the entered query; background
  indexing sends only the task `title`+`description` (2,000-character combined cap
  per task) to the configured knowledge embedding model. Status, priority,
  IDs, hierarchy, links/paths, session/model assignment, attachment filenames
  and bytes are never included in the embedding input; existing user-authored
  description text remains eligible even if it itself contains paths.
  Task data never uses repository-search tables or the settings-only `documents`
  table: `pix_task_index_meta`, `pix_task_documents` and `pix_task_vectors`
  are separate table families in `.pi/search/tasks.sqlite`. Only IDs, content
  hashes and configured-dimension float32 vectors persist, not the task text.
  Embeddings are keyed by a hash of semantic text. Status/link/model changes
  reuse the same vector; description edits, renames and deletions reconcile
  changed IDs/hashes and prune unreferenced vectors. Queries validate returned
  hashes against the current SQLite corpus before surfacing any task hit.
  SQLite write ownership, revalidation and cancellation fence concurrent
  writes, provider responses after configuration changes/removal, and stale task payloads.
  Background workers drain changed/missing documents in bounded provider batches;
  task database creation, replacement and WAL-backed edits are detected, including
  external writers. Metadata-only edits reuse vectors; deletions reconcile references.
  Queries do not initiate task-document embeddings. Cached vectors are retained when disabled, but no further
  provider requests are made without valid global configuration.
  The ACP semantic task RPC returns bounded search hits, fused with the local
  task hits by stable task ID; a semantic-only hit is not discarded by lexical
  BM25 coverage rules. A disconnected, slow or failing ACP preserves fully
  usable local task search with an independent diagnostic.
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
  projects invalidates a pending older commit reveal. Tasks-only searches
  never invoke Git, and task embedding requires the global provider configuration. Missing Git or
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
- Hybrid commits use the global `~/.config/pi/pi-tools-suite.jsonc` `search.embedding` provider,
  knowledge embedding model, dimensions and prefixes; Desktop never selects or switches
  the provider or alters the code/knowledge index. OpenRouter credentials come only
  from `OPENROUTER_API_KEY`; unrelated legacy configuration and credentials are not read. The selected
  provider may receive commit messages/metadata and search queries. The dialog
  discloses that the first search may index the entire current HEAD history and
  incur provider costs. This uses the same global semantic configuration as repository
  search; history-specific settings remain separate.
  Commit data and vectors live in `.pi/search/git-commits.sqlite`, in the
  `pix_commit_meta`,
  `pix_commit_documents`, and `pix_commit_vectors` tables. They reuse unchanged
  commit hashes, content and compatible vectors across restarts and append new
  commits. Reachability filtering excludes commits no longer on current HEAD.
  Provider/model/dimension/prefix identity fences incompatible vectors; the
  settings and commits vector tables may use distinct dimensions/encodings.
  Legacy databases are not read, imported or migrated. Settings, Sessions and Tasks
  use `settings.sqlite`, `sessions.sqlite` and `tasks.sqlite`. Stop and restart older
  Pi/ACP/Desktop clients before using source-local stores: mixed-version writers
  do not honor the new ownership protocol and are unsupported.
  A changed incompatible embedding identity is never mixed with existing vectors.
  A retained incompatible Settings cache blocks only settings-vector access, not
  writes to the separate Task/Session namespaces. Compatibility errors report that
  an explicit rebuild is required; normal indexing never silently replaces paid
  vectors. Schema-2 Settings reconciliation belongs to Settings writes, not unrelated
  namespace writes; global content-addressed vectors are retained across catalogues.
  The global configuration editor explains recovery: run the suite's user-only
  `/search-semantic reset-history` from the affected project to explicitly discard
  derived project Task/Session/Commit vectors, never the global Settings cache.
  Canonical tasks, sessions and Git history remain intact;
  subsequent semantic searches can rebuild the cache and incur embedding charges.
  Missing config/key/provider retains local BM25 results and durable caches.
  Durable source-local ownership precedes paid batches. The publication fence is
  same-file only; there is no cross-database atomic transaction. The global
  `~/.config/pi/search-provider-work.sqlite` coordinates at most four valid local provider
  leases across projects/processes; after a crash or partition it cannot prove the count of
  remote provider executions. Source/provider leases renew every 30 seconds and expire
  after 90 seconds. A queued source renews its claim and rechecks it after acquiring a slot;
  cancellation retains ownership until tracked transport settles, and lost ownership cannot
  publish. After two failed/interrupted network attempts (initial plus one automatic retry),
  explicit Continue is required; success resets failures, and Continue clears the exhausted
  budget before reconciliation. A short failed-work cooldown applies. Crashes after
  transmission can still duplicate provider billing.
  Contention is bounded; cancellation preserves committed batches and does not
  evict live owners or delete the index. Query/filter edits and closing cancel
  provider work and invalidate late publication. Public user/assistant session
  text and eligible saved titles may be sent for semantic indexing; tool outputs,
  thinking, attachments, task attachments, diffs and file contents are not sent
  by this source. Provider
  failures are opaque and credential-free; native/local hits remain available.
- Settings search uses authored labels, descriptions and synonyms, never
  configured values, credentials or unrelated settings files. A result opens
  its exact section and focuses its stable field ID.
- The inline Settings sidebar and saved-conversation search box reuse the same
  Desktop authored settings catalog, local BM25 normalization/ranking, and
  explicit `pix/search/query` Search retrieval as Universal Search, scoped to
  their respective source only. Typing previews local catalog fields or visible
  saved session titles immediately, including partial-word matches; it does not
  start semantic/provider work. Enter or the compact Search control submits
  the current query to the shared ACP backend. No Auto intent or RAG runs from
  these fields. Settings matches filter the existing mounted field controls
  by section/field identity (unlisted advanced rows retain local filtering);
  session matches are shown only when their stable ID remains in the available
  saved-conversation list, so already open tabs never reappear through search.
  Editing, connection/project changes and unmount cancel requests and ignore
  stale completions; unavailable ACP leaves local previews usable. Independent
  global semantic configuration and provider disclosures still apply.
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
  `.pi/search/sessions.sqlite` matches first/final excerpts lexically without embedding.
  Public-message chunks have a separate local lexical index and may also be embedded
  as described below. Per-file size/mtime and text-projection-version fingerprints
  skip unchanged JSONL; projection changes refresh existing first/final excerpts.
  Changed, deleted and unmapped sessions are reconciled by background indexing.
  Session queries use cached SQLite titles/snippets and lexical/semantic chunks;
  they perform stat-only freshness checks and do not read whole JSONL transcripts.
  A changed or missing file is excluded until an eligible background index refresh
  updates the cache. Legacy caches lacking indexed-file/range records require
  background backfill; there is no query-time scan fallback. Chunk byte offsets
  and lengths address serialized JSONL message records; text start/end are UTF-16
  positions in sanitized projected text. Cached sanitized snippets suffice for
  results, so query-time range reads are unnecessary. Sessions without a cached
  title are skipped. Queries observe renames/deletions only after indexing.
  Selecting a result opens/activates and hydrates that session, without paging
  to or guessing a particular message. First/final excerpt retrieval remains
  lexical and independent of semantic embedding configuration.
- Explicitly saved session names may also be semantically indexed with the
  shared global provider configuration. Names obtained from `session_info` that are identical to the first
  user message remain local lexical fallback; only authenticated named titles
  are eligible. The session-map entry retains this title provenance so the
  search layer cannot accidentally embed the first-message display fallback.
  This title namespace remains separate from the public-message chunk namespace below;
  unnamed sessions are eligible for message indexing. A valid global provider
  configuration authorizes uploading existing and new public user/assistant text;
  without it, local lexical retrieval remains available.
  Explicit names are synchronized locally to the dedicated
  `pix_session_meta`, `pix_session_titles` and `pix_session_vectors`
  tables inside `.pi/search/sessions.sqlite`. Rename/delete reconciliation removes
  stale title rows and unused vectors; repeated identical names share the same
  content-hashed embedding. A name change cannot use a stale vector belonging
  to the old title. Provider work requires valid global configuration and any
  required credentials, is batched and serialized behind SQLite write ownership,
  and can be canceled on configuration change/removal or project replacement. Background
  indexing can continue after a query, while local lexical hits remain usable
  immediately. The configured knowledge model, dimensions, prefixes and endpoint
  apply; session metadata is separate from settings/commit
  model identity. Incompatible metadata fails closed instead of deleting
  previously paid vectors.
- Session search additionally covers all public user/assistant text on the last
  persisted parent-linked JSONL branch, including short approvals/reversals and
  assistant commentary labelled with its stop reason. It excludes tool bodies,
  thinking blocks, attachments and abandoned branches; it does not classify messages
  with JEV. Native session ID and header cwd must match the discovered source.
  Top-level `pix-html` fences (including the `html-sandbox` alias) are attachments:
  their fence and source are excluded from both roles' public text before chunking,
  embedding, first/final excerpt extraction and RAG evidence budgeting. Prose before
  and after them remains searchable. Backtick/tilde fences and case-insensitive
  language tags follow Desktop fence recognition; an unclosed attachment excludes
  the remaining text. Ordinary code fences, nested Markdown examples and inline
  mentions remain text. Attachment-only messages retain ancestry but produce no
  chunks. Offsets refer to the projected text, not the original message source.
  The canonical JSONL is unchanged. A projection-version change invalidates cached
  chunk revisions even for unchanged files; normal synchronization replaces old
  text rows, and live retrieval never ranks removed source via cached vectors.
  Unchanged prose hashes continue to reuse compatible paid embeddings.
  Corrupt, incomplete, redirected, oversized or cyclic transcripts fail closed.
  For this public-message reader, the file cap remains 64 MiB; the per-record
  text cap is 1,048,576 UTF-16 characters of combined public text, not raw JSONL
  size. Large image/tool/thinking records are fully validated in a cancellable
  worker with a 30-second deadline per large record, retaining ancestry and public text only.
  Ordinary small records parse locally. Invalid JSON, worker failures/timeouts
  and oversized public text reject the session without truncation. These rules
  do not change the separate first/final boundary reader's raw-line cap.
  Missing parent links remain fail-closed; physical file order never repairs them.
  UTF-16-safe chunks are at most 1,600 characters and retain message ID, offsets,
  role, ordinal and content hash. Results remain one per session; the best chunk
  supplies a snippet and message identity for RAG, while navigation opens the session.
  All production session discovery (search, manual and background) admits a
  session only at least **24 hours from creation**. Creation time is the native
  filename timestamp, else a bounded imported-session header timestamp, then
  filesystem birthtime; modification time is never an age fallback. Young entries
  retain only minimal age metadata and are not hydrated for title/body. Saved-title
  and public-message automatic indexing additionally waits for **one hour of
  inactivity per session**, using transcript modification time and persisted
  runtime activity. New activity resets that session's delay; a running agent
  blocks its own session via renewable cross-host leases, not other idle sessions.
  Startup reuses persisted activity without starting a new hour. Metadata-only
  eligibility checks run approximately every 30 seconds. Automatic discovery
  reads file metadata plus bounded 16 KiB identity headers for new/changed files,
  caching unchanged headers instead of calling SDK full-transcript listing.
  Only eligible changed revisions hydrate titles/bodies. ACP reconciles an admitted
  title individually, without rediscovering the corpus or pruning other sessions'
  paid caches. A read-only shared retry-budget preflight pauses automatic discovery
  while Continue is required; encountering that state during a sweep stops the
  remaining candidates. Existing matching cached
  vectors stay searchable; session queries never create document embeddings.
  Background discovery persists a single successful pass-start watermark in
  `pix_session_sweep` in the sessions cache, bound to embedding identity and
  logical cache incarnation/revision; it does not persist a per-file manifest.
  Only a fully successful title-and-chunk pass advances the checkpoint. Failed,
  deferred, cancelled, unreadable or missing-title work cannot certify it. After
  restart, eligible unchanged bodies can be skipped using transcript mtime/ctime,
  activity, mapped title update time and the creation-plus-24-hour deadline, with
  a conservative two-second overlap. Candidate discovery remains complete for
  queries; only indexing work is filtered. Metadata and bounded identity-header
  checks still run. A cache/model mismatch or backwards clock forces a full
  eligible sweep; partial cache writes may invalidate the previous cutoff.
  Manual Index/Continue is a full repair pass and seeds the same watermark only
  on full success. Because the checkpoint is scalar, one pending mature session
  may hold it back; successful unchanged attempts are reused in memory meanwhile.
  Manual Index/Continue bypasses the idle delay only, not the 24-hour creation
  minimum. Mature-file changes use directory events coalesced into dirty paths,
  bootstrap plus bounded five-minute missed-event reconciliation, and maturity
  deadlines that admit sessions even without events. The one-shot CLI fully
  reconciles. Optional ACP snapshot requests can warm the digest from a bounded
  1.5-second session snapshot; ACP reconnect falls back to native metadata.
  Session digests cover mature file revisions and mature mapped title/id aliases.
  Session-index logical revision is trigger-maintained and commit-coupled across
  title, metadata, chunk and vector content tables; work heartbeat, FTS, WAL and
  VACUUM changes do not affect it. Legacy caches remain read-only during status,
  using a bounded metadata fingerprint until a writer installs revision tracking.
  Shared CLI/Desktop receipts use the updated source fingerprint, so old receipts
  require a new manual pass.
  With a valid global provider configuration and credentials, existing and new
  public text is uploaded in batches of 16; unchanged hashes reuse paid vectors.
  Automatic/manual synchronization drains remaining work, checking eligibility
  around provider requests and before publishing automatic results.
  Failures do not create a paid polling loop; explicit Continue retries interrupted work.
  Search indexing diagnostics use Pix's shared JSONL logger in
  `~/.config/pi/logs/`, not a source-local `events.jsonl`. Terminal failures,
  incomplete passes, meaningful vector saves (debug), background-worker failures
  and repeated skipped-transcript causes are recorded with fixed, bounded
  metadata only. No per-session heartbeat/start/empty-success spam, file path,
  transcript ID or text, prompt, provider body or credential is logged.
  Repeated skip/worker causes are coalesced per workspace for five minutes.
  After a worker failure or operationally incomplete index, periodic recovery
  backs off to 2–15 minutes, while fresh changes and explicit Index/Continue
  can trigger earlier work. There is no separate Activity log in the index
  status panel; its inline statuses, error banners and per-source actions remain.
  Standalone Pi without the Pix log sink does not create separate search logs.
  Source leases are shared with Pi/TUI; publication rechecks transcript revision and
  provider authorization. Workspace replacement/disposal aborts owned work.
  Local lexical message search is available without embeddings. There is no
  message-filter setting or relation graph.
  Obsolete `messageFilterEnabled` writes are rejected; legacy config keys are
  ignored. Opening search polls cheap status without discovering transcripts
  or rerunning queries.
- Code/Knowledge use [native lexical-first repository search](native-repository-search.md)
  through the same packaged engine as agent `project_search`, without external indexing
  tools, keys or an active ACP session for lexical search. Native results preserve paths, line ranges and bounded content
  for navigation/reranking/RAG. Requests own cancellation and ignore stale completion;
  concurrent publications use SQLite generation checks. No provider setup occurs.
  A valid `search.embedding` object in `~/.config/pi/pi-tools-suite.jsonc` enables native
  semantic enrichment across all projects and sources, configured in ordinary Pi with
  `/search-semantic configure <embedding JSON>` or in Desktop Tools Suite → Search, with
  the shared suite draft and top Save button. Configure in Settings from Search indices
  opens and focuses the Embedding model field, including after asynchronous config loading. There is
  no independent consent flag or confirmation step. The shared disclosure covers eligible
  semantic inputs and possible costs. Lexical results publish before optional hybrid
  enrichment, with bounded incremental coverage notices. Configuration changes cancel/restart
  search; no active ACP session is needed to read/change the global configuration.
  Native failure reports a source-specific notice without an external backend fallback.
  Successful empty native results remain empty. Failed semantic enrichment retains
  already-published lexical evidence; other local source results survive.
  Legacy search panels, setup/update commands, installers and adapters are absent;
  existing user data is not modified.
- Semantic settings search uses the same global configuration as all other sources.
  Only authored settings metadata and submitted queries enter its embedding input.
  Workspace startup registers `id`, `section`, `label`, `description` and `synonyms`
  through `pix/search/sync`, independently of opening Settings or submitting a search.
  The normalized catalogue fingerprint controls rebuilds: additions, removals and
  semantic field metadata changes reconcile the index, reusing unchanged chunk hashes.
  CSS/layout changes and user configuration values are not embedding inputs and do not
  invalidate the catalogue. A new application build/startup catches catalogue changes;
  no source-code filesystem watcher or rebuild of every field on each search is used.
  Settings and Tasks report separate activity/errors; cancellation and source revision
  checks prevent stale publications after edits, provider changes or teardown.
  Settings/Tasks indexing waits asynchronously for the source-local writer for up to
  90 seconds, remaining active while queued. Cancellation interrupts this
  wait; expiration reports a source-specific busy error without invoking the batch's
  provider work. Other local writes retain the short 600 ms acquisition budget.
  Status polling does not schedule writes or retries. A successful indexing pass clears
  that source's error.
  The provider, knowledge model, dimensions, prefixes and endpoint are configurable;
  responses require matching identity and strict vector validation. Settings offers
  a native global provider editor and an all-project/all-source upload/cost disclosure,
  without source checkboxes or another confirmation. OpenRouter credentials resolve
  from `OPENROUTER_API_KEY`, then static Pi SDK auth storage; Ollama needs no
  OpenRouter key. Invalid/missing configuration, required credentials or provider
  failure leaves local lexical lookup usable.
- Pi and native Desktop config saves share a bounded configuration-file directory
  lock, preserve unknown fields, compare original contents before atomic publication,
  and reject unsafe/oversized files. Desktop revisions identify the full content,
  including manual edits. Lock leftovers fail closed; active owners are not evicted
  by age. ACP rejects obsolete per-source preference writes.
- Search uses five project-local source databases under `.pi/search/`:
  `sessions.sqlite`, `tasks.sqlite`, `git-commits.sqlite`, `code.sqlite` and
  `knowledge.sqlite`; shared Settings uses `~/.config/pi/search/settings.sqlite`.
  Settings owns schema-2 `metadata`, `documents` and `vectors`;
  history sources own their respective `pix_<domain>_*` tables. Native chunks,
  lexical indexes and compatible paid vectors coexist in each native source store.
  Short token-leased publications never hold a database writer lock over provider
  HTTP; see [decision 0070](../docs/decisions/0070-search-source-work-recovery.md).
  Session title vectors use `pix_session_*`, while text-only first/final excerpts
  use `pix_session_boundary_*` FTS5 tables in `sessions.sqlite`. Public-message
  chunks, transcript revisions and provider-namespaced vectors use the shared
  `pix_session_chunks`, `pix_session_chunk_fts`, `pix_session_chunk_meta` and
  `pix_session_chunk_vectors` tables. Searches validate fresh live-branch chunks;
  retained vectors alone never authorize a stale session result.
  Legacy stores are not generally read, imported, migrated or repaired. The sole
  exception is compatible schema-2 project-local Settings vectors: an owned write
  may import them transactionally after validating configured identity. Read-only
  legacy files are never changed/deleted; incompatible identity/schema is skipped,
  while corrupt compatible data rejects the transaction atomically. Schema-1
  Settings caches remain incompatible; explicit recovery is separate from normal
  indexing. Settings vectors persist by content hash across catalogue versions;
  each query filters results against the caller's authored catalogue. Read-only
  status/configuration polling never writes or repairs stores.
  Obsolete running clients must be restarted separately; restart is not forced
  while a live draft is present. Source-local indexes do not modify canonical
  task storage, session files or Git history.
- Settings hashes/vectors and model metadata survive restarts and reuse unchanged
  content. SQLite/in-process writer queues acquire ownership before paid settings
  batches, use bounded contention waits and do not reset/unlink the database.
  The canonical search/ tree, its WAL/SHM sidecars, and any retained legacy
  databases or local backup files in that tree survive manual Clean and
  background TTL; no cleanup action may delete or reset the canonical database.

## Constraints and failure cases

- The Desktop search interface and RAG are Desktop-only. Session message indexing
  is shared with Pi/TUI `project_search`, scoped to the current project. Public text
  and its configured embeddings may persist in the source-local search store.
  Embedding configuration and credentials are shared with ordinary Pi across projects.
- Sources fail independently. Disconnected ACP retains authored settings lookup;
  missing/busy repository search does not suppress settings/session results. Request failures
  never imply a disconnected backend. Unexpected exceptions stay opaque; known
  source failures are credential-free. Aborts publish no failure notices.
- Initial source waiting is bounded to 20 seconds, including overview waiting
  and the shared repository request. Completed sources publish immediately,
  including lexical repository results before optional semantic enrichment. Slow sources keep working and may
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
- `acp/src/search/rag-citations.ts`
- `acp/src/search/session-chunk-service.ts`
- `acp/src/search/session-transcript.js`
- `acp/src/search/session-chunks.js`
- `acp/src/search/session-chunk-sync.js`
- `external/pi-tools-suite/src/project-search/session-transcript.mjs`
- `external/pi-tools-suite/src/project-search/session-chunks.mjs`
- `external/pi-tools-suite/src/project-search/session-chunk-sync.mjs`
- `acp/src/acp/openrouter-jev.ts`
- `acp/src/search/session-boundary-reader.ts`
- `acp/src/search/session-boundary-index.ts`
- `acp/src/search/session-boundary-service.ts`
- `acp/src/search/session-boundary-paths.ts`
- `acp/src/search/embeddings.ts`
- `acp/src/search/index-store.ts`
- `acp/src/search/source-work.js`
- `external/pi-tools-suite/src/project-search/source-work.mjs`
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
- `desktop/src/lib/search-dialog-controller.ts`
- `desktop/src/lib/search-voice-controller.ts`
- `desktop/src/lib/deepgram.ts`
- `desktop/src/lib/settings-search-catalog.ts`
- `desktop/src/app/search-navigation.ts`
- `desktop/src/components/UniversalSearch.svelte`
- `desktop/src/components/NativeRepositorySemanticConsent.svelte`
- `desktop/src-tauri/src/native_repository_semantic_config.rs`
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
- `desktop/src-tauri/src/lib.rs`

## Tests

- `tests/pix-desktop-search-schema.test.ts`
- `acp/test/search.test.ts`
- `acp/test/search-intent.test.ts`
- `acp/test/search-rag.test.ts`
- `acp/test/session-chunks.test.ts`
- `acp/test/session-attachments.test.ts`
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
- `desktop/src/lib/search-dialog-controller.test.ts`
- `desktop/src/lib/search-voice-controller.test.ts`
- `desktop/src/lib/deepgram.test.ts`
- `desktop/src/app/search-navigation.test.ts`
- `desktop/src/components/UniversalSearch.test.ts`
- `desktop/src/components/WorkspaceSidebar.test.ts`
- `desktop/src/lib/settings-search-catalog.test.ts`
- `desktop/src/components/DesktopModalDialogs.test.ts`
- `desktop/src/components/DesktopVisualRegressions.test.ts`
- `desktop/src-tauri/src/lib.rs`

## Verification

Run Desktop typecheck and focused search/queue/navigation/settings/modal tests,
ACP typecheck/build/search/agent tests and schema generation/tests. Cover title
boost, Robertson IDF, saturation, length normalization, explicit hybrid mode in
both native domains, bounded/redacted source-failure notices, and native request cancellation.
Also cover title deduplication/scope/renames/deletions, authenticated public-text
projection and exclusion of private/tool/attachment content, cache-only session
document vectors on queries (query embedding remains permitted), obsolete-schema
rejection without mutation, source-local vector preservation,
restart/hash reuse, contention, cancellation, revocation and stale completion.
Real macOS QA checks explicit submit, Sessions labels, settings/file/session
activation and native-search failure isolation, task reveal, commit metadata, and close/reopen
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
