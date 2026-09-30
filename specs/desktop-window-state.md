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

## Non-goals

- Persisting fullscreen, visibility, or window decoration state.
- Synchronizing window geometry between machines.
- Adding user-facing window-layout settings.

## Behavior

- On first launch, the window uses the dimensions and placement from `tauri.conf.json` and the operating system.
- On subsequent launches, recreate each saved window with its original stable
  label and workspace URL; do not add an extra main window when only project
  windows were open. Existing per-project Desktop session/tab persistence applies
  independently of the window geometry snapshot.
- A project change updates the native window's workspace even if localStorage or
  browser history persistence fails. An explicitly saved empty window remains empty.
- Closing a window while other windows remain excludes it from the next launch.
  Closing the last window exits the app and retains that last window for relaunch.
- Explicit application Quit freezes window membership/workspaces before background
  resource cleanup; destruction and late workspace updates cannot erase that snapshot.
- The development Restart button uses the same clean exit. `watch:all` waits for
  the old process to exit before launching its replacement, so shutdown persistence
  is not interrupted by SIGTERM/SIGKILL. A timed-out handoff leaves the old process alone.
- After a clean application exit, the next launch restores the last non-minimized size and position.
- Desktop coordinates restore the window onto the same available display.
- If the saved display is unavailable or the saved rectangle no longer intersects any display, the operating system chooses a safe position instead of restoring the window off-screen.
- A maximized window reopens maximized while retaining its previous normal geometry for a later unmaximize.
- Missing, unreadable, or malformed persisted state falls back to the configured defaults.
- UI-QA (`PI_UI_QA=1`) and release smoke (`PIX_RELEASE_SMOKE=1`) launches use one
  main window and do not read/write the user's open-window membership snapshot.
  The existing geometry plugin still operates in those launches.
- Native restore QA can explicitly set `PI_UI_QA_WINDOW_RESTORE=1` alongside
  `PI_UI_QA=1`: membership uses `qa-open-windows.json` and geometry uses
  `.qa-restore-window-state.json`, never the user's snapshots. The initial QA
  workspace override applies only when no windows were restored. Smoke still
  disables membership restoration even if the QA restore opt-in is set.

## Contracts

- Window state is stored in Tauri's application configuration directory by the official window-state plugin.
- For geometry, only size, position, and maximized state are persisted.
- Geometry is keyed by stable window label. Membership/workspaces use a versioned,
  bounded `open-windows.json` in the same application configuration directory,
  atomically replaced during clean exit on the existing shutdown worker.
- Configured automatic main-window creation is disabled; native startup creates
  either the saved window set or one default main window.

## Related files

- `desktop/src-tauri/Cargo.toml`
- `desktop/src-tauri/src/lib.rs`
- `desktop/src-tauri/src/window_restore.rs`
- `desktop/src-tauri/tauri.conf.json`
- `desktop/src/app/project-workspace.svelte.ts`
- `desktop/src/app/workspace-controller.ts`

## Tests

- `desktop/src-tauri/src/window_restore.rs`
- `desktop/src/app/project-workspace.test.ts`
- `desktop/src/app/workspace-controller.test.ts`

## Verification

- Run `cargo check --manifest-path desktop/src-tauri/Cargo.toml`.
- Run the desktop checks and tests.
- Run Rust `window_restore::tests` for snapshot validation, stable labels,
  encoded workspace routes, last-window close and frozen teardown ordering.
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
- Confirmed by Tauri documentation: the official window-state plugin automatically saves state on exit, restores it when a window is ready, and avoids applying a saved position that does not intersect an available monitor.
