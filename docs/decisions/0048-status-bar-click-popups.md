# 0048 — Status-bar click popups

- Status: accepted
- Recorded: 2026-10-05
- Decided: 2026-10-05
- Owner / approval evidence: user explicitly requested all Desktop status-bar popups open by click instead of hover (conversation-only evidence).
- Governing specs: [Desktop runtime status](../../specs/desktop-runtime-status.md), [Session usage](../../specs/session-usage.md), [Observer](../../specs/heads-up-observer.md), [Council](../../specs/brainstorm.md), [Session activity](../../specs/desktop-session-sidebar.md)
- Replaces: [0037 — Status-bar hover details](0037-status-bar-hover-details.md) for activation, retention and dismissal only; its content, ordering, tooltip removal and gap-free alignment choices remain.

## Context

The user reversed the earlier hover-opening request and separately requested
complete removal of the right Session pane, covered by
[0047](0047-remove-session-inspector.md). Detail access must remain in the status bar.

## Observations and sources

- Context/Usage and Observer had explicit pointer/focus opening handlers.
- Council and activity details used CSS hover/focus visibility; their clicks
  opened the former Session inspector.
- Usage reads recorded spend on demand; Observer opening can request a quiet
  snapshot. Neither opening performs inference or automatic quota refresh.
- These are source observations, not a claim of native UI verification.

## Decision

Use native button activation (click, Enter or Space) to toggle every status-bar
detail popup. Hover and mere focus never open it. Pointer departure does not
close it; repeat activation, outside pointer interaction, focus leaving its
region or Escape do. Escape restores trigger focus. Keep non-modal semantics,
gap-free positioning and existing actionable content. Context/Usage are mutually
exclusive. Session switches remount session-specific detail surfaces.

Council, individual agents, overflow `+N` and Plan use one shared click-popover
component. Overflow lists the additional agents rather than opening a removed
pane. Plan still centers the current item on opening and retains Clear.
Council participant-session navigation moves into the council popup rather than
being lost with the removed inspector.
Sidebar tooltips and non-status-bar surfaces are not changed.

## Alternatives

- Retain hover opening or idempotent clicks: contrary to the current request.
- Remove detail access with the inspector: loses live Plan/Subagent information.
- Use modal dialogs: unnecessarily blocks the workbench for status inspection.

## Consequences

Details require intentional activation. Hover timers and pointer corridors are
unnecessary. Existing telemetry, billing, quota refresh, controls and session
ownership guards remain authoritative.

## Revisit when

Native keyboard or narrow-window testing reveals unreachable actions or clipped
details, or new status controls introduce a different activation policy.
