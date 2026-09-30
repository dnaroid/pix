---
kind: spec
status: active
---

# Session quota wait

## Behavior

Desktop and TUI automatically retain a failed task when the provider reports an
exhausted subscription usage limit (hourly/five-hour or weekly). A generic 429
alone is insufficient: a fresh quota query must corroborate exhaustion. Billing,
authentication, context-size, network and ordinary server errors keep their
existing error/retry behavior.

Waiting is distinct from manual turn-boundary pause. The centered popup shows
the exhausted window and a live countdown to the reset check, or to the next
availability check when reset time is unknown. It offers **Try now**, **Cancel
auto-resume**, and **Hide**. Hiding only dismisses the popup; the status indicator
and `/quota-wait` can reopen it. Cancelling disables automatic checks and
continuation, but keeps the task available for a manual probe.

At the deadline a fresh provider quota query precedes continuation. Both hourly
and weekly windows must permit work; the later exhausted reset wins. Without a
supported quota endpoint, a hidden continuation of the same task acts as the
probe. Unknown reset times use exponential backoff from one minute, capped at
15 minutes. A failed quota API request defers the automatic probe rather than
treating a network failure as replenishment. **Try now** may deliberately probe
despite an exhausted or unavailable quota endpoint.

Wait transitions are non-model-context custom session entries. On reopening the
active branch, waiting is restored and immediately checked, not blindly delayed
until an old deadline. Available quota resumes an automatically waiting task;
cancelled auto-resume never restarts a task on reopening. There is no process or
timer while the application is closed. Manual new input or a model change
supersedes the old wait. Successful continuation clears it. Repeated exhaustion
returns to waiting without losing the task or replaying completed tool calls.

## Constraints and failure cases

- Only failed provider turns start a wait; quota display forecasts alone do not.
- Session shutdown/replacement invalidates timers and in-flight quota checks.
- Repeated timer ticks/actions coalesce; stale completions cannot restart another
  session or undo cancellation. Network work is asynchronous.
- Host automatic message queues do not drain while a quota wait is present.
- Short-lived SDK retries are stopped at the completed agent-run boundary when
  subscription exhaustion is identified; no tool batch is interrupted.
- Reset data depends on provider availability. Unknown or unparseable reset
  timestamps must not be represented as an exact replenishment guarantee.
- The automatic probe is a real model request and may consume replenished quota.

## Implementation

- `src/app/session/quota-wait.ts`
- `src/bundled-extensions/quota-wait/index.ts`
- `src/bundled-extensions/quota-wait/usage.ts`
- `src/bundled-extensions/quota-wait/popup.ts`
- `src/app/runtime.ts`
- `src/app/app.ts`
- `src/app/session/queued-message-controller.ts`
- `src/app/types.ts`
- `src/app/popup/popup-menu-controller.ts`
- `src/app/rendering/render-controller.ts`

## Tests

- `tests/quota-wait.test.ts`
- `tests/quota-wait-extension.test.ts`

## Verification

Build the TUI, ACP and Desktop; run deterministic state-machine, extension,
queue and session ownership tests. Verify both real interfaces show a centered
countdown and preserve waiting when hidden, with actionable blocked reports if
the environment cannot run either application.
