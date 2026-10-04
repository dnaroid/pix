---
kind: spec
status: active
---

# Desktop window tiling

## Behavior

- macOS Pix application menu includes **Разложить окна**. Standard application,
  editing, services, window and Quit menu items remain available.
- Arrange only Pix webview windows. The active window is placed first, followed
  by other windows in stable window-label order. Preserve the active window's focus.
- Fill the active window's display first, then remaining displays in macOS screen
  enumeration order. Each display is filled before using the next one.
- Use native logical-point work areas (excluding the menu bar and Dock).
  Each grid has at most three columns and three rows: 2×1, 2×2 and 3×3 when
  space/window count permits, with vertical or rectangular grids for other cases.
- Capacity is bounded by the configured 860×380 logical-point content minimum,
  including any native frame overhead. For the windows assigned to one display,
  choose the grid with the fewest empty cells, then the fewest rows. Tiles use
  the entire work area, left-to-right and top-to-bottom.
- Restore minimized and unzoom maximized windows only when assigned a tile.
  Fullscreen windows remain untouched in their own Spaces and do not consume tiles.
- When all displays are full, excess windows keep their geometry and state.
  Displays too small for one minimum-sized window are skipped.
- Arrangement changes ordinary window geometry; existing clean-exit
  [window persistence](desktop-window-state.md) applies. No layout preference,
  background observer, or continuous automatic rearrangement is introduced.

## Constraints and failure cases

- macOS only, consistent with Desktop support. No browser-preview or TUI control.
- Work areas, window membership and fullscreen state are read at activation on
  the main thread. Planning is bounded to nine tiles per screen; no IO or waiting
  occurs there. Native frames are set synchronously in Cocoa points to avoid
  backing-scale races across displays.
- If no eligible windows/displays fit, do nothing. OS Space and display policies
  may still constrain placement; physical mixed-DPI/multi-display acceptance
  requires connected hardware.
- Rationale: [0029 — Current-display-first window tiling](../docs/decisions/0029-window-tiling.md).

## Implementation

- `desktop/src-tauri/src/window_tiling.rs`
- `desktop/src-tauri/src/lib.rs`
- `desktop/src-tauri/Cargo.toml`

## Tests

- `desktop/src-tauri/src/window_tiling.rs::tests`

## Verification

- `cargo test --manifest-path desktop/src-tauri/Cargo.toml window_tiling::tests --lib`
- `cargo check --manifest-path desktop/src-tauri/Cargo.toml`
- In native Pix, arrange two/four/nine windows on sufficiently large displays;
  verify the menu label, first-window focus and row-major non-overlapping frames.
  On smaller displays verify minimum sizes and overflow to second/third displays
  or unchanged excess windows. Verify minimized/maximized/fullscreen behavior.
