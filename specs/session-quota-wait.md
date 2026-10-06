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

Waiting can start automatically after exhaustion or be scheduled manually with
`/wait usage-reset` (wait for available quota) or `/wait 1h20m` (compound duration
using days, hours, minutes, seconds; one second to 32 days), or
`/wait until <ISO timestamp with timezone>` (a future instant within 32 days).
The duration is saved
as an absolute deadline, so restarting does not restart the clock. A future
deadline is not shortened by a successful quota check on reopening. At expiry,
quota still must permit work; exhausted quota extends the wait.

Desktop's composer menu offers **Schedule continuation…**. Its centered setup
dialog selects a duration, a specific local date/time (with timezone shown), or
usage reset. Opening or cancelling the dialog leaves both execution and the
composer draft unchanged. Confirmation sends the corresponding wait command,
not a new user message; the draft remains untouched. Invalid, past, or more than
32-day timestamps cannot be submitted. The selected local time is converted to
an absolute ISO timestamp, preserving the exact deadline through the host bridge
and across restart. Setup and progress dialogs belong to the selected session;
background sessions cannot steal focus.

On a session already paused with the ordinary Pause button, scheduled
continuation invokes the same **Continue** lifecycle, without inserting another
user or custom message. On a running session the command requests a safe
turn-boundary pause; it never aborts an in-flight tool batch. Explicit Continue,
Stop, a new prompt, or a model change supersedes the scheduled action. Only an
error/completed assistant tail that cannot be resumed through `Agent.continue()`
uses the hidden continuation-message fallback.

Countdowns in Desktop and TUI show hours and minutes, rounded up to the next
minute, without seconds (zero minutes once due).

The centered popup shows
the exhausted window and a live countdown to the reset check, or to the next
availability check when reset time is unknown. It offers **Try now**, **Cancel
auto-resume**, and **Hide**. Hiding only dismisses the popup; the status indicator
and `/wait` (also `/quota-wait`) can reopen it. Cancelling disables automatic checks and
continuation, but keeps the task available for a manual probe. Desktop hides the
status indicator after cancellation; `/wait` can still reopen the retained wait.

Desktop renders the status indicator as a fixed-width retry icon in the first
visible quota window's attention slot, immediately after its reset countdown
(the short window when available). The countdown remains visible; the long wait
reason is only the icon's accessible label and the reopened popup's content,
never an inline status-bar string. If no quota window is available, the icon
remains next to Usage. Activating it reopens the existing wait popup.

At the deadline a fresh provider quota query precedes continuation. Both hourly
and weekly windows must permit work; the later exhausted reset wins. Scheduled
checks for a known exhausted reset run one minute after that reset, allowing
provider quota data to settle; the countdown includes this margin. Explicit
duration/date timers and unknown-reset backoff are unchanged. Without a
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

- Only failed provider turns start an automatic wait; quota display forecasts
  alone do not. Explicit `/wait` scheduling does not require a failed turn.
- Session shutdown/replacement invalidates timers and in-flight quota checks.
- Repeated timer ticks/actions coalesce; stale completions cannot restart another
  session or undo cancellation. Network work is asynchronous.
- Host automatic message queues do not drain while a quota wait is present.
- ACP wait controls bypass ordinary prompt ownership, including while paused or
  streaming; other extension commands keep their existing busy-session behavior.
  Extension-triggered continuation acquires normal active-run ownership so Stop
  and settled-state reporting remain available.
- Short-lived SDK retries are stopped at the completed agent-run boundary when
  subscription exhaustion is identified; no tool batch is interrupted.
- Reset data depends on provider availability. Unknown or unparseable reset
  timestamps must not be represented as an exact replenishment guarantee.
- The automatic probe is a real model request and may consume replenished quota.

## Implementation

- `src/app/session/quota-wait.ts`
- `src/app/session/quota-wait-control.ts`
- `src/app/session/agent-pause-controller.ts`
- `src/app/model/model-usage-status.ts`
- `src/bundled-extensions/quota-wait/index.ts`
- `src/bundled-extensions/quota-wait/usage.ts`
- `src/bundled-extensions/quota-wait/popup.ts`
- `src/app/runtime.ts`
- `src/app/app.ts`
- `src/app/session/queued-message-controller.ts`
- `src/app/types.ts`
- `src/app/popup/popup-menu-controller.ts`
- `src/app/rendering/render-controller.ts`
- `acp/src/acp/pix-acp-agent.ts`
- `acp/src/pi/pix-rpc-entry.js`
- `acp/src/config.ts`
- `acp/src/main.ts`
- `desktop/src-tauri/src/backend_runtime.rs`
- `desktop/src/app/quota-wait.svelte.ts`
- `desktop/src/lib/quota-wait.ts`
- `desktop/src/app/desktop-status-bar-view-model.svelte.ts`
- `desktop/src/components/QuotaWaitPopup.svelte`
- `desktop/src/components/QuotaWaitSchedulePopup.svelte`
- `desktop/src/components/DesktopOverlays.svelte`
- `desktop/src/components/StatusBar.svelte`
- `desktop/src/components/RuntimeStatusBarItems.svelte`
- `desktop/src/app/session-coordinator.ts`
- `desktop/src/app/prompt-agent-control.svelte.ts`
- `desktop/src/app/prompt-submit.ts`
- `desktop/src/app/prompt-queue-runtime.svelte.ts`

## Tests

- `desktop/src/components/RuntimeStatusBarItems.test.ts`
- `desktop/src/components/DesktopVisualRegressions.test.ts`
- `desktop/src/lib/quota-wait.test.ts`
- `tests/quota-wait.test.ts`
- `tests/quota-wait-extension.test.ts`
- `tests/quota-wait-sdk.test.ts`
- `tests/quota-wait-control.test.ts`
- `tests/model-usage-status.test.ts`
- `tests/queued-message-controller.test.ts`
- `tests/agent-pause-controller.test.ts`
- `acp/test/agent.test.ts`
- `acp/test/pix-rpc-entry.test.ts`

## Verification

Build the TUI, ACP and Desktop; run deterministic state-machine, extension,
queue and session ownership tests. Verify both real interfaces show a centered
countdown and preserve waiting when hidden, with actionable blocked reports if
the environment cannot run either application.
