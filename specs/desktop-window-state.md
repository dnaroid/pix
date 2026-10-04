# Desktop window state persistence

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Reopen all Pix Desktop windows that were open when the application exited, each
with its project, size and position, including the same display when that display
is still available at its saved desktop coordinates.

## Scope

- Persist every project window's normal size and desktop coordinates when the application exits.
- Persist the set of open window labels and their current workspace paths.
- Restore the persisted geometry on the next launch.
- Preserve whether the window was maximized.
- Persist the selected sidebar panel, sidebar collapsed state/width and session
  inspector open state/width independently for each stable window label.

## Non-goals

- Persisting fullscreen, visibility, or window decoration state.
- Synchronizing window geometry between machines.
- Adding user-facing window-layout settings.

## Behavior

- On first launch, the window uses the dimensions and placement from `tauri.conf.json` and the operating system.
- The minimum native window size is 860 × 380 logical points. The height keeps
  all seven 40 px Activity Bar buttons, its 12 px vertical padding, the 36 px
  titlebar and 28 px status bar visible, with 24 px spare vertical space.
  Default dimensions remain 1240 × 820; restored geometry respects this minimum.
- On macOS, clicking a control in an inactive window activates the window and delivers that same click to the webview (`acceptFirstMouse: true`), without requiring a second click. The shared configuration applies to default, restored, and newly opened project windows.
- On subsequent launches, recreate each saved window with its original stable
  label and workspace URL; do not add an extra main window when only project
  windows were open. Desktop session tabs and active-session pointers are scoped
  by stable window label and project, independently of the geometry snapshot.
- A project change updates the native window's workspace even if localStorage or
  browser history persistence fails. An explicitly saved empty window remains empty.
- Closing a window while other windows remain excludes it from the next launch.
  Closing the last window exits the app and retains that last window for relaunch.
- Explicit application Quit freezes window membership/workspaces before background
  resource cleanup; destruction and late workspace updates cannot erase that snapshot.
- A window close or application Quit with active conversations first requires
  [explicit confirmation](desktop-close-warning.md). Cancelling leaves the window
  registry unfrozen and all resources untouched; confirmation resumes clean exit.
- The development Restart button uses the same clean exit. `watch:all` waits for
  the old process to exit before launching its replacement, so shutdown persistence
  is not interrupted by SIGTERM/SIGKILL. A timed-out handoff leaves the old process alone.
- Normal macOS watcher shutdown, including terminal `Ctrl+C`, also requests
  clean application Quit by exact native PID and waits up to 30 seconds. It must
  not signal Desktop to stop it: failed/refused Quit or timeout leaves the app
  and launch helper alive with their bundles retained, rather than losing the
  latest window-membership snapshot.
- After a clean application exit, the next launch restores the last normal size and position (excluding minimized, maximized and fullscreen rectangles).
- Normal geometry is stored in macOS logical points, not unqualified physical
  pixels. It is applied to the window configuration before creation, so moving
  between screens with different backing scales does not repeatedly shrink it.
- Membership snapshots from before logical geometry was introduced still restore
  every project. Their unqualified plugin pixel rectangles are not migrated:
  the first launch uses configured dimensions/OS placement, then records the
  new normal geometry. Restored sizes respect configured logical minimums.
- Desktop coordinates restore the window onto the same available display.
- If the saved display is unavailable or the saved rectangle no longer intersects any display, the operating system chooses a safe position instead of restoring the window off-screen.
- A maximized window reopens maximized while retaining its previous normal geometry for a later unmaximize.
- Missing, unreadable, or malformed persisted state falls back to the configured defaults.
- UI-QA (`PI_UI_QA=1`) and release smoke (`PIX_RELEASE_SMOKE=1`) launches use one
  main window and do not read/write the user's open-window membership snapshot.
  The maximization plugin still operates in those launches; logical geometry is
  not persisted unless the native restore QA opt-in below is enabled.
- Native restore QA can explicitly set `PI_UI_QA_WINDOW_RESTORE=1` alongside
  `PI_UI_QA=1`: membership uses `qa-open-windows.json` and geometry uses
  `.qa-restore-window-state.json` for maximization, never the user's snapshots. The initial QA
  workspace override applies only when no windows were restored. Smoke still
  disables membership restoration even if the QA restore opt-in is set.

## Contracts

- Window state is stored in Tauri's application configuration directory.
- Normal size/position are owned by `window_geometry`/`window_restore`; the
  official window-state plugin persists/restores **only maximization**. It must
  not independently apply physical size/position after logical builder geometry.
- Geometry is keyed by stable window label. Membership/workspaces/logical geometry use a versioned,
  bounded `open-windows.json` in the same application configuration directory,
  atomically replaced during clean exit on the existing shutdown worker.
- Frontend pane layout uses localStorage keys under
  `pix.desktop.windowLayout.<encoded-window-label>.<preference>`. Windows sharing
  a project or webview origin cannot overwrite each other's layout. Reload and
  relaunch retain layout when the native label is retained; switching projects
  within a window keeps that window's layout. Browser preview has its own namespace.
- Legacy shared pane keys are not imported: their last writer cannot identify
  the owning window. Each window starts with default panes once, then remembers
  its own choices. Session-tab snapshots and active-session pointers also use
  this window namespace (`sessionTabs` / `activeSessions`), retaining per-project
  maps within each window. Legacy shared session keys are not imported either;
  windows start with a draft once, without deleting saved sessions. Shared recent
  projects and transient menus/dialogs are unchanged.
- Native move/resize/close callbacks cache only normal logical geometry, with no
  disk IO. Explicit Quit captures live normal geometry and freezes it with the
  membership snapshot before background teardown; late events cannot mutate it.
- Configured automatic main-window creation is disabled; native startup creates
  either the saved window set or one default main window.

## Related files

- `desktop/src-tauri/Cargo.toml`
- `desktop/src-tauri/src/lib.rs`
- `desktop/src-tauri/src/window_restore.rs`
- `desktop/src-tauri/src/window_geometry.rs`
- `desktop/src-tauri/tauri.conf.json`
- `desktop/src/app/project-workspace.svelte.ts`
- `desktop/src/app/workspace-controller.ts`
- `desktop/src/lib/window-layout-storage.ts`
- `desktop/src/app/session-inspector-preference.svelte.ts`
- `desktop/src/components/WorkspaceSidebar.svelte`
- `desktop/src/components/workspace-sidebar-layout-controller.svelte.ts`
- `desktop/src/components/SessionInspector.svelte`
- `scripts/watch-all.mjs`
- `scripts/watch-all-desktop-quit.mjs`

## Tests

- `desktop/src/lib/native-window-config.test.ts`
- `desktop/src-tauri/src/window_restore.rs`
- `desktop/src-tauri/src/window_geometry.rs`
- `desktop/src/app/project-workspace.test.ts`
- `desktop/src/app/workspace-controller.test.ts`
- `desktop/src/lib/window-layout-storage.test.ts`
- `tests/watch-all-desktop-quit.test.ts`

## Verification

- Run `cargo check --manifest-path desktop/src-tauri/Cargo.toml`.
- Run the desktop checks and tests.
- Run Rust `window_restore::tests` for snapshot validation, stable labels,
  encoded workspace routes, last-window close and frozen teardown ordering.
- Run Rust `window_geometry::tests` for mixed-scale round trips/repeated
  restarts, legacy fallback, logical minimums and unavailable-screen placement.
- In the native application, give multiple project windows distinct geometry,
  quit/relaunch and confirm all return; close one before Quit and confirm it does
  not return. Repeat after closing the main window, leaving only project windows.
- In the native application, move and resize the window on a secondary display, quit, relaunch, and confirm the geometry is restored.

## Risks / unknowns

- Window managers may constrain or slightly adjust restored geometry to keep the window usable.
- Native multi-display behavior still requires manual verification on each supported desktop platform.
- Display placement is restored by physical desktop coordinates, not a hardware
  display identifier. Reordering displays can change which screen owns a saved
  coordinate; disconnected/off-screen placement falls back to the OS.

## Evidence

- Confirmed by code: the main window has stable label `main` and configured fallback dimensions.
- Confirmed by code: native startup applies normal geometry in logical points
  before creating each window, checking logical display intersection. The official
  window-state plugin saves on exit and restores only maximization when ready.
