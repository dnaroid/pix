---
kind: spec
status: active
---

# Desktop inactive-window pointer behavior

## Behavior

Pointer enter/move over an inactive Pix window must not activate Pix, transfer
keyboard focus or raise the window. Normal WebKit/AppKit hover behavior is used;
there is no Pix-owned inactive-window hover bridge or event forwarding workaround.
The existing activating first click (`acceptFirstMouse: true`) stays unchanged.
This applies to initial, restored, fallback and newly opened project windows.
Explicit activation paths such as notification clicks are outside this contract.

## Constraints

- No native hover tracking child, global pointer monitor, polling or synthetic
  DOM events are installed to compensate for inactive WebKit hover behavior.
- Inactive CSS hover and HTML title tooltips are not guaranteed by Pix.
- Restart the updated native binary to remove tracking views from a running old
  build; source changes alone do not remove those already-installed views.

Decision: [Remove hover focus](../docs/decisions/0045-remove-hover-focus.md).
Historical approaches: [focus on hover](../docs/decisions/0038-focus-on-hover.md)
and [inactive forwarding](../docs/decisions/0036-inactive-window-hover.md).
Related: [Desktop window state](desktop-window-state.md).

## Implementation

- `desktop/src-tauri/src/startup_theme.rs`
- `desktop/src-tauri/src/lib.rs`
- `desktop/src-tauri/Cargo.toml`
- `desktop/src-tauri/tauri.conf.json`

## Tests

- `desktop/src-tauri/src/startup_theme.rs`
- `desktop/src/lib/native-window-config.test.ts`
- `desktop/src/startup-theme.test.ts`

## Verification

Run Cargo check/tests and the native-window-config/startup-theme Vitest tests.
Confirm no hover bridge installation or module remains. In native macOS Desktop,
after restarting the updated build, move the pointer over an inactive Pix window
while another app is frontmost: focus and ordering must remain unchanged. Clicking
the window should still activate it and deliver that first click.
