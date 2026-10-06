# 0051 — Read-only Claude reset grants

- Status: accepted
- Recorded: 2026-10-05
- Decided: 2026-10-05
- Owner / approval evidence: user asked to add Claude banked reset count and expiration after the source-discovery discussion; parent limited integration to reading, not spending resets.
- Governing specs: [Desktop quota resets](../../specs/desktop-quota-calendar.md), [Runtime status](../../specs/desktop-runtime-status.md)
- Replaces / replaced by: none; extends the provider-neutral reset-credit presentation from [0039](0039-quota-reset-calendar.md).

## Context

Pix already displays read-only Codex reset credits separately from scheduled
weekly quota resets. The user asked whether Claude's banked “Full reset” count
and expiration could also be displayed, then requested implementation.

## Observations and sources

Direct local inspection of installed Claude Code 2.1.283 found GET
`/api/oauth/usage?cedar_ember=1&skip_spend=1` and a `cedar_ember.grants` schema with
`resets_left`, `ends_at`, `starts_at`, `paused` and `usable_now`. The CLI sums
remaining quantities and formats `ends_at` as expiration. This is implementation
evidence, not a public supported API contract. Disposable extracts were recorded
under `.pi/artifacts/claude-reset-source-20261005-175806/`; they may be cleaned.
Durable behavioral fixtures are in [grant tests](../../tests/anthropic-reset-credits.test.ts)
and [usage transport tests](../../tests/model-usage-status.test.ts).

Initial discovery did not verify the current account's grants/deadlines:
browser observation was blocked before Usage by a security challenge, and no
live authenticated requests were performed then. Follow-up read-only account
inspection on 2026-10-05 found HTTP 200 for both ordinary and flagged usage:
ordinary `cedar_ember` was null, whereas flagged usage returned a status object
with `eligible: false`, `ineligible_reason: "surface"` and no grants under Pix's
ordinary User-Agent. The CLI transport sets `User-Agent: AI()`; its installed
`AI()` builds `claude-cli/2.1.283 (external, cli)` with an optional `client-app`
marker. A follow-up flagged GET with that format and `client-app/pi-ui-extend`
returned HTTP 200, `eligible: true`, one remaining reset and expiration
`2026-10-22T16:00:00+00:00`. This verifies read-only account response availability,
not native display or a supported public API. No reset redemption was performed.

## Decision

Reuse the separate reset-credit section and existing route credential. Read grants
from ordinary usage when non-null; otherwise request the CLI's read-only variant
as bounded supplementary data. Null in ordinary usage is not evidence that the
flagged details are unavailable. This corrects the initial null-suppresses-lookup
implementation based on the follow-up response evidence. A non-null inline
object remains authoritative, including an explicitly ineligible response.
Supplementary failure must not hide ordinary quota.
Use the verified CLI-surface compatibility User-Agent, with Pix's explicit
`client-app/pi-ui-extend` marker, only for the flagged grant lookup. The version
is the inspected protocol compatibility stamp, not a detected local CLI version.
Ordinary usage keeps Pix's existing identity. Do not spawn the CLI to discover a
version or change auth ownership for this read-only request.
Keep one row per grant with its remaining quantity and exact backend expiration;
show the local expiry date alongside the countdown for Claude grants.

Treat grants as banked, not necessarily redeemable now. Exclude ineligible,
paused, not-yet-started, spent and known expired grants; do not gate remaining
inventory on `usable_now` or cooldown. Missing expiry is explicit. Drop grant
inventory from stale credential-pending quota: external spending can invalidate
it without waiting for expiration. Never call the mutating reset endpoint.

## Alternatives

- Replace ordinary usage with the flagged endpoint: would make normal quota
  depend on undocumented supplementary response semantics.
- Expand one grant into N credits: duplicates expiry rows and permits unbounded
  UI size; retain quantity instead.
- Show only `usable_now` grants: hides banked resets until quota is exhausted.
- Browser cookies or another route's credential: creates cross-account ambiguity
  and new credential ownership; retain current credential boundaries.
- Generic Pix User-Agent for the flagged request: live evidence reports
  `ineligible_reason: "surface"` and hides the available grant. Use the verified
  CLI-surface protocol format with an explicit Pix marker instead.

## Consequences

Adds at most one ten-second supplementary lookup per normal quota refresh, no
refresh-on-open. Schema drift may hide grants while quota remains usable. The
display is passive and can lag external spending until the next refresh. Unit
and transport fixtures do not prove live account availability or native UI.

## Revisit when

Anthropic publishes an authoritative reset API, the installed CLI changes the
response/endpoint, or live account evidence disagrees with these fixtures.
Also revisit the pinned compatibility User-Agent if Anthropic changes surface
recognition; do not infer account ineligibility from a surface mismatch.
