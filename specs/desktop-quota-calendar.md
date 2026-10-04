---
kind: spec
status: active
---

# Desktop quota resets

## Behavior

Decision: [0039 — Compact quota reset calendar](../docs/decisions/0039-quota-reset-calendar.md).

Desktop Usage renders a compact weekly reset calendar above the
recorded-spend breakdown only when the current displayed provider snapshot has
a weekly quota window. It does not duplicate the account-wide remaining percentage,
quota heading or aggregate track already represented by the status trigger.
The Usage scroll area allows up to `min(640px, 100vh - 120px)` of content,
retaining room for the popup header and status bar on smaller windows.

The calendar shows seven consecutive local civil dates starting today, so today's
outlined date is always visible. It highlights the provider's reported reset date
when it falls within that range. Saturday/Sunday labels and dates use the
theme's muted red (`text-tool-error`), preserving today's outline and the
reset background. No explanatory
today/reset legend is shown. The reset detail always shows the actual date/year,
exact minute-level local time without a timezone suffix or duplicate countdown, even
when the reset falls outside the seven-date range. It does not predict
subsequent resets
or infer past daily consumption. The selected compact-week concept supersedes
the former no-quota-block policy in [session usage](session-usage.md); other
[runtime status](desktop-runtime-status.md) hover, refresh and billing rules stay.

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
- Only credits whose backend status is **available** are exposed. Known expired
  credits are filtered immediately and again by the mounted minute tick. When
  an available credit has no valid expiry, it remains visible as **Expiry
  unavailable** rather than inventing a date. Backend expiry is an RFC3339
  instant, converted to milliseconds; timezone-free dates and numeric app-server
  timestamps are not guessed. Duplicate backend credit IDs produce one row;
  distinct credits with identical titles/dates remain distinct. Known expirations
  decrement the snapshot total; unknown expirations cannot be inferred. Countdowns
  round up to minutes while the exact local expiry retains seconds.
- Date construction uses local civil-day arithmetic, not fixed 24-hour steps,
  so DST and month/year boundaries preserve seven unique consecutive dates.
- No weekly data means no calendar. Existing hourly/rate triggers are unchanged.
- Opening and focus/click remain idempotent, gap-free, and perform no quota
  refresh. Explicit Claude limits refresh remains independent.
- External redemption is observed at the existing quota refresh cadence (about
  five minutes), not instantly. This passive view offers no redemption action or
  additional refresh-on-open request.

## Implementation

- `desktop/src/components/QuotaResetCalendar.svelte`
- `desktop/src/components/ResetCreditsSection.svelte`
- `desktop/src/components/RuntimeStatusBarItems.svelte`
- `src/app/model/model-usage-status.ts`
- `acp/src/acp/desktop-commands.ts`
- `desktop/src/lib/acp-response-parsers.ts`
- `desktop/src/lib/quota-calendar.ts`
- `desktop/src/lib/runtime-status.ts`

## Tests

- `desktop/src/components/QuotaResetCalendar.test.ts`
- `desktop/src/components/ResetCreditsSection.test.ts`
- `desktop/src/lib/quota-calendar.test.ts`
- `desktop/src/lib/acp-response-parsers.test.ts`
- `desktop/src/components/StatusBarHover.test.ts`
- `desktop/src/components/DesktopVisualRegressions.test.ts`
- `desktop/src/lib/runtime-status.test.ts`
- `desktop/src/app/session-runtime-status.test.ts`
- `tests/model-usage-status.test.ts`

## Verification

Focused Desktop Vitest, including a DST-observing timezone run for date helpers;
Desktop check and build:web. Native visual QA is not asserted by unit/source tests.
