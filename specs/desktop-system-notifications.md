# Desktop system notifications

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Notify the user through the operating system when a Pix Desktop agent needs attention while its owning Desktop window is not currently visible and focused.

## Scope

- Native completion notifications after an agent's full Desktop work chain settles.
- Native question/input notifications for accepted agent-originated ACP elicitations.
- Native pause notifications when a live agent-control state transitions into `paused`.
- Native error notifications for agent prompt/continuation failures and abnormal ACP stop reasons.
- Per-window foreground suppression so a visible, focused Pix window continues to rely on its in-app UI instead of duplicating the same event as an OS notification.
- A Desktop General setting, `desktop.notifications.enabled`, that can disable all native notification permission requests and delivery. It defaults to `true`, and a project Desktop config may override the user-level value.

## Behavior

1. Before requesting OS permission or sending anything, Desktop resolves the latest effective `desktop.notifications.enabled` value from the user Desktop config and the active project's Desktop override. When disabled, no native notification is sent and no notification permission prompt is requested. Existing configs without the setting remain enabled for backward compatibility.
2. A Desktop window is foreground only while `document.visibilityState === "visible"` and `document.hasFocus()` are both true. Completion, question, and error notifications are suppressed while foreground and are eligible in every other state, including minimized/hidden windows and a Pix window that has lost focus to another application or another Pix project window.
3. Native notifications are best effort. Desktop checks notification permission, requests it once per window process when needed, caches the result for that run, and never lets notification API failures fail or delay agent work.
4. Successful completion is based on the ACP prompt/continuation stop reason after Pi's `agent_settled` boundary, not `agent_end`. `end_turn` is the only successful completion reason. User cancellation is silent. `max_tokens`, `max_turn_requests`, and `refusal` produce an error/attention notification instead of a success notification.
5. Desktop's own auto queue is part of the completion boundary. A prompt that settles and immediately starts an automatic queued prompt must not emit an intermediate completion notification. Run generations ensure only the final run in that chain may report completion.
6. Completion also waits while the owning session still reports active async subagents. When the subagent activity snapshot reaches zero, the deferred completion is emitted only if the session is idle and no newer prompt has started. Starting new work, clearing the session, or resetting prompt runtime drops an older deferred completion.
   The same successful fully-settled boundary is also exposed to Desktop session-tab chrome so an inactive conversation can be marked as completed-but-unseen without duplicating or weakening the notification coordinator's completion rules.
7. Pause is not completion. A live same-session transition into `paused` emits a `Pix — Paused` notification when native delivery is otherwise eligible, but an `end_turn` that leaves agent control `paused` or `continuable` does not emit success. The first observation of an already-paused session is not treated as a fresh pause. `Continue` carries the final ACP stop reason through the private `pix/session/agent_control` response so its eventual completion/error uses the same rules as a normal prompt.
8. Agent-originated ACP form/question elicitations notify as soon as Desktop accepts the pending request, including when the owning session tab is inactive. Desktop-local text-input elicitations used by its own commands/actions do not trigger system notifications.
9. Question notifications retain the owning session identity and the elicitation message. Completion and pause notifications use the session title. Error notifications use the session title plus a bounded single-line error/stop message.
   ACP 1.4 also reports provider failures under its generic `refusal` stop reason: the background notification is therefore neutral about whether the model refused, while the system error row in the conversation carries the original provider detail.
10. Notification bodies are whitespace-normalized and bounded. The feature does not mirror the transcript, thinking, tool calls/results, or full conversation history into OS notifications.
11. Clicking a Desktop notification reactivates the exact Pix window that created it, including showing/unminimizing/focusing that window, then selects the owning conversation session and its unified workbench tab. Notification activation is best effort and must not affect agent execution if native focus or navigation fails.
12. Each notification retains its own owning window and session. Clicking an older notification after a newer one was delivered must still select the older notification's conversation. Dismissal must not navigate. Activation listeners are window-scoped, installed before delivery, and released when the frontend unmounts; a subscription completing after teardown must not send or activate anything.

## Native integration

- Desktop uses the official Tauri v2 notification plugin for notification permission integration. Supported macOS Desktop delivery uses the custom `desktop_send_notification` command and native activation bridge. The command derives ownership from the invoking native window; the frontend cannot choose another window label.
- Desktop capabilities covering `main` and `project-*` windows allow only the plugin permission-check/request commands and explicitly deny `notification:notify`. This prevents plugin delivery from replacing Pix's native activation delegate.
- Native routing metadata lives in each notification's property-list-compatible `userInfo`; window-incarnation tokens reject clicks for destroyed/recreated windows. Delivery uses the same legacy macOS `NSUserNotificationCenter` API as the installed plugin, with a retained delegate, no per-notification click waiters, and teardown on app exit. Unbundled development retains the plugin's Terminal identity workaround off the main thread.
- After validating the live owner on the main thread, native activation unhides Pix, restores the owning window, explicitly activates the macOS application, and makes that exact window key/front before emitting conversation activation. Merely focusing a window is insufficient when another application is active. Focus remains best effort; routing still runs if obtaining the native window fails.
- The frontend listens on its own `WebviewWindow` for `desktop-notification-activated`, matching the native `EventTarget::webview_window` target kind and label (a `Window` listener is a different target). The payload carries the notification's `sessionId`; the existing conversation activation handler selects the session/workbench surface. It does not attach DOM click handlers to the plugin's fire-and-forget `Notification` constructor.
- Desktop support is macOS only; Windows/Linux notification activation is not a delivery requirement.
- Rationale: [Native notification activation routing](../docs/decisions/0016-native-notification-activation.md).

## Related files

- `desktop/src/lib/desktop-notifications.ts`
- `desktop/src/App.svelte`
- `desktop/src/app/prompt-run-lifecycle.svelte.ts`
- `desktop/src/app/prompt-agent-control.svelte.ts`
- `desktop/src/app/elicitation.svelte.ts`
- `desktop/src/app/session-activity.svelte.ts`
- `desktop/src-tauri/src/lib.rs`
- `desktop/src-tauri/src/desktop_notification.rs`
- `desktop/src-tauri/Cargo.toml`
- `desktop/src-tauri/Cargo.lock`
- `desktop/src-tauri/capabilities/default.json`
- `acp/src/acp/desktop-commands.ts`
- `acp/src/acp/pix-acp-agent.ts`

## Verification

- `desktop/src/lib/desktop-notifications.test.ts` covers foreground suppression, permission reuse, completion/error/cancel policy, active-subagent deferral, stale-completion cancellation, older-notification routing, subscribe-before-send, retry, and teardown races.
- `desktop/src/lib/desktop-notification-transport.test.ts` uses the real Tauri frontend APIs with mocked IPC to verify native command delivery, matching `WebviewWindow` subscription targets for main/project windows, owning-session activation, and unsubscribe even when the host `Notification` constructor has no EventTarget methods.
- `desktop/src-tauri/src/desktop_notification.rs` contains native metadata/activation and ownership regressions: out-of-order delivery, multiple windows, body clicks versus dismissal/actions, reused window labels, stale queued sends, and shutdown.
- Prompt-run lifecycle tests cover auto-queue generation gating and dedicated prompt-error signaling.
- Elicitation tests verify agent-originated pending requests notify while Desktop-local text input does not.
- ACP tests verify continuation returns its settled stop reason.
- Run Desktop check/build and focused/full compatible tests, ACP typecheck/agent tests, and `cargo check --manifest-path desktop/src-tauri/Cargo.toml`.

## Evidence

- Confirmed by code: ACP `session/prompt` resolves only after `agent_settled`; Desktop auto-queue draining happens after each prompt run and can start another prompt.
- Confirmed by the Desktop notification implementation and tests: fully settled work, user-abort suppression, and question attention determine native delivery.
- Confirmed by Tauri documentation: the official notification plugin provides permission checks/requests and native notification delivery on Desktop platforms.
