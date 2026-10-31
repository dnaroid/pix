# Desktop notifications (native and sound-only)

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Notify the user when a Pix Desktop agent needs attention. The default is native macOS notifications; an opt-in sound-only mode plays a short cue without popups or the OS notification center.

## Scope

- Native completion notifications after an agent's full Desktop work chain settles.
- Native question/input notifications for accepted agent-originated ACP elicitations.
- Native pause notifications when a live agent-control state transitions into `paused`.
- Native error notifications for agent prompt/continuation failures and abnormal ACP stop reasons.
- Per-window foreground suppression so a visible, focused Pix window continues to rely on its in-app UI instead of duplicating the same event as an OS notification.
- A Desktop General master setting, `desktop.notifications.enabled`, that disables both delivery modes when false (default `true`).
- A Desktop General switch, **Sound only (no popups)** (`desktop.notifications.usePix`, default `false`), that selects a sound cue instead of native notifications. The legacy key name is retained for existing configs. Both settings allow project Desktop overrides.

## Behavior

1. Before delivering anything, Desktop resolves the latest effective `desktop.notifications.enabled` and `desktop.notifications.usePix` values from the user Desktop config and the active project's Desktop override. Disabled suppresses both delivery modes. Legacy configs remain enabled with native macOS delivery. Changes apply after saving and are read for each event.
2. A Desktop window is foreground only while `document.visibilityState === "visible"` and `document.hasFocus()` are both true. Native completion, question, pause, and error notifications are suppressed while foreground. Sound cues are suppressed only when the owning conversation is the currently visible workbench tab in the focused window; other-tab events still sound. Both modes can signal when a window is unfocused, minimized, or hidden.
   Sound-only delivery does not create a Pix popup, retain notification text, or emit macOS banners. The cue is played through the native macOS sound API on the application main thread, not through the notification center. This allows it to play when the WebView is in the background. Sound failure must not affect the agent.
3. Native notifications are best effort. In native mode Desktop checks notification permission and requests it at most once per window process. Only a grant is cached: after a denial, later notifications re-check (never re-prompt) at most every 30 seconds, so enabling notifications in macOS System Settings takes effect without a restart. Notification API failures never fail or delay agent work; permission-check and delivery failures go to the diagnostic logger as `frontend:warning` once per failure streak. Sound-only mode does not check/request OS notification permission or send any native notification; a mode switch during an asynchronous native setup prevents stale native delivery.
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
- Rationale: [Native notification activation routing](../../decisions/0016-native-notification-activation.md).

## Related files

- `desktop/src/lib/desktop-notifications.ts`
- `desktop/src-tauri/src/desktop_notification_sound.rs`
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

- `desktop/src/lib/desktop-notifications.test.ts` covers foreground suppression, permission reuse, throttled denial re-check without re-prompting, once-per-streak failure logging, completion/error/cancel policy, active-subagent deferral, stale-completion cancellation, older-notification routing, subscribe-before-send, retry, teardown races, sound-only mode without popups or OS permission, mode switching, and disposal while preferences are pending.
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

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"4da74c83e55bd5395cd278a73ef3e27968c147c5b118c63f39e54c551c0cd846","checkedAt":"2026-10-31T01:13:17.073Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":64,"reportLanguage":"ru"} -->
