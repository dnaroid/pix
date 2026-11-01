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
The initial reveal also activates Pix and raises that window on the native main
thread. Every restored window is raised independently as its document becomes
ready; startup does not leave the restored windows behind other applications.
Optional tray-icon setup re-raises already visible windows if it finishes after
their reveal, but never exposes documents that are still loading. It does not
change activation policy; Dock and tray-icon modes share normal window behavior.
This does not wait for sessions, workspace services or network requests.

## Constraints and failure cases

On macOS, Tauri's background-color API does not color the WebView layer, so
native background updates alone are insufficient. Inline startup CSS precedes
the module bundle and follows the system color scheme without JavaScript.
Intentionally hidden windows stay hidden; subsequent document loads never show
the window again. A document that never finishes loading remains hidden.
Theme/background/show API failures are logged; no timer reveals an unpainted
window as a fallback.

## Related guidance

- [Visual contract](../design.md)
- [Reveal decision](../../decisions/0003-desktop-startup-reveal.md)

## Regression coverage

- Palette and one-shot reveal tests

- Pre-bundle CSS and palette consistency

## Verification

Run focused Rust and Vitest startup-theme tests. Verify real macOS launch under
dark and light system appearance, restored windows and new-project windows:
no white intermediate canvas in dark appearance, no repeated reveal on reload.
All restored windows must come to the foreground with the tray icon both disabled
and enabled.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"0afc4639b879cf886e26611d72ef59642980a23d85130ba74c2399734d833bd9","checkedAt":"2026-10-31T00:32:28.886Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":52,"reportLanguage":"ru"} -->
