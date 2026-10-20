# Desktop session activity HUD

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Show live execution Plan and Subagents activity (brainstorm council participants are ordinary sub-agents) for the active session in session-scoped IDE chrome, with a runtime-backed Plan clear action, without conflating runtime plans with project tasks. Plan and Subagents are presented through compact status-bar popups, not a persistent Session side pane.

## Scope

- Keep session activity out of the workspace Activity Bar; Project, Work,
  Source Control, Registry, Package Scripts, Search indexes, and Settings remain
  workspace/tool destinations. Work contains the project Tasks and Plans views;
  session activity steps remain distinct from project work.
- Give every visible session tab a compact semantic status icon derived from that session's own snapshots, prompt-running state, input attention, and unseen successful completion.
- Keep **Session activity** at the far-right edge of the status bar only when it conveys live Plan/Subagent activity. A compact summary shows active agents' configured icons and completed/total Plan progress; each activity popup is independently accessible from the status bar.
- Do not mount or persist a Session inspector. HUD availability depends only on active-session activity; no prior pane preference can hide it.
- Bridge versioned, session-scoped extension state from pi RPC through a private ACP notification.
- Render the todo hierarchy, status, active form, thinking level, owner, and blockers read-only.
- Exclude deleted todos and match the TUI's rule that a completed-only snapshot has no open todo panel.
- Render active Subagents grouped by run, including status, agent id, model, task/scope preview, and elapsed time.

## Non-goals

- Creating, editing, or reordering todos from Desktop, or directly mutating todo state outside the runtime command path.
- Starting, stopping, waiting for, or reading Subagent results from Desktop. (Opening a Subagent's persisted session as a read-only tab is supported; see Sub-agent session viewers.)
- Moving or changing project tasks stored in `.pi/tasks.sqlite`.
- A separate finished-Subagent list in the HUD; finished agents are reachable from the Subagent statistics dialog and `subagents` tool cards.
- Persisting a second Desktop-owned copy of extension state.

## Transport contract

- Pix ACP opts its child process into the bridge with `PIX_ACP_SESSION_STATE_BRIDGE=1`. Other RPC hosts never receive the private widget.
- An extension publishes a generic RPC session-state envelope through the supported fire-and-forget `setWidget` RPC UI method, using the reserved widget key `pix.session-state`.
- The widget lines are the event channel followed by its JSON payload. Todo uses channel `pi-tools-suite:todo:state`; Subagents uses `pi-tools-suite:async-subagents:live-state`. Both retain their existing version-1 snapshots.
- Pix ACP recognizes only that reserved key, validates and decodes the envelope, then emits private notification `pix/session-state` with `{ sessionId, channel, data }`.
- Other ACP clients can ignore the private notification. Ordinary extension widgets retain their existing behavior.
- The bridge stays channel-agnostic; adding Subagents does not add another ACP method or transport.
- Startup events must not be lost while the pi RPC subprocess is starting. The ACP wrapper subscribes before startup and the session is registered before events can be routed.
- Desktop validates the generic notification and each channel payload independently. Malformed, unknown-version, stale, or wrong-session data is ignored.
- The removed `workspace` tool no longer changes conversation cwd. Legacy `workspace` state envelopes do not update ACP session cwd, the translator, persisted session-map records or Desktop catalog cwd. See [Conversation workspace](workspace.md).

## Behavior

- The status HUD always reflects the active Desktop session; switching sessions switches runtime views immediately and never leaks another session's snapshot.
- State may arrive before `session/new` resolves, so Desktop stages up to one snapshot per activity channel under its pending attachment token, then binds that activity to the returned ACP session ID. The visible snapshot follows the active ID.
- Snapshot freshness is tracked independently per channel within the current activity attachment. ACP tags each enqueued Todo/Subagent notification with its Desktop attachment token; Desktop ignores mismatched tokens after forget/reopen, regardless of `checkedAt`. The live ACP runtime caches the latest two channel snapshots and replays them on lazy reattachment, retaining their original timestamps. New/fork startup notifications stage under a bounded pending request until its response identifies the session. Closing/forgetting discards ownership without retaining historical ID tombstones.
- With no active session, including while the selected conversation is a UI-only draft, no session activity HUD is rendered. With a real but activity-empty session, no inert Session status control is rendered.
- When at least one pending, in-progress, or deferred todo exists, all non-deleted todos are shown in stable hierarchy order, including completed items.
- The **Session steps** popup offers a compact, accessible **Clear session steps** action when its active session is ready and idle and has visible todos. It invokes private ACP `pix/session/clear_todos`, which dispatches the existing `/todos-clear` extension handler directly without running a user prompt, adding `/todos-clear` to chat, or creating a user transcript entry. It preserves the composer draft, reports request failures, disables while unavailable or in flight (including after popup remounts or switching away and back), and never mutates the displayed snapshot locally. The ACP session lock is claimed before asynchronous work so duplicate clears cannot race; the existing extension handler remains authoritative for state publishing and persistence. Success depends on that handler, not an unrelated session-list metadata write.
- Each Steps row offers one quiet icon action. **Go to where step #N started** scrolls the transcript to the newest successful `todo` call that set the step `in_progress` (falling back to the call that created it), expanding its collapsed activity group and briefly highlighting the revealed entry (~1.6 s primary tint via `data-transcript-highlight`; a newer reveal moves the mark, teardown clears it, and reduced motion disables the fade). The scan runs newest-first and stops at a plan boundary (`clear`, or `create`/`batch_create`/`import` with `replace: true`) so superseded plans with colliding ids are not matched; while no boundary is loaded it pages older history in (bounded, superseded by a newer jump or session switch) and reports an error if the start is not found. ACP lazy history keeps `rawInput` for `todo` calls (as for `question`) so this works without hydrating deferred results. Jump navigation remains available while a prompt runs. The action is absent for read-only sub-agent viewers and drafts.
- Subagents matches the TUI live-panel rule: only planned, running, or retrying agents are visible as live indicators; terminal agents leave the live list with the next snapshot, and the section does not invent historical state.

### Sub-agent session viewers

- Entry points: an "Open session" action in each live agent popup, each run row of the Subagent statistics dialog, and "Open <agentId> session" buttons in an expanded completed `subagents` tool card (targets read only from structured result details `{runDir, agents[]}` / `{runDir, agentId}`, never from result text; at most 12 per card). The async-subagents completion custom message has no Desktop transcript rendering and therefore no entry point. They call private ACP `pix/subagents/open_session { sessionId, runDir, agentId }`, which validates the run/agent path (realpath containment, no symlinked agent dir, session file inside the agent `sessions/` dir), registers or reuses a session-map record carrying `subagent: { runDir, agentId, parentSessionId }`, and returns the viewer session id. Desktop refreshes the catalog and selects it.
- Viewers never start a Pi process and never open the sub-agent JSONL through a Pi runtime (that could append to a file owned by the parent). `session/load`/`session/resume` return only `_meta["pix.subagent"]` with `{ terminal, revision }`; history comes from the persisted file. Desktop never marks a viewer runtime-ready, so queue/runtime-status/usage requests are not sent; the composer is replaced by a read-only banner. `open_session`/`session_state` may also return display-only `model { provider, modelId, name, thinking? }` and `context { tokens, contextWindow, percent }`, read incrementally from the JSONL (last `model_change`/`thinking_level_change`, last valid assistant usage; compaction resets tokens to unknown) with the context window from ACP's local model catalogue. The status bar shows them instead of skeletons, non-configurable. The banner's run name renders the UTC run-directory stamp in local time, and its Running/Finished state is cached per viewer so re-renders never flash "Checking…". All write paths reject viewer records.
- The banner shows agent, run, and Running/Finished state, and polls `pix/subagents/session_state` every 2s while non-terminal; when `revision` (file size:mtime) changes it replaces the transcript from persisted history. Polling stops on tab switch, terminal state, or error.
- "Continue in new session" calls `pix/subagents/fork_session`: ACP copies a snapshot truncated at the last complete line, forks it into the default session directory as an ordinary session whose header points to the original, and Desktop selects it. "Open parent" returns to the parent session when known.
- Closing a viewer tab only hides it; deleting forgets the map record and never touches the sub-agent files.
- Viewer sessions are hidden by default from both saved-session lists (titlebar session selector and the session-start saved-conversation selector); each shows a "Show sub-agent sessions" checkbox (only when such viewers exist, not persisted) to reveal them. On the session-start selector, its compact toolbar contains the search input and, when applicable, the checkbox; it wraps only at narrow widths. Typing filters local title previews, and Enter submits indexed search. Indexed search on the start screen never returns sub-agent viewers. When shown, a viewer nests in the saved-session tree under the conversation that opened it (`pix.subagent.parentSessionId`; a missing parent leaves it at the root) and its row carries a Bot icon beside the session title, without an agent-id badge. ACP excludes them from project session search/indexing: they are ephemeral, owned by the parent, and their results already appear in the parent transcript.
- Multiple live runs remain distinct even when they reuse an agent id. Run and task ordering follows the source snapshot.
- Status-HUD click popups show agent role, identity, status, elapsed time, task/scope, model, latest activity, and retry count. Agent id and run path have accessible labels. Run date/time labels are not displayed; run grouping and accessible run identity remain intact. Model footers show the shared provider icon beside recognized providers.
- Steps and individual-agent popups grow with their content up to the application
  window content height minus 70px (never below zero), including their header
  and footer. Their scrollable bodies have no separate 40vh/18rem height cap;
  they consume the remaining surface height, keeping the header and agent footer
  visible. Steps still centers the current task within that body on opening.
- Each of the first six live Subagents contributes its configured agent icon (falling back to the generic icon) as an accessible status-bar popup, with excess icons compacted behind a `+N` popup listing the remaining agents. Running and retrying icons pulse gently; planned icons remain still, and reduced-motion preferences disable the pulse. All status-bar popups toggle on click, Enter or Space, never hover or mere focus. Pointer departure leaves them open; repeat activation, Escape, outside click or focus leaving the region dismisses them. Escape restores trigger focus. An open Steps indicator contributes a neighboring `completed/total` progress popup; it reveals the full non-deleted session todo hierarchy in stable order, including completed items and each task's subject, status, active form/description, thinking, owner, and blockers. The bounded list is scrollable and centers the current item on popup open using `in_progress` → `pending` → `deferred` priority. Its indicator retains a circular tool-info progress ring. See [0048](../docs/decisions/0048-status-bar-click-popups.md).
- Background sessions remain observable from the top tab strip. The leading session status uses IDE-style semantic icons rather than a color-only dot: idle uses a success check, a running prompt or live Subagent uses a spinning info loader, elicitation waiting uses a warning question icon, and retrying Subagents use a warning triangle. Blocked Plan items are normal dependency-waiting state and do not trigger a tab warning. Plan status alone, including an in-progress item retained after execution stops, does not masquerade as active execution; its progress remains visible in the tab tooltip and Session activity surfaces.
- Successful completion that reaches the same fully-settled boundary used by Desktop notifications marks an inactive session tab as unseen-complete: the idle success check gains a small accent badge until that session tab is opened. The marker is cleared when the tab is viewed, when new work starts in that session, when the session is cleared, or when prompt/runtime state resets. Completion does not mark the session when its workbench tab is already selected.
- Status precedence is `needs-input` → `warning` → `running` → `unseen-complete` → `idle`, so a stale completion badge never masks current execution or attention. Fork identity remains a separate `GitFork` marker between the status icon and title.
- Elicitation attention stays attached to each requesting session when another tab becomes active, including when several background sessions are independently waiting for input.
- Tab activity never changes tab membership or order and does not replace the existing active-tab affordance.
- The Steps popup's `Task:` label for an executing plan wraps long task names and
  does not use a native title tooltip.
- Session todo progress is labeled **Steps** in the status HUD, tab activity labels and subagent todo progress; project-scoped work continues to use **Tasks**. The popup label is **Session steps**, its heading is **Steps**, and its accessible scroll region is **Session step list**.
- Desktop updates the derived activity summary only for the session whose Todo/Subagent snapshot changed. A live activity event does not rescan every retained session plan/run merely to refresh the tab strip or status HUD.

The status HUD Steps control vertically centers its `completed/total` count next
to a compact circular progress ring in place of the todo icon. The ring fills
clockwise from the top according to the completed fraction; no linear progress
track is rendered. Visibility depends only on live activity; click popup behavior
follows decision 0048.

- A session launched from a saved plan shows an **Executing plan** status-bar
  chip immediately left of the session activity/Steps HUD, only for live,
  non-draft, non-viewer sessions whose plan still exists in the current project
  documents snapshot. The chip shows saved checklist progress as the same ring
  as the Steps HUD (no icon) in the plan colour (`text-tool-skill`) and `N/M`,
  or `—` without checklist items; its click popup identifies the plan, explains that this
  is saved-file checklist progress distinct from live session Steps, and offers
  **Open plan** to open Preview. While mounted it refreshes project documents
  every three seconds in the foreground. Deleted or renamed plans no longer show
  the chip. Launch association is workspace-scoped in localStorage under
  `pix.desktop.planLaunches:<workspace>`, retaining at most 50 newest canonical
  `.pi/plans` launches; stale/reset launches are not recorded.
- If the executing plan is linked to a project task, the chip's popover includes
  **Task › Plan › This session** breadcrumbs, with the Task segment omitted when
  unlinked. The Steps popup's **Executing plan** block also shows
  `Task: <label>`. Breadcrumbs live in the chip popover because Desktop has no
  session header.
- In the Steps popup, the **Executing plan** block appears above the **Steps**
  header. Its plan-label button opens the plan Preview, and its progress ring
  (same ring as Steps, no icon, plan colour `text-tool-skill`) is saved-file
  checklist progress distinct from live session Steps. The Run
  prompt and `external/pi-tools-suite/docs/plan-writing.md` require saving each
  verified checklist item as `[x]` immediately; finer sub-steps stay in session
  Steps.

## Related files

- `external/pi-tools-suite/src/lib/rpc-session-state.ts`
- `external/pi-tools-suite/src/todo/todo.ts`
- `external/pi-tools-suite/src/async-subagents/index.ts`
- `acp/src/pi/pi-rpc-client.ts`
- `acp/src/acp/session-state-bridge.ts`
- `acp/src/acp/pix-acp-agent.ts`
- `desktop/src/lib/acp-client.ts`
- `desktop/src/lib/acp-client-types.ts`
- `desktop/src/lib/session-todos.ts`
- `desktop/src/lib/session-subagents.ts`
- `desktop/src/lib/session-activity.ts`
- `desktop/src/components/WorkbenchTabs.svelte`
- `desktop/src/components/StatusBar.svelte`
- `desktop/src/components/SessionActivityStatusHud.svelte`
- `desktop/src/components/StatusBarPopover.svelte`
- `desktop/src/components/WorkspaceSidebar.svelte`
- `desktop/src/app/session-activity.svelte.ts`
- `desktop/src/app/desktop-presentation-state.svelte.ts`
- `desktop/src/app/desktop-status-bar-view-model.svelte.ts`
- `desktop/src/app/desktop-workbench-prop-builders.ts`

## Verification

- Suite tests cover RPC-only publishing for both runtime channels and preserve the existing event-bus snapshots.
- ACP tests cover startup delivery, envelope decoding, session scoping, and malformed payload rejection.
- Todo-clear tests cover private ACP routing without a user prompt/transcript, idle and duplicate-request guards, handler failure propagation, completion acknowledgement, and the existing hidden-snapshot replay contract.
- Desktop tests cover notification decoding; todo validation, deleted filtering, hierarchy, and current-item priority; Subagents validation, active-state filtering, indicator detail projection, icon extraction, run grouping, elapsed labels, and stale/session-isolated snapshots; plus incremental session-activity summary/tone/progress derivation, detailed status HUD presentation, background-session isolation, and attachment ownership across forget/reopen.
- `npm --prefix external/pi-tools-suite run check`
- `npm --prefix acp run check`
- `npm --prefix desktop test`
- `npm --prefix desktop run check`
- `npm --prefix desktop run build:web`
- `npm run check`
