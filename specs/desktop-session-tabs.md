# Desktop session tab interaction

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Make the top conversation strip behave like a conventional desktop tablist while preserving the existing Pix rules for which sessions belong in the strip and how active sessions are loaded.

## Behavior

- Visible conversation sessions remain selected and ordered by the existing `buildTabSessions` / Desktop-TUI parity rules; this spec changes tab interaction, not tab membership or backend synchronization.
- Each conversation surface is a true `role="tab"` with `aria-selected`, a roving `tabindex`, and `aria-controls="conversation-workspace"`. The active tab is the normal Tab-sequence entry; when no active id exists, the first visible tab is the fallback entry.
- Left/Right move keyboard focus between visible tabs and wrap at the ends. Home/End move focus to the first/last tab. These navigation keys move focus only; they do not load/activate another session.
- Enter/Space activate a focused tab through native button behavior. Selecting an already-active tab is idempotent and does not open another surface.
- Delete closes the focused tab when that session is closable; running sessions keep their tab and close affordance disabled. After a successful closure, focus moves to the next visible tab, then the previous tab, then a newly selected tab if closing the last tab caused Pix to create one, and finally the session-picker control as a fallback.
- The pointer close affordance remains available on each tab. It is removed from the normal Tab sequence because Delete provides the keyboard close operation for the tab composite.
- Session selection/search is a separate titlebar action adjacent to New Conversation. The active tab no longer doubles as a session-selector trigger.
- The session-picker action retains its dialog expanded state and becomes the focus-restoration invoker when opened directly from the titlebar.
- The New Conversation action uses the shared `session.new` command metadata for its platform shortcut hint.

## Accessibility and focus invariants

- Focus and active/selected state are distinct. Arrow navigation can focus a background tab without activating it.
- Tab focus remains visibly outlined even when that tab is not selected.
- The tablist does not require every tab to be reachable by repeated Tab presses; arrow navigation owns movement inside the composite.
- Session-picker and New Conversation remain separate controls outside the tab roving-focus sequence.

## Related files

- `desktop/src/components/SessionTabs.svelte`
- `desktop/src/lib/session-tabs.ts`
- `desktop/src/App.svelte`
- `specs/desktop-session-parity.md`
- `specs/desktop-project-titlebar.md`

## Verification

- `desktop/src/lib/session-tabs.test.ts` covers wraparound and Home/End focus-index behavior.
- `npm --prefix desktop test`
- `npm --prefix desktop run check`
- `npm --prefix desktop run build:web`
