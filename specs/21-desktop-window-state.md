# Spec: Desktop window state persistence

## Type

Change

## Goal

Reopen Pix Desktop at the size and position where the user last left it, including the same display when that display is still available.

## Scope

- Persist the main window's normal size and desktop coordinates when the application exits.
- Restore the persisted geometry on the next launch.
- Preserve whether the window was maximized.

## Non-goals

- Persisting fullscreen, visibility, or window decoration state.
- Synchronizing window geometry between machines.
- Adding user-facing window-layout settings.

## Behavior

- On first launch, the window uses the dimensions and placement from `tauri.conf.json` and the operating system.
- After a clean application exit, the next launch restores the last non-minimized size and position.
- Desktop coordinates restore the window onto the same available display.
- If the saved display is unavailable or the saved rectangle no longer intersects any display, the operating system chooses a safe position instead of restoring the window off-screen.
- A maximized window reopens maximized while retaining its previous normal geometry for a later unmaximize.
- Missing, unreadable, or malformed persisted state falls back to the configured defaults.

## Contracts

- Window state is stored in Tauri's application configuration directory by the official window-state plugin.
- Only size, position, and maximized state are persisted.

## Related files

- `desktop/src-tauri/Cargo.toml`
- `desktop/src-tauri/Cargo.lock`
- `desktop/src-tauri/src/lib.rs`
- `desktop/src-tauri/tauri.conf.json`

## Verification

- Run `cargo check --manifest-path desktop/src-tauri/Cargo.toml`.
- Run the desktop checks and tests.
- In the native application, move and resize the window on a secondary display, quit, relaunch, and confirm the geometry is restored.

## Risks / unknowns

- Window managers may constrain or slightly adjust restored geometry to keep the window usable.
- Native multi-display behavior still requires manual verification on each supported desktop platform.

## Evidence

- Confirmed by code: the main window has stable label `main` and configured fallback dimensions.
- Confirmed by Tauri documentation: the official window-state plugin automatically saves state on exit, restores it when a window is ready, and avoids applying a saved position that does not intersect an available monitor.
