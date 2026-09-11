# Desktop sidebar indicators

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Make the Workspace Activity Bar a compact live health/status rail. Every activity destination may expose one small semantic attention dot without turning the rail into a badge dashboard or requiring every panel to stay mounted.

## Scope

- Centralize Activity Bar indicator policy for Project, Tasks, Source Control, Registry, Package Scripts, IDX, and Settings.
- Use a cheap workspace poll for filesystem/config/Git/runtime state that exists outside the currently mounted panel.
- Reuse already-pushed Registry state and backend terminal/IDX events instead of polling those systems again.
- Distinguish persistent conditions from unseen failure events.
- Keep indicator reasons available through the activity button title/accessibility label.

## Non-goals

- Showing counts in Activity Bar badges. In particular, Source Control does not display a changed-file count.
- Polling remote Registry state independently from the active ACP session.
- Running full Git diff/stat/branch discovery merely to decide whether a dot is needed.
- Running IDX health commands at the same cadence as the lightweight workspace poll.
- Treating the existence of ordinary project tasks or an uninitialized optional IDX project as an error by itself.

## Indicator language

- Every signal uses the same small circular marker at the same position on its Activity Bar button.
- `info` uses the semantic tool-info color for active/dirty state that is useful but not unhealthy.
- `warning` uses tool-warning for state that needs user review or input.
- `error` uses tool-error for failed, conflicted, unreadable, or invalid state.
- When several conditions apply, severity order is `error > warning > info` and only one dot is rendered.
- No normal/healthy state renders a dot.

## Signals by activity view

- **Project** — error only when the workspace/project tree cannot be read. A populated project is not attention by itself.
- **Tasks** — info while a project task is actively being run; error after project-task storage read/write failure. Merely having todo items does not light the Activity Bar.
- **Source Control** — info for a dirty working tree, commits ahead of upstream, or a branch behind upstream; warning for detached HEAD; error for unresolved conflicts or Git status failure. Changed-file counts are never rendered in the rail.
- **Registry** — warning for existing Registry attention (`update-available`, `missing-local`, `diverged`, `registry-changed`) or project-level review issues; error for a Registry snapshot error. Registry freshness continues to arrive through ACP session-state notifications/actions.
- **Package Scripts** — info while one or more package/shell terminals are running; error for a newly observed failed terminal or non-zero exit, or for package-script discovery errors. A failure event is acknowledged once the Scripts view is visible.
- **IDX** — info while maintenance is running; warning when current/proposed knowledge needs semantic maintenance; error for failed/timed-out maintenance, IDX health/status errors, or IDX becoming unavailable for a project that is already initialized. Failed-operation attention is acknowledged once the IDX view is visible.
- **Settings** — error when either supported user config is unreadable, malformed JSONC, schema-invalid, or the mounted Settings editor reports a load/save/validation error. Missing optional user config files are healthy.

## Polling and invalidation

- The frontend owns one `SidebarIndicatorService` per Desktop window/workspace sidebar.
- The fast backend poll runs approximately every 5 seconds while the window is visible/focused and every 30 seconds in the background. It returns Project, lightweight Git, terminal runtime, IDX-operation runtime, and user-config health in one typed IPC snapshot.
- Fast Git status uses a dedicated bounded porcelain-v2 branch/status probe only. It disables optional Git locks and fsmonitor, retains bounded output, and kills the probe after 5 seconds instead of allowing the Activity Bar service to hang behind a stuck filesystem hook. It does not calculate per-file numstat, local branch lists, or remotes.
- Package-terminal and IDX-operation state are read from the existing in-memory backend registries; no subprocess is started for those checks.
- Package-terminal and IDX **exit** events always invalidate the fast snapshot. Output events invalidate only until that runtime id is already known as running; ordinary terminal/log output does not turn a noisy process into a sub-second Git/config polling loop.
- Existing full Git refreshes triggered by Pix mutations invalidate the fast indicator snapshot immediately. External Git changes are discovered by the next fast poll.
- Registry state, task execution state, Project Explorer read errors, and mounted Settings errors flow reactively from their existing owners and do not require extra filesystem polling. Session todo/Subagent state is intentionally presented in session tabs/status chrome/the contextual inspector rather than in the workspace Activity Bar.
- IDX overview/knowledge health has a separate approximately 60-second foreground / 180-second background cadence because it invokes IDX. Both the shared service and mounted IDX panel coalesce refreshes to at most one in-flight request plus one queued refresh. While the IDX view is mounted, its own idle overview refresh is reused instead of issuing duplicate health commands; workspace/generation guards prevent a late background response from overwriting newer panel state.
- Refocusing or making the window visible triggers an immediate refresh.

## Persistent versus unseen state

- Persistent conditions such as dirty Git, knowledge drift, invalid configs, and active processes remain visible until the underlying condition clears.
- Terminal and IDX-operation failures are treated as unseen events: they attract attention while another view is active and are acknowledged when their owning view is shown.
- Failure acknowledgements are scoped to the current Desktop process/window and workspace. They are not persisted to disk.

## Backend safety and cost

- `workspace_sidebar_indicator_poll` runs through the existing blocking-task boundary so filesystem and Git work never blocks the WebView/UI thread.
- Workspace paths are canonicalized before inspection. Source Control retains the existing rule that the selected workspace must itself be the Git repository root.
- User config paths resolve from the platform home to `.config/pi/pix.jsonc` and `.config/pi/pi-tools-suite.jsonc`, matching the config loader/editor contract.
- User config health checks preserve JSONC support and validate the schema subset used by the Desktop settings editor without modifying files. Config reads/polls share a read lock while saves take the write lock, preventing the poll from observing the editor's truncate/write window; the config lock is released before Git/runtime state is inspected.
- Package-terminal and IDX registry mutexes are used only to copy/update in-memory state. Rejected child processes are killed/reaped after releasing those registries, PTY resize uses a separate per-terminal master lock, and Stop never waits indefinitely for a busy stdin writer before reaching its process-tree kill path.
- Poll failures are represented as indicator health instead of crashing or disabling unrelated views.

## Related files

- `desktop/src/components/WorkspaceSidebar.svelte`
- `desktop/src/components/SidebarIndicatorDot.svelte`
- `desktop/src/components/ProjectExplorer.svelte`
- `desktop/src/components/SettingsPanel.svelte`
- `desktop/src/lib/sidebar-indicators.ts`
- `desktop/src/lib/sidebar-indicators.test.ts`
- `desktop/src/App.svelte`
- `desktop/src-tauri/src/lib.rs`

## Verification

- TypeScript tests cover severity precedence, Git dirty/conflict semantics, runtime failure precedence, output-event throttling, and healthy/error Project/Settings states.
- Rust tests cover the lightweight dirty-Git indicator, rename-record parsing, and JSONC/schema-invalid user-config health.
- Run `npm --prefix desktop test`, `npm --prefix desktop run check`, `npm --prefix desktop run build:web`, and the Desktop Tauri Rust unit tests.

## Evidence

- Confirmed by code: the Activity Bar consumes one indicator map and one shared dot component rather than tab-specific badge markup.
- Confirmed by code: fast polling uses one typed Tauri command, while terminal/IDX events and existing ACP/session state provide push invalidation where available.
- Confirmed by tests: frontend policy helpers and backend polling helpers cover the highest-risk severity, unseen-failure, Git-cost, and config-validation behavior.
