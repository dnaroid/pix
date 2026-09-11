# Desktop session activity

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Add read-only, live views of the active session's execution Plan and Subagents to Pix Desktop without conflating either runtime surface with project tasks, and present that state in session-scoped IDE chrome rather than as a workspace-level destination.

## Scope

- Keep session activity out of the workspace Activity Bar; Project, Tasks, Source Control, Registry, Package Scripts, IDX, and Settings remain workspace/tool destinations.
- Give every visible session tab a compact per-session runtime indicator derived from that session's own snapshots and prompt-running state.
- Add a compact **Session activity** HUD/control to the status bar. It remains the persistent entry point for the active session inspector and expands to show live Subagent count and Plan progress when relevant.
- Add a right-side contextual **Session** inspector for the active session. On narrow windows it becomes an overlay so the primary transcript retains usable width.
- Use `Activity` for the inspector/status entry point, `Workflow` for the Agents section, and `ListChecks` for the Plan section.
- Bridge versioned, session-scoped extension state from pi RPC through a private ACP notification.
- Render the todo hierarchy, status, active form, thinking level, owner, and blockers read-only.
- Exclude deleted todos and match the TUI's rule that a completed-only snapshot has no open todo panel.
- Render active Subagents grouped by run, including status, agent id, model, task/scope preview, and elapsed time.

## Non-goals

- Creating, editing, deleting, or reordering todos from Desktop.
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
- State may arrive before `session/new` resolves, so Desktop retains snapshots by ACP session id and derives the visible one from the active id.
- Snapshot freshness is tracked independently per channel. A newer `checkedAt` snapshot wins over an older late notification. Forgetting/closing a runtime records a per-session freshness barrier, so an already-queued pre-close Todo/Subagent notification cannot repopulate cleared activity after the runtime is gone; a later snapshot from a reopened runtime is accepted normally.
- Inspector open/closed state is a Desktop IDE preference rather than session data. Keeping the inspector open across tab changes preserves spatial memory while its contents follow `activeSessionId`; the preference is persisted best-effort in local storage.
- With no active session, the status-bar entry is disabled; an already-open inspector shows a compact empty state until a session becomes active.
- With an active session, Plan and Agents remain distinct sections and each shows a compact informational empty state when it has no live content.
- When at least one pending, in-progress, or deferred todo exists, all non-deleted todos are shown in stable hierarchy order, including completed items.
- Subagents matches the TUI live-panel rule: only planned, running, or retrying agents are visible; terminal agents disappear with the next snapshot, and the section does not invent historical state.
- Multiple live runs remain distinct even when they reuse an agent id. Run and task ordering follows the source snapshot.
- The status HUD is intentionally denser than the inspector: idle state renders a compact Session entry point, while active state may show the live Subagent count and completed/total Plan progress.
- Background sessions remain observable from the top tab strip. Running prompts/live Subagents use an info/running signal; retrying Subagents, blocked Plan items, or a session waiting for elicitation input use warning semantics. Elicitation attention stays attached to each requesting session when another tab becomes active, including when several background sessions are independently waiting for input. A pending-only Plan does not masquerade as active execution.
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
- `desktop/src/lib/session-todos.ts`
- `desktop/src/lib/session-subagents.ts`
- `desktop/src/lib/session-activity.ts`
- `desktop/src/components/SessionInspector.svelte`
- `desktop/src/components/SessionTabs.svelte`
- `desktop/src/components/StatusBar.svelte`
- `desktop/src/components/SessionSubagentsPanel.svelte`
- `desktop/src/components/SessionTodosPanel.svelte`
- `desktop/src/components/WorkspaceSidebar.svelte`
- `desktop/src/App.svelte`

## Verification

- Suite tests cover RPC-only publishing for both runtime channels and preserve the existing event-bus snapshots.
- ACP tests cover startup delivery, envelope decoding, session scoping, and malformed payload rejection.
- Desktop tests cover notification decoding; todo validation, deleted filtering, open-state semantics, and hierarchy; Subagents validation, active-state filtering, run grouping, elapsed labels, and stale/session-isolated snapshots; plus incremental session-activity summary/tone/progress derivation, background-session isolation, and the post-forget freshness barrier.
- `npm --prefix external/pi-tools-suite run check`
- `npm --prefix acp run check`
- `npm --prefix desktop test`
- `npm --prefix desktop run check`
- `npm --prefix desktop run build:web`
- `npm run check`
