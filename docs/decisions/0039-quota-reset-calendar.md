# 0039 — Compact quota reset calendar

- Status: accepted
- Recorded: 2026-10-05
- Governing specs: [Quota calendar](../../specs/desktop-quota-calendar.md), [Session usage](../../specs/session-usage.md), [Runtime status](../../specs/desktop-runtime-status.md)
- Approval evidence: user chose the first of three calendar concepts, then asked why implementation had stopped.
- Supersedes: only the no-visible-quota-block follow-up in [0037](0037-status-bar-hover-details.md); its hover/layout decisions remain in force.

## Context and evidence

The user removed a verbose Weekly limit description and then requested a visual
calendar showing the reset date/time. Available provider data includes aggregate
weekly remaining percentage and one reset timestamp, not per-day consumption.
The user preferred a compact week to a timeline or full-month/hour diagram.

## Decision and scope

Add a separately labelled account-wide weekly calendar in the shared Usage
surface. Display seven local civil dates starting today, exact
local reset time without a timezone suffix, remaining percentage and countdown. Preserve the spend
breakdown, trigger indicators and explicit refresh. Never synthesize daily usage
or subsequent reset dates. Reuse the owned minute timer and quota selector.

## Alternatives

- Plain text: less readable and contrary to the chosen concept.
- Timeline: emphasizes waiting but was not the selected calendar.
- Full month with hourly detail: too large for compact hover chrome.
- Mix quota into session/model spend: falsely suggests session attribution.

## Consequences and revisit triggers

The Usage surface is taller but remains bounded/scrollable. Today is always in
the range; a reset outside it remains visible in the exact reset detail, without
a fabricated highlighted date. Missing/passed timestamps remain explicit instead
of implying fresh quota. Revisit after real Desktop use if the week orientation
or compactness is confusing. No native UI validation is claimed here.

## Follow-up: always include today

The user reported that today was absent when the reset was in the next calendar
week, and requested local time without a timezone. This supersedes the initial
Monday-first reset-week orientation: use a rolling seven-day range starting today.
The exact reset detail remains authoritative for timestamps outside that range.

## Follow-up: independent Codex reset-credit audit

Evidence: upstream `openai/codex` revision
`de3721a7be07054c8c2a41102b5a501f34155361` defines a separate read-only details
endpoint with RFC3339 expiry strings. Its account API explicitly allows fewer
detail rows than `available_count`; usage contains only the count summary.
The user requested a strict audit, exact expiry seconds, no redemption controls,
and minimal fixes in a shared worktree.

Preserve the server count independently of rows and fall back to the usage
summary when details fail. Use only Pi's Codex credential for this model route,
and bound the supplementary request through body consumption. These fixes avoid
misreporting availability, showing another application's account, and blocking
ordinary quota behind stalled details. See the governing quota spec and
[Codex credential contract](../../specs/openai-codex-usage-refresh.md).

Alternatives rejected: array length as the total (capped lists undercount),
fabricated rows for missing details (no expiry evidence), and refresh-on-open
(changes the established passive refresh contract). Retain the current
model-usage transport: credits are account metadata, not quota windows, and
current header telemetry is Anthropic-only. A separate global account store
is unnecessary for this scoped fix; revisit if Codex header telemetry or
cross-account live switching is introduced. External redemption can remain
visible until the next normal quota refresh; no immediate synchronization is
claimed. Native UI validation is reported separately from source/unit tests.

## Follow-up: compact Usage presentation

At the user's request, omit the duplicate weekly quota heading, percentage and
track from the popup while retaining its calendar. Also omit the redundant weekly
"Resets in … · Local time" line; retain the exact reset date/time and passed-reset
warning. Reset credits remain plain
single-line rows without disclosure; titles/countdowns with less than 24 hours
remaining use muted red. Exact expiry is retained as an accessible label rather
than a repeated visible card. Increase the scroll-area cap to 640px, bounded by
viewport height minus 120px. This supersedes earlier aggregate-display and
expanded-credit presentation choices, not the data or refresh contracts below.

## Follow-up: reset date always visible in a single row

Evidence: the user required the reset date in the calendar grid, rejected a
two-row mockup, and approved a single row showing October 5–12 with the 12th
highlighted. Keep the rolling seven civil dates including today; append the
actual reset date when outside that week and sort chronologically. Render seven
or eight equal-width columns without wrapping. This supersedes the earlier
choice to leave out-of-range resets only in the text detail.

For distant or passed timestamps, the added cell is the reported civil date,
not a predicted successor. Bounded eight-cell rendering avoids an unbounded
row for unusual provider data; intervening dates outside the base week are not
invented. Alternatives rejected: a second calendar row (explicitly rejected by
the user), omitting today (prior user requirement), or an arbitrarily long row
(unreadable in compact popup chrome). Exact date/year and time below remain
authoritative across month/year boundaries. Revisit if unusually distant resets
need a more explicit visual gap marker.

## Follow-up: preserve the calendar alongside usage visuals

The user clarified that the weekly calendar is useful and must remain, selecting
calendar + limit scales + model-token donut. This supersedes the attempted
calendar replacement, not the existing reset-credit or refresh contracts.
The short-window scale and model chart supplement the calendar; recorded model
tokens remain distinct from account quota. Presentation details belong in the
[quota spec](../../specs/desktop-quota-calendar.md).
