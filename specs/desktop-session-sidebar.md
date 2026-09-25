# Desktop session activity

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Add live views of the active session's execution Plan and Subagents to Pix Desktop, with a runtime-backed Plan clear action, without conflating either runtime surface with project tasks, and present that state in session-scoped IDE chrome rather than as a workspace-level destination.

## Scope

- Keep session activity out of the workspace Activity Bar; Project, Tasks, Source Control, Registry, Package Scripts, IDX, and Settings remain workspace/tool destinations.
- Give every visible session tab a compact semantic status icon derived from that session's own snapshots, prompt-running state, input attention, and unseen successful completion.
- Keep **Session activity** at the far-right edge of the status bar only when it conveys real hidden activity. When the inspector is closed and the active session has live Plan/Subagent activity, a compact summary shows the active agents' configured icons and completed/total Plan progress. Clicking any part of the summary opens the inspector. While the inspector is open, or when the active session has no visible Plan/Subagent activity, no Session status control is rendered.
- Add a right-side contextual **Session** inspector for the active session. On narrow windows it becomes an overlay so the primary transcript retains usable width.
- Use `Activity` for the inspector header, `Workflow` for the Agents section, and `ListChecks` for the Plan section.
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

## Behavior

- The Session inspector always reflects the active Desktop session; switching sessions switches both runtime views immediately and never leaks another session's snapshot.
- State may arrive before `session/new` resolves, so Desktop stages up to one snapshot per activity channel under its pending attachment token, then binds that activity to the returned ACP session ID. The visible snapshot follows the active ID.
- Snapshot freshness is tracked independently per channel within the current activity attachment. ACP tags each enqueued Todo/Subagent notification with its Desktop attachment token; Desktop ignores mismatched tokens after forget/reopen, regardless of `checkedAt`. The live ACP runtime caches the latest two channel snapshots and replays them on lazy reattachment, retaining their original timestamps. New/fork startup notifications stage under a bounded pending request until its response identifies the session. Closing/forgetting discards ownership without retaining historical ID tombstones.
- Inspector open/closed state is a Desktop IDE preference rather than session data, and opening it is always an explicit user action. New Plan/Subagent activity never auto-opens the pane. The preference is persisted best-effort in local storage, but an open or restored inspector automatically closes as soon as the active session has neither visible Plan todos nor live Subagents.
- Activity changes for a closed inspector update only the compact status-bar summary. They do not change the pane-open preference. Switching sessions follows the same rule: an inspector may remain open only while the newly active session has visible Plan/Subagent activity; an empty active session closes it immediately.
- Agents and Plan are independent native keyboard-accessible accordions with informative summary headers. They start collapsed without a snapshot, then use their first available snapshot to expand only when live agents or an open plan exist. A manual toggle before that snapshot takes precedence, and ordinary later snapshot updates never reset the accordion. Session switches reset these section defaults for the newly displayed session. DCP context capacity, category colors, savings, and statistics remain in the status-bar Context surface defined in [desktop-runtime-status.md](./desktop-runtime-status.md), rather than occupying a third Session-inspector section.
- With no active session, including while the selected conversation is a UI-only draft, no Session status control or inspector is rendered. With a real but activity-empty session, no inert Session button is rendered and an open inspector closes instead of showing an empty persistent pane.
- With an active session, Plan and Agents remain distinct sections and each shows a compact informational empty state when it has no live content.
- When at least one pending, in-progress, or deferred todo exists, all non-deleted todos are shown in stable hierarchy order, including completed items.
- The Plan header offers a compact, accessible Clear session plan action when its active session is ready and idle and has visible todos. It invokes private ACP `pix/session/clear_todos`, which dispatches the existing `/todos-clear` extension handler directly without running a user prompt, adding `/todos-clear` to chat, or creating a user transcript entry. It preserves the composer draft, reports request failures, disables while unavailable or in flight (including after inspector remounts or switching away and back), never mutates the displayed snapshot locally, and never toggles the Plan accordion. The ACP session lock is claimed before asynchronous work so duplicate clears cannot race; the existing extension handler remains authoritative for state publishing and persistence. Success depends on that handler, not an unrelated session-list metadata write.
- Subagents matches the TUI live-panel rule: only planned, running, or retrying agents are visible; terminal agents disappear with the next snapshot, and the section does not invent historical state.
- Multiple live runs remain distinct even when they reuse an agent id. Run and task ordering follows the source snapshot.
- The status HUD is intentionally denser than the inspector. While the inspector is closed, each live Subagent contributes its configured agent icon (falling back to the generic agent icon), with excess icons compacted behind a `+N` count, and an open Plan contributes `completed/total` progress such as `2/5`. The whole summary is one accessible button that opens the inspector. Once opened, the summary disappears completely; the inspector's own close control and the existing Session Activity command own closing.
- Background sessions remain observable from the top tab strip. The leading session status uses IDE-style semantic icons rather than a color-only dot: idle uses a success check, running prompt/live Subagent/in-progress Plan work uses a spinning info loader, elicitation waiting uses a warning question icon, and retrying Subagents or blocked Plan items use a warning triangle. A pending-only Plan does not masquerade as active execution.
- Successful completion that reaches the same fully-settled boundary used by Desktop notifications marks an inactive session tab as unseen-complete: the idle success check gains a small accent badge until that session tab is opened. The marker is cleared when the tab is viewed, when new work starts in that session, when the session is cleared, or when prompt/runtime state resets. Completion does not mark the session when its workbench tab is already selected.
- Status precedence is `needs-input` → `warning` → `running` → `unseen-complete` → `idle`, so a stale completion badge never masks current execution or attention. Fork identity remains a separate `GitFork` marker between the status icon and title.
- Elicitation attention stays attached to each requesting session when another tab becomes active, including when several background sessions are independently waiting for input.
- Tab activity never changes tab membership or order and does not replace the existing active-tab affordance.
- Plan is the Desktop label for the session-scoped todo execution surface; project-scoped work continues to use **Tasks**.
- The inspector is a connected workbench pane with compact rows and separators rather than nested cards. At normal widths it is a resizable auxiliary region with sensible bounds, pointer and keyboard resizing, and best-effort persisted width so repeated desktop work retains spatial memory. Below the narrow-window breakpoint it overlays the right edge of the workspace instead of shrinking the transcript further; its restored width remains constrained by the available window width.
- Desktop updates the derived activity summary only for the session whose Todo/Subagent snapshot changed. A live activity event does not rescan every retained session plan/run merely to refresh the tab strip or status HUD.

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
- `desktop/src/components/SessionInspector.svelte`
- `desktop/src/components/WorkbenchTabs.svelte`
- `desktop/src/components/StatusBar.svelte`
- `desktop/src/components/SessionSubagentsPanel.svelte`
- `desktop/src/components/SessionTodosPanel.svelte`
- `desktop/src/components/WorkspaceSidebar.svelte`
- `desktop/src/app/session-activity.svelte.ts`
- `desktop/src/app/desktop-presentation-state.svelte.ts`
- `desktop/src/app/desktop-status-bar-view-model.svelte.ts`
- `desktop/src/app/desktop-workbench-prop-builders.ts`

## Verification

- Suite tests cover RPC-only publishing for both runtime channels and preserve the existing event-bus snapshots.
- ACP tests cover startup delivery, envelope decoding, session scoping, and malformed payload rejection.
- Todo-clear tests cover private ACP routing without a user prompt/transcript, idle and duplicate-request guards, handler failure propagation, completion acknowledgement, and the existing hidden-snapshot replay contract.
- Desktop tests cover notification decoding; todo validation, deleted filtering, open-state semantics, and hierarchy; Subagents validation, active-state filtering, icon extraction, run grouping, elapsed labels, and stale/session-isolated snapshots; plus incremental session-activity summary/tone/progress derivation, close-only inspector policy, compact closed-panel status summary, background-session isolation, and attachment ownership across forget/reopen.
- `npm --prefix external/pi-tools-suite run check`
- `npm --prefix acp run check`
- `npm --prefix desktop test`
- `npm --prefix desktop run check`
- `npm --prefix desktop run build:web`
- `npm run check`
