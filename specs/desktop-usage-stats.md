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

The Usage panel header reads **Pix usage** and has a refresh action. There are
no provider tabs or source switch. The period selector defaults to **7 days**
and offers the supported periods for the available data.

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
grid is always padded to whole weeks: days before the window or after today
are `outside` cells drawn as faint outlines, never counted, hovered or
selectable. For the 7d period the calendar shows the current local week
(`currentWeekWindow`), while KPIs and other charts keep the rolling 7 days.
Hour-of-day strips use localized ticks and tooltips;
daily bars and the coverage date use the system locale through
`desktop/src/components/usage/usage-format.ts` (`formatDayKey`, `formatDate`,
`weekdayLabels`, `monthLabel`, `formatHour`, `formatHourTick`). Formatting uses
`Intl`, without a hardcoded `en-US` locale.

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

The Desktop store requests usage while the panel is open, refreshes on demand
and reacts to source-change notifications. Local-day bucketing and project
scope filtering are derived on Desktop; no request is needed to switch project
scope. Session summaries expose project paths so the UI can keep
other-project rows non-clickable.

## Tests

Focused coverage is in `tests/usage-stats-local-sources.test.ts`,
`tests/usage-stats-service.test.ts`, `acp/test/usage-stats-host.test.ts`,
Desktop usage derivation/store tests, and `UsagePanel.test.ts`. These cover
the source contract, whole-tree collection, single-service host, project
filtering, local calendar formatting and panel behavior.
