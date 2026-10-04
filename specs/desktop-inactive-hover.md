---
kind: spec
status: proposed
---

# Desktop focus on hover

## Behavior

On macOS, moving the pointer into or over the visible webview of an inactive
Pix window activates Pix and makes that exact window key and frontmost without
a click. This applies when another Pix window or another application is active.
Keyboard focus deliberately transfers to the hovered window; its existing first
responder is preserved. Moving out does not restore the previous focus.

The shared native creation path installs this support for initial, restored,
fallback and newly opened project windows. Active-window event delivery and
the existing activating first click remain unchanged.

## Constraints and failure cases

- macOS only; no browser-preview or other-platform changes.
- No synthetic JavaScript events, polling, global event monitors or private
  WebKit selectors/classes. Use public AppKit activation and window APIs.
- A passive, hit-test-transparent child NSView owns an ActiveAlways tracking
  area. Enter/move callbacks activate the app and make the owning window key
  only if it is not already key in the active app. WebKit's own tracking areas
  are neither inspected nor replaced; normal WebKit hover resumes after focus.
- Visible bounds follow native resizing. Ownership is entirely the native view
  hierarchy; no application registry, timers or closures retain closed windows.
  Installation is idempotent. Hidden/minimized/detached views do not take focus.
  Tracking is not enabled during mouse drags; clicks/drag hit testing remains
  with the webview. No explicit input focus, unhide or deminiaturize calls.
- Installation failures log a diagnostic but do not prevent opening a window.
- Native HTML `title` tooltip display is controlled by WebKit/AppKit and needs
  separate native runtime verification; CSS/DOM hover evidence alone is not
  evidence of tooltip display. This contract remains proposed until native QA.
- Focus transfer intentionally raises the hovered window. It is not inactive
  hover without focus stealing; that earlier approach failed per user report.

Decision: [Focus on hover](../docs/decisions/0038-focus-on-hover.md), superseding
[inactive-only forwarding](../docs/decisions/0036-inactive-window-hover.md).
Window click/persistence contract: [Desktop window state](desktop-window-state.md).

## Implementation

- `desktop/src-tauri/src/inactive_hover.rs`
- `desktop/src-tauri/src/startup_theme.rs`
- `desktop/src-tauri/src/lib.rs`
- `desktop/src-tauri/Cargo.toml`

## Tests

- `desktop/src-tauri/src/inactive_hover.rs` (focus policy and tracking option tests)
- `desktop/src-tauri/src/startup_theme.rs` (shared creation/reveal behavior)
- `desktop/src/lib/native-window-config.test.ts` (first-click compatibility)

## Verification

Run Cargo check and focused native Rust tests; run the native-window-config
Vitest regression. Real native QA must distinguish CSS hover, DOM event
delivery and native HTML title tooltip display. Check another Pix key window
and another frontmost app without clicking the hovered window; assert that Pix
activates and the hovered window becomes key, CSS hover and title tooltips work,
and exit does not restore focus. Check resize/new-window/close and reopen, hidden
and minimized windows, and normal active-window clicks and titlebar dragging.
