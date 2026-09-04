# Spec: Desktop session sidebar

## Type

Change

## Goal

Add read-only, live views of the active session's Todos and Subagents to Pix Desktop without conflating either runtime surface with project tasks.

## Scope

- Add a third left-sidebar tab named **Session**.
- Use the `Activity` icon for the Session tab and `ListChecks` for its Todos section.
- Use `Workflow` for the Subagents section in the same tab.
- Bridge versioned, session-scoped extension state from pi RPC through a private ACP notification.
- Render the todo hierarchy, status, active form, thinking level, owner, and blockers read-only.
- Exclude deleted todos and match the TUI's rule that a completed-only snapshot has no open todo panel.
- Render active Subagents grouped by run, including status, agent id, model, task/scope preview, and elapsed time.

## Non-goals

- Creating, editing, deleting, or reordering todos from Desktop.
- Starting, stopping, opening, waiting for, or reading Subagent results from Desktop.
- Moving or changing project tasks stored in `.pi/tasks.json`.
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

- The Session tab always reflects the active Desktop session; switching sessions switches both runtime views immediately and never leaks another session's snapshot.
- State may arrive before `session/new` resolves, so Desktop retains snapshots by ACP session id and derives the visible one from the active id.
- Snapshot freshness is tracked independently per channel. A newer `checkedAt` snapshot wins over an older late notification.
- With no active session, the tab asks the user to open a session.
- With an active session, Todos and Subagents remain distinct sections and each shows a compact informational empty state when it has no live content.
- When at least one pending, in-progress, or deferred todo exists, all non-deleted todos are shown in stable hierarchy order, including completed items.
- Subagents matches the TUI live-panel rule: only planned, running, or retrying agents are visible; terminal agents disappear with the next snapshot, and the section does not invent historical state.
- Multiple live runs remain distinct even when they reuse an agent id. Run and task ordering follows the source snapshot.
- The tab remains useful when the sidebar is collapsed: its Activity button opens it and indicates when the active session has open todos or live Subagents.
- The sidebar's top-level accessible name is **Workspace sidebar**, because it now contains both project-scoped and session-scoped data.

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
- `desktop/src/components/SessionActivityPanel.svelte`
- `desktop/src/components/WorkspaceSidebar.svelte`
- `desktop/src/App.svelte`

## Verification

- Suite tests cover RPC-only publishing for both runtime channels and preserve the existing event-bus snapshots.
- ACP tests cover startup delivery, envelope decoding, session scoping, and malformed payload rejection.
- Desktop tests cover notification decoding; todo validation, deleted filtering, open-state semantics, and hierarchy; plus Subagents validation, active-state filtering, run grouping, elapsed labels, and stale/session-isolated snapshots.
- `npm --prefix external/pi-tools-suite run check`
- `npm --prefix acp run check`
- `npm --prefix desktop test`
- `npm --prefix desktop run check`
- `npm --prefix desktop run build:web`
- `npm run check`
