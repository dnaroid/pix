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
- Use a cheap workspace poll for filesystem/config/local-Git/runtime state that exists outside the currently mounted panel, plus a separate sparse remote-Git freshness probe that never turns the fast poll into network work.
- Reuse already-pushed remote Registry state and backend terminal/IDX events; detect local Registry dirtiness inside the shared indicator service without running Registry Git/network work.
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

## Activity Bar keyboard contract

- The Workspace Activity Bar is one vertical `toolbar` composite rather than
  seven unrelated Tab stops.
- The currently remembered workspace view owns the toolbar's roving Tab stop,
  including when its panel is collapsed.
- ArrowUp/ArrowDown move focus between Project, Tasks, Source Control, Registry,
  Package Scripts, IDX, and Settings; Home/End move to the bounds and movement
  wraps at the rail ends.
- Moving keyboard focus does not activate or expand a view. Enter/Space/click
  retains the existing `selectTab` behavior, including collapsing the current
  panel when its active button is invoked again.
- Indicator tone/reason and `aria-pressed` selection remain independent from the
  temporary keyboard-focus position.

## Indicator quick actions

Decision: [0027 — Cause-specific sidebar quick actions](../docs/decisions/0027-sidebar-reason-actions.md).

- Right-click on an Activity Bar icon with a dot opens a component-owned context
  menu for **all current reasons**, not a generic section menu and not only the
  highest-priority reason shown in the tooltip. Without a dot there is no menu.
  Left-click behavior remains unchanged.
- Work commands (reload/retry, Fetch, Push, AI repair/review and commit/push) do
  not switch or expand sidebar panels. Only explicit inspection/navigation actions
  open a view. Project-file retry also checks the root while the explorer is absent;
  stale workspace, superseded or disposed results cannot update project health.
- Stable reason/command IDs are independent of tooltip wording. Each cause is
  labelled in the menu; repeated reports of the same cause share one command group.
- Dirty knowledge offers **AI review** through the existing new-session workflow;
  a stale index instead offers index maintenance. Neither command acknowledges
  knowledge or starts indexing automatically.
- Git offers status retry, failed-CI inspection/AI repair, conflict/change review,
  branch controls for detached HEAD, Fetch for upstream updates, Push for outgoing
  commits, and incoming-change controls for behind-upstream state. Commands reuse
  existing Git owners and eligibility guards; unsafe Push is disabled.
  Dirty working-tree changes additionally offer **Stage all, AI commit & push**:
  explicitly stage every change, generate the message, commit and push under one
  Git mutation lock. The command leaves the current panel/collapsed state unchanged
  and is available before Source Control has ever been opened. Unavailable AI,
  busy Git or known unsafe publication disable it; an unloaded full Git snapshot
  is checked by the transaction's fresh preflight, not a reason to disable the menu.
  Progress and failure details remain available in Source Control on request. See
  [Git workflow safety](desktop-git-workflows.md) for freshness and partial-success behavior.
- Tasks offer load retry, planned-task view, or opening the running task's linked
  session. Project errors offer tree reload. Registry reasons offer retry or the
  existing resource-review/sync controls. Terminal and IDX failures/activity open
  their output/maintenance views; settings errors open configuration controls.
- AI, busy, unavailable and unsafe actions are disabled using current capabilities;
  activation rechecks current reasons and guards. A reason clearing removes its
  commands; no remaining reasons, workspace switch, blur, resize or teardown closes
  the menu. Partial reason removal or command eligibility changes also dismiss the
  popup and return focus to its trigger, avoiding focus stranded on removed or
  disabled commands. Git eligibility includes active resolution startup; IDX AI
  review is disabled during locally observed or backend-reported maintenance.
  Local maintenance observations hand off to the sidebar service: panel teardown
  cannot clear busy state. A successful poll started after that observation
  transfers ownership to the backend snapshot; stale or failed polls cannot
  release the guard, and workspace changes discard the old workspace's handoff.
  Navigation reveals the owning view without collapsing an already-open
  panel. Actions that perform work reuse existing callbacks, not polling side effects.
- Shift+F10 / ContextMenu opens the same menu from the focused icon. Initial focus,
  ArrowUp/Down, Home/End and printable typeahead skip disabled items; Enter/Space
  activate the focused command. Escape restores icon focus, Tab dismisses and
  continues focus traversal, and outside pointer input dismisses the menu.

## Signals by activity view

- **Project** — error only when the workspace/project tree cannot be read. A populated project is not attention by itself.
- **Tasks** — info for planned (`todo`) project tasks or an active task action; error after project-task storage read/write failure. Completed/backlog tasks alone do not light the Activity Bar.
- **Source Control** — info for a dirty working tree, commits ahead of upstream, a locally-known branch behind upstream, or a remote upstream tip that differs from the local tracking ref even before a fetch; warning for detached HEAD; error for current-HEAD CI failure, unresolved conflicts or local Git status failure. Any failed ready CI run is an error even while another run is running. Remote-probe network/auth failures are best-effort and do not create an error dot. Changed-file counts are never rendered in the rail.
- **Registry** — warning when the indicator service detects local reusable/project resources that differ from their recorded provenance or are local-only while Registry is configured. Remote-side attention (`update-available`, `missing-local`, `diverged`, `registry-changed`) and project-level review issues continue to come from the pushed ACP Registry snapshot. While Desktop background project-state sync is pending, the Registry dot is `info`; while a sync is actively running the same dot uses a motion-safe ping animation. A background sync failure uses error severity. Optional remote-only resources (`not-installed`) remain a normal catalog state and do not light the Activity Bar. Registry snapshot or local-indicator health failures use error severity.
- **Package Scripts** — info while one or more package/shell terminals are running; error for a newly observed failed terminal or non-zero exit, or for package-script discovery errors. A failure event is acknowledged once the Scripts view is visible.
- **IDX** — info while maintenance is running; error for failed/timed-out maintenance, IDX health/status errors, or IDX becoming unavailable for a project that is already initialized. Otherwise explicit knowledge dirtiness or index-revision mismatch uses warning. Legacy knowledge counters do not establish semantic drift and never trigger an inferred warning. Failed-operation attention is acknowledged once the IDX view is visible.
- **Settings** — error when either supported user config is unreadable, malformed JSONC, schema-invalid, or the mounted Settings editor reports a load/save/validation error. Missing optional user config files are healthy.

## Polling and invalidation

- The frontend owns one `SidebarIndicatorService` per Desktop window/workspace sidebar.
- The fast backend poll runs approximately every 5 seconds while the window is visible/focused and every 30 seconds in the background. It returns Project, lightweight Git, terminal runtime, IDX-operation runtime, and user-config health in one typed IPC snapshot.
- Fast Git status uses a dedicated bounded porcelain-v2 branch/status probe only. It disables optional Git locks and fsmonitor, retains bounded output, and kills the probe after 5 seconds instead of allowing the Activity Bar service to hang behind a stuck filesystem hook. It does not calculate per-file numstat, local branch lists, or remotes.
- Remote Git freshness has a separate approximately 60-second foreground / 5-minute background cadence. It resolves the current branch's configured upstream locally, then runs only `git ls-remote` for that one upstream ref and compares the returned SHA with the existing local tracking-ref SHA. It does **not** run `git fetch`, download the remote object graph, update refs, or touch the working tree. Refocus/visibility refreshes are rate-limited to at most one remote attempt per 30 seconds so repeatedly switching windows cannot create a network loop.
- The remote probe coalesces concurrent invalidations to at most one in-flight request plus one queued retry and is guarded by workspace/generation checks. Network, authentication, timeout, or provider failures leave the last successful remote-freshness result in place and never block or fail the local fast poll. A branch/upstream change forces one fresh probe; otherwise a successful Pix-owned Git refresh immediately rechecks remote freshness only while an update dot is already active, so Fetch/Update project can clear the dot promptly without adding network work to ordinary local Git mutations.
- Current-HEAD CI status reuses the sparse remote lane while Git is closed, with no job-detail queries or separate background timer. The visible Git panel keeps its own cadence; its store skips sidebar requests while active/in-flight. Unavailable setup states do not busy-poll. Job caches retain only runs in the current snapshot; late results for removed runs are discarded.
- Package-terminal and IDX-operation state are read from the existing in-memory backend registries; no subprocess is started for those checks.
- Package-terminal and IDX **exit** events always invalidate the fast snapshot. Output events invalidate only until that runtime id is already known as running; ordinary terminal/log output does not turn a noisy process into a sub-second Git/config polling loop.
- Existing full Git refreshes triggered by Pix mutations invalidate the fast indicator snapshot immediately. External local Git changes are discovered by the next fast poll; external remote-only branch advances are discovered by the sparse remote probe.
- Pushed Registry refresh/action snapshots likewise invalidate the fast poll so a completed sync clears/recomputes the local Registry dot immediately; the pushed snapshot is only an invalidation signal for this local check, not the source of local dirtiness.
- The fast Registry poll also returns the specific dirty project artifacts among
  `tasks`, `plans`, and `todo`. WorkspaceSidebar consumes each new fast-poll
  `checkedAtMs` at most once and feeds its dirty artifact list into the same
  Desktop background sync coordinator used by direct saves. Desktop always
  reloads the matching local renderer state when a new poll reports a change:
  `tasks` reloads the task document, while `plans` and `todo` reload the
  project-document snapshot used by Registry plan selection. A new background
  push is scheduled only while the coordinator is idle, so pending/syncing/error
  phases do not create duplicate pushes or prevent the local UI from reflecting
  filesystem changes. A later poll can still detect a second external change to
  the same artifact without requiring an intermediate clean artifact set.
- Remote Registry state, task execution state, Project Explorer read errors, and mounted Settings errors flow reactively from their existing owners. The fast indicator poll additionally performs a local-only Registry check over `.pi/registry.json`, reusable resources, and project artifacts; it never fetches/clones the Registry or runs Registry Git commands. Session todo/Subagent state is intentionally presented in session tabs/status chrome/the contextual inspector rather than in the workspace Activity Bar.
- IDX overview health has a separate approximately 60-second foreground / 180-second background cadence because it invokes IDX. Both the shared service and mounted IDX panel coalesce refreshes to at most one in-flight request plus one queued refresh. While the IDX view is mounted, its own idle overview refresh is reused instead of issuing duplicate health commands; workspace/generation guards prevent a late background response from overwriting newer panel state.
- Refocusing or making the window visible triggers immediate local refresh; IDX health attempts, like remote Git, are rate-limited to at most once per 30 seconds.
- Initialized IDX health runs read-only `idx knowledge dirty` (5 seconds, 4 KiB). Only complete exit-0 `yes`/`no` is a verdict; incomplete/malformed/truncated results and timeouts are errors, not clean. Older CLIs without the command remain unknown. Polling never acknowledges specs.
- Index staleness warns conservatively when a valid indexed Git revision differs from current HEAD. Matching HEAD does not prove freshness of uncommitted edits. Indicator polling never starts dry-run, indexing or embedding work.
- Local Registry verification is metadata-first and cached per workspace/resource. Unchanged fingerprints reuse the previous hash verdict; only cache misses or metadata changes read file contents, with a bounded content-hash budget per fast poll so initial verification is amortized instead of turning the 5-second service into a filesystem scan storm.
- The `tasks` fast-poll hash follows the portable Registry task-bundle hash rather
  than hashing `tasks.jsonc` alone: local markers are normalized to portable
  attachment names and referenced `.pi/task-attachments` bytes participate in
  the comparison. Attachment-only task changes therefore become observable
  project dirtiness without leaving a permanent false-positive after sync.
- Registry provenance/config reads use stable before/after file stamps, and content hashing verifies the metadata fingerprint again before publishing. If a write races a poll, the backend marks that Registry sample unstable and the frontend keeps the last stable Registry indicator until a later poll completes, preventing stale-result flicker without locking Registry writes.
- Registry cache entries are pruned against current provenance and capped per workspace; resource churn cannot retain an unbounded history of hashes.

## Persistent versus unseen state

- Persistent conditions such as dirty Git, invalid configs, and active processes remain visible until the underlying condition clears.
- Registry background-sync presentation orders remote/error attention above
  active syncing, active syncing above ordinary pending dirtiness, and healthy
  state last. The ping animation is purely transient and honors reduced-motion
  styling.
- While a background Registry RPC is actively syncing, Registry-panel action
  controls are disabled even though the Desktop-wide foreground operation lock
  remains free. This prevents overlapping manual Registry commands without
  blocking unrelated workspace interaction.
- Terminal and IDX-operation failures are treated as unseen events: they attract attention while another view is active and are acknowledged when their owning view is shown.
- Failure acknowledgements are scoped to the current Desktop process/window and workspace. They are not persisted to disk.

## Backend safety and cost

- `workspace_sidebar_indicator_poll` runs through the existing blocking-task boundary so filesystem, bounded Registry hashing, and Git work never blocks the WebView/UI thread.
- `workspace_git_remote_update_probe` uses the same blocking-task boundary. Its single network command is non-interactive, limits stdout/stderr to 64 KiB each, has a 5-second hard deadline, and kills the isolated Git process group on timeout/error. The probe is read-only with respect to the repository: no fetch, ref update, index lock, or working-tree mutation is performed.
- Workspace paths are canonicalized before inspection. Source Control retains the existing rule that the selected workspace must itself be the Git repository root.
- User config paths resolve from the platform home to `.config/pi/pix-desktop.jsonc` and `.config/pi/pi-tools-suite.jsonc`, matching the config loader/editor contract. TUI `.config/pi/pix.jsonc` is intentionally excluded from Desktop settings health.
- User config health checks preserve JSONC support and validate the schema subset used by the Desktop settings editor without modifying files. Config reads/polls share a read lock while saves take the write lock, preventing the poll from observing the editor's truncate/write window; the config lock is released before Git/runtime state is inspected.
- Package-terminal and IDX registry mutexes are used only to copy/update in-memory state. Rejected child processes are killed/reaped after releasing those registries, PTY resize uses a separate per-terminal master lock, and Stop never waits indefinitely for a busy stdin writer before reaching its process-tree kill path.
- Poll failures are represented as indicator health instead of crashing or disabling unrelated views.

## Related files

- `desktop/src/components/WorkspaceSidebar.svelte`
- `desktop/src/components/SidebarIndicatorDot.svelte`
- `desktop/src/components/ProjectExplorer.svelte`
- `desktop/src/components/SettingsPanel.svelte`
- `desktop/src/lib/sidebar-indicators.ts`
- `desktop/src/lib/sidebar-indicator-types.ts`
- `desktop/src/lib/sidebar-indicator-policy.ts`
- `desktop/src/lib/sidebar-indicator-service.ts`
- `desktop/src/lib/sidebar-indicators.test.ts`
- `desktop/src/lib/sidebar-indicator-service.test.ts`
- `desktop/src/app/git-ci.svelte.ts`
- `desktop/src/app/git-ci.test.ts`
- `desktop/src/lib/git-ci.ts`
- `desktop/src/lib/idx.ts`
- `desktop/src/components/WorkspaceSidebarActivityBar.svelte`
- `desktop/src/components/SidebarIndicatorMenu.svelte`
- `desktop/src/components/sidebar-indicator-menu-controller.svelte.ts`
- `desktop/src/components/sidebar-indicator-menu-controller.test.ts`
- `desktop/src/components/workspace-sidebar-indicator-actions.ts`
- `desktop/src/components/workspace-sidebar-indicator-actions.test.ts`
- `desktop/src/lib/sidebar-indicator-actions.ts`
- `desktop/src/lib/sidebar-indicator-actions.test.ts`
- `desktop/src-tauri/src/lib.rs`

## Verification

- TypeScript tests cover severity precedence, Git dirty/conflict semantics, remote-upstream attention before fetch, local Registry sync attention, unstable Registry-sample retention, runtime failure precedence, output-event throttling, and healthy/error Project/Settings states.
- Rust tests cover the lightweight dirty-Git indicator, rename-record parsing, a real bare-remote advance detected by `ls-remote` without mutating local tracking refs, local Registry tracked/local-only detection and hash compatibility, and JSONC/schema-invalid user-config health.
- Deterministic tests cover planned-task/CI/explicit IDX policy, workspace-stale responses, coalescing, late subscription teardown, sparse focus cadence and mounted IDX reuse. Rust tests cover Registry cache churn, explicit knowledge verdicts, conservative revision mismatch and inherited-pipe descendant cleanup.
- Quick-action tests cover all reason mappings, simultaneous reasons, no healthy-state menu, capability disabling, focus navigation/typeahead/dismissal and late-open cancellation.
- Activation tests reject workspace-stale, cleared-reason and newly disabled commands; review invokes the existing callback, while inspection uses reveal, not toggle.
- Run `npm --prefix desktop test`, `npm --prefix desktop run check`, `npm --prefix desktop run build:web`, and the Desktop Tauri Rust unit tests.

## Evidence

- Confirmed by code: the Activity Bar consumes one indicator map and one shared dot component rather than tab-specific badge markup.
- Confirmed by code: fast polling uses one typed Tauri command, while terminal/IDX events and existing ACP/session state provide push invalidation where available.
- Confirmed by tests: frontend policy helpers and backend polling helpers cover the highest-risk severity, unseen-failure, Git-cost, and config-validation behavior.

## Decision

[Sparse read-only sidebar health](../docs/decisions/0025-sidebar-health-polling.md).
