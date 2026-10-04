# 0036 — Inactive-only native hover forwarding

- Status: superseded
- Recorded: 2026-10-04
- Decided: 2026-10-04
- Owner / approval evidence: user approved implementing native inactive hover
  without activation/focus stealing; forwarding design is an implementation choice.
- Governing spec: [Desktop inactive-window hover](../../specs/desktop-inactive-hover.md)
- Replaces / replaced by: replaced by [0038 — Focus on hover](0038-focus-on-hover.md)

Superseded after the user reported that forwarding did not work and explicitly
requested transferring window focus on hover. The rationale below records the
original no-focus requirement, not the current contract.

## Context

The user reports missing hover/tooltips in inactive macOS Tauri windows. The
existing `acceptFirstMouse` setting affects clicks, not passive pointer movement.
Activating the application/window on mouse enter is explicitly unacceptable.

## Observations and sources

- Source evidence: installed Tao 0.35.3 enables mouse-moved events on NSWindow;
  Wry 0.55.1 does not install inactive WKWebView hover forwarding.
- Upstream WebKit `Source/WebKit/UIProcess/mac/WebViewImpl.mm` creates primary
  tracking with ActiveInKeyWindow (or ActiveAlways for legacy scrollbars) and
  an opaque tracking owner that routes enter/move/exit to WebKit. Attaching
  an area with the WKWebView itself as owner is not sufficient source evidence.
- AppKit exposes tracking areas, options, owners and their mouse callbacks as
  public APIs. InVisibleRect follows visible bounds; area owners are unretained.
- User report and upstream source do not establish runtime success in the
  installed macOS WebKit. Native tooltips must be measured independently.

## Decision

Add a passive NSView child with an ActiveAlways/InVisibleRect tracking area in
the shared window builder. It never wins hit testing and forwards the original
native event to the current primary mouse tracking owner only if that owner's
area is inactive. Do not replace WebKit-managed areas or hard-code private class
names/selectors. Keep ownership in the view hierarchy and callbacks synchronous
and bounded on main; no background tasks, global monitors or retained windows.

## Alternatives

- Activate/make key on enter: violates the user's no-focus-stealing requirement.
- Synthetic DOM events: do not establish CSS hover or native tooltip semantics.
- Replace WebKit's primary area with an ActiveAlways copy: risks duplicates
  when WebKit recreates its own area after scrollbar preference changes.
- Global pointer monitor/polling: unnecessary shared lifecycle and coordinate
  complexity; native view tracking already scopes events to visible bounds.

## Consequences

Adds macOS-specific code but no frontend API/UI changes. Active-window and
already-Always tracking are not duplicated. Hit testing, clicks and titlebar
dragging retain existing semantics. Native QA is the acceptance gate, especially
for HTML title tooltips and another application's frontmost/key status.

## Revisit when

Native QA fails, macOS/WebKit changes tracking metadata or callbacks, title
tooltip behavior differs from DOM hover, or resize/teardown exposes stale hover.
