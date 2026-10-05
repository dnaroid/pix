# Desktop session activity HUD

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Show live execution Plan, Subagents, and brainstorm activity for the active session in session-scoped IDE chrome, with a runtime-backed Plan clear action, without conflating runtime plans with project tasks. Plan and Subagents are presented through compact status-bar popups, not a persistent Session side pane.

## Scope

- Keep session activity out of the workspace Activity Bar; Project, Tasks, Source Control, Registry, Package Scripts, IDX, and Settings remain workspace/tool destinations.
- Give every visible session tab a compact semantic status icon derived from that session's own snapshots, prompt-running state, input attention, and unseen successful completion.
- Keep **Session activity** at the far-right edge of the status bar only when it conveys live Plan/Subagent activity. A compact summary shows active agents' configured icons and completed/total Plan progress; each activity popup is independently accessible from the status bar.
- Do not mount or persist a Session inspector. HUD availability depends only on active-session activity; no prior pane preference can hide it.
- Bridge versioned, session-scoped extension state from pi RPC through a private ACP notification.
- Render the todo hierarchy, status, active form, thinking level, owner, and blockers read-only.
- Exclude deleted todos and match the TUI's rule that a completed-only snapshot has no open todo panel.
- Render active Subagents grouped by run, including status, agent id, model, task/scope preview, and elapsed time.

## Non-goals

- Creating, editing, or reordering todos from Desktop, or directly mutating todo state outside the runtime command path.
- Starting, stopping, opening, waiting for, or reading Subagent results from Desktop.
- Moving or changing project tasks stored in `.pi/tasks.jsonc`.
- Showing historical completed, failed, or stopped Subagents after they leave the live widget.
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
- The Plan popup offers a compact, accessible Clear session plan action when its active session is ready and idle and has visible todos. It invokes private ACP `pix/session/clear_todos`, which dispatches the existing `/todos-clear` extension handler directly without running a user prompt, adding `/todos-clear` to chat, or creating a user transcript entry. It preserves the composer draft, reports request failures, disables while unavailable or in flight (including after popup remounts or switching away and back), and never mutates the displayed snapshot locally. The ACP session lock is claimed before asynchronous work so duplicate clears cannot race; the existing extension handler remains authoritative for state publishing and persistence. Success depends on that handler, not an unrelated session-list metadata write.
- Subagents matches the TUI live-panel rule: only planned, running, or retrying agents are visible; terminal agents disappear with the next snapshot, and the section does not invent historical state.
- Multiple live runs remain distinct even when they reuse an agent id. Run and task ordering follows the source snapshot.
- Status-HUD click popups show agent role, identity, status, elapsed time, task/scope, model, latest activity, and retry count. Agent id and run path have accessible labels. Run date/time labels are not displayed; run grouping and accessible run identity remain intact. Model footers show the shared provider icon beside recognized providers.
- Each of the first six live Subagents contributes its configured agent icon (falling back to the generic icon) as an accessible status-bar popup, with excess icons compacted behind a `+N` popup listing the remaining agents. Running and retrying icons pulse gently; planned icons remain still, and reduced-motion preferences disable the pulse. All status-bar popups toggle on click, Enter or Space, never hover or mere focus. Pointer departure leaves them open; repeat activation, Escape, outside click or focus leaving the region dismisses them. Escape restores trigger focus. An open Plan contributes a neighboring `completed/total` progress popup; it reveals the full non-deleted Plan in stable hierarchy order, including completed items and each task's subject, status, active form/description, thinking, owner, and blockers. The bounded list is scrollable and centers the current item on popup open using `in_progress` → `pending` → `deferred` priority. See [0048](../docs/decisions/0048-status-bar-click-popups.md).
- Background sessions remain observable from the top tab strip. The leading session status uses IDE-style semantic icons rather than a color-only dot: idle uses a success check, a running prompt or live Subagent uses a spinning info loader, elicitation waiting uses a warning question icon, and retrying Subagents use a warning triangle. Blocked Plan items are normal dependency-waiting state and do not trigger a tab warning. Plan status alone, including an in-progress item retained after execution stops, does not masquerade as active execution; its progress remains visible in the tab tooltip and Session activity surfaces.
- Successful completion that reaches the same fully-settled boundary used by Desktop notifications marks an inactive session tab as unseen-complete: the idle success check gains a small accent badge until that session tab is opened. The marker is cleared when the tab is viewed, when new work starts in that session, when the session is cleared, or when prompt/runtime state resets. Completion does not mark the session when its workbench tab is already selected.
- Status precedence is `needs-input` → `warning` → `running` → `unseen-complete` → `idle`, so a stale completion badge never masks current execution or attention. Fork identity remains a separate `GitFork` marker between the status icon and title.
- Elicitation attention stays attached to each requesting session when another tab becomes active, including when several background sessions are independently waiting for input.
- Tab activity never changes tab membership or order and does not replace the existing active-tab affordance.
- Plan is the Desktop label for the session-scoped todo execution surface; project-scoped work continues to use **Tasks**.
- Desktop updates the derived activity summary only for the session whose Todo/Subagent snapshot changed. A live activity event does not rescan every retained session plan/run merely to refresh the tab strip or status HUD.

The status HUD Plan control vertically centers its `completed/total` count next
to a compact circular progress ring in place of the todo icon. The ring fills
clockwise from the top according to the completed fraction; no linear progress
track is rendered. Visibility depends only on live activity; click popup behavior
follows decision 0048.

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
