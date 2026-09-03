# Spec: Desktop project selector in the title bar

## Type

Change

## Goal

Place the active-project selector in the desktop window title bar instead of the conversation-tab row.

## Behavior

- On macOS, the webview extends into the native title bar and leaves space for the traffic-light controls.
- The title bar shows the active workspace name and opens the existing workspace chooser when clicked.
- Empty title-bar space can be used to drag the window.
- The macOS traffic-light controls are vertically aligned with the project selector.
- Conversation tabs remain in a separate row below the title bar.
- On platforms where native title-bar overlay is unavailable, the project control remains usable as the first in-app row.

## Non-goals

- Replacing native window controls on Windows or Linux.
- Moving conversation tabs into the native title bar.

## Related files

- `desktop/src-tauri/tauri.conf.json`
- `desktop/src/components/ProjectTitlebar.svelte`
- `desktop/src/components/SessionTabs.svelte`
- `desktop/src/App.svelte`

## Verification

- Run desktop type checks and tests.
- Build the desktop web frontend.
- Confirm the selector remains disabled while a prompt or workspace operation is active.

## Evidence

- Confirmed by code: the existing workspace chooser and disabled-state behavior.
- Confirmed by installed Tauri schema: `titleBarStyle: "Overlay"` and `hiddenTitle` are supported window options.
- Confirmed by native-window inspection (macOS): with `trafficLightPosition.y = 16` the traffic-light dots render at y 12..24 (center ≈18), aligned with the project selector centered in the 36px header; the macOS button frame draws the visible dot 4px above the configured frame origin, so y=16 is required for visual centering (y=12 rendered at y 8..20, 4px high).
- Confirmed by native-window inspection (macOS): dragging empty title-bar space moves the window and dragging the transcript area does not. Dragging requires the `core:window:allow-start-dragging` capability (`core:window:default` does not include it); `core:window:allow-internal-toggle-maximize` restores native double-click-to-zoom on the title bar.
