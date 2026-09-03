# Spec: Desktop project selector in the title bar

## Type

Change

## Goal

Provide a compact project switcher in the desktop window title bar instead of the conversation-tab row.

## Behavior

- On macOS, the webview extends into the native title bar and leaves space for the traffic-light controls.
- The title bar shows the active project name and a deterministic folder color derived from that name.
- Clicking the project control opens a compact menu of at most 20 recent projects.
- The active project is identified in the menu; selecting another recent project switches the workspace and moves it to the top of the list.
- Each recent project uses the same name-derived folder color as it does when active.
- The menu includes an action that opens the native directory chooser with directory creation enabled where the platform supports it.
- Recent projects persist locally under `pix.desktop.recentProjects`; malformed, relative, and duplicate entries are ignored.
- The existing `pix.desktop.workspace` value remains the persisted active project and is folded into the recent list on startup.
- Escape and outside-click dismiss the menu, and the project and conversation selectors do not remain open together.
- Empty title-bar space can be used to drag the window.
- The macOS traffic-light controls are vertically aligned with the project selector.
- Conversation tabs remain in a separate row below the title bar.
- On platforms where native title-bar overlay is unavailable, the project control remains usable as the first in-app row.

## Non-goals

- Replacing native window controls on Windows or Linux.
- Moving conversation tabs into the native title bar.
- Creating project scaffolding or initializing a repository inside a chosen folder.

## Related files

- `desktop/src-tauri/tauri.conf.json`
- `desktop/src/components/ProjectTitlebar.svelte`
- `desktop/src/components/ProjectFolderIcon.svelte`
- `desktop/src/lib/recent-projects.ts`
- `desktop/src/components/SessionTabs.svelte`
- `desktop/src/App.svelte`

## Verification

- Run desktop type checks and recent-project unit tests.
- Build the desktop web frontend.
- Confirm the selector remains disabled while a prompt or workspace operation is active.
- Confirm a selected folder can be created from the native chooser on supported platforms.

## Evidence

- Confirmed by code: the existing workspace chooser and disabled-state behavior.
- Confirmed by installed Tauri schema: `titleBarStyle: "Overlay"` and `hiddenTitle` are supported window options.
- Confirmed by native-window inspection (macOS): with `trafficLightPosition.y = 16` the traffic-light dots render at y 12..24 (center ≈18), aligned with the project selector centered in the 36px header; the macOS button frame draws the visible dot 4px above the configured frame origin, so y=16 is required for visual centering (y=12 rendered at y 8..20, 4px high).
- Confirmed by native-window inspection (macOS): dragging empty title-bar space moves the window and dragging the transcript area does not. Dragging requires the `core:window:allow-start-dragging` capability (`core:window:default` does not include it); `core:window:allow-internal-toggle-maximize` restores native double-click-to-zoom on the title bar.
