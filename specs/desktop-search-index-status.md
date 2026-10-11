---
kind: spec
status: active
---

# Desktop search index status

Source ownership and uncertain-work recovery are specified in
[decision 0070](../docs/decisions/0070-search-source-work-recovery.md).

## Goal

The workspace sidebar's **Search indexes** panel explains local search stores per source.

## Behavior

- Sources: Code, Knowledge, Settings, Sessions, Tasks, Git commits. A compact table shows local chunk/item counts when known and short semantic statuses (Off, Needs setup, Not indexed, Stored, Needs rebuild, Unavailable). Missing local indexes are On demand; direct-source lookup is Direct; incomplete scans are Partial. Stored (formerly Cached) means retained vectors, not a guarantee of freshness or current-provider coverage; Not indexed means no reported saved vectors. Explanations remain in tooltips, not footer paragraphs. Active and settled table cells share a fixed-height single-line container so spinners and narrow columns do not change row height.
- Data comes from read-only status commands; reads never create, migrate or repair stores. Each source has an independent SQLite file under `.pi/search`: `code.sqlite`, `knowledge.sqlite`, `settings.sqlite`, `sessions.sqlite`, `tasks.sqlite`, and `git-commits.sqlite`. Counts/configuration/ACP activity publish independently, with separate diagnostic errors. Refresh retains prior results; the header refresh indicator spins only for opening/manual diagnostic reads, not timer checks. Idle checks run 30 seconds after the prior read settles; while a source is indexing, checks run every 1.5 seconds after settlement. Semantic cells spin exclusively for that source's reported `indexingSources` activity or its explicit manual run, never the aggregate `indexing` flag. Sources with no live activity signal do not invent activity. Source failures show Unavailable; disconnect clears stale activity. A single workspace/client-scoped controller owns polling and manual action state; the panel and Activity Bar consume its shared snapshot, including while the panel is closed. Refresh, project/client changes and teardown invalidate stale completions; global configuration changes refresh diagnostics and reset/cancel stale manual work.
- The Search indexes Activity Bar dot uses the [central indicator manager](desktop-sidebar-indicators.md): error for diagnostic/source/manual failures; motion-safe animated info for reported source activity or a manual run; warning for missing/partial local indexes, incompatible caches, unavailable configured credentials, missing semantic vectors unless the local corpus is known empty, or a partial/stopped manual run. Active work takes precedence over pending coverage, but errors always win; pending reasons remain in the context menu. Unknown state, disabled semantics alone, and Stored counts do not establish missing coverage or freshness. Every reason offers Inspect search indexes. Ordinary status reads never animate the Activity Bar dot.
- There is no Details section. Row diagnostics remain available as cell tooltips. The semantic footer shows a short status and Settings link. Settings local count comes from the authored catalogue, while its cached vectors come from the settings-owned tables.
- Incompatible caches show Needs rebuild for their own source, not a generic provider failure. Schema-1 Settings configuration is rejected without mutation. All semantic source statuses reflect `search.embedding` in the shared global `~/.config/pi/pi-tools-suite.jsonc` configuration and required credential availability; credentials and caches alone do not activate semantics. There are no source-specific activation settings. Per-source vector coverage and freshness are not reported; Stored means vectors are retained, not that they cover or are fresh for the current corpus, while Not indexed means no stored vectors.
- Configure in Settings opens Tools Suite → Search and focuses the Embedding model field, including after asynchronous settings loading. Provider selection uses the shared custom selector; changes use the suite draft and top Save button, not a separate semantic save action. Removing configuration stops new embedding work and retains cached vectors.
- Each source has its own Index/Stop/Continue action; only that row spins for its manual run. Code/Knowledge use the cancellable native transport without ACP; Settings/Sessions/Tasks/Commits require the workspace ACP connection and use `pix/search/index`, not a synthetic search query. A run adds missing/changed content under the existing global semantic authorization; provider charges may apply, as disclosed in the action tooltip. Native and ACP document-only passes drain all eligible missing documents in batches of at most 16; manual indexing has no overall 128-document cap or overall native CLI/Rust/semantic deadline. Per-request HTTP timeouts, cancellation and storage safety bounds remain. Explicit indexing does not embed a search query or rank search results. It never resets caches, migrates providers or changes canonical tasks/sessions/history. Missing configuration/credentials, unavailable history connection, active work and known incompatible caches disable the relevant start action. Incompatible caches still require separately authorized recovery.
- Code and Knowledge manual actions start independently, without a shared UI FIFO or Queued state. Both rows may show active indexing concurrently. Cancelling one source does not stop the other; same-source repeated starts remain blocked until its transport settles, including after cancellation or configuration reset. Backend source ownership and the shared global provider limit remain unchanged.
- Git commits and Sessions hide Index/Continue only when read-only source inspection confirms an empty history, never from a zero/missing cached document or vector count. A running request retains Stop. Native Git inspection distinguishes an unborn branch from missing/corrupt refs; uncertainty keeps actions visible. ACP `pix/search/config` accepts optional `includeSourceStatus: true` and discovers saved sessions at most once per 30 seconds per workspace, counting unnamed sessions too. Failure clears the empty hint to unknown; discovery never reconciles caches or starts embeddings. Confirmed empty sources show 0 items and do not contribute missing-index indicator reasons.
- Index actions are compact icon-only buttons: Play starts indexing, StepForward continues a partial run, and Square stops a running manual run. Each retains an accessible action-and-source label and a descriptive title explaining the action or why it is unavailable; disabled states and handlers are unchanged. The adjacent Configure semantic search action is a Settings gear icon with an accessible label and title identifying the Embedding model destination. The narrower actions column keeps the source table compact.
- Manual runs return a source-specific complete/partial/error result with available coverage counts and a safe explanation. The row and last-run message expose the outcome; incomplete runs offer Continue rather than implying full coverage. Repeated clicks on a running source do not launch duplicates. Stop, panel close, workspace/client replacement and configuration changes cancel owned requests and suppress stale results; committed batches are retained. Settings/Tasks background work has independent workspace ownership and is not stopped merely by closing the panel. Source/provider leases renew every 30 seconds and expire after 90 seconds; queued work remains renewed and rechecks ownership after acquiring a slot. Cancellation retains ownership until tracked transport settles, and lost owners cannot publish. After two failed/interrupted network attempts (initial plus one automatic retry), explicit Continue is required; success resets failures, and Continue clears the exhausted budget before reconciliation. The shared global coordinator has at most four valid local leases, not a provable remote execution cap after crash/partition. A short cooldown applies; crash-after-transmission billing can duplicate. No Index all action is provided. Knowledge "dirtiness" and acknowledgment are not readiness criteria here.
- Settled last-run explanations are grouped under a collapsed-by-default Last runs disclosure, with a visible rotating Lucide chevron. Outcomes remain visible in the source row and its tooltip while the disclosure is collapsed.
- Closing the panel retains settled/manual-stop outcomes in the workspace controller and does not stop diagnostic polling. Opening it again reuses that controller; workspace/client replacement clears its state. A successful retry or configuration reset clears prior manual attention, while a panel visit alone does not acknowledge failures.
- Outside the status panel, the connected workspace registers its authored Settings catalogue with ACP `pix/search/sync`, even when Settings/Search are closed. Settings metadata changes and saved task changes drive background indexing; bootstrap reconciles offline changes. Configuration changes resynchronize the active workspace. Search queries reuse those document vectors and may embed the submitted query; Code/Knowledge, Sessions and Commits retain their respective search-driven behavior.

- Unrelated spread-prop updates (task/git refreshes or switching sidebar tabs) must not recreate the search controller or re-register the settings/task catalogue. Identity-only derived workspace/client values fence the Svelte effects.
- The sidebar receives an ACP client only after initialization reaches Ready. Status/configuration reads and catalogue registration never race transport startup; initialization failure/disconnection removes that client without disabling local native diagnostics.
- A scrollable Activity journal replaces the two explanatory footer paragraphs and fills the remaining panel height (with a small minimum readable area in short windows). Events appear chronologically with time and source; failures and warnings use severity color. New entries and viewport resizing follow the bottom only while the reader is at the bottom. Scrolling up suspends following and preserves the visible retained record, including when older records are evicted. The window retains at most **200 events in memory**, filtered to the selected workspace. Switching tabs, reconnecting, or remounting the sidebar preserves retained events; reopening starts at the latest entries. Restarting/reloading the window clears them. No journal file is written.
- Entries cover manual starts/results (including available indexed/total counts), failures/cancellation, catalogue sync registration, configuration notifications, observed background activity, store count changes and diagnostic errors/recovery. Unchanged status polls never append entries. A background transition to idle is not logged as verified success; short jobs between polls and jobs in other processes may only be visible through later count changes. This is a UI activity journal, not a complete backend/provider request trace. Sync acknowledgement means catalogue registration, not embedding completion. Raw provider errors, credentials and indexed content are never journalled.
- Bottom-follow is retained reader intent: new rows, content reflow, viewport resize, and delayed scroll events at an unchanged offset do not disable it. A reader's upward scroll pauses following; returning to the bottom resumes it. Pending restores cannot override a newer reader scroll. Both the viewport and the event list are observed for resizing.

## Implementation

- `desktop/src/components/SearchIndexPanel.svelte`
- `desktop/src/lib/search-index-status.ts`
- `desktop/src/lib/search-index-monitor.ts`
- `desktop/src/lib/search-index-controller.ts`
- `desktop/src/lib/workspace-search-index-controller.ts`
- `desktop/src/lib/workspace-search-index-owner.svelte.ts`
- `desktop/src/lib/search-index-history.ts`
- `desktop/src/lib/search-index-events.ts`
- `desktop/src/components/SearchIndexHistory.svelte`
- `desktop/src/lib/index-history-scroll.ts`
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

## Tests

- `desktop/src/lib/search-index-status.test.ts`
- `desktop/src/lib/search-index-monitor.test.ts`
- `desktop/src/lib/search-index-controller.test.ts`
- `desktop/src/lib/workspace-search-index-controller.test.ts`
- `desktop/src/lib/workspace-search-index-owner.test.ts`
- `desktop/src/lib/search-index-history.test.ts`
- `desktop/src/lib/search-index-indicators.test.ts`
- `desktop/src/lib/search-index-actions.test.ts`
- `desktop/src/lib/native-repository-search.test.ts`
- `desktop/src/lib/search-index-sync.test.ts`
- `desktop/src/lib/acp-client.test.ts`
- `desktop/src/components/SearchIndexPanel.test.ts`
- `desktop/src/lib/index-history-scroll.test.ts`
- `desktop/src/app/desktop-navigation-view-model-services.test.ts`
- `desktop/src-tauri/src/search_index_status.rs`
- `acp/test/search-source-status.test.ts`
