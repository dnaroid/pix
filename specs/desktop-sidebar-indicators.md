---
kind: spec
status: active
---

# Desktop sidebar indicators

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Make the Workspace Activity Bar a compact live health/status rail. Warning and error states color the destination icon without extra dots or badges or requiring every panel to stay mounted.

## Scope

- Centralize Activity Bar indicator policy for Project, Tasks, Source Control, Registry, Package Scripts, Search indexes, and Settings.
- Use a cheap workspace poll for filesystem/config/local-Git/runtime state that exists outside the currently mounted panel, plus a separate sparse remote-Git freshness probe that never turns the fast poll into network work.
- Reuse already-pushed remote Registry state and backend terminal events; detect local Registry dirtiness inside the shared indicator service without running Registry Git/network work. Search indexes reuse their workspace-owned read-only monitor.
- Distinguish persistent conditions from unseen failure events.
- Keep indicator reasons available through the activity button title/accessibility label.

## Non-goals

- Showing counts in Activity Bar badges. In particular, Source Control does not display a changed-file count.
- Polling remote Registry state independently from the active ACP session.
- Running full Git diff/stat/branch discovery merely to decide whether an indicator is needed.
- Running indexing or embedding work to decide whether a search indicator is needed.
- Treating the existence of ordinary project tasks or absent search indexes as an error by itself.

## Indicator language

- No Activity Bar dots or ping animations are rendered.
- `info` and normal/healthy states leave the icon neutral; reasons remain in the title and accessibility label.
- `warning` colors the icon with tool-warning for state that needs user review or input.
- `error` colors the icon with tool-error for failed, conflicted, unreadable, or invalid state.
- When several conditions apply, severity order is `error > warning > info`.
- Selection remains independent: the active view keeps its left stripe and background, including when its icon is status-colored.

## Activity Bar keyboard contract

- The Workspace Activity Bar is one vertical `toolbar` composite rather than
  eight unrelated Tab stops.
- The currently remembered workspace view owns the toolbar's roving Tab stop,
  including when its panel is collapsed.
- ArrowUp/ArrowDown move focus between Project, Tasks, Source Control, Registry,
  Package Scripts, Search indexes, LSP, and Settings; Home/End move to the bounds and
  movement wraps at the rail ends.
- Moving keyboard focus does not activate or expand a view. Enter/Space/click
  retains the existing `selectTab` behavior, including collapsing the current
  panel when its active button is invoked again.
- Indicator tone/reason and `aria-pressed` selection remain independent from the
  temporary keyboard-focus position.

## Indicator quick actions

Decision: [0027 — Cause-specific sidebar quick actions](../docs/decisions/0027-sidebar-reason-actions.md).

- Right-click on an Activity Bar icon with a current indicator opens a
  component-owned context menu for **all current reasons**, not a generic
  section menu and not only the highest-priority reason shown in the tooltip.
  Informational indicators remain actionable despite their neutral icon.
  Without an indicator there is no menu. Left-click behavior remains unchanged.
- Work commands (reload/retry, Fetch, Push, AI repair/review and commit/push) do
  not switch or expand sidebar panels. Only explicit inspection/navigation actions
  open a view. Project-file retry also checks the root while the explorer is absent;
  stale workspace, superseded or disposed results cannot update project health.
- Stable reason/command IDs are independent of tooltip wording. Each cause is
  labelled in the menu; repeated reports of the same cause share one command group.
- Search-index reasons offer **Inspect search indexes**; navigation never starts
  indexing or acknowledges knowledge. Manual indexing remains a panel action.
- Git offers status retry, failed-CI inspection/AI repair, conflict/change review,
  branch controls for detached HEAD, Fetch for upstream updates, Push for outgoing
  commits, and incoming-change controls for behind-upstream state. Commands reuse
  existing Git owners and eligibility guards; unsafe Push is disabled.
  Dirty working-tree changes additionally offer **Stage all, AI commit & push**:
  explicitly stage every change, generate the message, commit and push under one
  Git mutation lock. The command leaves the current panel/collapsed state unchanged
  and does not require navigating to Source Control to run. Without a confirmed
  remote (including while status is unloaded), the same command is labelled
  **Stage all, AI commit** and only stages, generates and commits locally; it
  never pushes, even if fresh status later discovers a remote. Standalone Push
  is omitted without a confirmed remote. Local review remains available.
  Unavailable AI, busy Git or conflicts disable the combined command; publication
  guards additionally apply when pushing is requested.
  Progress and failure details remain available in Source Control on request. See
  [Git workflow safety](desktop-git-workflows.md) for freshness and partial-success behavior.
- Tasks offer load retry, planned-task view, or opening the running task's linked
  session. Project errors offer tree reload. Registry reasons offer retry or the
  existing resource-review/sync controls. Local Registry changes additionally offer
  **Sync project changes to Registry** for all installed Project-scope skills/agents
  with `local-changes`, excluding Global publications and unsafe states. The action
  performs a fresh backend selection without requiring a panel visit, leaves panels
  unchanged, and is disabled during Registry loading, foreground/background actions
  or known missing configuration/project identity. Snapshot project-resource edits
  also expose this reason before the lightweight local poll catches up. See
  [Registry publication scope and tags](resource-registry-publication-tags.md).
  Terminal failures/activity open their output view; search-index attention opens
  Search indexes; settings errors open configuration controls.
- AI, busy, unavailable and unsafe actions are disabled using current capabilities;
  activation rechecks current reasons and guards. A reason clearing removes its
  commands; no remaining reasons, workspace switch, blur, resize or teardown closes
  the menu. Partial reason removal or command eligibility changes also dismiss the
  popup and return focus to its trigger, avoiding focus stranded on removed or
  disabled commands. Git eligibility includes active resolution startup.
  Navigation reveals the owning view without collapsing an already-open
  panel. Actions that perform work reuse existing callbacks, not polling side effects.
- Shift+F10 / ContextMenu opens the same menu from the focused icon. Initial focus,
  ArrowUp/Down, Home/End and printable typeahead skip disabled items; Enter/Space
  activate the focused command. Escape restores icon focus, Tab dismisses and
  continues focus traversal, and outside pointer input dismisses the menu.

## Signals by activity view

- **Project** — error only when the workspace/project tree cannot be read. A populated project is not attention by itself.
- **Tasks** — info for planned (`todo`) project tasks or an active task action; error after project-task storage read/write failure. Completed/backlog tasks alone do not light the Activity Bar.
- **Source Control** — info for a dirty working tree, commits ahead of upstream, a locally-known branch behind upstream, or a remote upstream tip that differs from the local tracking ref even before a fetch; warning for detached HEAD; error for current-HEAD CI failure, unresolved conflicts or local Git status failure. Any failed ready CI run is an error even while another run is running. Remote-probe network/auth failures are best-effort and do not create an error indicator. Changed-file counts are never rendered in the rail.
- **Registry** — warning when the indicator service detects local reusable/project resources that differ from their recorded provenance or are local-only while Registry is configured. Remote-side attention (`update-available`, `missing-local`, `diverged`, `registry-changed`) and project-level review issues continue to come from the pushed ACP Registry snapshot. While Desktop background project-state sync is pending or active, Registry retains an informational reason; active-sync metadata is retained for policy consumers, but the Activity Bar does not animate or color the neutral icon for info. A background sync failure uses error severity. Optional remote-only resources (`not-installed`) remain a normal catalog state and do not color the Activity Bar icon. Registry snapshot or local-indicator health failures use error severity.
- **Package Scripts** — info while one or more package/shell terminals are running; error for a newly observed failed terminal or non-zero exit, or for package-script discovery errors. A failure event is acknowledged once the Scripts view is visible.
- **Search indexes** — error for read/source/manual indexing failures; informational metadata for a manual run or source-specific reported background activity is retained, but the rail does not animate or color the neutral icon for info; warning for missing/partial local indexes, incompatible caches, unavailable configured credentials, missing vectors unless the local corpus is known empty, and partial/stopped manual runs. Errors take precedence over activity; during activity pending causes remain available but use info severity without masking the icon's warning/error tone. Ordinary diagnostic polling never means indexing. Unknown state, disabled semantics alone and stored vector counts do not establish incomplete coverage or freshness. See [Search index status](desktop-search-index-status.md).
- **Settings** — error when either supported user config is unreadable, malformed JSONC, schema-invalid, or the mounted Settings editor reports a load/save/validation error. Missing optional user config files are healthy.

## Polling and invalidation

- The frontend owns one `SidebarIndicatorService` per Desktop window/workspace sidebar.
- The fast backend poll runs approximately every 5 seconds while the window is visible/focused and every 30 seconds in the background. It returns Project, lightweight Git, terminal runtime, and user-config health in one typed IPC snapshot.
- Fast Git status uses a dedicated bounded porcelain-v2 branch/status probe only. It disables optional Git locks and fsmonitor, retains bounded output, and kills the probe after 5 seconds instead of allowing the Activity Bar service to hang behind a stuck filesystem hook. It does not calculate per-file numstat, local branch lists, or remotes.
- Remote Git freshness has a separate approximately 60-second foreground / 5-minute background cadence. It resolves the current branch's configured upstream locally, then runs only `git ls-remote` for that one upstream ref and compares the returned SHA with the existing local tracking-ref SHA. It does **not** run `git fetch`, download the remote object graph, update refs, or touch the working tree. Refocus/visibility refreshes are rate-limited to at most one remote attempt per 30 seconds so repeatedly switching windows cannot create a network loop.
- The remote probe coalesces concurrent invalidations to at most one in-flight request plus one queued retry and is guarded by workspace/generation checks. Network, authentication, timeout, or provider failures leave the last successful remote-freshness result in place and never block or fail the local fast poll. A branch/upstream change forces one fresh probe; otherwise a successful Pix-owned Git refresh immediately rechecks remote freshness only while an update indicator is already active, so Fetch/Update project can clear it promptly without adding network work to ordinary local Git mutations.
- Current-HEAD CI status reuses the sparse remote lane while Git is closed, with no job-detail queries or separate background timer. The visible Git panel keeps its own cadence; its store skips sidebar requests while active/in-flight. Unavailable setup states do not busy-poll. Job caches retain only runs in the current snapshot; late results for removed runs are discarded.
- Package-terminal state is read from the existing in-memory backend registry; no subprocess is started for those checks.
- Package-terminal **exit** events always invalidate the fast snapshot. Output events invalidate only until that runtime id is already known as running; ordinary terminal/log output does not turn a noisy process into a sub-second Git/config polling loop.
- Git owner snapshots invalidate the fast indicator snapshot through the shared ~180 ms event-refresh debounce only when indicator-relevant state changes: availability/error, branch/HEAD/upstream, detached state, ahead/behind counts, dirty or conflicted state. Identical snapshots and changes only to file details or line counts do not cause another native poll. A direct fast refresh cancels a pending debounce timer. External local Git changes are discovered by the next fast poll; external remote-only branch advances are discovered by the sparse remote probe.
- Pushed Registry refresh/action snapshots likewise invalidate the fast poll so a completed sync clears/recomputes the local Registry dot immediately; the pushed snapshot is only an invalidation signal for this local check, not the source of local dirtiness.
- The fast Registry poll also returns the specific dirty project artifacts among
  `tasks`, `plans`, and `workspace`. WorkspaceSidebar consumes each new fast-poll
  `checkedAtMs` at most once and feeds its dirty artifact list into the same
  Desktop background sync coordinator used by direct saves. Each dirty artifact
  carries a content stamp (`projectStamps`); Desktop reloads the matching local
  renderer state only when that stamp differs from the last observed one (or the
  artifact newly became dirty), while every poll still re-observes sync cheaply:
  `tasks` reloads the task document, while `plans` reloads the plan-document
  snapshot used by Registry plan selection. TODO remains readable/editable as a
  legacy project document but is not a Registry artifact or dirty-sync input.
  A new background push is scheduled only while the coordinator is idle, so pending/syncing/error
  phases do not create duplicate pushes or prevent the local UI from reflecting
  filesystem changes. A later poll can still detect a second external change to
  the same artifact without requiring an intermediate clean artifact set,
  because its stamp changes. Observed stamps reset on workspace switch and are
  dropped when an artifact becomes clean. Tracked artifacts reuse the cached
  verification fingerprint; untracked tasks use SQLite/WAL file stamps (a
  checkpoint may cause one extra reload, never a missed edit).
- Remote Registry state, task execution state, Project Explorer read errors, and mounted Settings errors flow reactively from their existing owners. The fast indicator poll additionally performs a local-only Registry check over canonical `.pi/registry.jsonc` (preferred when present), legacy `.pi/registry.json` only when canonical is absent, reusable resources, and project artifacts; it supports JSONC and never migrates provenance as a read side effect. A migration appearing during a sample invalidates that sample. It never fetches/clones the Registry or runs Registry Git commands. Session todo/Subagent state is intentionally presented in session tabs/status chrome/the contextual inspector rather than in the workspace Activity Bar.
- Search indexes have one workspace/client-scoped controller shared with the panel: quiet diagnostic reads every 30 seconds after settlement when idle, or every 1.5 seconds while indexing. Closing the panel cancels its manual requests but preserves outcomes and the monitor; it does not cancel independent Settings/Tasks background work. Workspace/client replacement disposes the old controller, timers and configuration listener; generation fences reject late completions. Configuration changes reset manual state and refresh diagnostics. Neither the controller nor indicator policy starts indexing without an explicit manual action; the separate Settings/Tasks change-driven synchronizer retains its existing authorization and lifecycle.
- Refocusing or making the window visible triggers immediate local indicator refresh; remote Git attempts remain rate-limited to at most once per 30 seconds. Simultaneous `focus`/`visibilitychange` events do not queue a second fast poll behind an in-flight one.
- Owner invalidations (Git panel snapshots, pushed Registry snapshots, terminal events) share one ~180 ms debounce, so bursts collapse into one fast poll instead of stacking extra IPC/Git work on top of the regular cadence. A scheduled or queued poll still runs after a workspace switch or state change during an in-flight poll.
- The service publishes only when indicator content changes, ignoring poll timestamps, so a steady poll does not re-run derived indicator/menu computation. A poll reporting Registry `projectChanges` is always published because its fresh `checkedAtMs` drives local reload/background sync.
- Local Registry verification is metadata-first and cached per workspace/resource. Unchanged fingerprints reuse the previous hash verdict; only cache misses or metadata changes read file contents, with a bounded content-hash budget per fast poll so initial verification is amortized instead of turning the 5-second service into a filesystem scan storm.
- Agent verification matches ACP's package hash: the Markdown definition plus
  an optional same-named companion directory. Companion presence and all nested
  file metadata participate in the cache fingerprint and before/after stability
  checks; companion bytes and entries count toward the same poll budgets.
  Companion edits/addition/removal remain dirty until synced, while a fully
  synced package clears the local warning. Symlinked or non-directory companions
  fail closed as indicator health errors rather than appearing clean.
- The `tasks` fast-poll hash follows Registry's canonical logical SQLite
  rows/attachment relationships and verified content-addressed blob bytes,
  rather than hashing physical `.pi/tasks.sqlite`/WAL/SHM bytes. A task or
  attachment association change is observable without false positives from
  SQLite checkpoints or page reorganization. Unreferenced blobs do not count.
- Registry provenance/config reads use stable before/after file stamps, and content hashing verifies the metadata fingerprint again before publishing. If a write races a poll, the backend marks that Registry sample unstable and the frontend keeps the last stable Registry indicator until a later poll completes, preventing stale-result flicker without locking Registry writes.
- Registry cache entries are pruned against current provenance and capped per workspace; resource churn cannot retain an unbounded history of hashes.

## Persistent versus unseen state

- Persistent conditions such as dirty Git, invalid configs, and active processes remain visible until the underlying condition clears.
- Registry background-sync policy retains its ordering of remote/error attention
  above active syncing, active syncing above ordinary pending dirtiness, and
  healthy state last. Activity Bar rendering uses only warning/error icon tones;
  it renders no dots or ping animation.
- While a background Registry RPC is actively syncing, Registry-panel action
  controls are disabled even though the Desktop-wide foreground operation lock
  remains free. This prevents overlapping manual Registry commands without
  blocking unrelated workspace interaction.
- Terminal failures are treated as unseen events: they attract attention while another view is active and are acknowledged when their owning view is shown. Search-index failures are not acknowledged by viewing the panel: diagnostics recover on a later successful read, and manual outcomes remain until retry, configuration reset or workspace/client replacement.
- Failure acknowledgements are scoped to the current Desktop process/window and workspace. They are not persisted to disk.

## Backend safety and cost

- `workspace_sidebar_indicator_poll` runs through the existing blocking-task boundary so filesystem, bounded Registry hashing, and Git work never blocks the WebView/UI thread.
- `workspace_git_remote_update_probe` uses the same blocking-task boundary. Its single network command is non-interactive, limits stdout/stderr to 64 KiB each, has a 5-second hard deadline, and kills the isolated Git process group on timeout/error. The probe is read-only with respect to the repository: no fetch, ref update, index lock, or working-tree mutation is performed.
- Workspace paths are canonicalized before inspection. Source Control retains the existing rule that the selected workspace must itself be the Git repository root.
- User config paths resolve from the platform home to `.config/pi/pix-desktop.jsonc` and `.config/pi/pi-tools-suite.jsonc`, matching the config loader/editor contract. TUI `.config/pi/pix.jsonc` is intentionally excluded from Desktop settings health.
- User config health checks preserve JSONC support and validate the schema subset used by the Desktop settings editor without modifying files. Config reads/polls share a read lock while saves take the write lock, preventing the poll from observing the editor's truncate/write window; the config lock is released before Git/runtime state is inspected. Per-file config verdicts and the package.json discovery error are cached by length/mtime stamp (package.json also by resolved path); unchanged files are not re-read or re-validated on each poll, and a stamp that moves during validation is not cached.
- Package-terminal registry mutexes are used only to copy/update in-memory state. Rejected child processes are killed/reaped after releasing those registries, PTY resize uses a separate per-terminal master lock, and Stop never waits indefinitely for a busy stdin writer before reaching its process-tree kill path.
- Poll failures are represented as indicator health instead of crashing or disabling unrelated views.

## Implementation

- `desktop/src/components/WorkspaceSidebar.svelte`
- `desktop/src/components/ProjectExplorer.svelte`
- `desktop/src/components/sidebar-project-retry.ts`
- `desktop/src/components/SettingsPanel.svelte`
- `desktop/src/lib/sidebar-indicators.ts`
- `desktop/src/lib/sidebar-indicator-types.ts`
- `desktop/src/lib/sidebar-indicator-policy.ts`
- `desktop/src/lib/sidebar-indicator-service.ts`
- `desktop/src/app/git-ci.svelte.ts`
- `desktop/src/lib/git-ci.ts`
- `desktop/src/lib/search-index-controller.ts`
- `desktop/src/lib/workspace-search-index-controller.ts`
- `desktop/src/lib/search-index-monitor.ts`
- `desktop/src/lib/search-index-indicators.ts`
- `desktop/src/components/WorkspaceSidebarActivityBar.svelte`
- `desktop/src/components/SidebarIndicatorMenu.svelte`
- `desktop/src/components/sidebar-indicator-menu-controller.svelte.ts`
- `desktop/src/components/workspace-sidebar-indicator-actions.ts`
- `desktop/src/lib/sidebar-indicator-actions.ts`
- `desktop/src-tauri/src/lib.rs`
- `desktop/src-tauri/src/sidebar_registry_resource_hash.rs`
- `desktop/src/app/desktop-sidebar-view-model.svelte.ts`
- `desktop/src/app/registry.svelte.ts`

## Tests

- `desktop/src-tauri/src/lib.rs` (sidebar indicator unit tests)
- `desktop/src-tauri/src/sidebar_registry_resource_hash.rs`
- `desktop/src/lib/sidebar-indicators.test.ts`
- `desktop/src/lib/sidebar-indicator-service.test.ts`
- `desktop/src/app/git-ci.test.ts`
- `desktop/src/components/sidebar-indicator-menu-controller.test.ts`
- `desktop/src/components/workspace-sidebar-indicator-actions.test.ts`
- `desktop/src/lib/sidebar-indicator-actions.test.ts`
- `desktop/src/lib/search-index-controller.test.ts`
- `desktop/src/lib/workspace-search-index-controller.test.ts`
- `desktop/src/lib/search-index-monitor.test.ts`
- `desktop/src/lib/search-index-indicators.test.ts`
- `desktop/src/components/WorkspaceSidebar.test.ts`
- `desktop/src/components/sidebar-project-retry.test.ts`
- `desktop/src/app/registry-store.test.ts`

## Verification

- TypeScript tests cover severity precedence, Git dirty/conflict semantics, remote-upstream attention before fetch, local Registry sync attention, unstable Registry-sample retention, runtime failure precedence, output-event throttling, and healthy/error Project/Settings states.
- Rust tests cover the lightweight dirty-Git indicator, rename-record parsing, a real bare-remote advance detected by `ls-remote` without mutating local tracking refs, local Registry tracked/local-only detection and hash compatibility, and JSONC/schema-invalid user-config health.
- Deterministic tests cover planned-task/CI/search-index policy, workspace-stale responses, coalescing, late subscription teardown, sparse focus cadence and mounted search-index reuse. Rust tests cover Registry cache churn, explicit knowledge verdicts, conservative revision mismatch and inherited-pipe descendant cleanup.
- Quick-action tests cover all reason mappings, simultaneous reasons, no healthy-state menu, capability disabling, focus navigation/typeahead/dismissal and late-open cancellation.
- Activation tests reject workspace-stale, cleared-reason and newly disabled commands; review invokes the existing callback, while inspection uses reveal, not toggle.
- Run `npm --prefix desktop test`, `npm --prefix desktop run check`, `npm --prefix desktop run build:web`, and the Desktop Tauri Rust unit tests.

## Evidence

- Confirmed by code: the Activity Bar consumes one indicator map and applies warning/error tone to destination icons; it renders no dot component.
- Confirmed by code: fast polling uses one typed Tauri command, while terminal events and existing ACP/session state provide push invalidation where available.
- Confirmed by tests: frontend policy helpers and backend polling helpers cover the highest-risk severity, unseen-failure, Git-cost, and config-validation behavior.

## Decision

[Sparse read-only sidebar health](../docs/decisions/0025-sidebar-health-polling.md).
