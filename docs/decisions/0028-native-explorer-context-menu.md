# 0028 — Native Project Explorer context menu

- Status: accepted
- Recorded: 2026-10-04
- Decided: 2026-10-04
- Owner / approval evidence: user selected native macOS menus in the task conversation.
- Governing spec: [Desktop workspace navigation](../../specs/desktop-workspace-navigation.md)
- Replaces / replaced by: none

## Context

The user reported a folder context menu clipped at the bottom of the application
window and asked whether a native menu could escape that boundary. The existing
Explorer popup was rendered inside the WebView, with an estimated height that
did not cover every directory command.

## Observations and sources

`project-explorer-menu-controller.svelte.ts` owned the DOM placement;
`native-context-menu.ts` already uses Tauri menus for generic Desktop commands.
The user chose the native option rather than only fixing in-window placement.
Native appearance and behavior still require a real macOS acceptance pass;
mocked tests establish ownership and routing, not OS rendering.

## Decision

Use a Tauri OS-native menu for Project Explorer in the Desktop host, retaining
the DOM fallback in standalone browser preview. Reuse existing file handlers
and command enablement. Await action-triggered clipboard and Git eligibility
before presenting a snapshot of commands. Keep menu resources until replacement
or disposal; serialize native registration with per-owner callback ids and
guard stale creation/callbacks. macOS owns screen placement and traversal.

## Alternatives

- Measuring and scrolling the HTML menu fixes clipping inside the WebView but
  cannot let it extend beyond the application window. Retained for web preview.
- A separate floating application window would add focus/lifecycle complexity
  where the OS already supplies the requested menu surface.

## Consequences

Native placement is no longer constrained by the WebView. Opening waits for
clipboard/Git checks; existing menus do not change on background Git refresh.
Browser preview remains visually different. No new permissions, filesystem
mutation semantics or supported Desktop platforms are introduced.

## Revisit when

Custom embedded controls, dynamic live commands, or native accessibility/focus
regressions require a different command surface.
