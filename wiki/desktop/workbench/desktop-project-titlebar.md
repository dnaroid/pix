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

- Native window titles use `Pix — <project folder name>` in the macOS Dock and
  system window lists. Windows without an active project use `Pix`; a filesystem
  root uses its path as the name. The title is set when creating/restoring each
  project window and updated when the current window selects another workspace.
  This native title does not add visible text to the custom titlebar.
- The window title bar does not contain a project selector. Instead, immediately
  after the platform/native-control inset it shows a compact non-interactive
  colored square with a two-letter abbreviation for the active project before
  the workbench tabs. The square fill follows the same project identity color as
  the status-bar project name and recent-project badges, including
  `.pi/workspace.jsonc` overrides and
  the deterministic full-path fallback hue. On macOS the webview still extends
  into the native title bar and reserves the existing traffic-light inset;
  conversation tabs remain in the 36 px header and empty title-bar space remains
  draggable.
  A single click on empty titlebar space, including an inactive window's
  activating click, must not move the window. Empty regions and tab controls
  start native dragging only after at least 4 px of screen-coordinate pointer
  movement with the primary button still held. Pointer release/cancellation,
  loss of window focus and teardown cancel pending gestures. Empty regions
  retain native double-click-to-zoom behavior.
  Hovering the square shows the full project name; it does not expose the full
  workspace path in that titlebar tooltip.
  The square is non-interactive chrome and keeps the normal arrow cursor rather
  than exposing an I-beam/text-selection cursor over its abbreviation.
- The `Project` sidebar view starts with a compact project switcher above the file
  explorer. It shows the active project, keeps an explicit chevron affordance at
  the right edge of the row, and opens an inline menu of at most 20 recent projects.
  The switcher measures the rendered fixed controls/padding/gaps and reports a
  dynamic minimum width to the sidebar. The sidebar uses that value both for drag
  clamping and as its CSS minimum, so resizing cannot clip the project name or chevron.
  Only a bounded project-name slot (96–160 px) contributes text width; the project
  path never contributes to the minimum and therefore cannot make the sidebar
  arbitrarily wide.
- The secondary path line under a project name shows only the containing directory;
  it does not repeat the project-folder basename already shown on the primary line.
- The active project is identified in the menu. Selecting another recent project
  switches the current workspace and moves it to the top of the persisted recent
  list.
- Right-clicking a recent-project row, or invoking its Context Menu key / Shift+F10,
  opens a keyboard-accessible project action menu with `Open in Finder` and
  `Remove from recent projects`. Finder opens the project root. Removal deletes
  only the stored recent-project shortcut: it does not close the workspace or
  delete project files, sessions, or workspace data. The action menu supports
  keyboard navigation, Escape dismissal with focus restoration, and dismissal
  when focus or interaction moves outside it.
- Removing an inactive project prunes its cached identity data, and pending
  identity reads for that removed project cannot repopulate the cache. Removing
  the active project preserves its identity cache and allows its pending reads
  to complete. Normal startup/reopen remembering can add a project back to
  recents.
- The switcher can open the native directory chooser for the current window or a
  new window. Current-window navigation is disabled while conflicting prompt,
  workspace, or task work is active; new-window actions remain available.
- Recent projects persist locally under `pix.desktop.recentProjects`; malformed,
  relative, and duplicate entries are ignored. `pix.desktop.workspace` remains
  the persisted active project and is folded into the recent list on startup.
- A valid `workspace` URL query is the startup workspace source of truth and
  takes precedence over persisted local storage. If local storage is unavailable,
  that URL workspace remains selected.
- UI-QA may opt into an initial workspace only with `PI_UI_QA=1` and an absolute,
  existing-directory `PI_UI_QA_WORKSPACE`. Desktop validates that value and
  navigates the initial main webview URL with one percent-encoded `workspace`
  query value; an invalid supplied QA value fails startup clearly, while an
  omitted value leaves the configured initial URL unchanged. Normal launches do
  not read or alter their initial URL for this override.
- Escape and outside-click dismiss the project menu. Escape restores focus to
  the project-switcher trigger. ArrowUp/ArrowDown plus Home/End navigate enabled
  project commands, printable-key type-ahead searches visible menu labels, and
  disabled current-window actions are skipped without being hidden. Opening the
  menu closes the conversation selector, and top-level session/workspace actions
  can close it through the sidebar component handle.
- The project menu search fuzzy-matches project names and full paths; an empty
  query preserves recent-project order. Opening by mouse focuses the search and
  resets its query. Native text editing remains available in the search field;
  its ArrowUp/ArrowDown keys move into the filtered command list, and Enter opens
  the strongest project match unless current-window navigation is disabled.
  The project list shows up to eight 44 px rows (358 px including list padding)
  when space permits; menu height is bounded by the actual space below it and
  updates on window resize. Escape and outside dismissal remain unchanged.
- The Project activity-rail icon is neutral and follows the same active/muted
  foreground treatment as the other Activity Bar icons. The two-letter titlebar
  badge uses the project identity color. Desktop does not repeat the project name
  or Git branch in the bottom status bar. The Project switcher's active row is
  text-only before its chevron (no leading folder icon) and stays neutral;
  recent-project badges show two-letter project abbreviations and remain
  identity-colored so different projects stay easy to distinguish.
- The window titlebar background also receives a restrained tint from that same
  active-project identity color. The tint is mixed lightly into the semantic
  `window-titlebar` surface rather than replacing it, uses the configured
  workspace color when present, and otherwise follows the same deterministic
  full-path fallback hue as the titlebar badge.
- Only the vertical Activity Bar icon rail shares the project-tinted background
  with the window titlebar, in light and dark themes. Expanded sidebar panels,
  their headers, and their contents retain `bg-sidebar`. Selected Activity Bar
  buttons use `background`, like selected Workbench tabs. This is a visual
  treatment only; sidebar interaction behavior is unchanged.
- The titlebar badge and recent-project badges use a stable fallback hue
  derived from the normalized full project path rather than only its basename.
  Windows drive and UNC identities are compared case-insensitively.
- When the window loses focus, only its titlebar project badge switches from
  a filled square to a transparent square with a project-colored border and
  project-colored letters. Regaining focus restores the filled appearance.
  The initial state follows document focus on mount; window focus/blur events
  update it, and component teardown removes the window listeners. Both light
  and dark fallback hues and custom project colors apply to the outline state.
  Recent-project menu badges, the titlebar tint, tabs and other chrome are unchanged.
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
- A project may replace the two-letter initials with a logo image. The image is
  stored as exactly one canonical file `.pi/project-icon.{png,jpg,webp,gif,svg}`
  (format detected from content, maximum 4 MB) and referenced from
  `.pi/workspace.jsonc` as `"icon": ".pi/project-icon.png"`. Only those canonical
  paths are accepted; anything else falls back to initials. All five names are
  canonical `.pi` files, so automatic/manual `.pi` cleanup never removes them;
  their `.project-icon.*.tmp` write temporaries are treated like other Pix temps.
  The titlebar badge and recent-project badges render the image instead of the
  initials; the unfocused-window titlebar state dims/desaturates the image.
- Project settings opens from the `Project settings…` footer item of the
  project switcher menu (titlebar and sidebar variants, shown only with an open
  workspace) and from right-click on the titlebar project badge; the badge
  contextmenu is consumed so no native/global context menu appears. The Project
  panel header no longer has a settings button.
- Project settings has a `Logo` section with `Initials` and `Image` modes. In
  `Image` mode the user can `Choose file…` (native chooser owned by Rust; the
  webview never passes arbitrary paths) or `Generate with AI`/`Generate another`
  with an optional free-text prompt (max 1000 characters). Generation calls
  OpenRouter chat completions with image modalities using `OPENROUTER_API_KEY` or
  the Pi auth `openrouter` key; the project name, user prompt, and the first
  1000 README characters are sent as descriptive context, not labels to render.
  The prompt puts final small-icon requirements after that context: a single
  bold silhouette occupying 80–90% of the canvas must remain recognizable at
  16–24 px, with a quiet solid neutral background by default (no default blue/
  cyan tile or gradients). It preserves explicit subject and style preferences.
  Text is omitted unless explicitly requested; then use only 1–2 large monogram
  characters as the main shape, never small labels. The model defaults to
  `google/gemini-2.5-flash-image` and can be overridden by
  `desktop.projectIcon.model` in project or global `pix-desktop.jsonc`. Picked or
  generated images are previews only; nothing is written until Save. Saving an
  image writes the canonical file first, then updates `icon` in the workspace
  config via the same compare-and-swap path; saving `Initials` removes only the
  `icon` property. Pick/generate results arriving after the dialog closes or a
  newer request starts are discarded.
- In `Custom` color mode, `From logo` (enabled when a stored or previewed logo
  exists) decodes the logo off-screen at 32×32 and fills the hex field with its
  most vivid prominent color: transparent, near-black, near-white and gray
  pixels are ignored and hue bins are weighted by saturation; a colorless logo
  falls back to its most frequent color. The value is an ordinary editable
  custom color written to `color` on Save; it does not follow later logo changes.
- Project settings remains open across background sidebar-prop updates for the
  same workspace (including Git/Registry refreshes). Only an actual workspace
  change resets its open, saving, and error state; explicit dismissal and a
  successful save retain their existing close behavior.
- Project-color saves are asynchronous and do not set the global workspace
  operation/busy state. The renderer reads the latest workspace config, applies
  the color edit, then uses a compare-and-swap Tauri write. If the file changed
  between read and write, the current document is returned and the renderer
  retries the edit up to three times instead of overwriting a concurrent change.
- Workspace-config replacement is written to a unique same-directory temporary
  file, flushed, atomically replaced where supported, and followed by a directory
  sync. Workspace writers add the published TypeBox editor-schema reference only
  when `$schema` is absent, preserving a custom schema reference as well as
  comments and unknown fields. Existing `.pi/workspace.jsonc` symlinks are rejected.
- On startup and project switch, only the active project's color override is
  loaded. Inactive recent projects are not accessed just to render the closed
  switcher; their overrides load asynchronously when the switcher opens.
  Remembering a project for another window does not read its override in the
  current window. Saving the active project's color refreshes only that
  project's override. Project switching and rendering never await color IO.
- Each color refresh owns a generation. A completion may mutate visible color
  state only if that generation is still current and the project still belongs
  to the recent-project list or remains the active workspace; stale completions
  are discarded.

## Non-goals

- Replacing native window controls on Windows or Linux.
- Creating project scaffolding or initializing a repository inside a chosen folder.
- Recoloring global IDE chrome or semantic status colors from the project color;
  the subtle active-project tint is limited to the titlebar and vertical Activity
  Bar rail.
- Treating a missing or invalid workspace color override as a desktop error.

## Invariants

- Project color loading never gates workspace switching, session actions, or the
  project file explorer.
- Older async color refreshes cannot overwrite a newer refresh.
- Starting a color save invalidates older color-read generations, so an in-flight
  pre-save read cannot repaint the saved value afterward.
- A stale workspace-config save cannot overwrite a newer Pix-owned config write;
  the compare-and-swap result is rebased and retried.
- Removing an inactive project from the recent list removes its cached override
  from visible state; the active workspace retains its identity.
- The renderer uses the existing asynchronous `read_project_file` Tauri command;
  filesystem work stays on its blocking worker path and remains confined to the
  canonical workspace.
- The bounded recent-project list also bounds color-load fan-out when the
  switcher opens; startup reads only the active project's override.

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

- `desktop/src-tauri/src/project_icon.rs`
- `desktop/src/lib/project-icon.ts`

- `desktop/src-tauri/src/window_restore.rs`
- `desktop/src-tauri/tauri.conf.json`
- `desktop/src/app/project-workspace.svelte.ts`
- `desktop/src/app/desktop-status-bar-view-model.svelte.ts`
- `desktop/src/components/WorkspaceSidebar.svelte`
- `desktop/src/components/WorkspaceSidebarActivityBar.svelte`
- `desktop/src/components/workspace-sidebar-layout-controller.svelte.ts`
- `desktop/src/components/workspace-sidebar-project-settings-controller.svelte.ts`
- `desktop/src/components/ProjectSwitcher.svelte`
- `desktop/src/components/ProjectSwitcherContextMenu.svelte`
- `desktop/src/components/ProjectSettingsDialog.svelte`
- `desktop/src/components/ProjectFolderIcon.svelte`
- `desktop/src/components/RuntimeStatusBarItems.svelte`
- `desktop/src/lib/recent-projects.ts`
- `desktop/src/lib/project-colors.ts`
- `desktop/src/app/project-workspace.test.ts`
- `desktop/src/components/WorkbenchTabs.svelte`
- `desktop/src/components/DesktopTitlebar.svelte`
- `desktop/src-tauri/src/lib.rs`

## Verification

- `desktop/src-tauri/src/window_restore.rs` tests cover native project-title
  formatting, Unicode/spaces, trailing separators, root paths, and empty windows.
- `desktop/src/lib/recent-projects.test.ts` covers normalized full-path fallback
  identity and two-letter project abbreviations.
- `desktop/src/app/project-workspace.test.ts` covers URL precedence over stale
  storage and retaining the URL workspace when storage fails. It also checks
  active-only startup refresh, lazy reads for inactive recent projects, cached
  color retention, and stale read rejection across switching and saving; Rust
  tests cover QA workspace validation and URL query encoding/replacement.
- `desktop/src/lib/project-colors.test.ts` covers JSONC override parsing and
  fallback behavior.
- `desktop/src/components/ProjectSwitcher.test.ts` covers current/new-window
  actions, project-row Finder/removal actions and keyboard dismissal, the visible
  chevron affordance, and verifies that the UI component does not own filesystem
  IPC.
- `desktop/src/components/ProjectSettingsDialog.test.ts` covers the settings
  entry point, automatic/custom controls, native color picker, and presentation/
  persistence separation.
- `desktop/src/components/workspace-sidebar-project-settings-controller.test.ts`
  covers same-workspace refresh stability, saving/error retention, reset on a
  real workspace change, and stale save completion after switching projects.
- `desktop/src/components/WorkspaceSidebar.test.ts` verifies that the Activity
  Bar project icon stays neutral, `ProjectSwitcher.test.ts` verifies that the
  active Project-switcher row stays neutral, and
  `WorkbenchTabs.test.ts` verifies the titlebar badge appears before tabs and is
  wired to project identity color, while `DesktopVisualRegressions.test.ts`
  verifies that the status-bar project label owns the identity color while the
  Git branch remains muted.
- Rust tests in `desktop/src-tauri/src/lib.rs` cover atomic workspace-config
  replacement and stale compare-and-swap rejection.
- Run `npm --prefix desktop test`, `npm --prefix desktop run check`, and
  `npm --prefix desktop run build:web`.

## Evidence

- Confirmed by code: `desktop/src/app/project-workspace.svelte.ts` owns
  project-color refresh/save generations and accepts results only for the
  current generation, workspace, and recent-project set.
- Confirmed by code: `ProjectSwitcher.svelte` owns the sidebar interaction state
  but no filesystem or Tauri IPC.
- Confirmed by code: `desktop-status-bar-view-model.svelte.ts` passes the active
  project's custom color plus deterministic full-path hue to
  `RuntimeStatusBarItems.svelte`; only the project-name span consumes that color,
  while the Git branch suffix keeps the normal muted status treatment.
- Confirmed by code: `ProjectSettingsDialog.svelte` is presentation-only;
  `project-workspace.svelte.ts` owns generation guards/retries and Rust owns
  confined atomic persistence.
- Confirmed by code: `read_project_file` runs project-file reads through the
  Tauri blocking worker path with workspace confinement.
- Confirmed by installed Tauri schema: `titleBarStyle: "Overlay"` and `hiddenTitle` are supported window options.
- Confirmed by native-window inspection (macOS): with `trafficLightPosition.y = 16` the traffic-light dots render at y 12..24 (center ≈18); the macOS button frame draws the visible dot 4px above the configured frame origin, so y=16 remains required for visual centering (y=12 rendered at y 8..20, 4px high).
- Confirmed by native-window inspection (macOS): dragging empty title-bar space moves the window and dragging the transcript area does not. Dragging requires the `core:window:allow-start-dragging` capability (`core:window:default` does not include it); `core:window:allow-internal-toggle-maximize` restores native double-click-to-zoom on the title bar.
- Confirmed by tests: the recent-project, project-color, and project-switcher unit
  tests cover the deterministic identity and override surface.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"05cc9ca996b891c3a37aa04308478b99e1c6a63b7ce0104e4be6ff0cb21d66d8","checkedAt":"2026-10-31T00:33:45.575Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":59,"reportLanguage":"ru"} -->
