# Spec: Retry action for exhausted automatic retries

## Type

Change

## Goal

Let the user resume a failed turn directly from the final automatic-retry error toast instead of typing a continuation prompt.

## Scope

- Add one optional clickable action to compact toasts.
- Show a `Retry` action when an automatic retry cycle ends unsuccessfully.
- Start a new turn with a hidden continuation message when the action is clicked.
- Keep toast actions scoped to the tab/session that created them.

## Non-goals

- Changing the SDK automatic-retry policy or attempt count.
- Exposing arbitrary toast actions through the public extension UI API.
- Retrying while the captured session is streaming, compacting, replaced, or no longer active.

## Behavior

1. A failed `auto_retry_end` event shows the existing persistent error text plus a `[Retry]` action row.
2. Clicking `[Retry]` dismisses the toast and invokes its action once. Clicking the error text still copies the error; it does not retry.
3. The action starts a turn by sending a non-displayed `pix-retry` custom message whose content asks the agent to continue the previous task.
4. A successful `auto_retry_end` keeps the existing success toast and has no action.
5. If the original session is no longer active, the action does nothing. If it is currently streaming or compacting, Pix shows a warning instead of starting another turn.
6. A synchronous or asynchronous failure to start the turn is shown as an error toast.

## Contracts

- Toast action callbacks are stored in `AppToastController`, not in render state.
- Action callbacks are removed when their toast is activated, dismissed, timed out, or globally cleared.
- Compact toast rendering reserves one row for the action when at least two overlay rows are available, so a long error cannot hide it.
- Action hit targets cover only the rendered action label.
- Continuation message: custom type `pix-retry`, content `Continue the previous task from where you stopped.`, `display: false`, and `triggerTurn: true`.

## Edge cases

- With only one available overlay row, the message remains visible and the action is omitted.
- Rapid repeated clicks cannot start multiple turns because activation removes the toast and callback before invoking it.
- Switching tabs before clicking cannot resume the stale session.
- Switching tabs while extension binding or message delivery is pending does not update the new active session's status or show a misleading failure there.

## Related files

- `src/ui.ts`
- `src/app/rendering/toast-controller.ts`
- `src/app/rendering/toast-renderer.ts`
- `src/app/screen/mouse-controller.ts`
- `src/app/session/session-event-controller.ts`
- `src/app/app.ts`

## Verification

- Toast renderer tests for action-row reservation and hit bounds.
- Toast controller tests for scoped one-shot activation and callback cleanup.
- Mouse controller tests for action activation versus error copying/dismissal.
- Session event tests for failed-only action wiring and captured-session retry.
- Host checks via `npm run check`.

## Risks / unknowns

- The SDK has no public manual retry primitive. A hidden custom message with `triggerTurn: true` intentionally models the user's current manual “continue” workaround.

## Evidence

- Confirmed by SDK types: `AgentSession.sendCustomMessage` accepts `display: false` and `triggerTurn: true`.
- Confirmed by code: failed automatic retries currently end in a persistent error toast.
- Confirmed by tests: compact error-toast body clicks currently copy the error text.
