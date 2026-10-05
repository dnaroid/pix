# 0037 — Status-bar hover details

- Status: superseded for popup activation/retention/dismissal; content and chrome choices remain accepted
- Recorded: 2026-10-05
- Decided: 2026-10-05
- Owner / approval evidence: user explicitly requested Desktop Context and Usage details on hover rather than click (conversation-only evidence).
- Governing specs: [Desktop runtime status](../../specs/desktop-runtime-status.md), [Session usage](../../specs/session-usage.md), [Observer](../../specs/heads-up-observer.md), [Council](../../specs/brainstorm.md)
- Replaces / replaced by: [0048 — Status-bar click popups](0048-status-bar-click-popups.md) supersedes hover/focus opening and pointer-departure dismissal. The historical rationale below is retained.

## Context

Context and Usage were click-open non-modal status-bar panels. The requested
change concerns opening/dismissal, not their telemetry, billing or quota semantics.

## Observations and sources

- [RuntimeStatusBarItems](../../desktop/src/components/RuntimeStatusBarItems.svelte)
  owns both panels; Usage includes actionable links and a limits-refresh button.
- [DESIGN.md](../../DESIGN.md) requires keyboard access to hover-exposed commands.
- No native UI verification is claimed by this decision.

## Decision

Open details on pointer hover or keyboard focus. Preserve the native button as an
idempotent activation fallback, not a click toggle. Keep the panel open while
pointer or focus is inside its region, bridge the visual gap with transparent
padding, and retain Escape/outside-pointer dismissal. Opening Usage once must
not duplicate its request when focus/click follows hover. Context still performs
no durable DCP request; Usage still performs no automatic quota refresh.

## Alternatives

- Keep click-only panels: contrary to the explicit request.
- Hover-only access: makes actionable Usage details inaccessible to keyboard users.
- Delayed-close timers: unnecessary when a continuous pointer hit region bridges
  the gap; avoiding timers removes teardown and stale-close concerns.

## Consequences

Details require no click and panel actions remain reachable. Hovering Usage now
initiates the existing on-demand spend load; provider quota polling is unchanged.
Keyboard focus can keep the panel open after the pointer leaves.

## Revisit when

Real desktop use reveals accidental openings or difficulty reaching panel actions,
or the panels move outside the trigger's DOM region.

## Follow-up: Observer, council and native tooltips

The user extended the request to Observer and council, clarified that removing
native tooltips applies to the **status bar**, not the sidebar, and requested
low placement that permits moving the pointer onto each popup. Observer now uses
idempotent hover/focus opening without autofocus or implicit checks. Its existing
owner guards, explicit controls and dismissal remain. Council already had custom
hover/focus details; transparent padding now bridges its gap. Both keep a small
six-pixel visual separation. All status-bar-owned `title` attributes are removed;
quota explanations move into the existing Usage surface. Sidebar behavior and
native AppKit popovers are out of scope. This extends, rather than supersedes,
the original decision's pointer continuity and keyboard-access rationale.

The user then requested Observer on the right, followed by Subagents and Plan,
with one-pixel separators. Radar replaces Eye to distinguish Observer from agent
icons; its status colors and checking-only pulse remain unchanged. Council stays
before Observer, Usage remains in the left group, and separators are conditional
on visible neighboring groups. This is a chrome-only choice, not an activity
policy change.

The final clarification extends the same conditional one-pixel separator to the
gap after council; no bullet separator is used. An absent council or absent next
visible group produces no separator.

## Follow-up: gap-free alignment and readable Observer icon

The user subsequently reported popups closing before the pointer reached them
and requested lower-edge alignment with Plan. This supersedes the six-pixel
visual separation above: all status-bar popups now touch their triggers without
bottom padding; Observer's fixed-position helper computes that same edge directly.
Pointer/focus ownership and dismissal are unchanged, with no delayed-close timers.

The user also requested removal of the visible weekly-limit description from
Usage. The spend popup no longer renders a quota-description block, matching the
session-usage contract; compact trigger windows and explicit refresh remain.
Finally, the user reported Radar unreadable at status-bar size. A 16px Binoculars
icon replaces it to give Observer a recognizable silhouette while preserving
status colors and checking-only pulse. Keeping Radar or adding text was rejected
in favor of a clearer compact icon. Revisit if real Desktop use still reveals
poor legibility or pointer reachability; no native UI verification is claimed.

The user also requested less space around separators. The right-hand controls
share a compact two-pixel gap with no extra separator margins. Plan uses the same
24px trigger height as the other controls so gap-free popup lower edges align.

The no-visible-quota-block follow-up is subsequently superseded only for the
separately labelled weekly calendar by [0039](0039-quota-reset-calendar.md).
All hover, refresh and gap-free alignment decisions remain unchanged.

## Follow-up: pointer-travel grace for Context and Usage

Evidence: the user still reports that the limits popup closes before the cursor
reaches it, unlike Plan and Observer. RuntimeStatusBarItems closes immediately on
pointer departure. Gap-free edges do not cover every diagonal path from a narrow
trigger to a wider popup; that path is the working explanation, not a claim of
native UI reproduction.

Add a 200ms pointer-departure grace period to the shared Context/Usage interaction.
This supersedes the earlier rejection of timers and the no-delay statement above,
but not lower-edge alignment. Reentry, focus/activation and sibling opening cancel
the pending close; expiry rechecks pointer/focus ownership. Escape, outside pointer
interaction and focus leaving an unhovered region remain immediate. The timer is
disposed with the component, avoiding stale closure or retained DOM after teardown.
Opening remains idempotent and quota refresh behavior is unchanged. Plan, Observer
and council interactions are not changed.

Alternatives: keep immediate closure (already insufficient in reported use), or
expand invisible hit areas (can intercept neighboring status controls). The bounded
delay is less intrusive, at the cost of a briefly lingering panel after departure.
Revisit the duration or pointer corridor if real Desktop use still shows difficulty
reaching actions. Fake-timer tests verify cancellation/lifecycle, not native cursor
geometry; no native UI verification is claimed.
