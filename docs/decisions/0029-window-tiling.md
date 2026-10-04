# 0029 — Current-display-first window tiling

- Status: accepted
- Recorded: 2026-10-04
- Decided: 2026-10-04
- Owner / approval evidence: user approved current-screen-first overflow and an
  application-menu entry in the task conversation, then requested implementation.
- Governing spec: [Desktop window tiling](../../specs/desktop-window-tiling.md)
- Replaces / replaced by: none

## Context

Users need to arrange multiple Pix windows without manually moving/resizing
them. Desktop currently supports macOS; existing native configuration imposes
860×380 logical-point content minimums.

## Observations and sources

- Verified: `tauri.conf.json` sets minimum content size; `window_geometry.rs`
  owns normal logical geometry for persistence.
- Verified: AppKit `NSScreen.visibleFrame` exposes usable display space and
  `NSWindow.setFrame:display:` accepts native point coordinates.
- Conversation evidence: user wants to fill the current display before second,
  third and subsequent displays; approves active-first row-major placement and
  leaving excess windows untouched. A menu item is sufficient; no toolbar button.
- Assumption: configured content minimum is the usable-size floor, not a new
  preference. Real multi-monitor behavior requires hardware evidence.

## Decision

Keep this in a cohesive native window-tiling module. Preserve Tauri's default
menu and add «Разложить окна» to the Pix application submenu. Plan up to a 3×3
grid per display using available point-space and configured native minimums.
Other windows use stable labels; other displays use macOS enumeration order.
Apply frames synchronously on the main thread to avoid asynchronous Tauri
move/resize scale transitions. Skip fullscreen Spaces; restore minimized and
zoomed windows only if they receive a tile. No background layout maintenance.

## Alternatives

- A toolbar button: unnecessary UI density; user selected the application menu.
- Preserve each window's monitor: rejected by the user in favor of filling the
  current screen first.
- Independent Tauri physical move/resize calls: existing geometry implementation
  documents backing-scale transition races; native point-space avoids them.
- Force all windows into 3×3: can violate native minimum sizes on small displays.

## Consequences

Predictable overflow without shrinking windows below supported minimums. Small
screens may support only vertical tiles. Fullscreen windows are intentionally
excluded to avoid asynchronous Space transitions. Arrangement replaces normal
geometry, so clean exit remembers it; there is no undo/previous-layout snapshot.

## Revisit when

Users need selectable layouts, undo, display-order preferences, fullscreen
participation, or native multi-display evidence shows incorrect placement.
