# Desktop Registry plan navigation

## Behavior

- Registry contains a persistent **Plans** section above the reusable resource
  catalog. It uses the existing canonical project-document snapshot and works
  without a configured remote registry or ready conversation session.
- If the project has no plans, the entire section (heading, search and list) is
  hidden. If plans exist but the current search matches none, the section and
  search remain visible with **No matching plans**.
- Search matches plan names and paths. Rows wrap file names rather than truncating
  them; a separate directory label distinguishes equally named plans.
- Choosing a plan opens the existing main-workspace Preview tab, leaving the
  Registry list and search intact. Markdown uses Preview's existing rendered
  reading mode and explicit editing controls; no second document viewer is added.
- The selected row follows the actual Preview file, not an optimistic click.
  Failed or stale reads therefore do not falsely select a different plan.
- Each row has separate, keyboard-accessible **Run** (Play) and **Delete** (Trash)
  icon buttons; neither action opens the plan in Preview as a side effect.
  Before Run, rows show a Lucide `FileCheck2` document icon, a compact static
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
  edits are not part of the launched plan. Run requires a ready session service;
  browsing and deletion remain available offline.
- Delete confirms the full plan path and warns that deletion and loss of unsaved
  edits cannot be undone. Cancellation leaves the file untouched. Successful
  deletion refreshes the list, closes Preview only if it is showing that plan,
  and schedules normal plans registry synchronization. It waits for pending
  saves and blocks new saves of that plan until deletion completes. Errors retain
  the list entry and use the existing UI/diagnostic error reporting.
- Plan actions reject duplicate launches/deletes. Stale confirmation, runtime
  preparation and completion cannot mutate a different workspace or conversation;
  a session created after launch invalidation is closed instead of activated.
- Search and list scroll survive Registry remounts within the current workspace
  (including switching sidebar panels or closing/reopening the sidebar). Changing
  workspace resets both. Changing search resets list scroll to the top.
- The Registry toolbar has no separate plan-picker button: the list is always
  visible. The project-sync plans action focuses the persistent search, closing
  a resource diff if necessary. Empty projects stay in Registry without a plans
  section or a redirect to another panel.
- Plan buttons support normal keyboard activation and Up/Down/Home/End focus
  movement. Escape clears a nonempty search; the clear button returns focus to it.
- The plan list owns its bounded scrolling (at most 45% of the Registry pane),
  leaving the resource catalog reachable. It is not a floating picker or dialog.
- Checklist progress comes from the native `list_project_documents` snapshot's
  `planProgress` map, keyed by plan path and containing `{ completed, total }`
  or `null`. The native parser counts Markdown task markers, including nested,
  ordered and quoted lists, while excluding fenced/indented code, HTML comments
  and metadata. Counts reflect saved files. Unreadable, invalid-UTF-8 or
  oversized files are unavailable. The count snapshot refuses/skips paths that
  are not canonical project paths, including symlink/escaping paths; existing
  plan enumeration may still report a list error for symlinks.
- Progress is refreshed through the existing project-files refresh while the
  Registry Plans panel is mounted in the foreground (3-second interval). It
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
