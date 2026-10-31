---
kind: spec
status: active
---

# Desktop optional menu-bar icon

## Behavior

- Settings → Desktop → General exposes **Show menu bar icon**.
- `desktop.trayOnly` in the global `~/.config/pi/pix-desktop.jsonc` is an
  optional boolean, defaulting to `false`. Project overrides do not apply to
  this process-wide preference. The legacy key name is retained for compatibility:
  `true` now enables an additional icon, not a tray-only application mode.
  Save and restart Pix to change the icon preference.
- On macOS, opting in creates one white square **P** icon in the system menu
  bar without changing the application's activation policy. Both modes retain
  the Dock icon, native application menus and standard window behavior.
  The icon is a non-template image so its amber attention dot retains its color.
  The default mode has no menu-bar icon.
- An amber dot indicates unseen input requests (including approvals), errors or
  completed work. Successful completion waits until the prompt has stopped,
  the agent is idle and no subagents remain active. Cancellation and pauses do
  not mark attention. This works independently of OS notification permission
  and notification settings. Attention is retained per conversation and window
  until its conversation is visible in a foreground Pix window; viewing one
  conversation does not clear another window or background tab. A new prompt,
  session deletion or workspace reset clears the corresponding stale attention.
- Left-clicking the menu-bar icon restores and raises every live app window,
  regardless of the attention dot, without changing any window's selected tab.
  The previously focused window stays on top when one exists.
- Right-clicking the icon opens a native menu listing every live app window,
  including minimized windows. Entries omit the leading `Pix — ` / `Pix - `
  from native workspace titles and use stable window-label identities; duplicate
  displayed titles are disambiguated by label. Windows with unseen attention
  have a `●` prefix on their project entry, using the same per-window state as
  the icon badge. Attention changes refresh both the menu and icon; marking
  does not change entry order or identity.
- **Show all windows** restores and raises every live window, leaving the
  previously focused window on top when one exists.
- **Arrange windows**, immediately after **Show all windows**, runs the same
  existing window arrangement as the app-menu **Arrange windows** action.
  Layout, display allocation, focus preservation and fullscreen exclusions are
  unchanged; see [window tiling](desktop-window-tiling.md).
- Selecting an entry restores, shows and focuses that window. Workspace title
  changes, project-window creation and destruction refresh the menu from live
  membership. A stale selection for a destroyed window does nothing.
- Both modes retain AppKit's native `Cmd+\`` / `Cmd+Shift+\`` window cycling;
  the tray installs no custom window-cycling menu items or shortcuts.
- **Quit Pix** uses the normal application exit path, including active-run
  confirmation, backend cleanup and window restoration persistence.
- Closing windows is unchanged: the last window closes the app; this is not a
  keep-alive/background mode. Other platforms do not enable this presentation.
- Config reads run on the blocking pool. Native icon/menu operations run on
  the main thread. Failed config reads or icon creation leave ordinary application
  behavior intact without a tray icon. Exit removes the icon, and late startup
  cannot recreate it after teardown begins. Attention updates validate native owner identity,
  prune destroyed/replaced windows and ignore shutdown; each renderer serializes
  and coalesces updates and releases focus/visibility listeners on teardown.
  There are no polling timers. A failed publish schedules a single pending
  retry (2 s, doubling to 60 s, reset on success) so the badge converges without
  another attention event; the retry is cancelled on teardown, and the failure is
  logged as `frontend:warning` once per failure streak.

## Implementation and verification

- `desktop/src-tauri/src/desktop_tray.rs`: config parsing, window menu, icon and
  application presentation; unit tests cover explicit opt-in, JSONC, stable
  entries, duplicate titles, refreshed membership and left-release-only activation.
- `desktop/src-tauri/src/lib.rs`, `window_restore.rs`: startup, shutdown and
  window membership/title hooks.
- `desktop/src-tauri/src/desktop_tray_icon.rs`, `desktop_tray_attention.rs`:
  cached antialiased icon variants and live-window attention aggregation.
- `desktop/src-tauri/src/desktop_notification.rs`: exact native foreground activation.
- `desktop/src/lib/desktop-tray-attention.ts`, `desktop-notifications.ts`,
  `desktop/src/App.svelte`: unseen-event tracking, settled-work integration and
  foreground conversation acknowledgement. Focused tests cover serialization,
  stale completion, failure retry, teardown and notification independence.
- `desktop/src/components/settings/DesktopSettingsEditor.svelte`,
  `desktop/src/lib/settings-search-catalog.ts`: authored setting and lookup.
- `src/schemas/pix-desktop-schema.ts`, `schemas/pix-desktop.json`,
  `desktop/src/lib/default-desktop-config.ts`: schema and default.
- `tests/pix-desktop-tray-schema.test.ts`: schema parity, boolean validation and
  a source guard against tray activation-policy changes or custom window cycling.

Native macOS QA must cover both startup modes (including Dock and application
menu availability), multiple windows, minimized window activation,
opening/closing windows, workspace title updates and guarded
Quit, forward/backward cycling (including minimized and ISO keyboard layouts),
left/right clicks, Show all windows and attention across conversations/windows. Unit tests alone
do not prove native menu, shortcut or Dock behavior.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"281b5b855134d59d55696aeef705943d582d713bd159c4a952b3ac64a626dc55","checkedAt":"2026-10-31T01:13:49.087Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":61,"reportLanguage":"ru"} -->
