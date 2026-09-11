# Desktop project switcher and identity color

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Keep project navigation in the workspace-oriented sidebar while giving every
project a stable visual identity that can be overridden from the project itself
without blocking desktop interactions.

## Behavior

- The window title bar does not contain a project selector. On macOS the webview
  still extends into the native title bar and reserves the existing traffic-light
  inset; conversation tabs remain in the 36 px header and empty title-bar space
  remains draggable.
- The `Project` sidebar view starts with a compact project switcher above the file
  explorer. It shows the active project, keeps an explicit chevron affordance at
  the right edge of the row, and opens an inline menu of at most 20 recent projects.
  The switcher measures the rendered fixed controls/padding/gaps and reports a
  dynamic minimum width to the sidebar. The sidebar uses that value both for drag
  clamping and as its CSS minimum, so resizing cannot clip the folder or chevron.
  Only a bounded project-name slot (96–160 px) contributes text width; the project
  path never contributes to the minimum and therefore cannot make the sidebar
  arbitrarily wide.
- The secondary path line under a project name shows only the containing directory;
  it does not repeat the project-folder basename already shown on the primary line.
- The active project is identified in the menu. Selecting another recent project
  switches the current workspace and moves it to the top of the persisted recent
  list.
- The switcher can open the native directory chooser for the current window or a
  new window. Current-window navigation is disabled while conflicting prompt,
  workspace, or task work is active; new-window actions remain available.
- Recent projects persist locally under `pix.desktop.recentProjects`; malformed,
  relative, and duplicate entries are ignored. `pix.desktop.workspace` remains
  the persisted active project and is folded into the recent list on startup.
- Escape and outside-click dismiss the project menu. Opening it closes the
  conversation selector, and top-level session/workspace actions can close it
  through the sidebar component handle.
- The project activity-rail folder and project-switcher folders use a stable
  fallback hue derived from the normalized full project path rather than only
  its basename. Windows drive and UNC identities are compared case-insensitively.
- A project may override the fallback identity color in `.pi/workspace.jsonc`:

  ```jsonc
  {
    "color": "#7aa2f7",
  }
  ```

  Three-, four-, six-, and eight-digit hex colors are accepted. Missing,
  malformed, or unsupported values silently use the deterministic fallback.
- The Project panel header exposes a project-settings action. It opens a compact
  IDE-style modal with `Automatic` and `Custom` identity-color modes, a native
  color picker plus editable hex value, a live folder preview, and the workspace
  config path. Saving `Automatic` removes only the `color` property; saving a
  custom color updates only that property and preserves sibling JSONC settings
  and comments. A malformed `.pi/workspace.jsonc` is never overwritten.
- Project-color saves are asynchronous and do not set the global workspace
  operation/busy state. The renderer reads the latest workspace config, applies
  the color edit, then uses a compare-and-swap Tauri write. If the file changed
  between read and write, the current document is returned and the renderer
  retries the edit up to three times instead of overwriting a concurrent change.
- Workspace-config replacement is written to a unique same-directory temporary
  file, flushed, atomically replaced where supported, and followed by a directory
  sync. Existing `.pi/workspace.jsonc` symlinks are rejected.
- Recent-project color overrides are loaded asynchronously on startup, whenever
  the recent list changes, and when the switcher opens. Project switching and
  rendering never await color IO.
- Each color refresh owns a generation. A completion may mutate visible color
  state only if that generation is still current and the project still belongs
  to the recent-project list; stale completions are discarded.

## Non-goals

- Replacing native window controls on Windows or Linux.
- Creating project scaffolding or initializing a repository inside a chosen folder.
- Recoloring global IDE chrome or semantic status colors from the project color.
- Treating a missing or invalid workspace color override as a desktop error.

## Invariants

- Project color loading never gates workspace switching, session actions, or the
  project file explorer.
- Older async color refreshes cannot overwrite a newer refresh.
- Starting a color save invalidates older color-read generations, so an in-flight
  pre-save read cannot repaint the saved value afterward.
- A stale workspace-config save cannot overwrite a newer Pix-owned config write;
  the compare-and-swap result is rebased and retried.
- Removing a project from the recent list removes its cached override from
  visible state.
- The renderer uses the existing asynchronous `read_project_file` Tauri command;
  filesystem work stays on its blocking worker path and remains confined to the
  canonical workspace.
- The bounded recent-project list also bounds color-load fan-out.

## Edge cases

- Projects with the same folder basename at different paths get independent
  deterministic identities.
- Reopening the switcher refreshes overrides, so an externally edited
  `.pi/workspace.jsonc` can be picked up without restarting Pix Desktop.
- Switching projects while an earlier color read is in flight cannot apply that
  older refresh after a newer generation starts.
- If the workspace config changes while the settings save is in flight, the color
  edit is reapplied to the returned current document. Repeated conflicts remain
  visible in the modal instead of silently winning with stale content.

## Related files

- `desktop/src-tauri/tauri.conf.json`
- `desktop/src/App.svelte`
- `desktop/src/components/WorkspaceSidebar.svelte`
- `desktop/src/components/ProjectSwitcher.svelte`
- `desktop/src/components/ProjectSettingsDialog.svelte`
- `desktop/src/components/ProjectFolderIcon.svelte`
- `desktop/src/lib/recent-projects.ts`
- `desktop/src/lib/project-colors.ts`
- `desktop/src/components/SessionTabs.svelte`
- `desktop/src-tauri/src/lib.rs`

## Verification

- `desktop/src/lib/recent-projects.test.ts` covers normalized full-path fallback
  identity.
- `desktop/src/lib/project-colors.test.ts` covers JSONC override parsing and
  fallback behavior.
- `desktop/src/components/ProjectSwitcher.test.ts` covers current/new-window
  actions, the visible chevron affordance, and verifies that the UI component
  does not own filesystem IPC.
- `desktop/src/components/ProjectSettingsDialog.test.ts` covers the settings
  entry point, automatic/custom controls, native color picker, and presentation/
  persistence separation.
- Rust tests in `desktop/src-tauri/src/lib.rs` cover atomic workspace-config
  replacement and stale compare-and-swap rejection.
- Run `npm --prefix desktop test`, `npm --prefix desktop run check`, and
  `npm --prefix desktop run build:web`.

## Evidence

- Confirmed by code: `App.svelte` owns project-color refresh generations and
  accepts results only for the current generation and current recent-project set.
- Confirmed by code: `ProjectSwitcher.svelte` owns the sidebar interaction state
  but no filesystem or Tauri IPC.
- Confirmed by code: `ProjectSettingsDialog.svelte` is presentation-only; App owns
  generation guards/retries and Rust owns confined atomic persistence.
- Confirmed by code: `read_project_file` runs project-file reads through the
  Tauri blocking worker path with workspace confinement.
- Confirmed by installed Tauri schema: `titleBarStyle: "Overlay"` and `hiddenTitle` are supported window options.
- Confirmed by native-window inspection (macOS): with `trafficLightPosition.y = 16` the traffic-light dots render at y 12..24 (center ≈18); the macOS button frame draws the visible dot 4px above the configured frame origin, so y=16 remains required for visual centering (y=12 rendered at y 8..20, 4px high).
- Confirmed by native-window inspection (macOS): dragging empty title-bar space moves the window and dragging the transcript area does not. Dragging requires the `core:window:allow-start-dragging` capability (`core:window:default` does not include it); `core:window:allow-internal-toggle-maximize` restores native double-click-to-zoom on the title bar.
- Confirmed by tests: the recent-project, project-color, and project-switcher unit
  tests cover the deterministic identity and override surface.
