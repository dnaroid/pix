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
10. Notification bodies are whitespace-normalized and bounded. The feature does not mirror the transcript, thinking, tool calls/results, or full conversation history into OS notifications.
11. Clicking a Desktop notification reactivates the exact Pix window that created it, including showing/unminimizing/focusing that window, then selects the owning conversation session and its unified workbench tab. Notification activation is best effort and must not affect agent execution if native focus or navigation fails.

## Native integration

- Desktop uses the official Tauri v2 notification plugin for notification permission integration and native application setup. Desktop delivery uses the Web Notification API directly (the same Desktop delivery path wrapped by the plugin helper) so Pix can retain the notification handle and attach an exact-window click handler.
- `notification:default` is granted to the Desktop capability covering `main` and `project-*` windows.
- The Tauri builder initializes `tauri_plugin_notification`; the frontend uses `@tauri-apps/plugin-notification` for permission checks and the Web Notification API for clickable Desktop delivery.
- Windows native notification behavior still inherits the Tauri plugin limitation that normal app identity/icon behavior requires an installed application rather than development mode.

## Related files

- `desktop/src/lib/desktop-notifications.ts`
- `desktop/src/App.svelte`
- `desktop/src/app/prompt-run-lifecycle.svelte.ts`
- `desktop/src/app/prompt-agent-control.svelte.ts`
- `desktop/src/app/elicitation.svelte.ts`
- `desktop/src/app/session-activity.svelte.ts`
- `desktop/src-tauri/src/lib.rs`
- `desktop/src-tauri/capabilities/default.json`
- `acp/src/acp/desktop-commands.ts`
- `acp/src/acp/pix-acp-agent.ts`

## Verification

- Desktop notification tests cover foreground suppression, permission reuse, completion/error/cancel policy, active-subagent deferral, and stale-completion cancellation.
- Prompt-run lifecycle tests cover auto-queue generation gating and dedicated prompt-error signaling.
- Elicitation tests verify agent-originated pending requests notify while Desktop-local text input does not.
- ACP tests verify continuation returns its settled stop reason.
- Run Desktop check/build and focused/full compatible tests, ACP typecheck/agent tests, and `cargo check --manifest-path desktop/src-tauri/Cargo.toml`.

## Evidence

- Confirmed by code: ACP `session/prompt` resolves only after `agent_settled`; Desktop auto-queue draining happens after each prompt run and can start another prompt.
- Confirmed by the existing terminal-bell/Telegram contracts: fully settled work, user-abort suppression, and question attention are the established Pix notification semantics.
- Confirmed by Tauri documentation: the official notification plugin provides permission checks/requests and native notification delivery on Desktop platforms.
