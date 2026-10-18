# Desktop Work plans navigation

## Behavior

- The workspace sidebar's **Work** destination stacks two accordions in a
  fixed order: **Plans** first, then **Tasks** (no segment switcher). Each
  header is a `<button aria-expanded>` with a state-rotating Lucide
  `ChevronRight` (`data-work-section-toggle`) and a count (`N` plans,
  `N · M done` tasks). Plans is always sized to its content (capped at half the
  panel height while Tasks is open, otherwise at the panel height, then
  scrolls); an open Tasks fills the rest. A collapsed section shrinks to its
  header and stays directly below the section above it, never pinned to the
  panel bottom.
- Accordion state is persisted per project in `.pi/workspace.jsonc` under
  `workPanel.collapsedSections` (ids `plans`, `tasks`; both open when omitted;
  unknown ids retained). Writes preserve comments/sibling settings and share the
  per-workspace compare-and-swap queue with other Desktop view-state writers
  (`app/workspace-config-persistence.ts`). Section bodies render only after the
  state is restored; malformed config keeps defaults and reports
  `frontend:work-panel-state` to the diagnostic logger. The former
  `pix.desktop.work.segment:<workspace>` localStorage key is no longer read.
- The Work header title is **Work** and its activity-bar action is **Work** or
  **Hide Work**. Its subtitle reports `N plans · M tasks`.
- Saved project plans appear in Work → Plans, not in Registry. The Plans accordion uses
  the existing canonical project-document snapshot and works without a
  configured remote registry or ready conversation session. It remains visible
  when empty, showing **No plans yet** with guidance; a non-matching search shows
  **No matching plans**.
- Registry contains only its resource catalog and project status. The
  project-sync **plans** artifact action opens Work, expands the Plans accordion and the
  sidebar if collapsed, and focuses plan search; stale-workspace actions are
  ignored.
- Search matches plan names and paths. Rows wrap file names rather than truncating
  them; a separate directory label distinguishes equally named plans.
- Choosing a plan opens the existing main-workspace Preview tab, leaving the
  Registry list and search intact. Markdown uses Preview's existing rendered
  reading mode and explicit editing controls; no second document viewer is added.
- The selected row follows the actual Preview file, not an optimistic click.
  Failed or stale reads therefore do not falsely select a different plan.
- Each row has separate, keyboard-accessible **Run** (Play) and **Delete** (Trash)
  icon buttons; neither action opens the plan in Preview as a side effect.
  The first line holds the wrapping plan name (`overflow-wrap:anywhere`, never
  truncated) and the two action buttons only; the progress indicator and task
  owner sit on a metadata line under the name, so long names never overlap
  controls. Progress shows a Lucide `FileCheck2` document icon, a compact static
  linear checklist-progress bar, and completed/total text. The bar uses a
  tool-success fill and muted track; it does not animate or invoke an LLM.
  Progress is exposed as an accessible progressbar with completed/total
  value text and `data-plan-checklist-progress`; no native title tooltip is
  shown. Counts describe saved
  Markdown task markers only, not whether gates or Definition of Done passed.
  A plan with no checklist items and unavailable progress both show a dash,
  with distinct accessible labels/tooltips.
  Run creates and activates a new conversation, then sends an instruction to read
  and execute the saved plan at its exact project-relative path. It does not
  create a saved task or consume the current composer draft. Unsaved Preview
  edits are not part of the launched plan. If the plan file disappears while the
  new session is starting, no prompt is sent and the error banner names the
  removed plan. Run requires a ready session service: the button stays
  disabled until the ACP client is initialized and startup restoration of the
  workspace's active session has finished (restoration may replace the active
  session, so an earlier click would be lost). The launch action repeats the
  same guard. Browsing and deletion remain available offline.
- A successful plan launch records `sessionId → plan path` per workspace in
  `localStorage` under `pix.desktop.planLaunches:<workspace>`. Only canonical
  `.pi/plans` paths are retained, with at most the 50 newest launches. Stale or
  reset launches are not recorded.
- Delete confirms the full plan path and warns that deletion and loss of unsaved
  edits cannot be undone. Cancellation leaves the file untouched. Successful
  deletion refreshes the list, closes Preview only if it is showing that plan,
  and schedules normal plans registry synchronization. It waits for pending
  saves and blocks new saves of that plan until deletion completes. Errors retain
  the list entry and use the existing UI/diagnostic error reporting.
- Plan actions reject duplicate launches/deletes. Stale confirmation, runtime
  preparation and completion cannot mutate a different workspace or conversation;
  a session created after launch invalidation is closed instead of activated.
- Search and list scroll survive Plans-panel remounts within the current workspace
  (including switching sidebar panels or closing/reopening the sidebar). Changing
  workspace resets both. Changing search resets list scroll to the top.
- Registry has no plans controls or plan-list props; the Plans accordion is the
  persistent plan navigator. Switching from Registry via the project-sync plans
  action focuses the persistent search.
- Plan buttons support normal keyboard activation and Up/Down/Home/End focus
  movement. Escape clears a nonempty search; the clear button returns focus to it.
- The plan list fills the Work panel height with no 45% height cap or bottom
  border. It is not a floating picker or dialog.
- Plans with a task owner are grouped under **Task plans** and show the task
  label; remaining plans appear under **Plans without a task**. The headings are
  omitted and the list stays flat when no plan has an owner. Ownership is the
  first task, in task order, whose first saved-plan link is that canonical path.
- A task card whose linked plan has a saved checklist with every item checked
  (`total > 0`, `completed >= total`) and whose status is not `done` shows
  **All plan items checked** with a **Mark done** button. The status changes only
  when the user clicks it (same path as the status menu); it is disabled while
  tasks are busy. Plans with no checklist or unavailable progress show no hint.
- An unowned plan offers the Pix searchable **Link to task** picker when eligible
  tasks exist. It lists tasks not marked done and without a plan. Linking saves
  the plan path to the task's `links`; it is rejected for an existing owner or
  task plan, a missing/non-canonical path, or while tasks are saving or failed
  to load. The picker is unavailable when task loading is not safe.
- Each plan row lists up to three recorded runs newest first, with session title
  and launch time; `+N earlier` summarizes older records. Runs whose session is
  no longer present are hidden. Selecting a run opens that session. Records
  come from the workspace's persisted plan-launch map (`planLaunches.sessionsFor`).
- Each run shows a status icon (with screen-reader label): **Running** while
  its start sequence is live (in memory, cleared when the prompt starts) or its
  prompt is in flight; otherwise the latest recorded prompt outcome decides:
  `failed` (prompt error or non-`end_turn`/`cancelled` stop reason) → **Failed**,
  `cancelled` → **Interrupted**, `completed` → **Done** unless the saved
  checklist still has open items (**Interrupted**). Without an outcome (app quit
  mid-run, legacy record) the saved checklist alone decides. Outcomes persist as
  optional `outcome`/`settledAt` in the launch record; malformed values drop only
  the status. A recorded launch whose prompt never starts settles as
  `cancelled` (navigated away) or `failed` (runtime not ready, plan removed,
  error).
- **Resume** appears under the runs only when the newest run is Failed or
  Interrupted and no run of the plan is Running; it shares Run's disabled state.
  It opens a new session with a continuation prompt (inspect partial changes,
  re-verify `[x]` items, continue from the first unchecked item) followed by the
  standard Run prompt, and records a new launch.
- The status-bar plan chip shows the run status and, for the newest resumable
  run of the plan, a **Resume in new session** button with the same readiness
  guard.
- Checklist progress comes from the native `list_project_documents` snapshot's
  `planProgress` map, keyed by plan path and containing `{ completed, total }`
  or `null`. The native parser counts Markdown task markers, including nested,
  ordered and quoted lists, while excluding fenced/indented code, HTML comments
  and metadata. Counts reflect saved files. Unreadable, invalid-UTF-8 or
  oversized files are unavailable. The count snapshot refuses/skips paths that
  are not canonical project paths, including symlink/escaping paths; existing
  plan enumeration may still report a list error for symlinks.
- Progress is refreshed through the existing project-files refresh while the
  Work Plans panel is mounted in the foreground (3-second interval). It
  stops while hidden/unfocused or unmounted; calls do not overlap and owned
  listeners/timers are disposed. There is no new filesystem watcher or runtime
  network dependency. Native counting runs off the UI thread, caches only
  counts/fingerprints by full canonical path, and bounds cache/read work; files
  deferred by a snapshot read budget are retried on the next poll. Unchanged
  versions do not repeat diagnostic failures. Existing document-load generation
  guards prevent stale workspace/reset responses from applying.

## Desktop agent guidance

- The suite registers `desktop_plan_guidance` beside the existing
  `desktop_visual_guidance` host inject, only for the `desktop` config profile.
  Structured prompt sections and prior opaque prompt overrides are both supported,
  without duplicate hints or capturing an active project's absolute path.
- The permanent hint directs durable implementation plans to `.pi/plans/` unless
  the user requested another location. It does not require a plan for trivial work.
- Detailed, project-neutral authoring rules live in the shipped suite resource
  `external/pi-tools-suite/docs/plan-writing.md`. The prompt references the
  installed resource's absolute path, resolved relative to the running module
  with `fileURLToPath`; it is not a development-checkout dependency. Root package
  files and the suite sync already include both `src/` and `docs/`.
- Agents read that resource only before authoring or materially revising a plan,
  and only when its full guidance is absent from context. Browsing, execution and
  ticking verified checkboxes do not trigger a read. No extra tool is registered.
- The guide grounds plans in current source and project instructions; unverified
  details become explicit assumptions or discovery steps. Technical questions
  are investigated before escalation; unresolved blockers identify affected work
  and its dependents. Proven independent work may continue, including during Run.
- Larger plans may identify useful parallel groups within project/tool delegation
  policy. Shared contracts and dependencies precede implementation; subagents get
  bounded context, write ownership and acceptance checks. One integrator updates
  the plan and verifies the combined result. Completion status alone is not evidence.
- Each gate names the phase, step or action it protects and is evaluated before
  that work, using evidence obtainable beforehand. Missing, failed or unrun
  required checks mean No-Go. Exceptions require explicit user risk acceptance
  within project constraints, without changing the actual check results; Go does
  not grant authorization. Existing applicable authorization is retained.
- Invalidated completion reopens the affected checklist items and gate decisions,
  including in flat plans. Historical and still-applicable evidence are retained;
  applicable checks are not repeated solely because a new phase/session began.
- The shared Run prompt repeats these execution rules and concurrent-edit
  precautions so execution does not rely on loading the authoring guide. Material
  replanning still follows the lazy authoring-guide loading rule.

## Plans linked to project tasks

- A task's `…` menu offers **Create plan** when the task has no canonical
  `.pi/plans` link, and **Open plan** when it does. Creating a plan first saves
  `.pi/plans/tasks/<id-slug>-<title-slug>.md` as the task's link, then opens a
  new session with an authoring-only prompt: write the plan, do not implement
  it. If saving the task link fails, no session is created. A task card with a
  linked plan shows a `FileCheck2` icon.
- Running a task whose first canonical plan link exists in the project
  documents snapshot uses the saved-plan Run prompt, augmented with the task
  context and authorization; it still associates the new session with the task
  as usual and records the plan launch. This association drives the
  **Executing plan** chip in the session status HUD. If the linked plan is not
  present in the snapshot, Run uses the ordinary task prompt.
- The Steps popup places an **Executing plan** block above its **Steps** header
  for a session launched from a saved plan. Its plan-label button opens the
  plan, and its checklist progress describes saved-plan progress independently
  from session Steps.
- When the executing session belongs to a task, the status-bar **Executing
  plan** chip popover shows **Task › Plan › This session** breadcrumbs; the Task
  segment is omitted for unlinked plans. The Steps popup's Executing plan block
  also shows `Task: <label>`. Desktop has no session header, so breadcrumbs are
  provided in the chip popover.
- The shared Run prompt and `external/pi-tools-suite/docs/plan-writing.md`
  require each verified item to be saved as `[x]` immediately; finer sub-steps
  stay in session Steps.

## Implementation and verification

- `desktop/src/components/RegistryPlansPanel.svelte`: attached list and search.
- `desktop/src/components/registry-plans-view.svelte.ts`: workspace-scoped search
  and scroll memory, with stale-owner guards and scroll-listener teardown.
- `desktop/src/components/RegistryPanel.svelte` and `WorkspaceSidebar.svelte`:
  composition and project-artifact routing.
- `desktop/src/app/desktop-sidebar-view-model.svelte.ts`: actual Preview path.
- `desktop/src/app/project-plan-actions.svelte.ts`: new-session plan launch,
  composed with existing task actions and session activation services.
- `desktop/src/app/project-plan-prompt.ts`: pure Run prompt builder shared by the
  Desktop launch action and behavioral evals; includes scoped blockers, gates,
  parallel integration, evidence invalidation and concurrent-edit handling.
- `desktop/src/app/project-documents.svelte.ts`: confirmed deletion and save
  serialization; `desktop-project-services.ts` owns Preview/registry follow-up.
- `desktop/src/components/RegistryPlansPanel.test.ts`: rendered rows/filtering,
  selection wiring, workspace/filter resets, remount memory and listener cleanup.
- `external/pi-tools-suite/src/desktop-plan-prompt.ts` and `src/index.ts`: lazy
  Desktop host guidance and registration. `test/desktop-plan-prompt.test.ts`
  verifies Desktop-only scope, composition/idempotence and relocated runtime paths.
- `desktop/src/app/project-plan-actions.test.ts` verifies the exact shared Run
  prompt is sent in a fresh session, including lifecycle and stale-owner guards.
- `external/pi-tools-suite/test/evals/plan-guidance.ts` supplies six read-only
  model checkpoints using the current guide or production Run prompt: independent
  work, conflicting contracts, scoped blockers, failed gates, worker completion
  without evidence and integration-invalidated evidence. Validator tests reject
  incorrect decisions, missing/failed plan reads and fixture changes. These cases
  do not exercise actual worker dispatch, concurrent edits or integration; their
  commands and limits are documented in `external/pi-tools-suite/docs/evals.md`.

Document loading, Markdown rendering, editing and saving retain their existing
Preview and project-document contracts. Document scroll is not a separate
per-plan cache in this list; only the navigator's scroll is retained here.

Checklist progress is native saved-file metadata: `list_project_documents`
returns `planProgress`, a plan-path map of `{ completed, total }` or `null`.
`desktop/src-tauri/src/plan_progress.rs` implements the bounded counter/cache;
the list displays a FileCheck2 icon, static linear bar and completed/total
counts, not verification that plan gates passed. No real UI QA was performed.
