---
kind: spec
status: active
---

<!-- pix:wiki-report {"version":1,"checkedAt":"2026-10-31T11:11:16.232Z","result":{"path":"wiki/desktop/workbench/desktop-workspace-navigation.md","documentHash":"a80b4aa41073465289d4fdd5cd2bb6f6a8e860f89ad06ea28eacdc258659ce36","modelRef":"zai/glm-5.3-flash","reportLanguage":"ru","checkedSources":12,"conflicts":[],"uncertainties":[],"reviewedSources":[{"path":"wiki/development/release/release-distribution.md","quote":"---\nkind: spec\nstatus: active\n---\n\n\n\n# GitHub Release distribution\n\n## Scope and version\n\nPix ships standalone Node runtime payloads in portable TUI archives and Tauri\nDesktop installers. The two variants share preparation code, not an identical\nfile inventory: only Desktop includes ACP. GitHub Releases are the only supported\ndistribution channel; the root package is private and must not be published to npm.\nDesktop product support is currently macOS only. Windows/Linux Desktop packaging\npaths and historical measurements below do not make those supported products;\ntheir validation is not a current Desktop delivery gate. TUI target support is unchanged.\nRoot `package.json` is the authoritative application version. ACP, Desktop,\nTauri, the Pix Cargo package, and the three npm lockfile root records share it.\n`npm version` runs `scripts/release/sync-version.mjs --stage` before creating its\ncommit/tag; `release:version:check` rejects drift. Releases use stable `vX.Y.Z`\ntags. The external tools\nsuite is not independently version-bumped.\n\n## Payload invariants\n\n- Targets are `linux-x64`, `macos-arm64`, and `windows-x64`. Packaging\n  runs natively on each target. Unsupported/cross-host targets fail before output\n  cleanup or dependency installation.\n- Node is downloaded from the official HTTPS distribution for the exact stable\n  version currently selected by the release builder's PATH. The repository does\n  not pin that version. The exact filename must appear once in `SHASUMS256.txt`;\n  its SHA-256 is verified before extraction. `release.json` records the source\n  archive hash and version. This is not a GPG verification or an asset attestation.\n- Release preparation removes only the owned compiler outputs (`dist`, and\n  `acp/dist` when building Desktop) before compilation. Stale Vosk models and\n  obsolete emitted JavaScript must not survive a previous local build. Source\n  files and the user's `models/` directory are not deleted.\n- Pix uses the actual `npm pack` allowlist and locked production dependencies,\n  including required optional platform packages. Desktop additionally installs\n  ACP's locked dependencies before conservative deduplication. Development\n  node_modules, HOME, credentials and the checkout are never copied into the\n  payload. Production runtime compilers/loaders such as jiti, and esbuild when\n  present in the production dependency graph, are retained.\n- Layout is `pix/runtime/node[.exe]`, `pix/app/{bin,dist,node_modules,...}` and\n  (Desktop only) `pix/app/acp/{dist,node_modules,...}`. Preserve the relative relationship between\n  ACP, Pix dist and the bundled tools suite. Native addons and dependency license\n  files are retained; `DEPENDENCIES.json` inventories shipped package metadata.\n- The shell/CMD launcher selects the absolute bundled Node path, prepends its\n  directory to PATH for child tools, preserves the caller's working directory,\n  forwards arguments, and propagates exit status.\n- Standalone means no separately installed Node/npm for Pix itself. Git, project\n  toolchains, optional language servers, voice/clipboard helpers and provider\n  credentials remain external requirements as applicable.\n\n## Payload optimization and size gates\n\nPreparation writes the TUI variant to `.artifacts/releases/\u003ctarget\u003e/pix` and the\nDesktop variant to `.artifacts/releases/\u003ctarget\u003e/desktop/pix`. Their `release.json`\n","startLine":1,"endLine":60},{"path":"wiki/desktop/workbench/desktop-context-menus.md","quote":"  inside the active workspace (including absolute local paths within it). The\n  command opens Files, clears its search, expands parents, selects and scrolls\n  to the file without reopening it or touching unsaved content. Outside-project\n  tabs omit it. The captured path and workspace are guarded against stale menu\n  callbacks. See [workspace navigation](desktop-workspace-navigation.md) and\n  [decision 0058](../../decisions/0058-reverse-file-navigation.md).\n- Markdown links to local project files offer **Open in Browser** for `.html` and\n  `.htm` targets, before **Show in Files** / **Reveal in Finder**. The native\n  file-action command revalidates that the resolved target is HTML and opens it\n  using the default HTTPS browser rather than the `.html` file association.\n- On macOS, Copy File places a native file URL on the pasteboard for Finder and\n  other applications, not plain path text or Project Explorer's private\n  cross-instance clipboard payload. Open uses the OS default application, not\n  the configured text editor. No implicit save/export of an unsaved draft occurs.\n  See [decision 0042](../../decisions/0042-preview-file-context-actions.md).\n- xterm keeps its native clipboard event path; terminal menus offer Copy and,\n  while the terminal accepts input, Paste. They do not offer document Select All\n  or text-editor Undo. `TerminalView` exposes its read-only state explicitly.\n\n## Native integration\n\nmacOS/Windows use Tauri predefined editing roles, not draft-value replacement,\nsynthetic clipboard events or a separate undo stack. This preserves the normal\nWebView paste path, including composer attachment handlers and terminal paste.\nThe native menu owns OS rendering, placement/clamping and keyboard traversal.\nProject Explorer also uses a component-owned native command menu in the Desktop\nhost, retaining DOM navigation only for standalone browser preview. Its file\ncommands and clipboard policy are specified in\n[workspace navigation](desktop-workspace-navigation.md). Other DOM component\nmenus retain the shared menu-navigation helpers.\nContext Menu / Shift+F10 routes through the same event dispatch as right-click;\nother editing and system shortcuts are not intercepted.\n\nLinux uses a closed `desktop_edit` command enum routed to WebKitGTK's\n`execute_editing_command`, rather than muda's X11 key emulation or unsupported\nLinux predefined Undo/Redo. It is scoped to the invoking WebView and does not\nevaluate arbitrary JavaScript. The Linux branch needs a native Linux smoke pass;\nmacOS compilation and browser tests do not prove Wayland/native Linux behavior.\n\nCopy Link Address and Copy Image use the official native clipboard plugin with\nwrite-text and write-image permissions. The Tauri dependency enables `image-png`\nso the encoded PNG bytes sent by Copy Image decode into the native RGBA image;\nwithout that feature, the clipboard plugin rejects them as raw bytes.\nProject Explorer additionally uses\n","startLine":111,"endLine":154},{"path":"wiki/usage/desktop-runtime-status.md","quote":"---\nkind: spec\nstatus: active\n---\n\n\n\n# Desktop runtime context and model limits\n\n\u003c!-- markdownlint-disable MD013 --\u003e\n\n## Type\n\nChange\n\n## Lifecycle\n\nActive implemented contract.\n\n## Goal\n\nBring the TUI's context-usage, prepared DCP context-map, and current-model quota signals into Pix Desktop without copying terminal presentation into the GUI. Desktop keeps durable DCP statistics as a separate protocol capability while rendering the live context state as dense IDE status chrome and lightweight click-open panels.\n\nDecision: [Status-bar click popups](../decisions/0048-status-bar-click-popups.md), superseding [hover details](../decisions/0037-status-bar-hover-details.md) for interaction only. Session-pane removal: [0047](../decisions/0047-remove-session-inspector.md).\n\n## Behavior\n\n- Usage remains in the left status group. The right group places Observer (radar), Subagents, then Plan, with no short vertical separators between groups. The status-bar top border remains; dividers inside popups and context-ring sector separators are unchanged.\n\n- Status-bar elements and their detail surfaces do not use browser-native `title` tooltips. Accessible labels remain. Usage shows recorded session spend, an integrated weekly cycle/remaining-quota timeline and a short-window Limits scale, not quota-description paragraphs; compact quota indicators remain in its trigger. See [quota limits](desktop-quota-calendar.md) and [decision 0039](../decisions/0039-quota-reset-calendar.md). Context, Usage and Observer popup lower edges match Plan, touching the top of their triggers with no visual gap. Sidebar tooltips are unchanged.\n\n- Once an active Desktop session runtime is ready, the status bar shows a slightly extended horizontal capacity track without an inline numeric percentage.\n- Compact status chrome labels context as `Context`, omits redundant hourly/weekly and `resets` text (window names and reset meaning remain in click details), and shows Claude Code provider model names without the `Claude Code ` prefix in the model/thinking display. Persistent model names use neutral foreground text and thinking uses muted text, leaving provider brand color to the icon; picker and usage-detail model colors are unchanged. Provider IDs and routing are unchanged. Context and quota use content-sized grid groups rather than equal columns; bounded inline controls clip excess content at very narrow widths instead of painting over neighboring controls, while detail panels remain unclipped.\n- Context and Usage have distinct inter-group spacing and fixed inner telemetry slots. Quota windows use track, reset countdown, then the associated warning/retry/cache indicator, with no bullet or middle-dot separators; loading placeholders follow the same order. Only actually present quota windows take space; the account label stays in the details rather than the trigger.\n  Neither Context nor quota triggers reserve or render numeric percentage slots, including their skeleton placeholders. Percentages remain available in detail panels and quota accessible descriptions; narrow-window clipping remains bounded by the outer control.\n","startLine":1,"endLine":35},{"path":"wiki/desktop/workbench/desktop-project-wiki.md","quote":"---\nkind: spec\nstatus: active\n---\n\n# Desktop project Wiki\n\n## Behavior\n\nThe Workspace Activity Bar has a **Wiki** destination beside Project. It uses\nthe shared sidebar selection, collapse, resize and keyboard behavior. The Wiki\nis a project directory containing Markdown pages, nested sections and ordinary\nassets; there is no separate document database or generated-code contract.\n\n`.pi/workspace.jsonc` configures the location:\n\n```jsonc\n{\n  \"wiki\": {\n    \"path\": \"wiki\",\n    \"index\": \"index.md\",\n    \"autoCheck\": false\n  }\n}\n```\n\nAll fields are optional. `path` is relative to the project; `index` is relative\nto that directory and may include subdirectories. The resulting default home\npage is `wiki/index.md`. JSONC comments, trailing commas and unrelated properties\nare accepted. Opening Wiki does not create files or rewrite the configuration.\nThe generated workspace schema describes these fields for editor completion.\n\nPaths must stay inside the project. Absolute paths, parent traversal, control\ncharacters, Git metadata and disposable `.pi/artifacts` / `.pi/subagents`\nstorage are rejected. The index must be `.md` or `.markdown`. Invalid JSONC or\ninvalid Wiki settings produce a visible error rather than selecting a different\ndirectory. Native file operations retain their existing existence, symlink and\nworkspace-containment checks.\n\n### Navigation and authoring\n\n- A missing Wiki shows **Create Wiki**. This explicitly creates missing parent\n  directories and a small Markdown home page, without overwriting an existing\n  index. An existing root without its configured index shows **Automatic contents**\n  beside the optional **Create index** action.\n- While the Wiki holds nothing but the untouched starter index (hidden entries\n  and leading check reports ignored), the panel offers **Migrate docs to Wiki**.\n  The explicit action starts a new agent session with the prompt from\n  `desktop/src/lib/wiki-migration-prompt.ts`: inventory existing docs/specs,\n  group them into sections with their own index pages, move them with `git mv`,\n  fix every reference to the old paths, verify links and leave the changes\n  uncommitted for review. The offer hides after a successful start and stays\n  hidden once the Wiki has other pages.\n  Partial filesystem failures remain visible and can be retried; the UI never\n  rolls back by deleting preexisting content.\n- The panel places a **Search Wiki** input above the existing tree; it replaces\n  the redundant Wiki-home toolbar row. Editing the query invalidates current\n  results; press Enter to search. Escape or the clear control cancels the search,\n  restores the same mounted tree and returns focus to the input. Results show a\n  page title, path and excerpt and open in the existing Wiki Preview route.\n  Opening a result preserves the sidebar query and results without rerunning the\n  search; the active result is marked with selected styling and `aria-current`.\n  The result's source line range is passed to Preview as a search range, separate\n  from source-view line ranges. Preview remains rendered Markdown and highlights\n  top-level rendered blocks whose source ranges intersect the search fragment.\n  The reveal runs after saved scroll-position restoration; history retains both\n  the range and scroll position. Search-range highlighting does not change\n  ordinary source-link navigation, which opens the source view with its existing\n  line-range behavior. Cancelling the search prevents stale results from\n  revealing a range.\n  Search reuses native repository search for Knowledge only, scoped to the\n  configured Wiki directory before retrieval; it deduplicates files and respects\n  existing source selection without enabling sources. Lexical results are shown\n  first; hybrid enrichment and native reranking are conditional on global\n  configuration. Search notices are displayed and logged, and configuration or\n  policy changes invalidate results. Visible tree rows load one directory at a\n  time; saved consistency summaries use a separate bounded metadata traversal.\n  Unopened descendants contribute to status summaries; expanding a folder loads\n  its rows. Files and folders whose names start with `.` are hidden recursively\n  and excluded from folder consistency summaries. Index pages are represented by\n  their folders and are hidden as separate file rows. Selecting **Contents**\n  opens the configured Wiki home, including a custom or nested index path. When\n  the Wiki root or a nested folder has no applicable index, opening it shows\n  generated, read-only Markdown contents in the existing Preview. The listing\n","startLine":1,"endLine":84},{"path":"wiki/desktop/design.md","quote":"and `textarea`) are the exception: they MUST retain native focus and\ncaret semantics without a global outline, border, or ring frame. Buttons and\nother keyboard-navigated controls retain the visible focus treatment.\n\nComposer surfaces may read as a distinct card-like work surface, but should not become visually heavier than the transcript/content above them.\n\nPlace send/submit emphasis inside the composer rather than coloring the entire composer with primary.\n\n## 12. Navigation, tabs, and selection\n\nPersistent navigation SHOULD primarily use neutral surfaces.\n\nSelected state can be communicated with:\n\n- surface change;\n- text contrast;\n- border relationship;\n- restrained primary indicator.\n\nDo not flood active navigation rows with primary unless the local design specifically requires it.\n\nKeyboard focus and selected/active state are separate and MUST remain visually\ndistinguishable. Selection persists when focus leaves a selected tab/list/tree\nitem; focus indicates where keyboard input currently acts.\n\nFor true composite widgets:\n\n- `Tab` / `Shift+Tab` move between meaningful components;\n- arrow keys move inside tablists, menus, trees, grids, radio groups, and similar\n  composites;\n- `Home` / `End` move to the first/last item where conventional;\n- `Escape` dismisses the topmost transient surface where expected;\n- closing/removing the focused object moves focus to a logical neighbor;\n- dismissing a transient surface restores focus to its invoker when possible.\n\nDo not add ARIA composite roles without implementing their keyboard behavior.\n\nTree/navigation specifics:\n\n- a file/project tree is one Tab stop, not one Tab stop per visible row;\n- Up/Down move between visible rows and Home/End move to the visible bounds;\n- Right expands a collapsed directory, then moves into its first visible child\n  when already expanded;\n- Left collapses an expanded directory, otherwise moves to its visible parent;\n- type-ahead moves focus by visible item label without changing selection;\n- file selection/open state stays distinct from keyboard focus;\n- secondary pointer actions on a tree row need a keyboard route that does not\n  create another Tab stop for every row.\n\nThe Workspace Activity Bar is a vertical toolbar composite. Only its current\nroving item participates in the normal Tab order; Up/Down/Home/End move focus\nwithout activating a destination, while Enter/Space/click performs activation.\n\n### 12.1 Commands and context actions\n\nChoose command surfaces intentionally:\n\n- frequent local command → toolbar/stable pane action;\n- contextual command → context menu plus optional hover accelerator;\n- global/frequent command → command picker/menu and shortcut;\n- secondary/rare command → menu/overflow;\n- destructive command → destructive semantics, with confirmation or undo where\n  the risk warrants it.\n\nHover-only UI must not be the only path to a critical command. Prefer one command\ndefinition that can feed toolbar, menu, context-menu, and shortcut surfaces.\n\nMenus use one keyboard contract across the application:\n\n- opening from the keyboard focuses an appropriate enabled item;\n- Up/Down wrap across enabled items and skip disabled commands;\n- Home/End jump to the first/last enabled item;\n- printable-key type-ahead searches visible command labels;\n- Escape dismisses and restores focus to the invoker;\n- Tab dismisses rather than trapping focus inside the menu.\n\nCommand identity MUST be stable and independent of presentation copy. Prefer\nnamespaced ids (`session.new`, `composer.focus`, `message.copy`) with centralized\nmetadata for label, description, scope, search keywords, shortcut, and destructive\nsemantics. Stateful components still own enablement and execution when they own\nthe underlying state; centralizing command metadata does not justify moving all\napplication state into a global store.\n\nThe command palette, shortcut hints, and keyboard dispatcher SHOULD derive from\nthe same command metadata. Do not maintain a second list of shortcut strings or\npalette labels by hand.\n\n### 12.2 Resizable panes and spatial memory\n\nPersistent secondary panes such as sidebars and inspectors SHOULD be resizable\nwhen width materially affects repeated work.\n\n","startLine":494,"endLine":585},{"path":"wiki/work-management/registry/resource-registry-project-state.md","quote":"  project's default Pi session directory (`PI_CODING_AGENT_DIR` or\n  `~/.pi/agent`). Once the parent is gone, the directory is removed after\n  24 hours of subtree inactivity. Unreadable directories and timestamp-named\n  legacy run directories keep the 72-hour TTL. Manual Clean is unchanged.\n  Deleting a parent session through ACP `session/delete` removes its\n  `.pi/subagents/\u003cparentSessionId\u003e/` directory immediately, except a symlinked\n  or non-UUID target or a directory that still contains `owned/`; a failed\n  removal is logged and left to this background policy.\n- Background cleanup is not run against a bare/uninitialized `.pi` directory.\n  After it completes, Registry storage state is refreshed only if that project\n  is still the active workspace. Manual Clean remains immediate and ignores the\n  TTL.\n- Desktop TODO and plan saves may lazily bootstrap a missing `.pi`, creating\n  only their required document directories; task and settings saves likewise\n  create only their required storage. A new `.pi` is ignored via a root\n  `/.pi/` `.gitignore` entry before creation, without changing Git's treatment\n  of already tracked files. Reads do not create storage. The optional full\n  initialization action is distinct from these lazy writes. Attachments may be\n  staged before the first task row; the eventual task save links them in\n  SQLite.\n- Markdown saves write and flush a temporary file through no-follow directory\n  handles, then atomically replace the destination entry. A destination symlink\n  installed before or during the save is replaced rather than followed.\n- Concurrent Desktop full-scaffold initializers use create-or-inspect\n  directories and SQLite transactions. On macOS, a first SQLite database is\n  initialized in a private staging directory, explicitly checkpointed with\n  `PRAGMA wal_checkpoint(TRUNCATE)` (requiring `busy == 0`), closed and flushed,\n  then published with exclusive `renamex_np(..., RENAME_EXCL)`. A competing\n  initializer cannot expose a version-zero database or replace an existing\n  database/task rows; the published database is inspected before success.\n\n## Related files\n\n- `acp/src/registry/service.ts`\n- `acp/src/registry/projects.ts`\n- `acp/src/registry/task-bundle.ts`\n- `acp/test/registry.test.ts`\n- `acp/src/acp/desktop-commands.ts`\n- `acp/test/desktop-commands.test.ts`\n- `desktop/src-tauri/src/lib.rs`\n- `desktop/src/app/registry.svelte.ts`\n- `desktop/src/app/registry-startup.ts`\n- `desktop/src/app/registry-startup.test.ts`\n- `desktop/src/app/desktop-root-effects.svelte.ts`\n- `desktop/src/app/registry-store.test.ts`\n- `desktop/src/lib/registry.ts`\n- `desktop/src/lib/registry-background-sync.ts`\n- `desktop/src/lib/registry-project-sync.ts`\n- `desktop/src/lib/registry-project-sync.test.ts`\n- `desktop/src/components/RegistryPanel.svelte`\n- `desktop/src/components/RegistryProjectStatus.svelte`\n- `desktop/src/components/RegistryCatalog.svelte`\n- `desktop/src/components/RegistryStatusIcon.svelte`\n- `desktop/src/app/registry-project-storage.svelte.ts`\n- `wiki/work-management/tasks/desktop.md`\n- `wiki/desktop/conversations/desktop-attachments.md`\n\n## Verification\n\n- ACP `test/registry.test.ts` covers project-state push/pull,\n  portable task attachments, attachment-only status changes, stale remote\n  attachment removal, conflicts, and direct workspace-scoped operations.\n- Desktop Rust task persistence tests cover reference-based local attachment\n  pruning after successful task-document writes, idempotent `.pi` skeleton\n  initialization without overwriting an existing task document, concurrent\n  initialization with atomic task-skeleton publication, distinction between\n  lazy writes and complete-scaffold initialized state, rejection of bare\n","startLine":353,"endLine":419},{"path":"wiki/desktop/conversations/desktop-file-mentions.md","quote":"---\nkind: spec\nstatus: active\n---\n\n# Desktop file and folder mentions\n\n## Type\n\nChange\n\n## Lifecycle\n\nActive implemented contract.\n\n## Behavior\n\n- Typing `@` in the Desktop prompt composer searches local project files and folders. A shared off-UI-thread index applies nested `.gitignore` rules, does not traverse symlinks, and updates incrementally from file watching. Results are fuzzy-ranked and limited to 20.\n- The composer displays path chips beside the native textarea. Arrow keys navigate, Enter/Tab select, Escape dismisses, and mouse selection and accessible announcements are supported.\n- Selection inserts plain `@path`; paths with spaces or quotes use JSON quoting. It inserts text only: the completion never reads or attaches file contents. The model receives the literal text and may later read paths using tools.\n- Mention context is keyed by workspace as well as session/draft state. Lookup suppresses LLM autocomplete. Requests are debounced and aborted/ignored when stale; project/session teardown is guarded. Slash-command and shell-command contexts are excluded.\n- Drafts without an active session are supported through the cwd-scoped ACP `pix/files/complete` extension.\n\nInsertion is plain `@path` unless the path contains spaces, `@`, backslashes, or quotes; those paths are JSON-quoted. Line-range selection is not implemented.\n\n## Related\n\n- [Desktop prompt autocomplete](desktop-autocomplete.md)\n- [TUI](../../tui/index.md)\n\n\n","startLine":1,"endLine":31},{"path":"wiki/desktop/workbench/desktop-project-titlebar.md","quote":"- Reopening the switcher refreshes overrides, so an externally edited\n  `.pi/workspace.jsonc` can be picked up without restarting Pix Desktop.\n- Switching projects while an earlier color read is in flight cannot apply that\n  older refresh after a newer generation starts.\n- If the workspace config changes while the settings save is in flight, the color\n  edit is reapplied to the returned current document. Repeated conflicts remain\n  visible in the modal instead of silently winning with stale content.\n\n## Related files\n\n- `desktop/src-tauri/src/project_icon.rs`\n- `desktop/src/lib/project-icon.ts`\n\n- `desktop/src-tauri/src/window_restore.rs`\n- `desktop/src-tauri/tauri.conf.json`\n- `desktop/src/app/project-workspace.svelte.ts`\n- `desktop/src/app/desktop-status-bar-view-model.svelte.ts`\n- `desktop/src/components/WorkspaceSidebar.svelte`\n- `desktop/src/components/WorkspaceSidebarActivityBar.svelte`\n- `desktop/src/components/workspace-sidebar-layout-controller.svelte.ts`\n- `desktop/src/components/workspace-sidebar-project-settings-controller.svelte.ts`\n- `desktop/src/components/ProjectSwitcher.svelte`\n- `desktop/src/components/ProjectSwitcherContextMenu.svelte`\n- `desktop/src/components/ProjectSettingsDialog.svelte`\n- `desktop/src/components/ProjectFolderIcon.svelte`\n- `desktop/src/components/RuntimeStatusBarItems.svelte`\n- `desktop/src/lib/recent-projects.ts`\n- `desktop/src/lib/project-colors.ts`\n- `desktop/src/app/project-workspace.test.ts`\n- `desktop/src/components/WorkbenchTabs.svelte`\n- `desktop/src/components/DesktopTitlebar.svelte`\n- `desktop/src-tauri/src/lib.rs`\n\n## Verification\n\n- `desktop/src-tauri/src/window_restore.rs` tests cover native project-title\n  formatting, Unicode/spaces, trailing separators, root paths, and empty windows.\n- `desktop/src/lib/recent-projects.test.ts` covers normalized full-path fallback\n  identity and two-letter project abbreviations.\n- `desktop/src/app/project-workspace.test.ts` covers URL precedence over stale\n  storage and retaining the URL workspace when storage fails. It also checks\n  active-only startup refresh, lazy reads for inactive recent projects, cached\n  color retention, and stale read rejection across switching and saving; Rust\n  tests cover QA workspace validation and URL query encoding/replacement.\n- `desktop/src/lib/project-colors.test.ts` covers JSONC override parsing and\n  fallback behavior.\n- `desktop/src/components/ProjectSwitcher.test.ts` covers current/new-window\n  actions, project-row Finder/removal actions and keyboard dismissal, the visible\n  chevron affordance, and verifies that the UI component does not own filesystem\n  IPC.\n- `desktop/src/components/ProjectSettingsDialog.test.ts` covers the settings\n  entry point, automatic/custom controls, native color picker, and presentation/\n  persistence separation.\n- `desktop/src/components/workspace-sidebar-project-settings-controller.test.ts`\n  covers same-workspace refresh stability, saving/error retention, reset on a\n  real workspace change, and stale save completion after switching projects.\n- `desktop/src/components/WorkspaceSidebar.test.ts` verifies that the Activity\n  Bar project icon stays neutral, `ProjectSwitcher.test.ts` verifies that the\n  active Project-switcher row stays neutral, and\n","startLine":239,"endLine":297},{"path":"wiki/development/desktop.md","quote":"# Pix Desktop\n\nLightweight Tauri 2 + Svelte 5 client for Pix. It runs `pix-acp` as an\nisolated child process and communicates with it over ACP JSON-RPC.\n\n## Platform support\n\nPix Desktop is currently supported and released only on **macOS Apple Silicon**.\nWindows and Linux Desktop packages are intentionally not produced or\nplatform-validated in CI for now. This does not affect Pix TUI support on\nWindows or Linux.\n\n## Visual direction\n\nThe desktop client follows the terminal renderer's information hierarchy:\nproject-scoped sessions are horizontal tabs, the transcript remains visually\nuninterrupted, thinking and tool activity stay compact, and model, thinking,\nconnection, and workspace controls live in the bottom status area. The left\nActivity Bar hosts workspace tools (Tasks, Project, Wiki, Source Control and\nothers); conversations are not a chat list beside chat-bubble messages.\n\n## Local setup\n\nFrom the repository root:\n\n```sh\nnpm --prefix acp install\nnpm --prefix desktop install\nnpm run dev:desktop\n```\n\nFor repository-wide development, run `npm run watch:all` from the repository\nroot instead. It watches Pix, pix-acp, the bundled tool suite, and both Desktop\nlayers. Desktop is restarted only after a successful build; on a build error,\nthe last working process stays open.\n\n`dev` and `build` compile `acp/dist/main.js` before Tauri starts. The current\nMVP expects `node` to be available on `PATH`; pix-acp resolves pi's bundled RPC\nentry from its pinned npm dependency. Packaging Node and pix-acp as a signed\nsidecar is intentionally deferred.\n\nFor non-standard development setups, set `PIX_ACP_NODE_BINARY` to the Node\nexecutable and/or `PIX_ACP_ENTRY` to a built pix-acp entry point.\n\n## macOS title bar quirks\n\nThe project selector lives in a custom title bar (`ProjectTitlebar.svelte`,\n36px tall) rendered under `titleBarStyle: \"Overlay\"` + `hiddenTitle`. Two\nTauri 2/macOS traps are easy to reintroduce:\n\n- **Window dragging stops working.** `data-tauri-drag-region` sends the\n  `window.start_dragging` IPC, which is *not* part of `core:window:default`\n  (and therefore not part of `core:default`). The capability set in\n  `src-tauri/capabilities/default.json` must explicitly include\n  `core:window:allow-start-dragging` (plus\n  `core:window:allow-internal-toggle-maximize` if double-click-to-zoom on the\n  title bar should keep working). Without the permission the drag silently\n  does nothing — there is no visible error in the UI.\n- **Traffic lights render 4px higher than configured.** macOS draws the\n  12px traffic-light dots 4px above the `trafficLightPosition` frame origin\n  (NSButton frame inset). With a 36px header, `y: 16` puts the visible dots\n  at y 12..24, centered on the row; `y: 12` makes them sit 4px too high and\n  misaligned with the selector. If the header height changes, recompute as\n  `y = (headerHeight - 12) / 2 + 4`.\n\nVerification recipe (real window, macOS): see `.pi/skills/tauri-window-qa`;\nmeasure the dot bounds from a screenshot (red/green pixel scan) and compare\nwith the header row border; drag via a CGEvent mouse-down/move/up sequence on\nempty header space and confirm the window position changes while the content\narea stays inert.\n\n## Checks\n\n```sh\nnpm --prefix desktop run check\nnpm --prefix desktop test\ncargo check --manifest-path desktop/src-tauri/Cargo.toml\n```\n\n\n","startLine":1,"endLine":80},{"path":"wiki/context/dcp.md","quote":"---\nkind: spec\nstatus: active\n---\n\n# dcp: dynamic context pruning (as-is spec)\n\n\u003e Risk classes: **data / cross-cutting / provider-context mutation**. DCP is\n\u003e headless. Raw Pi session messages remain the recovery source; DCP changes only\n\u003e the projected provider context and persists durable projection decisions as\n\u003e structured `dcp-journal` custom entries in the same session JSONL.\n\n## Type\n\nAs-is\n\n## Lifecycle\n\nActive implemented contract.\n\n## Purpose\n\nDCP keeps a long-running agent inside its context budget without rewriting the\nraw conversation. It exposes stable `mNNN`/`bN` addressing and the `compress`\ntool, can apply exact continuation summaries, and has a bounded emergency path.\nHistorical details are recovered through `session` history actions, not by expanding a\ncompressed block back into the provider prefix.\n\nOnly sessions created by the journal implementation are supported. There is no\nsidecar importer, legacy state reader, dual-write mode, `decompress`, or\n`recompress` compatibility path.\n\n## Lifecycle and persistence\n\n1. A confirmed new persistent session receives one `dcp-journal` `init` custom\n   entry before DCP publishes provider-visible addressing/rewrite decisions.\n   Ephemeral sessions use the same contract in memory for their lifetime.\n2. `session_start` resets transient runtime state and replays the complete\n   journal on the active branch. A non-empty persisted session without a valid\n   journal is deliberately unsupported rather than adopted as a new DCP\n   session. Unknown versions, broken predecessor chains, or conflicting\n   operation IDs fail closed.\n3. `tool_call`/`tool_result` maintain transient tool records. Exact args/output\n   needed by current policy can be reconstructed from the raw branch. Large raw\n   tool bodies are not duplicated into the journal.\n4. `context` builds a detached provider projection, applies already committed\n   exact blocks/prune decisions, maintains stable IDs, evaluates pressure and\n   candidates, and publishes any new durable projection decision before the\n   resulting bytes may be used by the provider.\n5. `before_provider_request` records which tool results actually occur in the\n   outgoing payload. `after_provider_response` treats HTTP status as diagnostic\n   acceptance only. A successful finalized assistant `message_end` can promote\n   provider evidence when the local attempt is unambiguous. This evidence is\n   runtime-only and returns to unknown after restart.\n6. `agent_end` and `session_shutdown` do not persist a full DCP runtime snapshot.\n   Durable decisions are appended at their mutation/publication boundary.\n\nPlain `custom` entries are not provider messages. `dcp-journal` must never be\nstored as `custom_message` or copied into a model-facing tool result.\n\nAsync-subagent common spawn explicitly loads `dcp/subagent.ts` for every role\nand attempt, without interactive `/dcp` commands or the full suite. The normal\nDCP configuration and model overrides still apply. Enabled `compress` survives\nrestricted/empty work-tool lists, CLI exclusions and model selection; read-only\nchild/council guards allow this context-only operation. Async children are always\npersisted sessions and use the normal journal. An in-memory (unpersisted) session\nmanager keeps decisions in memory only: no journal writes, no raw history mutation. See [subagent spawn](../tools/agents/async-subagents.md#spawn-corespawnts).\n\n","startLine":1,"endLine":68},{"path":"wiki/search/repo-knowledge-agent-workflow.md","quote":"maintenance, without treating generated answers as semantic proof.\n\n## Scope\n\n- Repo-aware tool descriptions, prompt guidance, schemas and search options.\n- General coding discovery, document/contract retrieval, and task-scoped audit.\n- Documentation and deterministic prompt/adapter tests.\n\n## Behavior\n\n- `repo_context`, `repo_inspect`, `repo_audit`, and `repo_search` are removed.\n  Code and Knowledge use native `project_search` across Pi/TUI/ACP/Desktop;\n  there is no external-backend fallback, setup/update command, panel, provider migration or\n  repository-search gate. See [Project-wide agent search](project-search-agent-tool.md).\n- Native lexical retrieval needs no embedding credentials. Opt-in repository and\n  commit embeddings use the global `search.embedding` object in\n  `~/.config/pi/pi-tools-suite.jsonc` (legacy `.pi/search/semantic.json` is\n  ignored); chunks/queries may be transmitted externally.\n- The primary bundled extension exposes `project_search` with its full schema to\n  ordinary Pi, ACP, and every async child/provider child/council. Every caller has\n  the same sources (`sessions`, `tasks`, `commits`, `code`, `knowledge`), options,\n  and `patch:\u003cliteral\u003e` behavior; there is no child restriction or reduced facade.\n  Children still omit suite setup commands and parent orchestration/delegation\n  guidance, and retain their normal work-tool restrictions. `project_search` does\n  not initialize or update external search services. Repository embeddings are\n  authorized only by that saved global configuration, with no separate consent\n  step, and keep the same provider safeguards. See [decision 0060](../decisions/0060-subagent-read-only-repo-tools.md)\n  and [project search](project-search-agent-tool.md).\n- `project_search` is the single project retrieval tool. It defaults to all five\n  sources for every caller; choose sources explicitly to narrow scope. Code and\n  Knowledge use native search; unsupported legacy filters are removed from the\n  schema. See its spec for supported options and privacy details. Markdown\n  documents are searched subject to ignore/exclusion filters. Explicit frontmatter\n  kind/status takes precedence; inferred purpose is advisory.\n- Preserve visible warnings, truncation and continuation hints. Empty or degraded\n  retrieval does not establish the absence of a contract. Read authoritative\n  primary documents and relevant code/tests rather than trusting summaries or\n  rankings as semantic proof.\n- Start compact. Use `project_search` to locate relevant contracts, code and tests,\n  initially with at most 3 results and no inline content. For maps, inventories,\n  symbols or dependencies, use available file/path and structural tools as useful;\n  `project_search` is retrieval, not an architecture/dependency graph. Read exact\n  returned ranges directly; only\n  expand for a named gap. Exact identifier/text lookup uses available `Grep`/`grep`,\n  otherwise shell `rg`; path-only discovery uses available `Glob`/`find`, otherwise\n  shell `rg --files`. Read known paths directly; never require an unavailable tool.\n  These text-only fallbacks do not weaken AST-first routing for structural queries.\n- Being new to a repository alone does not request an architecture map: a\n  reading guide for a behavior starts with `project_search` and direct reads.\n  Before creating a spec or making a material behavior change, use\n  `project_search` to locate the contract and evidence, then read primary sources.\n  Keep the governing\n  document's behavior/scenarios/constraints/interfaces aligned in\n  the same task; create a focused spec only if needed. New specs use the\n  project's spec template (`specs/TEMPLATE.md` when present), with\n  `kind: spec` and intended `status`, and\n  project-root-relative paths in Implementation/Tests sections. If the template\n  is absent, ask before creating one rather than inventing a convention.\n  Existing useful documents do not need reformatting.\n- Before completing an implementation task, the parent runs the available\n  `knowledge-auditor` with the final behavior/result and exact task-changed\n  project-relative paths. Obtain the result and resolve concrete documentation\n  questions; the parent retains product and architecture decisions.\n- The docs-only specialist updates affected specs/README material using the final\n  implementation and tests as evidence. It fixes small, unambiguous drift and\n  returns substantial or ambiguous discrepancies to the parent. Accurate\n  documentation needs no edit. If the role is unavailable, the parent maintains\n  affected documentation directly.\n- Documentation maintenance does not require search setup. The bundled\n  role has no indexed-project visibility gate. Search and direct reads are\n  sufficient; retrieval results are not evidence of semantic correctness.\n- Do not require `idx knowledge dirty`, `idx knowledge acknowledge`, index\n  refreshes, review receipts, a global clean verdict, or exhaustive traversal of\n  every declared Implementation/Tests dependency. Read only the evidence needed\n  to resolve the task's documentation questions. Unrelated\n  knowledge state do not block this work.\n- The same role accepts an explicitly assigned **spec-review** with exact\n  documentation paths and a review goal. This is bounded documentation work,\n  not global cleanup or certification; changed product paths are not required.\n- Preserve unrelated and concurrent edits. An unassigned document with existing\n  local edits is a conflict to report, not permission to overwrite it. Re-read\n  changed documentation before applying patches.\n- Return documentation updated/no changes needed, exact documentation paths\n  changed and unresolved questions with evidence. Do not produce a global\n  dirtiness verdict or dependency-coverage ledger. Source/test/configuration\n  changes remain outside the role; disposable reports use `.pi/artifacts/`.\n\n## Decision history\n\n","startLine":21,"endLine":109},{"path":"wiki/decisions/0042-preview-file-context-actions.md","quote":"# 0042 — Native file actions for Preview and media\n\n- Status: accepted\n- Recorded: 2026-10-04\n- Decided: 2026-10-04\n- Owner / approval evidence: user requested media/Preview right-click actions and\n  explicitly selected actual-file copying plus menus on both tab and content.\n- Governing spec: [Desktop context menus](../desktop/workbench/desktop-context-menus.md)\n- Replaces / replaced by: none\n\n## Context\n\nImage menus already copy pixels and open externally. Video, Preview headers and\nread-only file surfaces also need copy/open/reveal commands usable with Finder.\n\n## Observations and sources\n\nThe existing generic native menu owns generation guards and resource teardown.\nProject Explorer's clipboard previously used text encoded for Pix instances;\nnative macOS Explorer Copy now additionally publishes Finder file URLs while\nretaining the Pix reference. Preview models distinguish display names from local\npaths.\nThese are code observations, not evidence of native OS acceptance testing.\n\n## Decision\n\nReuse the generic menu owner, with trusted path metadata on Preview and attachment\nsurfaces. Preserve image pixel copying and editing/selection menus. Copy File\nuses macOS native file-URL clipboard semantics; opening uses the OS default app.\nTab headers act on the underlying file rather than serializing an unsaved draft.\nBackend validation remains mandatory. Desktop support remains macOS-only.\n\n## Alternatives\n\n- Copying path text does not satisfy the user's explicit file-copy choice.\n- Reusing Explorer's Pix reference alone would not enable Finder paste; its\n  native file-URL representation provides that interoperability.\n- Adding component-owned menus would duplicate native menu lifecycle ownership.\n\n## Consequences\n\nUsers can transfer local files to Finder and open/reveal them consistently.\nRemote/data-only sources cannot be revealed without a local file. Image content\ncopy and tab file copy intentionally differ. Native clipboard interoperability\nstill requires macOS acceptance evidence beyond mocked frontend tests.\n\n## Revisit when\n\nDesktop platform support changes, users require draft export or remote-video\ncaching, or native pasteboard compatibility tests expose application failures.\n\n\n","startLine":1,"endLine":52}],"notices":["Неопределённость 1 не прошла проверку: цитата отсутствует или встречается в предоставленном тексте несколько раз."],"coverage":{"scope":"retrieved-passages","checkedPassages":12,"candidateSources":63,"excerptedSources":9,"limits":["query-sampling","candidate-limit","source-limit","context-limit","passage-limit"]},"status":"incomplete"}} -->

# Desktop workspace keyboard navigation

<!-- markdownlint-disable MD013 -->

## Type

Change.

## Lifecycle

Active implemented contract.

## Goal

Make Pix Desktop workspace navigation behave like an IDE navigator: the Activity
Bar and Project Explorer are keyboard-first composite controls with stable focus,
while project selection/open state remains separate from transient focus.
Desktop product support is macOS only; retained Windows/Linux branches do not
establish compatibility requirements.

## Project Explorer behavior

- Reverse navigation opens Files without changing the workspace root: clicking
  a validated relative directory link or choosing **Show in Files** on a Preview
  editor tab clears the Files search, expands the root and ancestors, selects the
  target, and scrolls/focuses its row. Directory targets also expand. This does
  not open a file, change the active workbench tab, or save/discard an editor draft.
  Only the required lazy branch is loaded; missing/unsafe targets are not invented.
  Replacement reveals, workspace changes, teardown and changed tree-focus intent
  cancel stale asynchronous completion. Paths outside the project have no tab
  reveal action. See [decision 0058](../../decisions/0058-reverse-file-navigation.md).
- The tree starts with an explicit workspace-root directory row named after the
  project folder. It is expanded on mount and workspace change; refresh and search
  preserve its current state. Its children are one level deeper. Click,
  Enter/Space and Left/Right toggle/navigate it like other directories. Collapsing
  the root clears all descendant expansion preferences but keeps selected files intact;
  the root participates in the same single roving Tab stop.
- Collapsing any directory clears its own and all descendant expanded-directory
  paths, including hidden descendants, and persists the reduced list. Reopening
  shows its immediate children collapsed; sibling branches, cached listings and
  selected files remain unchanged.
- Right-click or Context Menu / `Shift+F10` on the root offers New File/New Folder
  and Paste in the project root, plus external-editor and file-manager commands,
  and Copy Project Name / Copy Absolute Path, without requiring empty space below
  the file list. Copy Project Name copies the root entry's name; Copy Absolute
  Path copies the active workspace path verbatim. The root cannot be renamed,
  deleted, copied, duplicated or dragged. It remains reachable in empty, loading
  and failed-listing states. Root collapse is transient and is not stored among
  relative expanded-directory paths; successful create/paste expands its target.
- The visible project hierarchy is exposed as one ARIA `tree` containing
  `treeitem` rows with `aria-level`; directory rows additionally expose
  `aria-expanded`.
- Exactly one visible tree row participates in the normal Tab sequence. The
  current focused row wins, then the selected/open file when visible, then the
  first visible row.
- ArrowUp/ArrowDown move focus across visible rows without wrapping. Home/End move
  to the visible bounds. Keyboard movement scrolls the focused row into view.
- ArrowRight expands a collapsed directory. On an already expanded directory it
  moves to the first visible child when one exists.
- ArrowLeft collapses an expanded directory. Otherwise it moves to the nearest
  visible parent row; a root item remains in place.
- Enter/Space open files or toggle directories. Printable-key type-ahead uses a
  short accumulated query and wraps to the next visible matching entry name.
- Opening a file updates persistent selected-file styling; moving focus alone
  never changes that selection.
- Row hover background follows only the pointer, not DOM focus. Restoring focus
  after deletion must not leave a second hover-like filled row when the pointer
  moves elsewhere. Keyboard focus remains visible through the inset focus ring,
  separately from persistent selected/open-file styling.
- Refreshing project files updates the root and currently visible expanded
  directories in place. It preserves expanded directories, the selected file,
  focus state, and existing rows while refresh requests are in flight. When the
  workspace changes, selection/focus and loaded directory contents reset, but
  that project's folder expansion state is restored from
  `.pi/workspace.jsonc` under `projectExplorer.expandedDirectories`. Only
  relative expanded-directory paths are stored; directory contents are never
  persisted. The list is bounded to 256 paths, writes are debounced and
  serialized, and conditional workspace-config writes retry concurrent edits
  while preserving comments and unrelated settings. Stale branches are pruned
  as their nearest loaded parent is enumerated, so restoring state does not
  trigger an unbounded filesystem walk.
- `Shift+Enter` opens the focused file or directory in the configured external
  editor. Gram is a supported built-in choice. When no external editor is
  configured, Desktop reports that the user must choose one in Desktop Settings
  rather than silently assuming Zed. The external-editor icon is visible only on
  the pointer-hovered row, disappearing immediately when the pointer leaves;
  retained DOM focus or selected-file state must not leave another icon visible.
  It is removed from the normal Tab sequence so every tree row does not add a
  second Tab stop.
- On macOS, Gram targets are opened through Gram's bundled CLI when it is present
  inside the installed app bundle; LaunchServices app opening remains the fallback.
  This keeps file/project opening aligned with Gram's own command-line entry point
  even when the `gram` executable is not installed on `PATH`.
- Project entries expose IDE-style contextual file commands without adding a Tab
  stop per row. Right-click, the Context Menu key, and `Shift+F10` open the same
  command surface for the focused row. The command set includes Open/Open in
  External Editor, New File/New Folder for directory targets, Copy/Paste,
  Duplicate, Rename, Copy Relative Path, Copy Project Name for the root,
  Copy Absolute Path, and Delete where applicable. Relative-path copying applies
  to files and folders below the workspace root and copies
  plain filesystem text without quoting or URI escaping. Absolute paths include
  the active workspace root; relative paths retain the existing project-relative form.
- HTML files (`.html` and `.htm`, case-insensitive) additionally offer **Open in
  Browser** in both menu surfaces. On macOS this opens the saved file in the
  default HTTPS browser, regardless of the HTML file's editor association, without
  saving drafts or starting a web server. Other files, folders and the root omit
  the action. The backend rejects missing, non-HTML, symlink and escaped targets;
  failures use the Files error surface and stale failures cannot affect a replaced
  workspace or disposed panel.
- In the Tauri Desktop host, Project Explorer uses an OS-native context menu.
  On supported macOS Desktop it may extend beyond the application window; the
  OS owns placement, screen-edge clamping and keyboard traversal. Pointer menus
  use the click position and keyboard menus anchor below the focused row. The
  invoking row keeps focus. Clipboard and Git-ignore eligibility are awaited
  before popup and captured for that opening; background Git refreshes do not
  change an already-presented native menu. Paste still rereads at activation.
  Replacement, workspace change and disposal invalidate callbacks and release
  native resources; intervening interactions cancel pending preparation/IPC.
  Popup promise resolution is not treated as a portable dismissal signal.
  See [decision 0028](../../decisions/0028-native-explorer-context-menu.md).
- The standalone browser preview retains the DOM menu, bounded inside its
  viewport with an 8 px inset using rendered dimensions. It repositions on
  content changes, scrolls internally if needed and dismisses on window resize.
- The same context menu reveals the targeted file or folder in the OS file manager,
  or opens the project folder for the root context menu. On supported macOS
  Desktop the label is **Reveal in Finder**, and Finder selects the targeted
  entry. The native command validates the target
  against the workspace and rejects symlink targets or escaped paths.
- In the Tauri Desktop chat context menu, a Markdown project-file link also offers
  **Open on GitHub** or **Open on GitLab** between **Show in Files** and
  **Reveal in Finder** when its workspace-relative target resolves to a supported
  Git remote link. Links outside the current project do not offer this action.
  Remote lookup is ordered with native menu registration; lookup failures silently
  hide the item. Activating it opens the resolved URL in the external browser.
- When Git is available and the repository's selected remote is hosted on
  GitHub or GitLab (including self-hosted instances), the context menu offers
  **Open on GitHub** or **Open on GitLab** for files, folders and the project
  root. Remote selection matches Git CI: branch upstream remote, otherwise
  `origin`, otherwise the sole configured remote. The link targets the current
  branch, or the detached HEAD commit, and uses a file or tree URL with
  percent-encoded path segments. SSH remotes open over HTTPS without the SSH
  port; HTTP(S) remotes retain their scheme and port. Unsupported/missing
  remotes, unavailable Git or failed lookups hide the item. Lookup results are
  generation-guarded so stale results cannot populate a newer menu; failures
  opening the link are logged as `project-explorer:open-remote-failed` and
  shown through the explorer operation error surface.
- `F2` renames the focused entry, `Delete` requests deletion, and the platform
  primary Copy/Paste shortcuts operate on the Project Explorer entry clipboard
  while tree focus is active. These shortcuts do not replace normal text-editing
  shortcuts outside the tree.
- Tree selection supports Cmd/Ctrl-click toggling, Shift-click and Shift+Arrow
  visible-range extension, and Cmd/Ctrl+A for all visible entries. The workspace
  root is excluded; selected descendants of selected directories are deduplicated
  before group operations. Dragging selected entries onto a folder or root moves
  them together; Escape cancels the drag. On macOS, the existing Files tree uses
  an AppKit file-URL drag source, not a replacement native/Finder tree. Dragging
  Files into Finder copies by default and requests Move with Cmd; Finder owns
  the transfer, and Pix never deletes originals in the source-ended callback.
  Outbound Finder transfers are outside Pix Undo/Redo; the source tree refreshes
  after the native session ends.
- Finder file/folder drops onto a Files folder or tree background copy by
  default; Cmd requests a move. File rows and non-tree controls reject drops
  rather than falling back to the project root or composer. Accepted imports
  use the existing scoped operation/history owner, with Undo/Redo, no overwrite,
  descendant deduplication and protected-path/symlink guards. Inbound moves use
  exclusive rename; cross-volume moves fail without copy-and-delete fallback.
  Copy keeps the existing collision-free naming policy. Native incoming data is
  captured from the actual `NSDraggingInfo.draggingPasteboard`, not the general
  clipboard or a globally named drag board; ordinary text paths are not files.
  Main-thread capture consumes a label-scoped, expiring one-shot snapshot with
  bounded URL data. A new native drag clears an unconsumed snapshot; unsupported
  file promises cannot reuse an older file drop. Capture reads the registered
  context directly without asynchronously dispatching another webview callback;
  URL resolution and filesystem validation run off the UI thread. Source
  cancellation, document reload, window/panel teardown and workspace replacement
  invalidate pending preparation or stale completions. A bounded watchdog
  acknowledges an unstarted native source without prematurely releasing it.
  Quarantined sources reject transfers and block a second session on that view;
  ownership is released only by the matching ended callback, or after button-up
  if the source never began. Active AppKit sessions retain ownership until their
  ended callback. The pinned Wry class's
  drag callback ABI is checked before bridging WebKit's DOM negotiation; an
  incompatible bridge fails closed instead of importing unrelated clipboard data.
- Finder-to-composer and Files-to-composer drops insert path references only,
  even with Cmd, and never copy/move/delete originals. Same-workspace Files
  references remain relative using immutable native source metadata; external
  paths remain absolute. Existing question attachment routing is retained.
- New File/New Folder and Rename edit the name inline in the tree, without a
  dialog. Creation expands the destination (including the workspace root) and
  inserts a temporary input as its first child; rename replaces the targeted
  row. The input takes focus and is the tree's only Tab stop while editing.
  Rename selects a file's basename without its final extension, or the full
  name for folders, extensionless files and dotfiles without a later dot.
  `Enter` submits, `Escape` cancels and restores row focus; leaving the input
  cancels without moving focus back. IME composition does not submit or cancel.
  Clipboard and arrow keys retain native text-input behavior. Empty names,
  `.`/`..` and path separators show inline validation without filesystem I/O;
  unchanged rename cancels without a mutation. Workspace replacement and panel
  teardown discard the input and invalidate stale callbacks/completions.
- Copy writes a versioned Pix file/folder reference (source workspace, relative
  path and kind) to the system clipboard. In native macOS Desktop, Copy writes
  Finder-readable file URLs together with the Pix version-2 reference in one
  pasteboard transaction; Paste prioritizes that Pix reference when both are
  present, preserving the source workspace. Copy snapshots the pasteboard change
  count before filesystem validation and checks it again before commit, so a late
  Copy cannot overwrite a newer clipboard value; a mismatch is reported as a
  recoverable error. Cut remains text-only Pix move data and is limited to the
  same workspace. Browser fallback remains text-only.
  Paste works across project windows
  and independently running Pix instances on the same macOS machine, including
  after changing projects or closing the source window. It copies the current
  source contents at paste time, not a snapshot; deleted/inaccessible sources
  report an operation error. On macOS, Paste also accepts Finder file-URL items:
  an action-triggered native pasteboard snapshot adapts validated local regular
  files and directories from any parent into a bounded version-2 copy batch with
  source workspace `/`. Paste never rewrites the clipboard; ordinary text paths
  remain invalid, while Pix text references remain supported. Reads occur only
  when opening a file menu and on Paste, not by polling; Paste rereads the
  clipboard before mutation. Snapshot changes, stale menu reads, workspace
  replacement and panel teardown cannot apply stale state. Native Copy and Finder
  imports are limited to 1..1000 entries and 32768 encoded bytes. Existing copy/history behavior
  supplies collision-free names, recursive copy and Undo/Redo; selected
  descendants are deduplicated, and unsafe sources/destinations (including
  symlinks, special files, protected history storage and copying a directory into
  itself) are rejected. Browser fallback remains text-only. See
  [decision 0026](../../decisions/0026-cross-instance-file-clipboard.md).
- Copy, cut, paste and duplicate operate on the selected entry group when one is
  selected, otherwise on the focused/context entry. Cut is limited to the same
  workspace; copy may cross workspaces. Group moves, copy, duplicate and delete
  are preflighted as a batch. Conflicts, vanished parents, symbolic links and
  replacements of existing directories are refused; safe-save replacement
  of a regular file is accepted by moving its current contents intact. Cross-
  volume rename does not fall back to copy-and-delete. A late batch failure may
  leave a successful prefix, which is retained as one undoable operation and
  reported as a warning.
- File mutations are workspace-relative backend operations. They reject paths
  that escape the active project and do not follow symbolic links. Copying a
  project entry creates a non-conflicting destination name rather than silently
  overwriting an existing file or directory. Cross-project Paste validates source
  paths relative to the source workspace and destination paths relative to the
  receiving workspace, checks canonical paths to reject copying a folder into
  itself/descendants even through different workspace roots, and runs recursive
  copying off the UI thread. Exclusive creation prevents overwrite or deletion
  of a target claimed concurrently by another instance; a collision race reports
  an error and can be retried. Partial copies owned by the operation are cleaned
  up after a copy failure, including encountering a nested symbolic link.
- Rename, copy/paste, duplicate, create, and delete refresh only the affected
  directory state. Rename preserves focus/selection and expanded descendants
  under the new path when possible and updates the workspace-config expansion paths;
  deletion moves focus to a logical surviving row and clears stale
  selected/expanded state beneath the removed path from both memory and the
  sparse persisted preference.
- Delete requires confirmation and retains the removed data in recovery storage
  for Undo rather than permanently deleting it.
- Pending file I/O does not globally disable Files commands. Mutations use scoped
  reservations; independent forward requests may proceed concurrently. Undo/redo
  replay is disabled/refused until mutations are idle, not queued. Pending document writes finish before a
  mutation and new writes are reserved; a dirty Preview blocks mutation, while a
  clean Preview closes to invalidate stale paths.
  Deletion/rename reserve the affected subtrees; creation keeps its parent directory alive and
  reserves the new path, allowing independent sibling mutations. Copy/paste and
  duplicate conservatively reserve the destination subtree because the backend
  chooses the output name (including partially visible copies). Copying into the
  workspace root therefore excludes other mutations in that root while it runs;
  navigation, opening files and clipboard-reference/path commands remain usable.
  Ignore operations protect the target and possible ancestor `.gitignore` files.
  Conflict checks apply both to menu availability and action activation.
  Files shows active operation labels/counts without a modal progress window.
  Create/rename inline inputs close after submission, before filesystem I/O; failures
  appear in the Files error surface. Each operation owns its completion token;
  finishing one cannot unlock or invalidate another, and workspace replacement
  or panel teardown invalidates all old completions. Late deletion completion
  does not restore tree focus after the user has moved to another row.
  A pending create/rename completion cannot steal focus from a newer name input
  or a different focused tree row; created files open only when that completion
  still owns focus. Name-mutation failures also reach the diagnostic logger.
  See [decision 0028](../../decisions/0028-scoped-file-operation-reservations.md).
- Create, copy, delete, rename and move support Undo/Redo. A group request is one
  history token; partial undo can be retried. Controls are available in the
  toolbar/context menu and via Cmd+Z/Cmd+Shift+Z while Files is focused (not while
  editing a name, searching, or editing Preview text). History is runtime-only
  for the mounted panel and current workspace, with a 100-operation limit.
  Durable recovery data and intent journals live under `.pi/file-history`; they
  are never automatically purged, are excluded from manual and TTL Clean and
  Files tree/search, and nested `.gitignore` files contain `*`. Journals are for
  manual recovery only and are never replayed as executable work after restart.
  A batch that changes nothing removes its own empty token folder, and a copy
  whose staged duplicate cannot be moved into place removes that stage (the
  source is never touched); cleanup failures reach the diagnostic logger.
- Backend history work is serialized per workspace, not process-wide: the
  runtime token map is locked only to look up, insert or forget a token, while
  copies, moves, fsyncs and journal saves hold an in-process lock for the target
  workspace (plus the source workspace for imports and cross-workspace copies,
  acquired all-or-nothing) and the storage `flock` that guards other Pix
  processes. A long copy in one workspace therefore never delays Files
  mutations, Undo/Redo or Forget in another. Forgetting a token while its
  Undo/Redo runs lets that replay finish; later replays are refused.
- File/folder context menus expose **Add to .gitignore** only after a local Git
  check confirms an exact workspace-root repository and a target not already
  matching ignore rules, including tracked files and folders with tracked
  descendants. Ignore matching is checked independently of the index. The backend
  rechecks eligibility before writing; it never removes anything from the index,
  so already tracked files retain their Git status after a rule is added. It appends
  an anchored, escaped literal rule, with a trailing slash for folders, to the
  nearest existing ancestor `.gitignore`, or creates the root `.gitignore`.
  Existing rules/comments and newline style are preserved. Workspace escapes,
  symlinks and Git metadata are rejected. Completion refreshes directory listings
  and the shared Git snapshot, updating target/ancestor/`.gitignore` colors without
  manual refresh. Menu checks and mutation completions cannot affect a replaced
  workspace or closed menu/panel. Rechecking the same menu target after a Git
  snapshot refresh preserves its confirmed eligibility while the read is pending,
  so polling does not make the action blink. A fresh ineligible result or failed
  check hides it; changing targets clears the previous target's eligibility.
- Browser fallback retains pointer-based internal Files moves and composer
  references; lazy directory loading is unchanged.
- Project Explorer keeps dotfiles and dotfolders in the normal tree. Entries whose basename starts with `.` use muted opacity by default so ordinary source files retain visual priority; hover, keyboard focus, and selected/open state restore normal readability.
- The workspace-root `.pi` directory, root `AGENTS.md`, direct canonical files in `.pi`, and durable canonical `.pi` directories are emphasized with primary-colored, medium-weight names and `FolderCog`/`FileCog` icons. Canonical entries are limited to the native cleanup allowlists; ephemeral containers such as `artifacts` and `subagents` are excluded. Descendants are not blanket-emphasized, and unknown paths remain unchanged. Emphasized dot entries bypass default muting. Git status name colors retain precedence over emphasis, while icons remain primary-colored; row tooltips describe the entry's role. This is visual-only and does not change focus, navigation or selection.
- Project Explorer colors changed file names from the shared workspace Git snapshot, without displaying status letters or badges. Added/untracked files use success, deleted files warning, conflicts error, and other changes info semantic colors. Working-tree status takes color precedence over staged status; tooltips and accessible row labels describe both scopes. Existing folders containing changed descendants use info-colored names, even when collapsed, with conflicts taking error-color priority. Renames color both source and destination ancestor folders; absent/deleted files are not invented in the filesystem tree. Clean files and unavailable/non-repository snapshots have no decorations.
- While Files is mounted, local Git status refreshes on opening/workspace change, Files Refresh, window focus, file-operation completion, and about every five seconds after the previous read completes. Reads are serialized and repeated triggers coalesce; closing the panel stops scheduling. This reuses the workspace-guarded Git store and does not fetch remotes or traverse/expand the lazy tree. Git errors do not prevent file browsing or change its health indicator.
- While Files is mounted and the window is focused and visible, directory listings
  refresh about every five seconds after the previous poll completes and immediately
  when returning to the window. Only the root and visible expanded directories are
  read, without recursively scanning the project or adding a filesystem watcher.
  Polling preserves existing rows, expansion, selection and focus, skips directories
  already loading, and uses the tree's generation/request guards against stale
  workspace or mutation completions. Cached directory polls are quiet: no loading
  spinner or error clear/reappear cycle while waiting. Successful reads clear old
  errors; initial uncached loads and explicit directory reloads retain loading
  feedback. Equal listings retain array/map identity and do not invalidate tree
  rendering; changed listings reuse unchanged entries. Git polls likewise reuse
  equal snapshots and omit repeated branch/remote listings after metadata bootstrap
  (see [Git status reads](../integrations/desktop-git-workflows.md#explorer-local-status-reads)).
  Background/hidden windows stop scheduling;
  closing Files removes timers and activity listeners. Search results are not polled.
- Expanding a previously loaded directory rereads it and its visible expanded
  descendants, retaining cached rows until completion. Reopening the workspace
  root rereads the root and visible expanded directories. This exposes folders
  created by agents or external tools while a branch was collapsed, without
  waiting for the next poll or scanning unopened branches; in-flight reads coalesce.
- The Files panel keeps a compact project-search field above the lazy tree. Typing a query runs a bounded background search over project-relative file paths and UTF-8 file contents without expanding tree nodes; `Ctrl+Shift+F` / `Cmd+Shift+F` focuses that field while the Files panel is active.
- Project search does not follow symbolic links and skips dependency/generated directories such as `.git`, `node_modules`, `target`, `dist`, `build`, `coverage`, `.next`, and `.svelte-kit`. Individual content reads are bounded to 2 MB, scanning stops after 20,000 files, and at most 500 path/content matches are returned so searching cannot turn the renderer into an unbounded filesystem walk. A newer search from the same window, a cleared query, an unmounted Files panel or a closed window stops the previous walk; unreadable subdirectories are skipped instead of failing the whole search.
- Search results show the relative path, source line/column when the hit came from file contents, and a compact line preview. Activating a content hit opens Preview at that exact source line; activating a path-only hit opens the file normally. Clearing the query returns to the existing lazy tree with its expansion/selection state intact.

## Activity Bar behavior

- **Wiki** opens the project-document tree described in
  [Desktop project Wiki](desktop-project-wiki.md). It shares the rail's keyboard,
  selection, collapse and sizing behavior; documents open in Preview.

- The workspace rail is one vertical toolbar with a single Tab entry anchored to
  the active destination, including when the panel is collapsed. Arrow/Home/End
  navigation moves DOM focus but does not move that Tab entry; returning with Tab
  enters at the active destination rather than the last arrow-focused button.
  This is not a focus-following roving-tabindex implementation.
- The rail is a compact 30 px column with 40 px-high view buttons and 20 px
  icons. Density changes must preserve visible focus and the single-composite
  keyboard model.
- ArrowUp/ArrowDown and Home/End move focus without activating a destination.
- Enter/Space/click keeps the existing view-selection/collapse behavior.
- Every expanded workspace panel header includes a compact Close control. It uses
  the same collapse path as activating the already-selected Activity Bar item,
  so closing the panel preserves the current destination for the next reopen.
- The expanded workspace panel has no per-view maximum width. Pointer or keyboard
  resizing may keep widening it until the window reaches the shared minimum width
  reserved for the main conversation/workbench area.
- Focus movement does not alter indicator state or acknowledge a destination;
  acknowledgement remains tied to the view actually becoming visible.

## Implementation

- `desktop/src-tauri/src/project_browser.rs`
- `desktop/src-tauri/Cargo.toml`

- `desktop/src/App.svelte`
- `desktop/src/app/desktop-project-services.ts`
- `desktop/src/app/preview-file-io.ts`
- `desktop/src/components/DesktopSidebar.svelte`
- `desktop/src/lib/desktop-context-target.ts`
- `desktop/src/lib/native-context-menu.ts`
- `desktop/src-tauri/src/project_directory_link.rs`
- `desktop/src/components/ProjectExplorer.svelte`
- `desktop/src/components/project-explorer-tree-controller.svelte.ts`
- `desktop/src/components/project-explorer-operations.svelte.ts`
- `desktop/src/components/project-explorer-menu-controller.svelte.ts`
- `desktop/src/lib/project-explorer-native-menu.ts`
- `desktop/src/components/project-explorer-drag-controller.svelte.ts`
- `desktop/src/components/WorkspaceSidebar.svelte`
- `desktop/src/components/WorkspaceSidebarActivityBar.svelte`
- `desktop/src/components/workspace-sidebar-layout-controller.svelte.ts`
- `desktop/src/lib/keyboard-navigation.ts`
- `desktop/src/lib/project-tree.ts`
- `desktop/src/lib/project-git-decorations.ts`
- `desktop/src/lib/project-entry-emphasis.ts`
- `desktop/src/lib/project-git-refresh.ts`
- `desktop/src/lib/project-files-refresh.ts`
- `desktop/src/lib/project-git-ignore.ts`
- `desktop/src/app/desktop-sidebar-view-model.svelte.ts`
- `desktop/src/lib/project-explorer-expansion.ts`
- `desktop/src/lib/project-entry-clipboard.ts`
- `desktop/src/lib/sidebar-indicators.ts`
- `desktop/src-tauri/src/lib.rs`
- `desktop/src-tauri/src/git_ignore.rs`

## Tests

- `desktop/src-tauri/src/project_browser.rs`: HTML eligibility and workspace validation.

- `desktop/src/lib/project-files-refresh.test.ts` covers foreground-only polling,
  focus/visibility resumption, serialized reads, failure retries and teardown during
  in-flight work. Project Explorer source tests pin the visible-directory refresh
  and mounted-component lifecycle wiring.

- `desktop/src/lib/keyboard-navigation.test.ts` covers composite and type-ahead
  navigation primitives.
- `desktop/src/lib/project-tree.test.ts` covers visible parent lookup, workspace
  root naming, nesting, empty/loading rows, and collapse without preference loss.
- `desktop/src/lib/project-explorer-expansion.test.ts` covers compact per-project
  expansion persistence, malformed state rejection, and storage bounds.
- `desktop/src/components/ProjectExplorer.test.ts` covers tree semantics and the
  keyboard external-editor route and emphasized Pix-entry presentation.
- `desktop/src/lib/project-entry-emphasis.test.ts` covers canonical entry matching
  and excluded/unknown paths.
- `desktop/src/components/project-explorer-operations.test.ts` covers independent
  mutations during deferred deletion, ancestor/destination conflicts, partially
  copied output protection, out-of-order completion and workspace/teardown invalidation.
- `desktop/src/components/project-explorer-tree-controller.test.ts` covers deferred
  row focus after workspace replacement, teardown and changed focus intent,
  lazy reverse navigation, pending-list reuse, missing targets and newer reveals,
  descendant expansion reset on parent/root collapse, persistence and sibling preservation.
- `desktop/src/app/preview.test.ts` covers directory-link routing without Preview
  changes and stale classification cancellation.
- `desktop/src/lib/native-context-menu.test.ts` covers captured tab reveal actions
  and remote-link actions for project Markdown links.
- `desktop/src-tauri/src/project_directory_link.rs` tests directory confinement,
  file/missing-path rejection and symbolic-link rejection.
- `desktop/src/components/project-explorer-menu-controller.test.ts` covers
  measured browser-menu bounds, content growth, keyboard anchoring, stale focus
  work, observer teardown and native host routing/cancellation.
- `desktop/src/lib/project-explorer-native-menu.test.ts` covers shared command
  policy, awaited eligibility, OS coordinates, serialized registration, stale
  callbacks, error reporting and idempotent resource release.
- `desktop/src/lib/project-entry-clipboard.test.ts` covers shared references,
  format/path validation, cross-project eligibility, text replacement, failures,
  out-of-order reads and teardown. Native project-entry/copy tests cover recursive
  cross-workspace copying, preserved source contents, collision naming, exclusive
  target creation, unsafe destinations and canonical self/descendant rejection.
- Native `git_ignore` tests cover real Git eligibility, literal rules, nested
  ignore files, append preservation, tracked files/folders with unchanged index
  contents, and unsafe paths.
- `desktop/src/lib/project-git-ignore.test.ts` covers stale menu/workspace/status
  reads, teardown invalidation, stable visibility during repeated status refreshes
  and non-repository failures.
- `desktop/src/lib/project-git-decorations.test.ts` covers staged/working-tree status, conflicts, ancestor aggregation, rename/copy semantics, and clearing snapshots; `desktop/src/lib/project-git-refresh.test.ts` covers polling, request coalescing, failed reads, and in-flight teardown.
- `desktop/src/components/WorkspaceSidebar.test.ts` covers Activity Bar composite
  wiring.
- Native project-search tests cover path/content hits, case-insensitive ASCII
  matching, ignored dependency directories, and empty queries. The binary-file
  fixture is not paired with an explicit binary-skipping assertion; that coverage
  remains a gap. Project Explorer source tests pin the search command, shortcut,
  bounded result UI, and matched-line Preview navigation.
- `npm --prefix desktop test`
- `npm --prefix desktop run check`
- `npm --prefix desktop run build:web`

<!-- pix:wiki-check {"version":1,"status":"attempted","runId":"19234a89-390d-4a92-841c-d7eb9a972182","contentHash":"a80b4aa41073465289d4fdd5cd2bb6f6a8e860f89ad06ea28eacdc258659ce36","checkedAt":"2026-10-31T11:11:16.236Z","maxDocumentChars":128000} -->
