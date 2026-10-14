---
kind: spec
status: active
---

# Desktop menu-bar mode

## Behavior

- Settings → Desktop → General exposes **Menu bar instead of Dock**.
- `desktop.trayOnly` in the global `~/.config/pi/pix-desktop.jsonc` is an
  optional boolean, defaulting to `false`. Project overrides do not apply to
  this process-wide preference. Save and restart Pix to change presentation.
- On macOS, opting in creates one white square **P** icon in the system menu
  bar, then switches to accessory activation policy to hide the Dock icon.
  The icon is a non-template image so its amber attention dot retains its color.
  The default mode keeps the Dock and has no menu-bar icon.
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
  displayed titles are disambiguated by label.
- **Show all windows** restores and raises every live window, leaving the
  previously focused window on top when one exists.
- Selecting an entry restores, shows and focuses that window. Workspace title
  changes, project-window creation and destruction refresh the menu from live
  membership. A stale selection for a destroyed window does nothing.
- In menu-bar-only mode, explicit app-menu equivalents implement `Cmd+\`` and
  `Cmd+Shift+\`` to cycle forward/backward through visible, non-minimized Pix
  windows in stable window-label order. They require a Pix-owned key window
  and an active app; they are not global shortcuts. Dock mode retains AppKit's
  native window cycling. Keyboard dispatch in accessory mode needs native QA.
- **Quit Pix** uses the normal application exit path, including active-run
  confirmation, backend cleanup and window restoration persistence.
- Closing windows is unchanged: the last window closes the app; this is not a
  keep-alive/background mode. Other platforms do not enable this presentation.
- Config reads run on the blocking pool. Native icon/menu operations run on
  the main thread. Failed config reads keep the Dock; a failure to create the
  icon never hides it. Exit removes the icon, and late startup cannot recreate
  it after teardown begins. Attention updates validate native owner identity,
  prune destroyed/replaced windows and ignore shutdown; each renderer serializes
  and coalesces updates and releases focus/visibility listeners on teardown.
  There are no polling timers.

## Implementation and verification

- `desktop/src-tauri/src/desktop_tray.rs`: config parsing, window menu, icon and
  application presentation; unit tests cover explicit opt-in, JSONC, stable
  entries, duplicate titles, refreshed membership and left-release-only activation.
- `desktop/src-tauri/src/lib.rs`, `window_restore.rs`: startup, shutdown and
  window membership/title hooks.
- `desktop/src-tauri/src/desktop_tray_icon.rs`, `desktop_tray_attention.rs`:
  cached antialiased icon variants and live-window attention aggregation.
- `desktop/src-tauri/src/desktop_window_cycle.rs`, `desktop_notification.rs`:
  accessory-only app-menu cycling and exact native foreground activation.
- `desktop/src/lib/desktop-tray-attention.ts`, `desktop-notifications.ts`,
  `desktop/src/App.svelte`: unseen-event tracking, settled-work integration and
  foreground conversation acknowledgement. Focused tests cover serialization,
  stale completion, failure retry, teardown and notification independence.
- `desktop/src/components/settings/DesktopSettingsEditor.svelte`,
  `desktop/src/lib/settings-search-catalog.ts`: authored setting and lookup.
- `src/schemas/pix-desktop-schema.ts`, `schemas/pix-desktop.json`,
  `desktop/src/lib/default-desktop-config.ts`: schema and default.
- `tests/pix-desktop-tray-schema.test.ts`: schema parity and boolean validation.

Native macOS QA must cover both startup modes, multiple windows, minimized
window activation, opening/closing windows, workspace title updates and guarded
Quit, forward/backward cycling (including minimized and ISO keyboard layouts),
left/right clicks, Show all windows and attention across conversations/windows. Unit tests alone
do not prove native menu, shortcut or Dock behavior.
