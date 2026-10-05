# 0045 — Remove hover focus

- Status: accepted
- Recorded: 2026-10-05
- Decided: 2026-10-05
- Owner / approval evidence: user requested removal because accidental hover
  brings Pix to the front and covers other windows.
- Governing spec: [Inactive-window pointer behavior](../../specs/desktop-inactive-hover.md)
- Replaces / replaced by: replaces [0038](0038-focus-on-hover.md)

## Context

Hover activation intentionally transferred focus and raised Pix, but the user
reports that accidental pointer movement makes this disruptive.

## Observations and sources

- Reported evidence: the user's accidental-hover/frontmost-window observation.
- Source evidence: `inactive_hover.rs` called app activation and
  `makeKeyAndOrderFront` from enter/move callbacks, installed by `startup_theme.rs`.
- Runtime removal verification is not yet established by native automation.

## Decision

Remove the entire native hover bridge, its startup installation, module and
exclusive AppKit features. Do not restore the earlier opaque WebKit forwarding
workaround. Leave normal platform hover and activating first-click behavior
unchanged. Notification-driven activation is unrelated and remains intact.

## Alternatives

- Delay or opt-in hover activation: not requested; retains unwanted focus behavior.
- Restore inactive event forwarding: previously reported not working by the user.

## Consequences

Pointer movement alone no longer has a Pix-owned activation/front-order path.
Inactive-window hover/tooltips remain subject to WebKit's normal behavior. An
already-running build needs a restart onto the updated binary to remove its
installed native tracking view.

## Revisit when

A reliable no-activation hover solution is demonstrated and explicitly requested.
