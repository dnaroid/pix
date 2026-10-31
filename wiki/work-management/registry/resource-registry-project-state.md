<!-- pix:wiki-report {"version":1,"checkedAt":"2026-10-31T00:17:44.922Z","result":{"path":"wiki/work-management/registry/resource-registry-project-state.md","documentHash":"29dcf59cb044227dac9896903b783248461c18532d344098988f9a36512d95a9","modelRef":"zai/glm-5.3-flash","reportLanguage":"ru","checkedSources":12,"conflicts":[],"uncertainties":[],"reviewedSources":[{"path":"wiki/desktop/guide.md","quote":"do non-model settings such as Auto by default, routing fallback tier, visible\nmodels, RAG thinking effort, autocomplete limits, frontier flags and economy.\n\nCode and Knowledge use native local search. Optional semantic retrieval requires\nexplicit project consent/configuration in `.pi/search/semantic.json`; eligible\nchunks and queries may be sent externally using `OPENROUTER_API_KEY`. Existing\nLegacy search directories/configuration are not consulted.\n\n## Project initialization states\n\nDesktop exposes explicit setup actions instead of failing with generic empty\npanels:\n\n- Source Control shows **Initialize Git** when the selected workspace has no Git\n  repository. Pix refuses to create a nested repository when the workspace is\n  already inside another Git root.\n- Registry offers **Initialize project Registry** as an optional full scaffold\n  setup (SQLite tasks, plans and attachments); saving a task, plan, attachment\n  or project setting creates only the required `.pi` storage on demand. Merely\n  opening/reading a workspace does not create `.pi`. Creating a new `.pi`\n  appends `/.pi/` to the root `.gitignore` while preserving existing rules and\n  newline style; existing `.pi` directories are not retroactively ignored.\n  Initialization does not import, read or remove old JSONC task files.\n- Search indexes reports local/semantic store state without initializing or\n  repairing indexes.\n\n## Configuration\n\nDesktop does not inherit the TUI's `pix.jsonc`.\n\nUser configuration:\n\n```text\n~/.config/pi/pix-desktop.jsonc\n```\n\nProject override:\n\n```text\n\u003cworkspace\u003e/.pi/pix-desktop.jsonc\n```\n\nSchema:\n\n```text\nhttps://unpkg.com/pi-ui-extend/schemas/pix-desktop.json\n```\n\nThe Desktop profile contains settings consumed by Desktop/ACP, including model\ndefaults, prompt helpers, visible models, external editor, voice input and Git\nreview/commit-message model preferences. TUI-only renderer/theme settings stay\nin `pix.jsonc`.\n\nProject settings (name color and logo) open from **Project settings…** at the\nbottom of the project switcher menu, or by right-clicking the project badge in\nthe titlebar. They can assign a logo using **Initials** or **Image**. Images may\nbe selected with the native file chooser or generated through OpenRouter; they\nremain previews until saved. A saved image is stored as `.pi/project-icon.png`,\n`.jpg`, `.webp`, `.gif` or `.svg` (content-detected, up to 4 MB) and referenced\n","startLine":114,"endLine":172},{"path":"wiki/work-management/registry/index.md","quote":"# Resource registry\n\nProject state, publication tags, agent companions and Desktop plan/diff surfaces.\n\n[Wiki home](../../index.md)\n\n## Pages\n\n- [Desktop Work plans navigation](desktop-registry-plans.md)\n- [Desktop Registry resource diff](desktop-registry-resource-diff.md) — active\n- [Registry agent companion directories](resource-registry-agent-companions.md) — active\n- [Resource Registry: project state](resource-registry-project-state.md)\n- [Registry publication scope and tags](resource-registry-publication-tags.md) — active\n","startLine":1,"endLine":13},{"path":"wiki/decisions/0064-sqlite-project-tasks.md","quote":"managed by SQLite rather than handwritten application protocols.\n\nThe clean break intentionally means that old tasks are **not visible** until\nthe user recreates them explicitly in SQLite; the old files remain on disk\nwithout automatic deletion. An agent with unrestricted filesystem access\ncould bypass this tool; preventing every form of direct write requires\nindependent OS capability/sandbox restrictions, not only a restricted API.\n\n## Validation\n\n- Task-tool tests: single-row updates, conflicts, deletion restrictions,\n  immutable blob associations, explicit slash commands, no legacy fallback.\n- Desktop Rust tests: schema initialization, per-task changes, no-follow\n  storage checks, attachment integrity and Registry indicator.\n- ACP Registry tests: SQLite push/pull, attachment content, provenance.\n- Desktop UI tests: full CRUD controls, task drag, filters, run and session\n  reopening. Rust tests cover task-only mutation, atomic attachment links and\n  position rebalancing without overwriting unrelated content.\n\n\n","startLine":53,"endLine":72},{"path":"wiki/desktop/conversations/desktop-session-sidebar.md","quote":"- Background sessions remain observable from the top tab strip. The leading session status uses IDE-style semantic icons rather than a color-only dot: idle uses a success check, a running prompt or live Subagent uses a spinning info loader, elicitation waiting uses a warning question icon, and retrying Subagents use a warning triangle. Blocked Plan items are normal dependency-waiting state and do not trigger a tab warning. Plan status alone, including an in-progress item retained after execution stops, does not masquerade as active execution; its progress remains visible in the tab tooltip and Session activity surfaces.\n- Successful completion that reaches the same fully-settled boundary used by Desktop notifications marks an inactive session tab as unseen-complete: the idle success check gains a small accent badge until that session tab is opened. The marker is cleared when the tab is viewed, when new work starts in that session, when the session is cleared, or when prompt/runtime state resets. Completion does not mark the session when its workbench tab is already selected.\n- Status precedence is `needs-input` → `warning` → `running` → `unseen-complete` → `idle`, so a stale completion badge never masks current execution or attention. Fork identity remains a separate `GitFork` marker between the status icon and title.\n- Elicitation attention stays attached to each requesting session when another tab becomes active, including when several background sessions are independently waiting for input.\n- Tab activity never changes tab membership or order and does not replace the existing active-tab affordance.\n- The Steps popup's `Task:` label for an executing plan wraps long task names and\n  does not use a native title tooltip.\n- Session todo progress is labeled **Steps** in the status HUD, tab activity labels and subagent todo progress; project-scoped work continues to use **Tasks**. The popup label is **Session steps**, its heading is **Steps**, and its accessible scroll region is **Session step list**.\n- Desktop updates the derived activity summary only for the session whose Todo/Subagent snapshot changed. A live activity event does not rescan every retained session plan/run merely to refresh the tab strip or status HUD.\n\nThe status HUD Steps control vertically centers its `completed/total` count next\nto a compact circular progress ring in place of the todo icon. The ring fills\nclockwise from the top according to the completed fraction; no linear progress\ntrack is rendered. Visibility depends only on live activity; click popup behavior\nfollows decision 0048.\n\n- A session launched from a saved plan shows an **Executing plan** status-bar\n  chip immediately left of the session activity/Steps HUD, only for live,\n  non-draft, non-viewer sessions whose plan still exists in the current project\n  documents snapshot. The chip shows saved checklist progress as the same ring\n  as the Steps HUD (no icon) in the plan colour (`text-tool-skill`) and `N/M`,\n  or `—` without checklist items; its click popup identifies the plan, explains that this\n  is saved-file checklist progress distinct from live session Steps, and offers\n  **Open plan** to open Preview. While mounted it refreshes project documents\n  every three seconds in the foreground. Deleted or renamed plans no longer show\n  the chip. Launch association is workspace-scoped in localStorage under\n  `pix.desktop.planLaunches:\u003cworkspace\u003e`, retaining at most 50 newest canonical\n  `.pi/plans` launches; stale/reset launches are not recorded.\n- If the executing plan is linked to a project task, the chip's popover includes\n  **Task › Plan › This session** breadcrumbs, with the Task segment omitted when\n  unlinked. The Steps popup's **Executing plan** block also shows\n  `Task: \u003clabel\u003e`. Breadcrumbs live in the chip popover because Desktop has no\n  session header.\n- In the Steps popup, the **Executing plan** block appears above the **Steps**\n  header. Its plan-label button opens the plan Preview, and its progress ring\n  (same ring as Steps, no icon, plan colour `text-tool-skill`) is saved-file\n  checklist progress distinct from live session Steps. The Run\n  prompt and `external/pi-tools-suite/docs/plan-writing.md` require saving each\n  verified checklist item as `[x]` immediately; finer sub-steps stay in session\n  Steps.\n\n## Related files\n\n- `external/pi-tools-suite/src/lib/rpc-session-state.ts`\n- `external/pi-tools-suite/src/todo/todo.ts`\n- `external/pi-tools-suite/src/async-subagents/index.ts`\n- `acp/src/pi/pi-rpc-client.ts`\n- `acp/src/acp/session-state-bridge.ts`\n- `acp/src/acp/pix-acp-agent.ts`\n- `desktop/src/lib/acp-client.ts`\n- `desktop/src/lib/acp-client-types.ts`\n- `desktop/src/lib/session-todos.ts`\n- `desktop/src/lib/session-subagents.ts`\n- `desktop/src/lib/session-activity.ts`\n- `desktop/src/components/WorkbenchTabs.svelte`\n- `desktop/src/components/StatusBar.svelte`\n","startLine":78,"endLine":133},{"path":"wiki/operations/desktop-lsp-onboarding.md","quote":"- After installation Desktop writes the fixed server template and returned\n  executable path/env into the trusted user\n  `~/.config/pi/pi-tools-suite.jsonc` LSP server list. JSONC comments and\n  unrelated settings are preserved, an existing server with the same ID is\n  replaced, and optimistic conflict checks retry before failing visibly.\n- Project-local `.pi/pi-tools-suite.jsonc` trust semantics are unchanged.\n  Installing an LSP does not auto-trust or rewrite project-local LSP commands.\n\n## Lifecycle and concurrency\n\n- Workspace changes clear pending warning/install UI state. A late native\n  installation result from the previous workspace is rejected before a new\n  user-config registration begins and cannot overwrite installer UI for the new\n  workspace.\n- Native package installation may already have written files before a workspace\n  switch. A global user-config write that was already started may still finish;\n  it is an approved global registration and stale UI completion is ignored.\n- Session teardown clears that session's visible or pause-pending suggestion.\n\n## Related files\n\n- `external/pi-tools-suite/src/lsp/onboarding.ts`\n- `external/pi-tools-suite/src/lib/lsp.ts`\n- `external/pi-tools-suite/test/lsp-onboarding.test.ts`\n- `desktop/src-tauri/src/lsp_install.rs`\n- `desktop/src/lib/lsp-onboarding.ts`\n- `desktop/src/app/lsp-onboarding.svelte.ts`\n- `desktop/src/components/TranscriptPane.svelte`\n- `desktop/src/components/LspInstallPane.svelte`\n- `desktop/src/lib/workbench-tabs.ts`\n- `desktop/src/app/workbench-model.ts`\n\n## Verification\n\n- pi-tools-suite onboarding tests cover catalog matching, registered-server\n  suppression, and the structured private state event.\n- Desktop helper tests cover trusted event parsing, comment-preserving/conflict-safe\n  JSONC server registration, pause-pending teardown, serialized installation,\n  and stale workspace completion.\n- Workbench/model and source-level regressions cover the centered warning,\n  pause/install wiring, dedicated installer tab, and no-auto-continue copy.\n","startLine":77,"endLine":117},{"path":"wiki/architecture/desktop-operation-lock-audit.md","quote":"\n- local/background work owns a local busy state;\n- only a transition that mutates the identity or coherent state of the active\n  workspace/session may temporarily block active-session mutation;\n- an async operation must never clear a lock owned by another operation;\n- stale completions must be rejected by captured client/workspace/session\n  ownership, not by assuming the UI stayed blocked.\n\n## Fixed in the current pass\n\n- Resource Registry refresh/install/update/push/pull/uninstall/remove already use\n  Registry-local `actionId`. Project Registry initialization and cleanup now do\n  the same and no longer receive the global lock setter.\n- Prompt enhancement no longer blocks the workbench while the model request is\n  pending. Duplicate enhancement for the same session is coalesced, and a late\n  answer does not overwrite text edited by the user after the request started.\n- Background session close/delete now use per-session action ownership. Closing\n  or deleting one inactive conversation no longer disables the active\n  conversation or unrelated workbench controls. A stale close completion after\n  a workspace change is ignored.\n- Workspace session startup no longer acquires/releases `operationRunning`\n  inside an already locked workspace switch. Concurrent startup requests are\n  coalesced only for the same ACP client and workspace; a new workspace gets a\n  distinct startup owner.\n\n## Remaining global lock sites\n\n### P1 — replace the ownerless boolean\n\n`operationRunning` is still a single boolean in `desktop/src/App.svelte`.\nThe surviving call sites usually guard against overlap before setting it, but\nthe state has no owner/token. Disconnect/reset code can also clear it.\n\nThis makes correctness depend on every current and future caller respecting the\nsame convention. A safer replacement is an owned/scoped mutation coordinator,\nfor example:\n\n- `workspace-transition`;\n- `active-session-transition`;\n- local `session:\u003cid\u003e` operations outside the global coordinator.\n\nReleasing a scope should require the same opaque owner that acquired it. The\nderived UI state should distinguish \"active session cannot mutate\" from\n\"unrelated background work exists\".\n\n### P1 — active-session import and resume are globally scoped\n\nFile: `desktop/src/app/conversation-session-actions.ts`\n\nRemaining functions:\n\n- `importConversationPath()`;\n- `resumeConversationPath()`.\n\nBoth mutate the active session/runtime/history, so concurrency with prompt\n","startLine":14,"endLine":68},{"path":"wiki/decisions/0072-session-native-subagents.md","quote":"  per-agent directory (`owned_launch` pointer, `owned-launch/\u003cUUID\u003e/` with\n  spec, generation, claim, journals, receipts, retirement proof). Restart\n  reconciliation discovers it by scanning\n  `.pi/subagents/\u003cparentSessionId\u003e/owned/\u003cbatch\u003e/\u003cagentId\u003e/`\n  (`core/owned-retirement.ts` ~356–405, `core/owned-launch/label.ts` ~67–112).\n  The launchd access probe is given the directories it must reach\n  (`tools/spawn.ts` ~71–76).\n\n## Decision\n\n1. **Storage.** A child session lives in the project, in a directory named\n   after its parent's session id:\n   `\u003ccwd\u003e/.pi/subagents/\u003cparentSessionId\u003e/\u003cchild\u003e.jsonl`. Keeping children out\n   of the global Pi store hides them from every resume list and from usage\n   stats (the parent already records their usage) without per-surface\n   filters, and gives one directory to delete per parent. Parent ids are\n   UUIDs, legacy run directories are timestamp-named, so both coexist under\n   `.pi/subagents/` without collision. Headless parents without a stable host\n   session key use process-local state; with a stable key they use the journal\n   described under Consequences. Child metadata is a `subagent_meta` custom\n   entry containing `version`, `agentId`, `batch`, `runDir`, `cwd`, optional `subagentType`, `parentSession`, `parentSessionId` and `scope`; it does not contain the launch task or prompt.\n   That entry, not the header, is the\n   authoritative lineage; the header's `parentSession` stays reserved for\n   forks.\n2. **Single writer.** Only the child process appends to its JSONL. The parent\n   persists lifecycle patches as `pi-tools-suite:subagent` custom entries in\n   its own session, folded in order. Live process state (handles, activity,\n   full result text and stderr tail) remains in memory. This replaces\n   `registry.json`; child death outcomes are recorded by the parent.\n3. **Lazy flush.** The child receives its prompt immediately, so metadata is\n   flushed with the first user message. Until then the parent's in-memory\n   record is the only state, which matches today's planned/queued phase.\n4. **Identity.** `agentId` is the launch identifier (commonly `task.id`) accepted by `send`/resume, not the Pi session id. Pi assigns the child-session UUID; the parent records the session file reported in RPC events, and `subagent_meta` maps that session to `agentId`. A run key identifies `(scope, batch)` but is not a directory;\n   `runDir` is the compatibility input alias for a batch. An `agentId` without\n   a batch resolves to the latest-launched matching record in scope.\n5. **Owned launch.** Its ownership records move unchanged in shape to\n   `.pi/subagents/\u003cparentSessionId\u003e/owned/\u003cbatch\u003e/\u003cagentId\u003e/\u003claunchId\u003e/`,\n   beneath an owned base created only for owned launches. Reconciliation scans\n   those directories. Background cleanup must never remove a parent directory\n   that still holds an unretired owned-launch record. All invariants stay: keep every generation\n   until both exact UUID services are proven absent, atomic `link(2)` claims,\n   atomic generation publication before launch, fail closed on missing or\n   ambiguous records. The access probe targets the new root.\n6. **Artifacts.** Disposable UI-QA/browser workspace output goes to\n   `.pi/artifacts/subagents/\u003cbatch\u003e-\u003cagentId\u003e/`. `AGENTS.md`, the artifact\n   storage spec and role-prompt guidance should stay aligned with this target;\n   see stage 5 below for implementation status.\n7. **Retention and limits.** Desktop background cleanup replaces the 72-hour\n   TTL for parent-scoped directories: `.pi/subagents/\u003cparentSessionId\u003e/` is\n   kept while the parent session file exists (found via the children's\n   `subagent_meta.parentSession` path or the project's default Pi session\n   directory) and removed once the parent is gone and the subtree has been\n   idle for 24 hours. Unreadable directories and legacy run directories keep\n   the 72-hour TTL; manual Clean immediately removes ordinary subagent state\n   but preserves `owned/` launch records until retirement.\n   Deleting a parent session through ACP `session/delete` reads the parent\n   id from its header and removes `.pi/subagents/\u003cparentSessionId\u003e/` at once;\n   it refuses non-UUID ids, symlinks and directories that still contain\n   `owned/`, and a failure only logs a warning (background cleanup reclaims\n   the orphan later). Role frontmatter `maxTurns` and budget support remains a\n   planned design item, not implemented behavior.\n8. **No migration.** New code does not read legacy run trees or sidecars;\n   legacy run directories are ignored by session-native readers and may be\n   removed by explicit cleanup or Desktop cleanup.\n9. **Delivery in stages**, each with focused tests: (1) remove the no-session\n   mode — done; (2) parent-scoped `.pi/subagents/\u003cparentSessionId\u003e/` sessions +\n   `subagent_meta` and parent-based cleanup — done; (3) state in session entries\n   + parent index instead of `registry.json` and sidecars — implemented; (4) one\n   read model in the suite for TUI/ACP/Desktop, `open_session` by `agentId` —\n   implemented; (5) artifacts in `.pi/artifacts` — the UI-QA/browser workspace\n   path is implemented, but role-prompt path cleanup remains incomplete; (6)\n   cascade delete is implemented, while `maxTurns`/budget and new batch filters\n   are not implemented; (7) specs and tests are updated alongside implemented\n   behavior, not evidence that the remaining design items shipped. The behavior\n   described above is the accepted target design; unimplemented items are not\n   part of the current runtime contract.\n\n## Alternatives\n\n- Children as top-level sessions with header `parentSession` (pure\n  OpenCode style): every resume surface would need a new filter, and existing\n  fork grouping would mislabel children; rejected.\n- Keep run directories and only trim sidecars: does not remove the run tree or\n  the registry the user asked to remove; rejected.\n- Claude-style `.meta.json` next to each child transcript: still a sidecar;\n  the `subagent_meta` entry carries the same data inside the session.\n","startLine":59,"endLine":144},{"path":"wiki/work-management/registry/desktop-registry-resource-diff.md","quote":"of a misleading empty diff. Loading/failed/empty states are distinct, and\nlate responses from a closed view, previous selection or previous workspace\nmust not replace the current view.\n\nDiff collection holds the shared cross-process checkout lock described in\n[Registry publication](resource-registry-publication-tags.md), so another ACP\nprocess cannot reset or replace the checkout during comparison.\n\n## Implementation\n\n- `acp/src/registry/service.ts`\n- `acp/src/registry/cache-lock.ts`\n- `acp/src/registry/diff-service.ts`\n- `acp/src/registry/diff.ts`\n- `acp/src/registry/publication-location.ts`\n- `acp/src/registry/git.ts`\n- `acp/src/acp/desktop-commands.ts`\n- `acp/src/acp/pix-acp-agent.ts`\n- `desktop/src/lib/registry.ts`\n- `desktop/src/lib/acp-pix-extensions.ts`\n- `desktop/src/lib/acp-client.ts`\n- `desktop/src/app/registry.svelte.ts`\n- `desktop/src/components/RegistryPanel.svelte`\n- `desktop/src/components/RegistryCatalog.svelte`\n- `desktop/src/components/RegistryItemActions.svelte`\n- `desktop/src/components/RegistryDiffPanel.svelte`\n- `desktop/src/components/WorkspaceSidebar.svelte`\n- `desktop/src/app/desktop-sidebar-view-model.svelte.ts`\n\n## Tests\n\n- `acp/test/registry-cache.test.ts`\n- `acp/test/registry.test.ts`\n- `acp/test/desktop-commands.test.ts`\n- `acp/test/agent.test.ts`\n- `desktop/src/lib/acp-client.test.ts`\n- `desktop/src/lib/registry.test.ts`\n- `desktop/src/app/registry.test.ts`\n- `desktop/src/components/RegistryPanel.test.ts`\n\n## Verification\n\nExercise agent sidecar-only edits/additions/removals and skill-tree changes,\nincluding the direction of additions/removals; verify request validation,\nread-only operation, binary/size handling, error states and stale-workspace\nguards. Run focused backend, ACP and Desktop tests plus their type checks.\n\n\n","startLine":45,"endLine":92},{"path":"wiki/work-management/index.md","quote":"# Work management and resources\n\nSession-local todos, saved project tasks and durable resource registry are distinct stores with different authorization and lifecycle rules.\n\n[Wiki home](../index.md)\n\n## Topics\n\n- [Resource registry](registry/index.md) — Project state, publication tags, agent companions and Desktop plan/diff surfaces.\n- [Saved project tasks](tasks/index.md) — Project task storage, agent authorization and Desktop task management. Session todos are not saved project tasks.\n- [Session todos](todos/index.md) — Planning, initial status, thinking overrides, replay and documentation finalization.\n\n\n","startLine":1,"endLine":13},{"path":"wiki/work-management/tasks/desktop.md","quote":"  Deleting a referenced task requires unlinking/reparenting dependents first.\n  Validation runs under the SQLite write transaction, not only in the UI;\n  agent and slash updates preserve optional fields and reject invalid deletes.\n- `links` store project-relative file/artifact paths or regular web URLs;\n  unsafe local paths are rejected by the editor. Existing `links` are presented\n  as named, clickable rows, not anonymous counts. Attachments remain a separate\n  SQLite association table rather than embedded paths in a description.\n\n## Registry interaction and storage safety\n\n- Each successful Desktop task save marks the Registry `tasks` artifact\n  dirty for debounced background sync; failures do not schedule a push.\n  Agent/slash updates are observed by panel polling and Registry local\n  hashing independently of Desktop callbacks.\n- Registry exports a committed consistent SQLite snapshot (SQLite online\n  backup, including WAL contents), plus referenced content-addressed blobs.\n  It hashes canonical task rows/relationships and verified attachment\n  bytes, not the physical DB file or temporary WAL/SHM bytes.\n- Registry imports into the existing local database **inside a transaction**,\n  with provenance/expected-hash conflict checks and without replacing its\n  inode. Pull is a deliberate bulk action outside the restricted task API.\n- Cleanup preserves `tasks.sqlite`, `tasks.sqlite-wal`,\n  `tasks.sqlite-shm`, `task-attachments/`, and durable project state.\n  It does not clear live journal sidecars or follow symlinks.\n- Reject redirected SQLite files/sidecars, nonregular files, unsupported\n  schema versions, invalid task payloads, unsafe blobs and invalid hashes.\n  Read errors never authorize data deletion or recreation.\n- On macOS/APFS, concurrent SQLite last-close cleanup can expose `-wal` or\n  `-shm` metadata with `nlink=0` just after its inode was unlinked. That is\n  a normal ephemeral state, **not** a hard link, and must not block Tasks.\n  `nlink\u003e1` on a sidecar still rejects an actual hard-link alias, as do\n  symlinks and nonregular files. The canonical `.pi/tasks.sqlite` and\n  immutable attachment blobs continue to require exactly one link.\n\n## Implementation and verification\n\n- `desktop/src/components/WorkspaceSidebarTasksPanel.svelte`\n- `desktop/src/components/TaskFieldSelect.svelte`\n- `desktop/src/components/TaskProjectLinkInput.svelte`\n- `desktop/src/components/WorkspaceSidebarTaskModelControl.svelte`\n- `desktop/src/components/ModelThinkingPicker.svelte`\n- `desktop/src/components/WorkspaceSidebar.svelte`\n- `desktop/src/app/project-tasks.svelte.ts`\n- `desktop/src/app/project-actions.svelte.ts`\n- `desktop/src-tauri/src/project_tasks_sqlite.rs`\n- `desktop/src-tauri/src/lib.rs`\n- `desktop/src/components/WorkspaceSidebarTasksPanel.test.ts`\n- `desktop/src/components/WorkspaceSidebar.test.ts`\n- `desktop/src/app/project-actions.test.ts`\n- `desktop/src-tauri/src/lib.rs` native SQLite/revision/blob/Registry tests\n\nThe API restriction does **not** sandbox all OS file tools: independently\nprivileged code could still open `.pi/tasks.sqlite` directly. The sanctioned\n","startLine":241,"endLine":293},{"path":"wiki/desktop/workbench/desktop-workspace-navigation.md","quote":"  finishing one cannot unlock or invalidate another, and workspace replacement\n  or panel teardown invalidates all old completions. Late deletion completion\n  does not restore tree focus after the user has moved to another row.\n  A pending create/rename completion cannot steal focus from a newer name input\n  or a different focused tree row; created files open only when that completion\n  still owns focus. Name-mutation failures also reach the diagnostic logger.\n  See [decision 0028](../../decisions/0028-scoped-file-operation-reservations.md).\n- Create, copy, delete, rename and move support Undo/Redo. A group request is one\n  history token; partial undo can be retried. Controls are available in the\n  toolbar/context menu and via Cmd+Z/Cmd+Shift+Z while Files is focused (not while\n  editing a name, searching, or editing Preview text). History is runtime-only\n  for the mounted panel and current workspace, with a 100-operation limit.\n  Durable recovery data and intent journals live under `.pi/file-history`; they\n  are never automatically purged, are excluded from manual and TTL Clean and\n  Files tree/search, and nested `.gitignore` files contain `*`. Journals are for\n  manual recovery only and are never replayed as executable work after restart.\n- File/folder context menus expose **Add to .gitignore** only after a local Git\n  check confirms an exact workspace-root repository and a target not already\n  matching ignore rules, including tracked files and folders with tracked\n  descendants. Ignore matching is checked independently of the index. The backend\n  rechecks eligibility before writing; it never removes anything from the index,\n  so already tracked files retain their Git status after a rule is added. It appends\n  an anchored, escaped literal rule, with a trailing slash for folders, to the\n  nearest existing ancestor `.gitignore`, or creates the root `.gitignore`.\n  Existing rules/comments and newline style are preserved. Workspace escapes,\n  symlinks and Git metadata are rejected. Completion refreshes directory listings\n  and the shared Git snapshot, updating target/ancestor/`.gitignore` colors without\n  manual refresh. Menu checks and mutation completions cannot affect a replaced\n  workspace or closed menu/panel. Rechecking the same menu target after a Git\n  snapshot refresh preserves its confirmed eligibility while the read is pending,\n  so polling does not make the action blink. A fresh ineligible result or failed\n  check hides it; changing targets clears the previous target's eligibility.\n- Browser fallback retains pointer-based internal Files moves and composer\n  references; lazy directory loading is unchanged.\n- Project Explorer keeps dotfiles and dotfolders in the normal tree. Entries whose basename starts with `.` use muted opacity by default so ordinary source files retain visual priority; hover, keyboard focus, and selected/open state restore normal readability.\n- The workspace-root `.pi` directory, root `AGENTS.md`, direct canonical files in `.pi`, and durable canonical `.pi` directories are emphasized with primary-colored, medium-weight names and `FolderCog`/`FileCog` icons. Canonical entries are limited to the native cleanup allowlists; ephemeral containers such as `artifacts` and `subagents` are excluded. Descendants are not blanket-emphasized, and unknown paths remain unchanged. Emphasized dot entries bypass default muting. Git status name colors retain precedence over emphasis, while icons remain primary-colored; row tooltips describe the entry's role. This is visual-only and does not change focus, navigation or selection.\n- Project Explorer colors changed file names from the shared workspace Git snapshot, without displaying status letters or badges. Added/untracked files use success, deleted files warning, conflicts error, and other changes info semantic colors. Working-tree status takes color precedence over staged status; tooltips and accessible row labels describe both scopes. Existing folders containing changed descendants use info-colored names, even when collapsed, with conflicts taking error-color priority. Renames color both source and destination ancestor folders; absent/deleted files are not invented in the filesystem tree. Clean files and unavailable/non-repository snapshots have no decorations.\n- While Files is mounted, local Git status refreshes on opening/workspace change, Files Refresh, window focus, file-operation completion, and about every five seconds after the previous read completes. Reads are serialized and repeated triggers coalesce; closing the panel stops scheduling. This reuses the workspace-guarded Git store and does not fetch remotes or traverse/expand the lazy tree. Git errors do not prevent file browsing or change its health indicator.\n- While Files is mounted and the window is focused and visible, directory listings\n  refresh about every five seconds after the previous poll completes and immediately\n  when returning to the window. Only the root and visible expanded directories are\n  read, without recursively scanning the project or adding a filesystem watcher.\n  Polling preserves existing rows, expansion, selection and focus, skips directories\n  already loading, and uses the tree's generation/request guards against stale\n  workspace or mutation completions. Cached directory polls are quiet: no loading\n  spinner or error clear/reappear cycle while waiting. Successful reads clear old\n  errors; initial uncached loads and explicit directory reloads retain loading\n  feedback. Equal listings retain array/map identity and do not invalidate tree\n  rendering; changed listings reuse unchanged entries. Git polls likewise reuse\n  equal snapshots and omit repeated branch/remote listings after metadata bootstrap\n  (see [Git status reads](../integrations/desktop-git-workflows.md#explorer-local-status-reads)).\n  Background/hidden windows stop scheduling;\n  closing Files removes timers and activity listeners. Search results are not polled.\n- Expanding a previously loaded directory rereads it and its visible expanded\n  descendants, retaining cached rows until completion. Reopening the workspace\n  root rereads the root and visible expanded directories. This exposes folders\n  created by agents or external tools while a branch was collapsed, without\n  waiting for the next poll or scanning unopened branches; in-flight reads coalesce.\n- The Files panel keeps a compact project-search field above the lazy tree. Typing a query runs a bounded background search over project-relative file paths and UTF-8 file contents without expanding tree nodes; `Ctrl+Shift+F` / `Cmd+Shift+F` focuses that field while the Files panel is active.\n- Project search does not follow symbolic links and skips dependency/generated directories such as `.git`, `node_modules`, `target`, `dist`, `build`, `coverage`, `.next`, and `.svelte-kit`. Individual content reads are bounded to 2 MB, scanning stops after 20,000 files, and at most 500 path/content matches are returned so searching cannot turn the renderer into an unbounded filesystem walk.\n","startLine":276,"endLine":335},{"path":"wiki/work-management/registry/resource-registry-publication-tags.md","quote":"  or NUL. Agent frontmatter rejects non-string-array tags. Malformed optional\n  skill tag metadata does not hide an otherwise usable catalog entry.\n- Editing preserves unrelated YAML/body, rejects malformed/duplicate tag\n  frontmatter and symlinked paths, and refuses stale file contents after an\n  asynchronous dialog. Cancellation and failures must not overwrite newer work.\n- Actions remain workspace-scoped and validate resource type and safe name.\n  The ACP build must include the standalone Registry service for live verification.\n\n## Implementation\n\n- `acp/src/registry/config.ts`\n- `acp/src/registry/cache-lock.ts`\n- `acp/src/registry/git.ts`\n- `acp/src/registry/service.ts`\n- `acp/src/registry/resources.ts`\n- `acp/src/registry/publication-location.ts`\n- `acp/src/registry/publication-scope.ts`\n- `acp/src/registry/project-resource-sync.ts`\n- `acp/src/registry/metadata.ts`\n- `acp/src/registry/tag-publication.ts`\n- `acp/src/registry/status.ts`\n- `acp/src/registry/agent-markdown.ts`\n- `external/pi-tools-suite/src/async-subagents/core/agents-dir.ts`\n- `acp/src/acp/desktop-commands.ts`\n- `desktop/src/lib/registry.ts`\n- `desktop/src/app/registry.svelte.ts`\n- `desktop/src/components/RegistryPanel.svelte`\n- `desktop/src/components/RegistryCatalog.svelte`\n- `desktop/src/components/RegistryItemActions.svelte`\n- `desktop/src/lib/registry-card-actions.ts`\n- `desktop/src/lib/registry-background-sync.ts`\n- `skills/skill-creator/SKILL.md`\n- `skills/skill-creator/scripts/quick_validate.py`\n- `.pi/skills/project-agent-creator/SKILL.md`\n- `.pi/skills/project-agent-creator/scripts/validate-agents.ts`\n\n## Tests\n\n- `acp/test/registry-cache.test.ts`\n- `acp/test/registry.test.ts`\n- `acp/test/registry-metadata.test.ts`\n- `acp/test/agent.test.ts`\n- `acp/test/desktop-commands.test.ts`\n- `desktop/src/lib/registry.test.ts`\n- `desktop/src/app/registry-store.test.ts`\n- `desktop/src/components/RegistryPanel.test.ts`\n- `desktop/src/lib/registry-card-actions.test.ts`\n- `desktop/src/lib/registry-background-sync.test.ts`\n\n## Verification\n\nRun targeted registry/metadata, ACP command-validation and Desktop unit tests,\ntools-suite typecheck and Desktop/ACP typechecks. Real UI QA checks both tabs,\ntag editing/search and both conversion directions with retained evidence.\n","startLine":145,"endLine":198}],"notices":["Результат 1 не прошёл проверку: цитата отсутствует или встречается в предоставленном тексте несколько раз."],"coverage":{"scope":"retrieved-passages","checkedPassages":12,"candidateSources":55,"excerptedSources":10,"limits":["query-sampling","candidate-limit","source-limit","context-limit","passage-limit"]},"status":"incomplete"}} -->
# Resource Registry: project state

## Type

Change

## Lifecycle

Implemented; this is the current project-state registry contract.

## Goal

Synchronize project-scoped tasks, plans, and workspace state through the
private Git registry without making task attachments depend on machine-specific
absolute paths.

## Scope

- Desktop Registry push/pull/sync for tasks, plans, workspace and project.
- Project provenance in canonical `.pi/registry.jsonc` (with read-only legacy
  lookup of `.pi/registry.json` when the canonical file is absent).
- Portable synchronization of SQLite task rows and SHA-256 content-addressed
  attachments from `.pi/tasks.sqlite` and `.pi/task-attachments`.
- Pix Desktop local project-state initialization for workspaces that do not yet
  have a `.pi` directory.

## Remote layout

For project key `<key>`, the registry stores:

- `projects/<key>/tasks.sqlite` (transaction-consistent online backup)
- `projects/<key>/task-attachments/<sha256>` for blobs referenced by the
  synchronized SQLite attachment association table
- `projects/<key>/plans/`
- `projects/<key>/workspace.jsonc`

Legacy `projects/<key>/TODO.md` files are ignored; Registry does not publish,
fetch, report or delete them.

The Registry SQLite copy is a consistent transport snapshot: neither side
copies a live database's raw bytes without its WAL. Task descriptions contain
plain text, and attachments are related by hash and task id inside SQLite,
not by embedded `file://` or portable text markers. There is no legacy
JSONC/task overlay import or fallback.

## Behavior

- Registry provenance is JSONC. Status/read operations are side-effect free;
  malformed or unsupported provenance is an error and is never bypassed by
  falling back to the legacy file. The first subsequent provenance write
  migrates legacy state by publishing the complete canonical document
  atomically without clobbering a concurrently created canonical file, then
  removes the legacy file only if its contents are unchanged. A failed legacy
  cleanup is logged but does not undo the successful canonical write. Registry
  writes add the Registry editor schema reference only when `$schema` is absent.
- The package generates and exports TypeBox editor schemas at
  `schemas/workspace.json` and `schemas/registry.json`. Desktop's four workspace
  config writers add the workspace `$schema` reference when absent; they retain
  an existing custom `$schema`, comments, and unknown fields.

- Desktop schedules a background catalog refresh three seconds after ACP is
  ready for the active workspace, without requiring the Registry panel to open.
  Busy operations, Registry actions and project sync defer the request until a
  new quiet three-second interval. Workspace/client changes, disconnection and
  teardown cancel pending timers; reconnect schedules a new load. In-flight
  responses retain the Registry store's workspace/lifecycle stale-response guards.

1. `push tasks` validates the local SQLite v1 schema, task payloads, rows and
   attachment association integrity, then uses SQLite online backup to capture
   a transactionally consistent snapshot (including committed WAL content).
2. Only blob hashes referenced from `task_attachments` participate in the
   Registry artifact. Each referenced blob is verified for safe regular-file
   containment, size and SHA-256; removed references are omitted remotely.
3. `pull tasks` checks remote SQLite schema, rows and blobs; imports rows into
   the existing local database within `BEGIN IMMEDIATE` and copies blobs as
   immutable content-addressed files. It does not rename the live DB inode.
4. Push and pull enforce the project provenance/observed hash for the
   transaction boundary. A concurrent task write cannot silently be turned
   into an all-task Registry replacement; it must be reviewed/retried.
5. The task artifact hash is canonical JSON of sorted task rows (including
   revision/position), attachment metadata and associations plus every linked
   immutable blob's bytes. WAL/SHM file bytes, free pages and SQLite packing
   are excluded. Editing a linked blob produces a checksum error.
6. The remote revision for `tasks` follows both
   `projects/<key>/tasks.sqlite` and `projects/<key>/task-attachments/`, so a
   remote attachment-only change participates in update/conflict detection.
7. The registry Git commit stages the current project's directory in the
   disposable clone. Other project keys and reusable skills/agents are not
   included.
8. Pix Desktop owns one background project-state sync coordinator. A successful
   per-row SQLite task write marks `tasks` dirty; saving a canonical Markdown
   plan (`.pi/plans/**/*.md`, excluding
   generated/temporary paths) marks `plans` dirty; successful
   Desktop saves of `.pi/workspace.jsonc` mark `workspace` dirty. The fast sidebar
   Registry poll also reports project artifacts that changed outside those
   Desktop save paths, so agent/external edits enter the same coordinator. Those
   external-change signals also refresh the corresponding local Desktop store
   before sync: `tasks` reloads the SQLite task view, while `plans` reloads the
   plan document snapshot. A queued signal is discarded if the
   workspace changed before it is applied.
   Canonical changes are determined by the Registry payload, **not directory
   timestamps or SQLite sidecar activity**. The native poll and ACP use the same
   filtering contract: only non-service Markdown files under `.pi/plans/` are
   plan data; skill and agent packages include their authored scripts/assets
   but skip hidden, temporary, backup, lock, log, cache, build and generated
   paths. Examples excluded from Registry dirty detection and publication are
   `.DS_Store`, `*.tmp`, `*.bak`, `*.lock`, `*.log`, `*~`, `.cache/`,
   `node_modules/`, `__pycache__/`, `artifacts/`, `build/`, `dist/`,
   SQLite `-wal`/`-shm`/`-journal` and unrelated `.pi` files. Agent notes with
   no valid agent definition are not standalone Registry resources. The
   unchanged backup-only plan scaffold is not a local Registry plan artifact.
   SQLite task comparison remains a transaction-consistent **logical** hash of
   rows, revisions, ordering and referenced blob content, capturing committed
   WAL changes without hashing sidecar bytes. Unlinked task-attachment blobs
   do not trigger sync. A canonical change is still detected by periodic
   polling even when it originates from an agent or external editor.
   Publishing a plan sends only canonical Markdown; pulling it updates the
   canonical Markdown while preserving local backup/scratch files. A
   scratch-only local plans folder without provenance must never delete a
   different project state's remote plans.
9. Dirty project-state writes are debounced for approximately 900 ms. Repeated
   writes to one artifact collapse into one push, while more than one dirty
   artifact collapses into one project operation. The automatic request is
   `sync-project`, handled directly by the ACP Registry service; it never
   opens confirmation dialogs or emits successful-push notifications. It syncs
   tasks/plans/workspace and also saves newly discovered Local-only project
   skills/agents under `projects/<key>/skills|agents`. Published resource edits
   and unsafe/conflict/removal states are not automatically pushed. It never
   promotes a resource to Global (see publication/tags spec).
   Untracked remote collisions and changed tracked revisions return actionable
   errors without overwrite; explicit foreground push retains confirmation.
   Initial/refresh snapshots seed safe local-only/local-changes project artifacts
   and Local-only project resources.
   Persistent poll observations neither restart debounce nor clear terminal
   errors, and different artifacts are retained while pending or in flight.
10. Background sync never takes the Desktop foreground-operation lock. Registry
    actions are workspace-scoped: Desktop sends the workspace cwd to ACP, and
    ACP executes filesystem/Git operations directly in its Registry service.
    No Pi runtime or conversation session is created, loaded, or required. A
    blocked sync remains pending and retries on a short idle cadence instead of
    dropping dirty state. While the actual background Registry RPC is in flight,
    Registry-panel actions are locally disabled so a manual Registry command
    cannot overlap it; unrelated Desktop UI remains available.
11. Dirty state is removed from the current batch before an RPC starts. If the
    same or another artifact changes while that RPC is in flight, the new dirty
    state survives and starts another debounced pass after the current pass
    completes.
12. Workspace changes reset coordinator state with a generation guard, so a late
    response from the previous workspace cannot clear or overwrite the new
    workspace's pending/sync UI state.
13. A retryable ACP busy race returns to `pending`. Other thrown background-sync
    failures, including authoritative snapshot errors, become an `error` state
    and retain the dirty artifacts. A later
    local edit or foreground Registry action can retry that retained state.
14. Opening or reading a workspace with no `.pi` directory is side-effect free:
    task/document reads return empty state and do not create `.pi` or modify
    `.gitignore`. The first Desktop write creates only the required storage:
    task creation initializes `.pi/tasks.sqlite`; plans create their needed
    `.pi/plans/` directories; settings write their configuration file; and
    attachment blobs may be saved before the first task row. These lazy writes
    do not constitute full Registry initialization. The optional **Initialize
    project Registry** action creates the complete scaffold: schema-v1
    `.pi/tasks.sqlite` with WAL, `.pi/plans/` and `.pi/task-attachments/`, then
    reloads project tasks and documents. Remote Registry setup is separate.
15. When a new `.pi` directory is created, Desktop appends `/.pi/` to the
    workspace root `.gitignore` before creating it, unless an existing literal
    `.pi`, `.pi/`, `/.pi` or `/.pi/` rule already covers it. Existing ignore
    rules and their LF/CRLF convention are preserved; this does not untrack
    files already tracked by Git. An already-existing `.pi` is not retroactively
    added to `.gitignore`. Permission or other write failures are reported and
    do not claim that the requested save succeeded. Plans, but not TODO,
    participate in Registry project-state sync.
16. `.pi/workspace.jsonc` is a project artifact with the same project-key,
    provenance, status, conflict confirmation, and push/pull semantics as tasks
    and plans; its remote path is `projects/<key>/workspace.jsonc`.
    Pulling it refreshes Desktop project settings; switching back to the scripts panel loads the
    pulled launch commands. The whole file is synchronized without redaction:
    do not put credentials or private shell arguments in it unless the private
    Registry remote is trusted to hold them. The Desktop ACP Registry request
    validator accepts `workspace` for `push-project`, `pull-project` and `sync-project`,
    while still rejecting unknown project scopes.
17. A workspace Git repository is optional. An explicit
    `resourceRegistry.projectKey` takes priority. Otherwise Registry derives a
    key from Git `remote.origin.url` when available. With neither, it silently
    generates a unique `local-<uuid>` identity in `.pi/registry-project-key`
    (atomic, persistent and preserved by Desktop Clean .pi). This fallback is
    reused across refreshes/restarts and independent across workspaces; it is
    never written as an explicit config override. If a valid `origin` later
    appears, its derived key takes precedence automatically, while the stored
    fallback remains available if `origin` is removed. Existing publications
    under a previous key are not silently moved or overwritten: provenance
    mismatch continues to require review. Missing `.pi` is not created by
    catalog refresh and does not generate a project-key warning; reads remain
    side-effect free, while Desktop writes lazily create only their required
    `.pi` storage. Full project-state scaffold initialization remains optional.
    Reusable skills/agents remain usable
    without Git. Interactive remote setup gives generic Git URL guidance when
    no remote is configured, rather than presenting an example repository as
    a usable value.
18. Pix Desktop presents reusable Registry resources as an IDE-style catalog.
    Project artifacts stay in the dedicated project-sync review surface and do
    not appear in the reusable-resource browser. Reusable resources that exist
    in this project appear under **Installed**, regardless of publication;
    remote resources without a local copy appear under **Available**.
    Each card separately shows a **Local** or **Published** badge, with
    synchronization/conflict state shown independently.
    Stale provenance entries with neither a local nor a current
    remote copy do not masquerade as Available entries. Search and resource-
    type filtering apply only within the active catalog section, while existing
    install/update/push/uninstall/remove actions keep their current Registry
    semantics. **Installed** shows project resources and remains available when no
    remote is configured; in that state the snapshot scans local skills/agents
    and exposes only local actions. **Available** is the uninstalled remote catalog and
    prompts for connection when no remote is configured. Project-state
    initialization is likewise independent: an uninitialized tasks/plans
    scaffold does not hide the reusable-resource catalog.
    Routine local project changes display automatic background sync rather
    than a manual review/push prompt; actual conflicts, missing keys, remote
    changes and errors retain review actions and diagnostics.
    Installed agent cards with an explicit `models` entry, legacy `model`, or
    `modelByParent` mapping expose a selector backed by the existing searchable
    model catalog. Automatic and `modelSelection: frontier` profiles are
    excluded. Choices and per-agent resets live separately in
    `.pi/agent-model-overrides.json` as version 1 project state with a `models`
    map; it is independent of authored agent content and Registry
    synchronization, hashing and publishing. Reset removes that agent's choice
    and restores the current authored profile/parent mapping. A chosen primary
    applies only to fresh launches and preserves authored profile and branch
    fallback candidates. Explicit task, CLI, global and environment choices
    retain higher priority; economy and vendor policies continue to apply.
    Malformed or unsafe state fails closed during runtime loading and is refused
    for Registry writes. Canonical project cleanup preserves this file.
19. Foreground Registry actions (refresh/install/update/push/pull/uninstall/
    remove) use Registry-local busy state and do not take Pix Desktop's global
    operation-running lock. The rest of the workbench remains interactive while
    Registry Git/filesystem work runs asynchronously in ACP.
    Workspace/client generation guards discard stale completions after
    a workspace switch or lifecycle reset. Registry-local controls may still be
    disabled while their own action is active. Local project initialization and
    reclaimable `.pi` cleanup follow the same rule: they use the Registry
    `actionId`, never the Desktop-global lock.
20. The ACP service returns an authoritative post-action snapshot directly;
    there is no extension widget event, runtime reload, or snapshot-event wait.
    Actions, diffs and their snapshots serialize access to the shared per-process
    disposable checkout and project provenance. Git runs in asynchronous child
    processes without a shell. Registry configuration retains the existing
    `resourceRegistry` JSONC layers and environment overrides for compatibility.
    Registry has no TUI module or `/registry` command.

## Compatibility

- There is no legacy `.pi/tasks.jsonc` or `.pi/tasks.d/` import, migration or
  fallback during ordinary Registry operations. Such files and local migration
  backups are ignored for dirty detection and not published; users retain
  control of their original files.
- SQLite schema v1 and canonical task attachments are the only supported
  Registry task representation. Task descriptions remain plain text; no legacy
  `file://` marker resolution or rebasing occurs.

## Invariants

- Registry attachment names cannot escape the task-attachment directory.
- Registry task attachments must be immutable SHA-256-named regular files;
  symbolic links, hard links and mismatched hashes are rejected.
- Task attachment references exist only in SQLite relations, not in text markers.
- Referenced attachment content participates in provenance hashing. A task push
  removes no-longer-referenced blobs from the remote Git artifact.
- Every successful Desktop task mutation reaches the background sync coordinator
  through the SQLite task save path; failed local persistence never
  schedules a remote push.
- Background project sync is coalesced to one in-flight Registry action. It does
  not force-push through provenance conflicts.
- The sidebar's cheap Registry task check hashes the same normalized task bundle
  as Registry provenance, including referenced attachment bytes, so a completed
  background push can converge back to a clean local indicator.
- Desktop full project-state scaffold initialization is optional and idempotent;
  ordinary Desktop writes lazily create only the storage they require. The
  initialized marker always requires the complete scaffold: a regular
  `.pi/tasks.sqlite` plus project-owned regular `.pi/plans/` and
  `.pi/task-attachments/` directories. A bare `.pi` directory or unrelated
  `.pi/pix.jsonc` is not initialized state. Existing task content is never
  overwritten, and `.pi` plus scaffold subdirectories must be regular
  project-owned directories rather than symbolic links escaping the workspace.
- Initialization inspects an already-existing `tasks.sqlite` before accepting a
  concurrent publication race: it must be a regular file canonically inside `.pi`,
  and its schema version must be compatible.
  An existing symbolic link, directory, or escaping target is an error, never
  an idempotent-success result.
- The Registry panel reports the logical byte size of the current project-owned
  `.pi` tree plus the currently reclaimable generated-junk byte count. Size
  traversal never follows symbolic-link targets; a missing `.pi` is represented
  as absent rather than as an alternate storage layout.
- Total and reclaimable bytes are returned by one native storage inspection so
  the panel does not duplicate full-tree traversal. Desktop bounds local project
  inspection waits to five seconds; a stalled or failed storage inspection ends
  the loading state with a local unavailable/timeout status, and a later Refresh
  starts a new inspection instead of leaving `Checking…` indefinitely.
- Registry cleanup is allowlist-based and never resets project state. The
  canonical top-level project directories are `agents/`, `artifacts/`,
  `plans/`, `search/`, `skills/`, `subagents/`, and `task-attachments/`.
  Unsupported legacy `tasks.d/` is not canonical and is reclaimable.
- Cleanup preserves the canonical `agents/`, `plans/`, `search/`, `skills/`, and
  `task-attachments/` trees, but removes every entry recursively inside
  `.pi/artifacts/` and `.pi/subagents/` while leaving those two container
  directories in place. Subagent cleanup preserves any scope containing
  owned-launch records; Manual Clean removes its other contents but retains
  `owned/` (unknown ownership fails closed) until async-subagent cleanup proves
  those launches drained and retired.
- `.pi/search/index.sqlite` is durable universal-search state, not disposable
  output. Manual Clean and TTL cleanup preserve the complete `search/` tree,
  including SQLite WAL/SHM sidecars. Session deletion prunes index rows; it does
  not delete the database. See [Desktop universal search](../../search/desktop-universal-search.md).
- Any other regular top-level directory directly under `.pi/` is non-canonical
  and is removed recursively. Top-level regular files are allowlist-based too:
  `AGENTS.md` (untracked personal rules for Pix context),
  `pi-tools-suite.jsonc`, `pix-desktop.jsonc`, `pix.jsonc`,
  `qa_auth.jsonc`, `registry.json`, `registry.jsonc`, `tasks.sqlite`, `tasks.sqlite-wal`,
  `tasks.sqlite-shm`, `tasks.sqlite-journal`, `todo-plan.json`,
  and `workspace.jsonc` are preserved; other ordinary top-level files
  (for example temporary receipt JSONs and unsupported legacy `tasks.jsonc`)
  are reclaimable. The existing cleanup of `.DS_Store`
  and stale Pix temporary files still applies, while fresh Pix temp files keep
  their stale-age protection. `.pi/TODO.md` is non-canonical and is eligible
  for Clean and normal 72-hour TTL cleanup; it is not eagerly deleted merely
  because Registry synchronization was retired. Desktop retains legacy TODO
  document read/edit compatibility, but TODO is not a Registry task-link
  suggestion or Registry project artifact.
- Previously recorded `projectResources.todo` provenance is ignored when read;
  provenance reads remain side-effect free. The next provenance write prunes
  that retired entry. Existing remote TODO files remain ignored and are not
  destructively removed.
- Recursive removal uses no-follow traversal: symbolic-link targets are never
  traversed or deleted. A root `.pi` symbolic link or non-directory is rejected
  rather than followed.
- When Desktop opens an already-initialized project, it starts the same cleanup
  policy in the background with a 72-hour TTL. The project open path does not
  wait for cleanup and the foreground operation lock is not taken.
- TTL cleanup treats each direct child of `.pi/artifacts/` and `.pi/subagents/`,
  each non-canonical top-level file/directory, and the other ordinary cleanup
  targets as one candidate. A candidate is removed only when its own modification
  time and every entry in its subtree are at least 72 hours old. The candidate
  is re-checked immediately before deletion so activity that begins during size
  accounting preserves it.
- Exception for parent-scoped sub-agent sessions
  ([decision 0072](../../decisions/0072-session-native-subagents.md)): a
  UUID-named `.pi/subagents/<parentSessionId>/` child is never removed by TTL
  cleanup while its parent session file exists. The parent is found through a
  child's `subagent_meta.parentSession` path or a `<timestamp>_<id>.jsonl` in the
  project's default Pi session directory (`PI_CODING_AGENT_DIR` or
  `~/.pi/agent`). Once the parent is gone, the directory is removed after
  24 hours of subtree inactivity. Unreadable directories and timestamp-named
  legacy run directories keep the 72-hour TTL. Manual Clean is unchanged.
  Deleting a parent session through ACP `session/delete` removes its
  `.pi/subagents/<parentSessionId>/` directory immediately, except a symlinked
  or non-UUID target or a directory that still contains `owned/`; a failed
  removal is logged and left to this background policy.
- Background cleanup is not run against a bare/uninitialized `.pi` directory.
  After it completes, Registry storage state is refreshed only if that project
  is still the active workspace. Manual Clean remains immediate and ignores the
  TTL.
- Desktop TODO and plan saves may lazily bootstrap a missing `.pi`, creating
  only their required document directories; task and settings saves likewise
  create only their required storage. A new `.pi` is ignored via a root
  `/.pi/` `.gitignore` entry before creation, without changing Git's treatment
  of already tracked files. Reads do not create storage. The optional full
  initialization action is distinct from these lazy writes. Attachments may be
  staged before the first task row; the eventual task save links them in
  SQLite.
- Markdown saves write and flush a temporary file through no-follow directory
  handles, then atomically replace the destination entry. A destination symlink
  installed before or during the save is replaced rather than followed.
- Concurrent Desktop full-scaffold initializers use create-or-inspect
  directories and SQLite transactions. On macOS, a first SQLite database is
  initialized in a private staging directory, explicitly checkpointed with
  `PRAGMA wal_checkpoint(TRUNCATE)` (requiring `busy == 0`), closed and flushed,
  then published with exclusive `renamex_np(..., RENAME_EXCL)`. A competing
  initializer cannot expose a version-zero database or replace an existing
  database/task rows; the published database is inspected before success.

## Related files

- `acp/src/registry/service.ts`
- `acp/src/registry/projects.ts`
- `acp/src/registry/task-bundle.ts`
- `acp/test/registry.test.ts`
- `acp/src/acp/desktop-commands.ts`
- `acp/test/desktop-commands.test.ts`
- `desktop/src-tauri/src/lib.rs`
- `desktop/src/app/registry.svelte.ts`
- `desktop/src/app/registry-startup.ts`
- `desktop/src/app/registry-startup.test.ts`
- `desktop/src/app/desktop-root-effects.svelte.ts`
- `desktop/src/app/registry-store.test.ts`
- `desktop/src/lib/registry.ts`
- `desktop/src/lib/registry-background-sync.ts`
- `desktop/src/lib/registry-project-sync.ts`
- `desktop/src/lib/registry-project-sync.test.ts`
- `desktop/src/components/RegistryPanel.svelte`
- `desktop/src/components/RegistryProjectStatus.svelte`
- `desktop/src/components/RegistryCatalog.svelte`
- `desktop/src/components/RegistryStatusIcon.svelte`
- `desktop/src/app/registry-project-storage.svelte.ts`
- `wiki/work-management/tasks/desktop.md`
- `wiki/desktop/conversations/desktop-attachments.md`

## Verification

- ACP `test/registry.test.ts` covers project-state push/pull,
  portable task attachments, attachment-only status changes, stale remote
  attachment removal, conflicts, and direct workspace-scoped operations.
- Desktop Rust task persistence tests cover reference-based local attachment
  pruning after successful task-document writes, idempotent `.pi` skeleton
  initialization without overwriting an existing task document, concurrent
  initialization with atomic task-skeleton publication, distinction between
  lazy writes and complete-scaffold initialized state, rejection of bare
  `.pi`/`.pi/pix.jsonc` initialized-marker bypasses and nonregular scaffold races,
  Unix symlink/nonregular scaffold rejection, symlink-safe Markdown replacement,
  and lazy document saves without full scaffold initialization. macOS first-db
  publication tests cover staging, checkpointing and exclusive publication.
- Desktop coordinator tests cover debounce, scope coalescing, busy deferral,
  changes during an in-flight push, retained error state, and foreground-lock
  independence.
- Registry store/panel tests cover local initialization without a ready ACP
  session, local `.pi` size/reclaimable-byte reporting and allowlist-based
  garbage cleanup, background TTL cleanup, stale-workspace lifecycle guards, and
  the Installed/Available separation and Local/Published badges for reusable resources.
  Sidebar tests cover
  pending/syncing/error presentation, initialization/storage wiring and the
  shared animated indicator. Rust coverage verifies that storage
  sizing/cleanup preserves the canonical data trees, empties artifacts/subagents,
  removes non-canonical top-level directories, applies the 72-hour TTL only to
  initialized projects, and does not follow symlink targets. The fast Registry
  check also uses task attachment bytes when comparing the `tasks` project
  artifact.
- ACP Desktop command tests cover `workspace` push/pull request validation and
  rejection of unknown scopes before the Registry RPC is dispatched.

## Risks / unknowns

- Legacy tasks that still reference arbitrary external `file://` paths remain
  non-portable until those attachments are re-saved into project task storage.
- Git remains the transport for attachment bytes, so very large or numerous
  task attachments can increase registry repository size over time even after
  current-state files are deleted from the latest tree.

## Evidence

- Confirmed by code: task push builds a normalized task bundle and copies only
  referenced project-owned attachments; task pull materializes the bundle and
  rebases markers to the destination workspace.
- Confirmed by tests: a pushed attachment is stored without the source
  workspace path, pulls into a new local task-attachment path, changes Registry
  status when its bytes change, and is removed remotely when no task references
  it.

<!-- pix:wiki-check {"version":1,"status":"attempted","runId":"be10804d-802a-4a0d-81f8-ba18fd60f930","contentHash":"29dcf59cb044227dac9896903b783248461c18532d344098988f9a36512d95a9","checkedAt":"2026-10-31T00:17:44.925Z","maxDocumentChars":128000} -->
