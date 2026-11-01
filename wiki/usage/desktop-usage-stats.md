---
kind: spec
status: active
---

# Desktop usage statistics panel

<!-- markdownlint-disable MD013 -->

## Goal

Show historical usage recorded in Pix sessions, with project scope, time
period, usage metrics and session-level detail.

## Source and data contract

`pix-sessions` is the only usage source. It scans the complete
`<agentDir>/sessions` tree across projects; each session's header `cwd`
identifies its project. `createUsageStatsSources({ log, agentDir })` creates
the source set. Accounting uses the shared `usageFromEntry(entry)` from
`src/app/session/session-usage.ts` and preserves its accounting semantics.

The wire contract has `USAGE_SOURCE_IDS = ['pix-sessions']` and
`USAGE_UNITS = ['tokens']`. `PROJECT_USAGE_SOURCE_IDS` is not part of the
contract. Buckets contain values and optional `projectCwd`, but no `series`,
`dims` or `quotaPercent`; change notifications are `{ source }` without a
`cwd`. Requests still require a valid `cwd`, but collection does not use it.

ACP `UsageStatsHost` owns one `UsageStatsService`; it does not maintain
per-project services or an LRU. The host disposes the service with the agent.

## Desktop behavior

The outer sidebar header reads **Usage**, with the refresh action immediately
before Close. There is no duplicate **Pix usage** toolbar inside the panel,
nor provider tabs or a source switch. The period selector defaults to **7 days**
and offers the supported periods for the available data.

**Provider limits** is a separate disclosure above historical statistics. It
uses the same account-quota widgets and `displayModelUsage` precedence as the
status-bar popover: remaining percentages, hourly segments, reset countdowns,
weekly calendar/day slices, daily-budget warnings and cached-state labels.
Day slices describe the aggregate weekly quota, not independently measured daily
limits. Expanding **Provider limits** discovers authenticated supported provider routes from
the sessionless model catalogue and queries their quotas through `draft_config`,
independently of the active session/model (OpenAI, Anthropic/Claude Code, Z.ai,
and Antigravity). Account-wide routes use one representative model; Antigravity
retains model-specific queries. Queries have bounded concurrency, refresh every
five minutes while expanded (one minute for pending local Claude Code credentials),
and also run on header refresh while expanded. Collapsing the section or closing
the panel stops polling and queued queries; already-started requests may finish
but their late completions are ignored, including after a same-workspace reopen.
Completions from previous workspaces/connections or disposed panels are ignored. Failed
refreshes retain prior quotas as cached; missing quotas remain visible as loading,
unavailable or failed provider rows, rather than silently omitting the provider.
Provider quota rows are app-wide, not owned by an ACP connection or workspace, and
persist in localStorage under `pix.desktop.providerUsageQuota.v1`. Remounts,
project switches, reconnects and application restarts can therefore render the
last rows immediately. Refresh-time credential-scope checks still discard rows
belonging to a different login; persisted loading rows without quota data are
not restored.
When an OpenRouter API key is configured (`OPENROUTER_API_KEY` or Pi
`auth.json`'s `openrouter.api_key`), Provider limits also shows an OpenRouter
row. Its Tauri `openrouter_usage` command requests `/api/v1/key` and
`/api/v1/credits` (credits 403/404 are tolerated) and returns balance
(`total_credits - total_usage`), key spend for today/week/month, key limit and
effective budget. Neither the key nor its label is returned. The frontend polls
every five minutes only while Provider limits is expanded and persists its
snapshot in localStorage under `pix.desktop.openRouterUsage.v1`; on failure,
available cached values remain visible with a **Cached** marker.
Existing runtime snapshots (including draft telemetry) supplement fetched quotas;
there are no usage-history-derived quota estimates. The
newest snapshot wins for each provider/account/model before grouping models into
one chart block per provider/account, including Antigravity. For each hourly or
weekly window the summary uses the lowest reported remaining percentage and
that window's actual reset time, rather than summing or averaging model pools.
Selected cached windows retain the cached indicator; distinct accounts remain
separate. Loading/unavailable/error placeholders are also grouped by provider
and do not duplicate a provider that already has a chart. The panel shows no
model names or repeated `Limits` headings; the status-bar popover keeps its
existing heading. Request-header RPM/TPM windows are not
account quotas and are not rendered here. Missing quota data has an explicit
empty state; provider limits do not depend on historical usage being present.

Provider rows (both quota charts and missing/loading placeholders) are ordered
by descending call count across all available Pix usage history, across projects
and dates, independently of historical chart filters. Credential-route aliases
share their quota-provider family's score; accounts within a provider share
that score. The last order is saved per project as `usagePanel.providerOrder`
in `.pi/workspace.jsonc`, restored together with disclosure state before quota
requests start, and used throughout loading. Partial, stale, failed or empty
history never resets that order. Only a complete `ready` snapshot with valid
calls can update it. Equal call counts retain the saved relative provider order;
new providers without a saved rank and accounts within each provider use a stable
provider/account fallback. Tokens and cost are not popularity proxies. While
**Provider limits** is expanded it also consumes the shared history snapshot
for this ordering, without mounting or calculating collapsed historical charts.
Quotas still render if history is empty or unavailable.

Disclosure state is project-local in `.pi/workspace.jsonc` under
`usagePanel.collapsedSections`. Stable ids (`provider-limits`, `overview`,
`activity`, `daily`, `models`, `sessions`, `cache`) survive metric/filter changes,
panel reopening and application restart. Missing ids default to expanded.
Changes preserve JSONC comments and sibling settings, serialize accepted toggles
across panel reopening, and retry conditional-write conflicts without dropping
other sections' changes. Malformed configuration is not overwritten; failures
remain visible and are sent to Desktop diagnostics. Late restores cannot undo
user input or apply another project's state; accepted writes remain scoped to
their original project even after panel teardown.

Sections stay closed until their saved state is restored, so persisted collapsed
sections never briefly render expanded or start background requests. Only an
explicit summary activation changes/persists disclosure state; native toggle
events caused by rendering or restoration do not. Collapsed section content is
unmounted and its chart-specific derivations sleep until expansion. Provider
quota polling and its minute clock also stop while **Provider limits** is
collapsed. Historical sections and provider popularity share one source: it
remains active while any historical section or **Provider limits** is expanded,
but stops accepting completions and requesting source-change updates when all
are collapsed. Re-expansion requests the current
snapshot; data retained for other expanded sections is rendered only on expansion.
Header refresh does not wake collapsed sections and is disabled when all sleep.

The Usage panel is remounted when switching workbench tabs. To avoid a cold
render on each remount, the frontend retains disclosure state and provider order
in a module-level per-project cache, usage-stat snapshots per ACP client and
project, and app-wide provider quota rows in localStorage. Cached values render
immediately; disclosure state is re-read from workspace configuration in the
background, and opening still refetches usage statistics and resumes quota
polling. Refresh indicators display over retained data. Usage-stat snapshots
remain in-memory remount optimizations; quota rows persist across restarts.

Historical disclosure headers remain mounted through loading, empty results and
refreshes; empty sections explain the lack of data inside their expanded body.
Cold loads use skeletons and expanded sections show a small update spinner.
Warm refreshes retain charts and settled missing-provider rows rather than
replacing them with skeletons. Cached/status text stays in the existing single-line
provenance row rather than inserting/removing a banner above the disclosures.

`UsageSourceView` provides a **This project / All projects** segmented toggle,
defaulting to **This project**. Project filtering compares normalized
`projectCwd` values with the current workspace. Metrics are cost, tokens and
calls. Breakdown charts, a plan-quota KPI and a calls-total series are not
shown. Top-session rows are clickable only when they belong to the current
project; other-project rows remain informational. Usage session ids are Pi
session header ids, which differ from the ACP ids Desktop assigns to sessions
it creates, so each session summary also carries `sessionFile`. A click
resolves the ACP id by matching it against the catalog's `pix.sessionFile`,
then by an identical id. If neither matches, Desktop refreshes the catalog once
and reports an error when the session is still missing.

The calendar, daily bars, hour-of-day strip and **By model** shares are
interactive. Hovering or keyboard-focusing a populated chart item shows an
immediate Pix-styled tooltip (day and value; daily total and per-model values
with colors; or hour range, value and share). Tooltips flip below or clamp to
the viewport and dismiss on scroll, resize or blur; chart items do not use
native SVG titles. Click, Enter or Space toggles the corresponding local day,
hour or model filter. The model dropdown, **By model** rows and daily-bar legend
share model-filter state; the collapsed **Other** row is not selectable. Items
with no usage are not interactive unless they are already selected.

Active day/hour filters appear as removable **Active chart filters** chips under
the controls. KPIs, top sessions and cache efficiency use all active filters.
Calendar and daily bars respond to hour and model filters (not day), the hour
strip responds to day and model (not hour), and **By model** shares respond to
day and hour (not model). Selected items are highlighted and other items in
those charts are dimmed. A day/hour filter that has no matching data in the
current period, scope and model is silently dropped. The empty state is based
on the period total, not the filtered total.

Time filtering is provided by `filterByTime(buckets, { day, hour })` in
`desktop/src/lib/usage-stats.ts`: filtering drops untimed buckets, and an hour
filter matches hourly buckets only.

The activity calendar uses local-time day buckets and shows localized date,
month and weekday labels. Week columns start on the system locale's first day
of week (`localWeekStart` via `Intl.Locale` week info; Monday when the runtime
does not expose it), and the Mon/Wed/Fri row labels follow that order. The
grid is always padded to whole weeks. Days before the window in the first
column show their real activity from the same project/model/hour-filtered
history, using the same color scale, and support value tooltips. These context
days are marked `outside`: they cannot be selected and are excluded from the
calendar summary and period totals. Other charts and KPIs keep the selected
period. Context days without activity, missing dates and future padding cells
remain faint noninteractive outlines; future days never carry activity.
For the 7d period the calendar shows the current local week
(`currentWeekWindow`), while KPIs and other charts keep the rolling 7 days.
Hour-of-day strips use localized ticks and tooltips;
daily bars and the coverage date use the system locale through
`desktop/src/components/usage/usage-format.ts` (`formatDayKey`, `formatDate`,
`weekdayLabels`, `monthLabel`, `formatHour`, `formatHourTick`). Formatting uses
`Intl`, without a hardcoded `en-US` locale.

## Persistent cache

Usage data is cached globally within the selected Pi agent profile, not in a
project's `.pi/usage-cache`. The versioned directory is
`<agentDir>/cache/usage/v1/`, where `agentDir` is the profile directory selected
by ACP (or the SDK default). `history.json` holds the last complete
`pix-sessions` snapshot for the whole profile; quota persistence uses one
hashed model slot per profile containing its credential scope and quota.
Project filters, metrics and charts derive from the same saved history rather than caching
duplicate per-project views. Disclosure state and the saved provider order
remain project-local preferences in `.pi/workspace.jsonc`.

ACP restores history before answering the first Usage request, marks it
`stale`, and starts normal collection without replacing saved charts with cold
skeletons. To keep that first request fast, ACP warms the host once per process
about 3 s after a `pix-desktop` `initialize` (unref'd timer, skipped after
dispose): `UsageStatsHost.warm()` loads the usage module and restores the disk
snapshot without collecting; failures are swallowed and retried by the next
real request. The root usage-stats module never imports the Pi SDK barrel;
`agentDir` is a required option that the ACP host supplies
(`options.agentDir ?? getAgentDir()`). `UsageStatsService.restore()` coalesces concurrent restores
and cannot overwrite a newer live snapshot or resurrect a disposed service.
The collector persists complete `ready` results only: partial scans, errors
and failed refreshes cannot replace the last complete history. JSON parsing
and serialization run in the existing collection worker by default; the
existing in-process fallback remains available when worker startup fails.

The sessionless draft catalogue accepts `includeUsageCache: true` to return
account-verified stale quota snapshots without contacting quota endpoints.
The panel hydrates them before live queries finish. Quota cache keys include
profile and locally resolved credential identity: OpenAI OAuth uses the tuple
of verified JWT `chatgpt_account_id` and `sub` (or JWT `email` when `sub` is
absent); if either claim is missing, it falls back to refresh/access token
identity. Anthropic/Claude has no proven stable account id and therefore uses
conservative token identity.
Other supported identities include API keys, Claude CLI credential source
and login, and the entire enabled Antigravity refresh-credential/project set
(not a fallback email). Identity lookup does not refresh OAuth or use quota
network calls. Missing or changed identity cannot read another login's cache.
Credential identity crosses the Desktop boundary only as an opaque hash. The
saved model slot is restored only when its saved scope matches the current
identity; a successful refresh for another account replaces it, bounding
orphaned quota files. Persisted quota payloads contain
display windows and account labels, never credentials, authorization headers,
raw endpoint responses or reset-credit counts. Expired saved windows are
removed and remaining windows retain their original observation timestamp.

Cached panel queries bypass the older route-only Claude telemetry fallback
and request `freshOnly` provider results, so Antigravity's legacy embedded
credential-file quota cache cannot be relabelled as a new successful refresh.
The native cache checks identity again after a live query and before returning
its result. A login change invalidates the batch (`usageCacheInvalidated`),
clears retained panel quotas and ignores peer responses. Catalogue responses
may include `usageCache.routeScopes`, mapping routes to opaque identity hashes;
individual query responses may include `usageCacheScope`. These optional,
validated fields detect account changes between requests in one batch and
remain backward compatible when omitted. Invalidation immediately re-reads
the catalogue and starts one fresh generation without waiting for abandoned
requests; repeated invalidation falls back to the one-minute retry. Ordinary
polling remains five minutes.

Cache writes use private files (`0600`) and atomic unique-temp-file renames;
new cache directories use `0700`. Files are versioned, size-bounded and
validated. Missing, corrupt, unsupported or unwritable cache files do not
prevent live collection; handled failures are reported once per owner and
operation with sanitized diagnostics. Failed Antigravity live probes remain
failed while previously displayed bars are retained; the failed response itself
is not reported as a cache diagnostic. This is a disposable last-success cache,
not an archive or credential store; deleting
the directory simply makes the next expanded section cold.

Restoring data is not permission to wake collapsed sections. Quota cache
hydration/live polling starts only with **Provider limits** expanded; history
restoration/collection starts only while an expanded historical section or
provider popularity needs the shared source. All-collapsed panels have no
refresh timers, subscriptions or quota requests. Closing/pausing ignores late
frontend completions; existing cache data remains available on reopening or
application restart.

## Lifecycle and derivation

Cold collection is progressive. The first unprimed `LocalUsageSource`
collection stats all session files, parses files modified within
`partialWindowMs` (7 days by default) first, and emits an interim snapshot with
status `loading`, null coverage and the message “Showing recent sessions while
older history loads.” It then reads all files and returns the complete
snapshot. Warm refreshes skip this partial pass; `clear()` resets the source
for another cold collection. `JsonlTailCache.read` accepts `{ prune?: boolean
}`; `prune: false` retains cached entries for paths not requested.

`UsageStatsService` forwards `onPartial` to sources. Interim data is emitted
through `onChange` only when it can populate a cold entry (there is no retained
snapshot, or the retained snapshot is still `loading`); it never replaces
retained data. Sources may implement `dispose()`, which the service calls when
disposed.

Parsing is performed by `WorkerCollector` in a worker thread. The main thread
resolves session roots and includes them with each collect request; the worker
owns the warm per-file cache. Abort is forwarded to the worker. A worker crash
rejects pending calls and the next collection respawns it. If startup fails
(worker error/exit or 30-second ready timeout), the service logs
`usage_stats.worker_unavailable` once and uses in-process collection for the
rest of that session. `createUsageStatsSources({ log, agentDir, inProcess })`
selects the source setup; `createPixSessionsSource` requires `{ agentDir }` or
`{ roots }`, with optional `partialWindowMs`.

On a measured 2.1 GB session tree containing 1,372 files, the first interim
snapshot took about 1.5 seconds, full collection 6–7.5 seconds, and warm
refresh about 0.2 seconds; maximum host event-loop lag was about 1 ms (versus
about 36 ms in-process). These are measured observations, not timing
guarantees.

The Desktop store requests usage while at least one historical section or
**Provider limits** (for popularity ordering) is expanded,
refreshes on demand and reacts to source-change notifications only while active.
Local-day bucketing and project
scope filtering are derived on Desktop; no request is needed to switch project
scope. Session summaries expose project paths so the UI can keep
other-project rows non-clickable.

## Regression coverage

Coverage includes the source contract, whole-tree collection, single-service host, project
filtering, local calendar formatting, persisted stale-first hydration,
profile/account isolation, invalidation and teardown races, corrupt cache
handling, and panel behavior.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"8bbdbdf54538bdebe20509cee9ee7486e963cf769076643453d270b7f361a11d","checkedAt":"2026-10-31T10:55:57.641Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":64,"reportLanguage":"ru"} -->
