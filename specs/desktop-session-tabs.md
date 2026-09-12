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
- Delete closes the focused tab, and middle-button mouse down on a tab closes it through the same application close flow. The tab strip itself is not a native Tauri drag region; left-button window dragging stays on the explicit tab drag action/free titlebar space so WebView middle-click is not swallowed. After a successful keyboard closure, focus moves to the next visible tab, then the previous tab, then the UI-only draft tab when it becomes the fallback.
- Closing a running session from the close button, Delete, or middle-click requires explicit confirmation. Confirming closes the ACP session, which cancels/aborts its active run through the existing `session/close` teardown path; cancelling the confirmation leaves the tab and run untouched.
- The pointer close affordance remains available on each tab, including running tabs. It is removed from the normal Tab sequence because Delete provides the keyboard close operation for the tab composite.
- The titlebar no longer has a separate session-picker chevron. New Conversation is the only trailing titlebar action and sits flush immediately after the last visible tab with no extra left gap; unused titlebar space stays to its right as the window-drag region.
- Activating New Conversation opens/reuses a **UI-only draft tab**. Opening or restoring that draft must not call ACP `session/new`, allocate a Pi runtime, create a session-map record, or persist a session id. While untouched, its central workspace shows a searchable saved-session selector above the normal composer.
- The embedded selector fills the available transcript height down to the composer. Its heading/search area remains fixed while only the saved-session list scrolls, and each saved conversation occupies one dense row with title and timestamp on the same line.
- The embedded selector omits sessions already represented by open tabs, so the surface only offers saved conversations that are not already visible in the titlebar.
- The embedded selector has no separate **New conversation** row. Typing, path insertion, voice insertion, or adding an attachment marks the draft as edited and removes the selector immediately, but still does **not** create an ACP session.
- The first real prompt submission from the draft creates the ACP session lazily, waits for that runtime to become ready, retargets the unsent attachment draft to the new id, replaces the synthetic titlebar tab with the real session tab, and only then sends the prompt.
- First-prompt materialization uses a draft-scoped busy state instead of the global Desktop operation lock. The composer and session/workspace mutation controls are temporarily disabled while the runtime is starting, but unrelated workbench navigation remains responsive.
- Draft materialization is generation-guarded. If its workspace/client/draft ownership becomes stale, the created ACP session is discarded asynchronously and a late completion cannot replace newer UI state or surface an obsolete error.
- Pending attachment inspection/caching settles before submit snapshots the composer draft, so pressing Enter immediately after paste/attach cannot race the first prompt and silently omit the file.
- Choosing a saved conversation from the embedded selector closes the UI-only draft and loads that saved session directly; no throwaway ACP session is created or closed.
- Repeated New Conversation actions reuse the existing draft tab instead of creating multiple empty chooser tabs.
- A sole UI-only draft tab is not closable. Its close affordance is omitted, and Delete or middle-click are ignored. Closing the last real session still transitions to one draft tab, which then remains as the minimum conversation surface.
- A UI-only draft is never persisted as the active project session, so restarting Pix cannot attempt `session/history` for it. For compatibility, an older mapped empty session that returns the exact `session history … is unavailable` condition is discarded only after the concurrent runtime load also fails; a history response may not race a valid runtime into deletion. Stale runtime-load completions are generation-guarded and cannot resurrect a forgotten session.
- The New Conversation action uses the shared `session.new` command metadata for its platform shortcut hint; the command-palette New/Open Conversation actions use the same UI-only draft surface.

## Accessibility and focus invariants

- Focus and active/selected state are distinct. Arrow navigation can focus a background tab without activating it.
- Tab focus remains visibly outlined even when that tab is not selected.
- The tablist does not require every tab to be reachable by repeated Tab presses; arrow navigation owns movement inside the composite.
- New Conversation remains a separate control outside the tab roving-focus sequence.

## Related files

- `desktop/src/components/SessionTabs.svelte`
- `desktop/src/components/SessionStartView.svelte`
- `desktop/src/components/PromptComposer.svelte`
- `desktop/src/lib/session-tabs.ts`
- `desktop/src/App.svelte`
- `specs/desktop-session-parity.md`
- `specs/desktop-project-titlebar.md`

## Verification

- `desktop/src/lib/session-tabs.test.ts` covers wraparound and Home/End focus-index behavior.
- `npm --prefix desktop test`
- `npm --prefix desktop run check`
- `npm --prefix desktop run build:web`
