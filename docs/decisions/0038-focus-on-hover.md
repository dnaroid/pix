# 0038 — Focus on hover

- Status: accepted
- Recorded: 2026-10-04
- Decided: 2026-10-04
- Owner / approval evidence: user reported “не работает” and requested
  “передавать фокус окна при ховере над ним”.
- Governing spec: [Desktop focus on hover](../../specs/desktop-inactive-hover.md)
- Replaces / replaced by: replaces [0036](0036-inactive-window-hover.md)

## Context

Inactive-only WebKit event forwarding did not work according to the user. The
previous constraint against focus stealing is explicitly removed by the new
request. Scope is exposed macOS Pix webview bounds, including custom chrome.

## Observations and sources

- Reported evidence: user says the previous approach does not work; no native
  automated reproduction was obtained.
- Source evidence: `inactive_hover.rs` already installs a passive ActiveAlways
  tracking child in the shared startup window builder. `desktop_notification.rs`
  already uses AppKit app activation followed by exact-window key/front ordering.
- Assumption requiring native QA: making the hovered window key restores normal
  WebKit CSS hover and native title tooltips. Compile/policy tests do not prove it.

## Decision

Replace opaque WebKit owner forwarding with app activation and exact-window
`makeKeyAndOrderFront` on pointer enter/move. Skip already-key active windows and
hidden/minimized/detached windows. Preserve hit-test transparency and native view
ownership, do not enable tracking during drag, and do not change first responder
explicitly. No focus restoration on exit, timers or global monitors.

## Alternatives

- Continue inactive forwarding: user reports failure and requests focus instead.
- Focus only on click: does not satisfy the requested hover behavior.
- Global pointer monitoring: adds coordinate/lifecycle complexity unnecessarily.

## Consequences

Hover now deliberately steals keyboard focus and raises the hovered Pix window.
An enter or move event may activate Pix from another app. This simplifies delivery
by removing dependency on WebKit's tracking owner metadata. Actual native focus,
tooltips, resizing and teardown behavior still need runtime verification.

## Revisit when

Native QA shows missing focus/hover/tooltips, drag interference, focus oscillation,
or the user requests opt-in/no-focus behavior again.
