---
kind: spec
status: active
---

# Desktop search index status

Source ownership and uncertain-work recovery are specified in
[decision 0070](../decisions/0070-search-source-work-recovery.md).

## Goal

The workspace sidebar's **Search indexes** panel explains local search stores per source.

## Behavior

- Sources: Code, Knowledge, Settings, Sessions, Tasks, Git commits. Each source row has an accessible checkbox; the five non-Settings source selections are project-local, while Settings is global across projects and synchronized with Desktop Settings → Assistant → Search settings. The Local cache column shows cached file/session/task/commit counts, with Settings showing available authored fields, rather than chunk counts or live source totals. Code and Knowledge counts are cached files; Sessions counts distinct session IDs present in cached title or public-message chunk tables. Counts describe cached entities, not current corpus totals. Stored vectors are retained cache, not proof of current coverage. Turning a source off retains its cache.
- Data comes from read-only status commands; reads never create, migrate or repair stores. Code, Knowledge, Sessions, Tasks and Git commits use independent SQLite files under the selected project's `.pi/search/`; Settings uses shared `~/.config/pi/search/settings.sqlite`. Settings source-work coordination and manual-run records are also global; coordination and manual-run records for the other five sources remain project-local. Compatible schema-2 legacy project Settings vectors may be imported only during an owned write, after validating configured identity; the transaction is atomic. Read-only legacy data is never changed/deleted. Incompatible legacy identity/schema is skipped; corrupt compatible data rejects the import atomically and leaves the legacy source untouched. Project indexing must repair or move that legacy file before retrying; it does not silently repair or ignore unsafe paid data. Global Settings vectors are retained by content hash across authored-catalogue versions, and each query filters against its caller's authored catalogue. Read-only status never imports. A single workspace-scoped UI controller owns polling/manual action state; Settings selection and invalidation are global across workspaces. Refresh, project/client changes and teardown invalidate stale completions.
- Activity Bar Search-index indicators and source spinners use reported index-worker activity, not local Tasks change checks. Tasks watcher debounce and asynchronous corpus scans are reported separately as `checkingSources.tasks`; checks neither set aggregate `indexing` nor appear in `indexingSources`. The Search sidebar icon, activity history, and semantic source spinner therefore do not report checks as background indexing. An active index worker remains reported as active even when it is waiting between provider requests; this is not a guarantee that a provider request is underway. The Tasks panel icon is unrelated and unchanged. The Activity Bar uses the [central indicator manager](../desktop/workbench/desktop-sidebar-indicators.md): error for diagnostic/source/manual failures; informational reasons retain reported source activity/manual-run metadata but do not color the icon or animate; warning for missing/partial local indexes, incompatible caches, unavailable configured credentials, missing semantic vectors unless the local corpus is known empty, or a partial/stopped manual run. Active work takes precedence over pending coverage, but errors always win; pending reasons remain in the context menu. Unknown state, disabled semantics alone, and Stored counts do not establish missing coverage or freshness. Every reason offers Inspect search indexes. Ordinary status reads never animate the Activity Bar.
- There is no Details section. Row diagnostics remain available as cell tooltips, including chunk/vector counts. The semantic footer shows a short status and Settings link. Settings local count comes from the authored catalogue, while its cached vectors come from the settings-owned tables.
- Active semantic cells show visible Indexing or Stopping text beside a compact indeterminate ring. Sessions include both saved-name and public-message vectors; local message-chunk counts remain a separate unit. Session status counts are computed only from cached title/chunk session IDs (distinct union), tolerate a missing table, and do not discover source sessions or use the network. These are not per-run completed/total counts and never produce a percentage. Source-specific labels remain accessible; reduced-motion disables rotation. Partial native scans may expose their retained file count without being marked Ready.
- Incompatible caches show Needs rebuild for their own source, not a generic provider failure. Schema-1 Settings configuration is rejected without mutation. All semantic source statuses reflect `search.embedding` in the shared global `~/.config/pi/pi-tools-suite.jsonc` configuration and required credential availability; credentials and caches alone do not activate semantics. A configured source with no reported store remains Unavailable/unknown rather than Not indexed; Not indexed means a known store reports no vectors. Stored means vectors are retained, not that they cover or are fresh for the current corpus.
- Native status-read failures show a bounded, single-line reason from the native string/Error message in the status banner, with a generic fallback when no usable reason is available. A successful Refresh clears the banner error. Raw provider errors are not sent to the shared Pix Logger; the panel retains only current status.
- Project-local source selection is the optional `search.sources` map in the project's `.pi/workspace.jsonc`. It accepts only boolean `code`, `knowledge`, `sessions`, `tasks`, and `commits` entries; Settings remains global in `~/.config/pi/search/settings-enabled.json` and its Assistant Search toggle. Missing workspace/search/map/flags defaults Code on and every other project source off. Workspace files are limited to 64 KiB. Malformed/unsafe workspace configuration or an invalid source map fails closed with all six sources off. Global provider configuration remains required for embeddings and does not override source selection. Old `.pi/search-sources.json` and its lock are not read, imported or migrated; existing search caches are retained.
- Workspace JSONC edits preserve comments, trailing commas, unknown sibling fields, and unrelated project settings. Writers coordinate across native Node/Bun saves, Rust workspace compare-and-swap and generic editor writes, and Registry workspace pulls through the permanent `.pi/workspace.jsonc.lock/writer.sqlite` SQLite mutex (`BEGIN IMMEDIATE`). Registry checks its expected local state while holding the lock and records provenance from the immutable installed bytes, not a later reread after releasing the lock. Manual and TTL cleanup preserve `.pi/workspace.jsonc` and the lock subtree. Source-selection saves update only their requested setting; whole-document saves preserve the existing search revision when effective source flags are unchanged, and effective flag changes stamp a new revision. Unrelated Explorer/Usage edits do not invalidate searches. Generic editor writes to the workspace file require a loaded-content snapshot and reject missing/stale snapshots; target resolution accounts for path aliases. External noncooperating editors that change and restore content between observations are not guaranteed detectable. Atomic temp-file replacement is used; do not claim universal power-loss durability.
- Selection controls manual/background indexing and every search path, including lexical fallbacks. Turning a source off cancels owned work and rejects stale completion, disables its manual action and hides it from Universal Search filters and `project_search` metadata. Caches are retained and reusable after re-enable. Failed or malformed saves retain the previous valid selection. An interrupted response may already have applied a workspace write: reread before retrying. Disabled rows show Off regardless of retained vector counts.
- Disabled sources do not contribute activity or retained-cache warning/error reasons to the Activity Bar; policy-read errors remain visible. Operation revisions fence disable/re-enable between watcher observations, including checkpoints before paid work and publication. No-op selections retain the same revision. ACP status exposes invalid-policy errors and retains the project catalogue and watcher when a status read observes a changed policy before its watcher callback.
- Native diagnostics reject redirected `.pi`/search directories, non-regular or hardlinked databases, and unsafe SQLite sidecars before opening them. Views in the owned `pix_*`/`metadata` namespaces are rejected before count/metadata queries, so recursive views cannot turn a diagnostic read into unbounded execution. Reads do not mutate targets. This is validation at read boundaries, not a guarantee against arbitrary concurrent replacement by an actor who can mutate the storage directories.
- Configure in Settings opens Tools Suite → Search and focuses the Embedding model field, including after asynchronous settings loading. Provider selection uses the shared custom selector; changes use the suite draft and top Save button, not a separate semantic save action. Removing configuration stops new embedding work and retains cached vectors.
- Each source has its own Index/Stop/Continue action; only that row spins for its manual run. Code/Knowledge use the cancellable native transport without ACP; Settings/Sessions/Tasks/Commits require the workspace ACP connection and use `pix/search/index`, not a synthetic search query. A run adds missing/changed content under the existing global semantic authorization; provider charges may apply, as disclosed in the action tooltip. Native and ACP document-only passes drain all eligible missing documents in batches of at most 16; manual indexing has no overall 128-document cap or overall native CLI/Rust/semantic deadline. Session manual discovery also has no interactive 15-second title-discovery timeout: it remains caller-cancellable, authenticates a refreshed list, and reuses that list for the chunk pass instead of scanning a third time. Interactive query discovery keeps its short timeout. Per-request HTTP timeouts, cancellation and storage safety bounds remain. Explicit indexing does not embed a search query or rank search results. It never resets caches, migrates providers or changes canonical tasks/sessions/history. Missing configuration/credentials, unavailable history connection, active work and known incompatible caches disable the relevant start action. Incompatible caches still require separately authorized recovery.
- Code and Knowledge manual actions start independently, without a shared UI FIFO or Queued state. Both rows may show active indexing concurrently. Cancelling one source does not stop the other; same-source repeated starts remain blocked until its transport settles, including after cancellation or configuration reset. Backend source ownership and the shared global provider limit remain unchanged.
- Git commits and Sessions hide Index/Continue only when read-only source inspection confirms an empty history, never from a zero/missing cached document or vector count. A running request retains Stop. Native Git inspection distinguishes an unborn branch from missing/corrupt refs; uncertainty keeps actions visible. ACP `pix/search/config` accepts optional `includeSourceStatus: true` and checks saved-session metadata at most once per 30 seconds per workspace, counting unnamed sessions too. The optional hint has a one-second budget and uses background metadata discovery, never interactive SDK transcript hydration. Timeout/failure clears the hint to unknown without blocking the activity response; the discovery slot remains occupied until the underlying read settles, and late results cannot publish. Discovery never reconciles caches or starts embeddings. Confirmed empty sources show 0 items and do not contribute missing-index indicator reasons.
- Index actions are compact icon-only buttons: Play starts indexing, StepForward continues a partial run, and Square stops a running manual run. Each retains an accessible action-and-source label and a descriptive title explaining the action or why it is unavailable; disabled states and handlers are unchanged. The adjacent Configure semantic search action is a Settings gear icon with an accessible label and title identifying the Embedding model destination. The narrower actions column keeps the source table compact.
- Manual runs return a source-specific complete/partial/error result with available coverage counts and a safe explanation. The source row and its tooltip expose the outcome; incomplete runs offer Continue rather than implying full coverage. ACP records metadata-only incomplete-run diagnostics for both Sessions and Git commits, including the fixed failure phase/reason (when known), coverage counts (when available), and elapsed time, not provider messages or history contents. Repeated clicks on a running source do not launch duplicates. Stop, panel close, workspace/client replacement and configuration changes cancel owned requests and suppress stale results; committed batches are retained. Settings/Tasks background work has independent workspace ownership and is not stopped merely by closing the panel. Source/provider leases renew every 30 seconds and expire after 90 seconds; queued work remains renewed and rechecks ownership after acquiring a slot. Cancellation retains ownership until tracked transport settles, and lost owners cannot publish. After two failed/interrupted network attempts (initial plus one automatic retry), explicit Continue is required; success resets failures, and Continue clears the exhausted budget before reconciliation. The shared global coordinator has at most four valid local leases, not a provable remote execution cap after crash/partition. A short cooldown applies; crash-after-transmission billing can duplicate. No Index all action is provided. Knowledge "dirtiness" and acknowledgment are not readiness criteria here.
- Stop immediately changes the visible phase to Stopping, while the running slot remains occupied until transport settlement. The final stopped state offers Continue and never publishes a late success from an aborted run.
- Closing the panel retains settled/manual-stop outcomes in the workspace controller and does not stop diagnostic polling. Opening it again reuses that controller; workspace/client replacement clears its state. A successful retry or configuration reset clears prior manual attention, while a panel visit alone does not acknowledge failures.
- Outside the status panel, the connected workspace registers its authored Settings catalogue with ACP `pix/search/sync`, even when Settings/Search are closed. Enabled Settings metadata changes and saved task changes drive background indexing; bootstrap reconciles offline changes. Task change detection (debounce and asynchronous corpus scan) is checking, not indexing; after shutdown it is no longer reported as checking. Configuration changes resynchronize the active workspace. Settings/Tasks/Sessions queries reuse maintained document vectors and may embed the submitted query. All production session discovery (search, manual and background) admits only sessions at least 24 hours after creation: native filename timestamp, else bounded imported-header timestamp, then filesystem birthtime; modification time is never an age fallback. Young sessions retain only minimal age metadata and are not hydrated for title/body. Automatic indexing additionally requires the existing one-hour idle/running fences; manual indexing bypasses idle only, not the 24-hour minimum. Mature session changes are tracked by directory events coalesced into dirty paths, with bootstrap and bounded five-minute missed-event reconciliation; age deadlines admit sessions without an event. One-shot CLI discovery fully reconciles. ACP snapshot requests may opt into a 1.5-second-bounded session snapshot to warm digest state; reconnect falls back to native metadata. Session source digests include mature file revisions and mature mapped title/id aliases. The session index revision is trigger-maintained and commit-coupled across title, metadata, chunk and vector content tables; work heartbeats, FTS, WAL and VACUUM are excluded. Legacy caches remain read-only during status with a bounded metadata fingerprint until a writer installs tracking. Shared CLI/Desktop receipts use these source digests; old receipts require a new pass.

- Automatic session indexing persists one successful pass-start watermark in `pix_session_sweep` in `.pi/search/sessions.sqlite`, bound to embedding identity and logical cache incarnation/revision, not a per-file manifest. Only a fully successful title/chunk pass advances it; failures, deferred/cancelled/unreadable work and missing titles do not certify it. Restart selection may skip unchanged bodies using mtime/ctime, activity, mapped-title update time and creation + 24-hour admission, with a conservative two-second overlap. Metadata, bounded identity headers and eligibility checks still run, while query candidate discovery remains complete. Cache/model mismatch or backwards clock forces a full eligible sweep; partial writes may invalidate the previous cutoff. Manual Index/Continue is a full repair pass and seeds the same watermark only on full success. One pending mature session may hold back the scalar watermark; successful unchanged attempts are reused in memory meanwhile.

- Unrelated spread-prop updates (task/git refreshes or switching sidebar tabs) must not recreate the search controller or re-register the settings/task catalogue. Identity-only derived workspace/client values fence the Svelte effects.
- The sidebar receives an ACP client only after initialization reaches Ready. Status/configuration reads and catalogue registration never race transport startup; initialization failure/disconnection removes that client without disabling local native diagnostics.
- The index status panel intentionally has no embedded Activity/log history,
  log-clear control or Last runs disclosure. Per-source action outcomes remain
  available in the current table, errors/status banners, and tooltips. Relevant
  search and indexing failures instead go to the shared Pix JSONL logger at
  `~/.config/pi/logs/`, available via the separate opt-in Logs sidebar.

## Diagnostic recovery

Startup reads show **Checking…**, not Off or an unavailable cache before the
selection/count response arrives. A failed count read retains the last successful
counts with a visible timestamped warning; these are not presented as a fresh read.
Diagnostic failures retry after 1, 2, 4, 8… seconds, capped at the normal interval
(30 seconds idle, 1.5 seconds active). Successful recovery returns to ordinary
polling. The five-second read deadline, single-flight transport ownership,
generation guards and teardown cancellation still apply; retries never start
indexing. These recovery rules do not establish the cause of a particular native
startup failure.

Count and activity errors include a bounded diagnostic reason (up to 240 characters)
and an automatic-retry notice; a failed activity read does not discard readable counts.

## Snapshot coverage and cheap change checks

An ACP `pix/search/config` request may include an optional 1.5-second session digest snapshot. Its timeout or read failure omits only `sessionSnapshot`: the remaining status still succeeds and the native freshness probe can proceed without that digest. Caller cancellation still rejects, and a late digest cannot be published after the deadline.

Each source also displays two independent facts:

- **Unchanged / Changed** compares Code/Knowledge content against the committed
  indexed file manifest, independently of a manual receipt. Settings, Tasks,
  Sessions and Git commits compare their source digest against the coverage
  digests recorded in their own index by the last complete, stable writer pass
  (manual or background); without a coverage table they fall back to the last
  stable manual receipt. It is an observation at the tooltip's check time,
  not continuous freshness or a content-integrity audit.
- **No baseline** (`untracked`) means metadata was read successfully but no
  recorded manual pass exists for comparison (a source whose existing index
  reports manifest or coverage comparison can instead show Unchanged/Changed).
  It does not mean the cache is empty
  or search is broken. **Check unavailable** (`unchecked`) means a check could not
  establish a recent observation. **Index changed** (`index-changed`) means the
  physical cache changed or disappeared since the recorded pass; SQLite maintenance
  and background indexing may also cause this state.
- **Cache changing** (`index-changing`) means the cache changed during
  the check itself: logical content/vector membership for Code/Knowledge, physical
  cache metadata for other sources. SQLite maintenance alone does not invalidate
  Code/Knowledge. This is not
  an unavailable cache or evidence of complete coverage. The last-pass result
  remains historical. Checks keep the normal 60-second metadata cadence rather
  than repeatedly scanning the repository while another process writes.
- **Last pass full / Last pass partial / No recorded pass / Pass unverified** describes that
  historical pass, not a percentage inferred from cached entities/vectors and
  not certification of subsequent cache writes. Existing caches without a
  receipt show No recorded pass or Pass unverified until a manual Index/Continue establishes one.
  Changed storage does not erase historical pass coverage or certify current coverage.
  CLI `check` uses the same states and historical coverage rules.

The workspace controller runs a read-only `snapshot-probe` through the owned
native child (`native-cli.mjs` accepts `operation: "snapshot-probe"` and returns
per-source observations or an unchecked/error result). Automatic observations are cached for 60 seconds (including while
the ordinary status loop polls faster); explicit Refresh forces a check. Checks
older than 120 seconds, incomplete/failed checks, and disabled sources are not
shown as current. Errors never mean an empty successfully checked corpus.
Failed freshness transport reads retain the historical receipt, discard the
current observation/live run state, and become eligible for another read after
five seconds rather than caching a transport failure for a minute. A successful
shared read that reports a missing receipt remains authoritative.

Probe failures expose only whitelisted fixed diagnostics, including
`Index changed during check`; arbitrary exceptions, paths and content are not
returned. Old observations (including Cache changing) expire after 120 seconds.

| Source | Cheap observation |
| --- | --- |
| Code / Knowledge | Shared bounded Git candidate enumeration (non-Git walk fallback), native classification/ignore rules and stat validation. Reuse a published hash when file identity matches; otherwise read/hash that candidate with normal eligibility checks. Compare the sorted path/content-hash manifest with the committed index, not DB timestamps. |
| Settings | SHA-256 of the authored in-memory settings catalogue |
| Tasks | Bounded read-only SQLite snapshot of task IDs, payloads and row revisions, ordered by ID. WAL checkpointing, VACUUM and board-position-only changes do not change this signature; committed additions, edits and deletions do. Missing storage is not created; invalid/unsupported or oversized stores return Unchecked. |
| Sessions | Creation-age admission (24 hours from native filename timestamp, bounded imported-header timestamp, or filesystem birthtime; never mtime), bounded native-directory enumeration and ACP map metadata, plus mature transcript revisions; young entries retain only minimal age metadata and no title/body hydration |
| Git commits | HEAD OID, replacement refs and shallow/grafts metadata; no history/log scan |

For Settings, Tasks, Sessions and Git commits the observed source digest is
`sha256(["source-coverage-v1", source, revision, identity])`, where identity is
the effective semantic embedding identity (provider, model, dimension, prefixes,
base URL) or null. It excludes the workspace path, configuration-file timestamps
and source-selection revisions, so comment-only config edits or Desktop/CLI
restarts do not report Changed; an embedding change does. The Settings revision is
the shared `settingsCatalogueDigest` used by Desktop, sync and the CLI.

Writers record coverage digests in a `pix_source_coverage(digest, recorded_at)`
table inside the source index database, in the same transaction as the final
write: Settings after a drain with no pending change (keep 16 catalogue
variants), Tasks after a final pass whose task snapshot is identical before and
after (keep 1), Sessions when a sweep completes with every admitted session
indexed and a stable session snapshot (keep 1), and Git commits when every
commit document has a vector and the commit stamp is unchanged across the pass
(keep 8). Incomplete, cancelled or racing passes record nothing. The read-only
probe reads that table between its store fences; read failures simply omit the
comparison.

Git commits are also indexed in the background: ACP polls the commit stamp of
each synced workspace (at most eight) every 60 seconds and starts a commit index
pass only when the stamp differs from the last attempted one and no matching
coverage is recorded. Failed passes are not retried for the same stamp except
for transient failures; disabled sources, missing semantic configuration and the
automatic-work pause suppress polling work.

Code/Knowledge include the effective per-source embedding identity so a model
change during a manual pass cannot certify the old configuration. Classification
changes affect the effective file manifest rather than config-file timestamps.
The repository scan
shares the existing native scan caps and a three-second budget; the overall probe
has a four-second abort budget and the UI diagnostic lane remains timeout-bound.
Session enumeration/map entry limits are 10,000; the map read is capped at 4 MiB.
Oversized/binary/linked candidates use the same exclusion rules as indexing.
The v2 native schema adds `pix_native_stamps` (path, content hash, stat identity),
published in the existing generation-CAS transaction. Writer migration from v1
is additive and preserves lexical data and vectors. A read-only probe never
migrates: old/missing stamps require content reads until the next normal local
index publication. With matching published stamps, source bodies are not read.
Touched-but-identical files are rehashed but remain Unchanged; repeated checks
rehash them until a writer publishes their new stamps. Stat identity reuse is an
advisory optimization, not protection against deliberately spoofed metadata.

Manual Index/Continue obtains source observations before and after the existing
index operation. Only a matching, stable pair plus a valid backend outcome can
produce a receipt. Changes during the pass return incomplete/Continue, retaining
reusable embeddings. Abort, workspace teardown, configuration invalidation and
stale completions cannot publish a new receipt. A failed probe does not prevent
the indexing operation itself, but cannot establish verified coverage.

Desktop and the standalone shell command now share receipts in the derived
project store `.pi/search/manual-runs.sqlite`, separate from source index files.
Old `pix.search-snapshot.v1:` localStorage receipts are not imported or trusted by
the production controller. Receipts contain only opaque digests, completion flags
and timestamps; run records also retain state and sanitized counts (not document
text, secrets, PID-based kill targets or raw provider errors). Reopening requires
a new metadata observation, never trusts the old timestamp alone.
For Code/Knowledge, bounded read-only transactions validate the schema and read
file hashes plus vector keys and lengths (not vector payloads). Before/after
logical snapshots fence concurrent changes. Generation, completion timestamps,
stamps and vector leases are excluded: no-op publications, checkpoint and VACUUM
do not invalidate the observation. Vector membership is not an integrity audit.
For other sources, cache DB/WAL/journal metadata is observed before
and after each probe; concurrent changes make it unchecked. Empty WAL/journal
sidecars created by SQLite readers are equivalent to absent sidecars. A later cache stamp
change or removed index invalidates current-snapshot verification, while retaining
the explicitly historical last-pass coverage. The standalone shell
command and Desktop manual passes both produce shared receipts. Background and
legacy session-owned `/search-index` indexing do not manufacture receipts; the
historical last-pass row keeps its receipt semantics, but Unchanged/Changed for
these sources comes from writer-recorded coverage, so complete background passes
restore Unchanged without a manual run. Without coverage, changed caches show
Index changed until a new stable shared manual pass (or Changed if source
metadata also changed). This deliberately favors false invalidation over
false freshness, and does not promise transactional certification of the index
between the backend response and the subsequent observation.
Code/Knowledge instead compare the current content manifest with their index,
including after background/local lexical indexing; this never manufactures a
semantic pass receipt or upgrades unknown historical coverage.

Checks create no index/cache files, request no query/document embeddings, and
never initialize providers. Session metadata discovery is event-driven for mature
files, with bootstrap and five-minute bounded reconciliation; a maturity deadline
admits a file even without an event. Existing one-hour automatic idle/running
fences remain in addition to the 24-hour creation minimum; manual indexing skips
only idle gating.

## Standalone control

From the checkout, `npm run search:index -- <command> [source|all] [--project PATH]`
works without a Desktop/ACP session. Sources are `code`, `knowledge`, `settings`,
`sessions`, `tasks`, and `commits`; Settings uses the same authored catalogue as
Desktop (no configuration values). Output is JSON; `--json` is accepted explicitly.

- `status [source|all]`: enabled policy, stored counts, last shared run/receipt.
- `check [source|all]`: additionally perform a read-only metadata freshness check.
- `index <source|all>` / `continue <source|all>`: foreground explicit manual pass;
  both reuse cached batches, and `all` visits only enabled sources sequentially.
  No provider/model is configured or source enabled implicitly. Provider charges
  may apply. Partial completion exits 2; failures exit 1; Ctrl-C exits 130.
- `stop [source|all]`: cooperatively cancel shared manual owners (CLI or Desktop),
  never unrelated processes or background/legacy slash-command indexing.
- `enable <source>` / `disable <source>`: explicitly update source selection,
  without starting indexing. These require one named source; Settings changes the
  global flag, while the other sources update the selected project's policy.
- `migrate settings`: provider-free compatibility import requiring valid configured
  embedding identity and globally enabled Settings. Returns canonical shared
  Settings database path and reusable vector count; leaves the legacy project
  database untouched.

`status`, `check`, and `stop` default to `all`; mutation/index targets must be
explicit. Missing control storage stays missing on status/check/stop. Each source
has a random owner token and 60-second lease, renewed every 5 seconds. Stop is
observed on heartbeat; an `all` sweep also owns a batch lease and checks its
cancellation before each source and before backend work, so `stop all` fences
the queued tail even between sources. Committed batches remain reusable. Transport teardown is
awaited before finalizing; stale owners cannot publish receipts over a successor.
Crashed/expired runs become `interrupted`, not complete. Existing index writer
leases and provider limits remain authoritative and independent. CLI results
become visible in Desktop on its next freshness poll (up to 60 seconds) or Refresh;
external active runs show Indexing/Stopping and block duplicate UI starts.

Focused checks: `node --import tsx --test tests/search-index-cli.test.ts`,
`node --test external/pi-tools-suite/test/index-control.test.mjs`, and
`npx tsc -p scripts/search-index.tsconfig.json`.

## Implementation

- `scripts/search-index.ts`
- `external/pi-tools-suite/src/project-search/index-control.mjs`
- `external/pi-tools-suite/src/project-search/managed-index-run.mjs`

- `desktop/src/components/SearchIndexPanel.svelte`
- `desktop/src/lib/search-source-selection.ts`
- `external/pi-tools-suite/src/project-search/native-cli.mjs`
- `acp/src/search/source-policy.js`
- `acp/src/search/source-policy-lock.js`
- `external/pi-tools-suite/src/project-search/source-policy.mjs`
- `external/pi-tools-suite/src/project-search/source-policy-lock.mjs`
- `desktop/src/lib/search-index-status.ts`
- `desktop/src/lib/search-index-monitor.ts`
- `desktop/src/lib/search-index-read-lane.ts`
- `desktop/src/lib/search-index-controller.ts`
- `desktop/src/lib/workspace-search-index-controller.ts`
- `desktop/src/lib/workspace-search-index-owner.svelte.ts`
- `desktop/src/app/desktop-navigation-view-model-services.ts`
- `desktop/src/lib/search-index-indicators.ts`
- `desktop/src/lib/search-index-actions.ts`
- `desktop/src/lib/native-repository-search.ts`
- `desktop/src/lib/search-index-sync.ts`
- `desktop/src/lib/acp-client.ts`
- `desktop/src-tauri/src/search_index_status.rs`
- `acp/src/search/source-work.js`
- `desktop/src/components/WorkspaceSidebar.svelte`
- `desktop/src/components/WorkspaceSidebarActivityBar.svelte`
- `acp/src/search/contract.ts`
- `acp/src/search/request.ts`
- `acp/src/search/service.ts`
- `external/pi-tools-suite/src/project-search/snapshot-probe.mjs`
- `external/pi-tools-suite/src/project-search/source-coverage.mjs` (mirrored to `acp/src/search/source-coverage.js`)
- `external/pi-tools-suite/src/project-search/commit-stamp.mjs` (mirrored to `acp/src/search/commit-stamp.js`)
- `external/pi-tools-suite/src/project-search/session-watermark.mjs`
- `acp/src/search/settings-task-indexer.ts`
- `acp/src/search/session-chunk-service.ts`
- `acp/src/search/commit-service.ts`
- `acp/src/search/commit-worker.ts`
- `desktop/src/lib/search-index-freshness.ts`

## Tests

- `desktop/src/lib/search-index-status.test.ts`
- `desktop/src/lib/search-index-monitor.test.ts`
- `desktop/src/lib/search-index-controller.test.ts`
- `desktop/src/lib/workspace-search-index-controller.test.ts`
- `desktop/src/lib/workspace-search-index-owner.test.ts`
- `desktop/src/lib/search-index-indicators.test.ts`
- `desktop/src/lib/search-index-actions.test.ts`
- `desktop/src/lib/native-repository-search.test.ts`
- `desktop/src/lib/search-index-sync.test.ts`
- `desktop/src/lib/acp-client.test.ts`
- `desktop/src/components/SearchIndexPanel.test.ts`
- `desktop/src/app/desktop-navigation-view-model-services.test.ts`
- `desktop/src-tauri/src/search_index_status.rs`
- `acp/test/search-source-status.test.ts`
- `acp/test/search-sync.test.ts`
- `acp/test/source-policy-lock.test.ts`
- `acp/test/fixtures/source-policy-writer.mjs`
- `external/pi-tools-suite/test/source-policy.test.ts`
- `desktop/src/lib/search-source-selection.test.ts`
- `external/pi-tools-suite/test/snapshot-probe.test.mjs`
- `acp/test/commit-search.test.ts`
- `acp/test/search-task-semantic.test.ts`
- `acp/test/search-mirror-parity.test.ts`
- `desktop/src/lib/search-index-freshness.test.ts`

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"06df5ddb3c83bf8f359795895e91f69d3a97c72fac3fa729b926731ddd6ca1ac","checkedAt":"2026-10-31T00:03:39.444Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":57,"reportLanguage":"ru"} -->
