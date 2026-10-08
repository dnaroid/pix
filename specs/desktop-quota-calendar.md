---
kind: spec
status: active
---

# Desktop quota resets

## Behavior

Decision: [0039 — Compact quota reset calendar](../docs/decisions/0039-quota-reset-calendar.md).
Claude banked grants: [0051 — Read-only Claude reset grants](../docs/decisions/0051-claude-reset-grants.md).

Desktop Usage preserves the weekly reset calendar: seven local civil dates
starting today, plus the actual reported reset date as an eighth cell when
outside that range. The grid stays on one row, highlights today and the reset,
and colors weekends with the theme's muted red. Exact local reset date/year
and minute-level time remain visible below it, without predicted future resets.
Date cells are compact (28px high), with an outlined today and a solid primary
reset marker with contrasting text (also on weekends). Ordinary weekend dates
retain muted red. The exact reset time is a higher-contrast, medium-weight
unboxed line, not a separate filled card.

A provider-agnostic **Limits** section shows the account quota windows
(`hourly`, then `weekly`) above the calendar when available, including weekly-only
snapshots. Each shows a neutral progress track,
remaining percentage explicitly labelled “remaining”, reset countdown and
cumulative daily-budget warning as defined in [runtime status](desktop-runtime-status.md). Each window has a readable label/percentage row,
a full-width track and a separate “Resets in …” line. A passed reset explicitly
says “Reset time reached · Awaiting quota refresh”, not just “reset”.
The weekly track has seven equal day sectors, matching the compact status-bar
track; separators overlay the aggregate remaining fill, not measured per-day
usage. Short-window tracks remain continuous.
The popup weekly track also overlays a thin primary-colored **now** marker:
its position is `clamp((resetAt - now) / (windowSeconds * 1000) * 100, 0, 100)`
percent from the left. The window starts at the right edge and time moves left
toward reset, independently of the remaining-quota fill. The marker stays visible
at both edges, is omitted for unknown/invalid timing, and its time-remaining meaning
and orientation are included in the row's accessible label. It uses the existing
minute tick, without another timer or request; compact footer tracks are unchanged.
The weekly calendar also retains the exact reset date/time; header-derived rate windows are
excluded from this section. Stale windows remain visibly marked as cached.
The complete popup is bounded by the application viewport height minus 70px,
with internal scrolling and no extra timers or refresh-on-open requests.

After the calendar and any reset credits, directly before the spend table,
**Token usage by model** adds a donut only when more than
one provider/model entry has nonzero recorded tokens. Its center shows the sum
of attributed model tokens; its legend identifies the models and token counts.
Chart entries use successive semantic palette colors independently of provider,
so models sharing a provider remain distinguishable. Each legend dot matches its
segment; the palette repeats after eight entries. Table model colors are unchanged.
Thin popup-background separators mark segment boundaries without changing token shares.
Unattributed usage remains in the unchanged table, not assigned to a model.
The existing reset-credit section, provider/model/tokens/cost table and explicit
Claude limits refresh remain intact. These additions apply across providers,
not only Claude.

For OpenAI Codex OAuth quota snapshots, Desktop also renders a separate
**Reset credits** section when the account has available rate-limit reset
credits. These are one-shot account credits, not the weekly quota's scheduled
reset, so they must never be merged into or labelled as the weekly calendar.
By default each credit occupies one compact row with its backend title and
relative expiry countdown (or unavailable state), without a disclosure or expanded
cards. Credits expiring in strictly less than 24 hours use muted red for their
title and countdown; exactly 24 hours and unknown expiry retain normal colors.
The existing minute tick updates this styling. Exact local expiry through seconds
remains in the countdown's accessible label. Missing-detail counts remain visible.
The UI does not expose the backend credit id
and does not offer redemption.
The availability total comes from the backend, not the length of its potentially
capped detail list. If only the total is known, the section shows that total and
an explicit details-unavailable message, without fabricated credit rows. Credits
remain visible without weekly/hourly windows and precede recorded session usage.

Anthropic subscription OAuth and the Claude Code provider use the same section
for **banked reset grants** returned in `cedar_ember`. Each grant is one row,
with its backend label (fallback **Full reset**), remaining quantity (`×N` when
greater than one), visible local expiration date and relative countdown. The
accessible expiry retains the exact date/year/time through seconds. The section
total is the sum of valid grants' `resets_left`, not the number of grants or
`resets_total`. Quantities are not expanded into duplicate rows. “Available” here
means banked, not redeemable right now: `usable_now`, limit-exhaustion and cooldown
are not permission to spend a reset and do not hide banked grants. No redemption
request or control is implemented.

## Constraints and failure cases

- Missing, nonfinite, nonpositive or invalid reset timestamps show **Reset time
  unavailable**, with no manufactured calendar or countdown.
- A passed reset says **Reset time reached · Awaiting quota refresh**; it does
  not claim the account quota has replenished or advance the date by seven days.
- Cached windows are visibly marked **Cached** and filtered out at their own
  reset by the existing runtime-status selector. The existing mounted minute
  timer feeds that selector and countdown; no extra timers or network requests.
- Reset-credit details come from the authenticated read-only Codex
  `rate-limit-reset-credits` endpoint during the existing model-usage refresh.
  This supplementary request is best-effort: endpoint failure, rate limiting,
  or schema rollout must not fail or hide ordinary weekly/hourly quota. The
  request, including its body, is bounded by ten seconds. If details fail, the
  count from the usage summary remains usable; failed details are not cached as
  current rows. [Codex credentials](openai-codex-usage-refresh.md) are shared with
  the quota request, including after OAuth rotation.
- Only Codex credits whose backend status is **available** are exposed. Known expired
  credits are filtered immediately and again by the mounted minute tick. When
  an available credit has no valid expiry, it remains visible as **Expiry
  unavailable** rather than inventing a date. Backend expiry is an RFC3339
  instant, converted to milliseconds; timezone-free dates and numeric app-server
  timestamps are not guessed. Duplicate backend credit IDs produce one row;
  distinct credits with identical titles/dates remain distinct. Known expirations
  decrement the snapshot total; unknown expirations cannot be inferred. Countdowns
  round up to minutes while the exact local expiry retains seconds.
- Claude grants use the existing route's OAuth credential, never a different
  application's login for that route. If the ordinary usage response omits
  `cedar_ember` or returns it as null, make a best-effort read-only GET to
  `/api/oauth/usage?cedar_ember=1&skip_spend=1` during the existing quota refresh.
  Only this flagged lookup uses the verified CLI-surface compatibility
  User-Agent `claude-cli/2.1.283 (external, cli, client-app/pi-ui-extend)`; it
  explicitly identifies Pix. The ordinary quota request retains its existing
  User-Agent. No CLI launch or credential refresh is needed for that header.
  This supplementary request, including body consumption, is bounded by ten
  seconds; failures or malformed details preserve ordinary quota and do not
  retain previous grant rows. A non-null inline block (including an ineligible
  object) does not cause an extra lookup. Regular API keys make no grant request.
- Claude exposes only eligible, unpaused grants with valid distinct backend IDs
  and positive safe-integer `resets_left`; unsafe aggregate counts are rejected.
  Known future starts, malformed non-null start times, and known expirations
  (including exactly now) are excluded. A missing/invalid `ends_at` keeps a banked
  grant with **Expiry unavailable** rather than inventing a deadline. Both dates
  accept explicit RFC3339 instants only. Known grant expirations remove the whole
  quantity, including on the owned minute tick. Claude credential-pending stale
  quota retains only quota windows, not grant rows/counts that may have been spent.
- Date construction uses local civil-day arithmetic, not fixed 24-hour steps,
  so DST and month/year boundaries preserve seven unique consecutive base dates
  and, when needed, one distinct reported reset date.
- No weekly data means no calendar. Existing hourly/rate triggers are unchanged.
- Opening and focus/click remain idempotent, gap-free, and perform no quota
  refresh. Explicit Claude limits refresh remains independent.
- External redemption is observed at the existing quota refresh cadence (about
  five minutes), not instantly. This passive view offers no redemption action or
  additional refresh-on-open request.

## Implementation

- `desktop/src/components/QuotaResetCalendar.svelte`

- `desktop/src/components/UsageLimitBars.svelte`
- `desktop/src/components/ModelUsageDonut.svelte`
- `desktop/src/components/ResetCreditsSection.svelte`
- `desktop/src/components/RuntimeStatusBarItems.svelte`
- `src/app/model/model-usage-status.ts`
- `src/app/model/model-usage-reset-credits.ts`
- `acp/src/acp/desktop-commands.ts`
- `desktop/src/lib/acp-client-types.ts`
- `desktop/src/lib/acp-response-parsers.ts`
- `desktop/src/lib/quota-calendar.ts`
- `desktop/src/lib/runtime-status.ts`

## Tests

- `desktop/src/components/QuotaResetCalendar.test.ts`

- `desktop/src/components/UsageLimitBars.test.ts`
- `desktop/src/components/ModelUsageDonut.test.ts`
- `desktop/src/components/ResetCreditsSection.test.ts`
- `desktop/src/lib/quota-calendar.test.ts`
- `desktop/src/lib/acp-response-parsers.test.ts`
- `desktop/src/components/StatusBarHover.test.ts`
- `desktop/src/components/DesktopVisualRegressions.test.ts`
- `desktop/src/lib/runtime-status.test.ts`
- `desktop/src/app/session-runtime-status.test.ts`
- `tests/model-usage-status.test.ts`
- `tests/anthropic-reset-credits.test.ts`

## Verification

Focused Desktop Vitest, including a DST-observing timezone run for date helpers;
Desktop check and build:web. Native visual QA is not asserted by unit/source tests.
