# 0016 — Native notification activation routing

- Status: accepted
- Recorded: 2026-10-03
- Decided: 2026-10-03
- Owner / approval evidence: user reported that clicking Desktop system notifications only foregrounds Pix instead of selecting the owning tab; implementation repairs the existing contract (conversation-only evidence).
- Governing spec: [Desktop system notifications](../../specs/desktop-system-notifications.md)
- Replaces / replaced by: none

## Context

The existing contract requires activation of the exact owning window and conversation, not merely foregrounding Pix. Desktop currently supports macOS only. Agent work must remain independent of notification failures.

## Observations and sources

- Reported by the user: notification activation foregrounds Pix without selecting the owning tab.
- Verified in installed `tauri-plugin-notification` 2.4.0 `src/init-iife.js`: the plugin replaces `window.Notification` with a fire-and-forget IPC constructor, not an EventTarget. Its desktop delivery path does not return a native activation callback to the frontend.
- The old [frontend adapter](../../desktop/src/lib/desktop-notifications.ts) delivered a notification before attempting `addEventListener`, so a best-effort catch masked the missing click bridge.
- Existing tests mocked callback delivery and did not exercise that host constructor. The new [transport regression](../../desktop/src/lib/desktop-notification-transport.test.ts) verifies the actual IPC/listener boundary.
- Native OS interaction remains a separate acceptance check; mocked IPC alone cannot prove notification-center behavior.
- Follow-up source verification found a second boundary mismatch: native emits to `WebviewWindow`, but the first frontend bridge subscribed via `Window.listen`. Tauri filters these target kinds separately. The transport regression now keeps the actual frontend APIs and asserts the IPC target kind and label, rather than mocking `.listen`.

## Decision

Keep plugin permission checks but replace delivery with a macOS native command/activation bridge. Derive window ownership from the invoking webview, retain the session with each notification, and emit activation only to that window. Subscribe before sending and release frontend listeners on unmount, including subscriptions that complete after disposal. Retain the existing conversation/workbench selection handler and foreground-suppression/completion policy.

Use the installed plugin's legacy `NSUserNotificationCenter` delivery API with an owned delegate, notification-local metadata, and live-window incarnation checks. Deny the plugin's delivery command so it cannot overwrite the delegate; retain only its permission APIs. Development's Terminal identity lookup runs off the main thread. No thread waits for a notification click.

## Alternatives

- Keep a DOM click handler on the plugin constructor: cannot work because the constructor has no EventTarget API or activation bridge.
- Choose the latest session on application focus: focus does not identify which notification was clicked and would misroute older notifications and ordinary app activation.
- Add supported Windows/Linux routing: outside the macOS-only Desktop product scope.

## Consequences

The native bridge adds platform-specific code, but makes notification ownership explicit rather than inferring it from current focus or the newest notification. Native clicks require validation in a bundled macOS app and remain best effort; denied OS permission, closed windows, or unavailable sessions must not affect agent execution.

## Revisit when

Tauri provides a verified Desktop activation API with per-notification ownership, macOS changes notification delegate behavior, or Desktop officially gains another supported platform.
