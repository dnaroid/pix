---
kind: spec
status: active
---

# Desktop startup theme

## Behavior

The native window and initial HTML use the semantic background for the current
system color scheme: light `#faf9f5`, dark `#0f1115`. A dark launch must not expose
the WebView's default white surface before the document paints.

All window creation paths (initial, restored, fallback and new project) create
windows hidden. A configured-visible window is shown after its first completed
document load, with the native theme background applied before showing it.
This does not wait for sessions, workspace services or network requests.

## Constraints and failure cases

On macOS, Tauri's background-color API does not color the WebView layer, so
native background updates alone are insufficient. Inline startup CSS precedes
the module bundle and follows the system color scheme without JavaScript.
Intentionally hidden windows stay hidden; subsequent document loads never show
the window again. A document that never finishes loading remains hidden.
Theme/background/show API failures are logged; no timer reveals an unpainted
window as a fallback.

## Implementation

- `desktop/src-tauri/src/startup_theme.rs`
- `desktop/src-tauri/src/window_restore.rs`
- `desktop/index.html`
- `desktop/src/styles.css`
- [Visual contract](../DESIGN.md)
- [Reveal decision](../docs/decisions/0003-desktop-startup-reveal.md)

## Tests

- `desktop/src-tauri/src/startup_theme.rs` (palette and one-shot reveal tests)
- `desktop/src/startup-theme.test.ts` (pre-bundle CSS and palette consistency)

## Verification

Run focused Rust and Vitest startup-theme tests. Verify real macOS launch under
dark and light system appearance, restored windows and new-project windows:
no white intermediate canvas in dark appearance, no repeated reveal on reload.
