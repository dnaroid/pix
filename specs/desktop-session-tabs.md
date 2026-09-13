# Desktop conversation-tab interaction

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Preserve Pix conversation/session membership and lazy draft semantics after conversation tabs move into the unified top Workbench tab strip beside Preview and Git Diff.

## Behavior

- Visible conversation sessions remain selected and ordered by the existing `buildTabSessions` / Desktop-TUI parity rules. The unified workbench chrome does not change session membership or backend synchronization.
- Conversation tabs are `kind: "session"` members of `WorkbenchTabs`. Preview and Git Diff may appear between them visually, but those UI-only tabs never enter the session id arrays used by `buildTabSessions`, restore metadata, saved-session selection, or ACP/TUI synchronization.
- The active conversation runtime and the selected workbench surface are distinct concepts. While Preview/Git Diff is selected, the current session remains the underlying active runtime and keeps its activity/status state. Selecting a conversation tab activates/loads that session and selects the shared `conversation-workspace` panel.
- The unified workbench tablist owns Left/Right, Home/End, Delete, and middle-click behavior across every visible tab. Arrow/Home/End move focus only; Enter/Space activate through native button behavior.
- Closing a running conversation from the close button, Delete, or middle-click requires explicit confirmation. Confirming closes the ACP session through the existing `session/close` teardown path; cancelling leaves the tab and run untouched.
- Session close still chooses/loads a valid fallback conversation runtime when the active session is removed. The visible workbench focus fallback may be a neighboring Preview/Git Diff tab; in that case Pix keeps the fallback conversation runtime active underneath that UI-only surface.
- The pointer close affordance is outside the normal Tab sequence because Delete provides keyboard close within the workbench tab composite.
- New Conversation is the only trailing titlebar action outside the tablist and stays immediately after the last visible workbench tab. Unused titlebar space to its right remains the window-drag region.
- Activating New Conversation opens/reuses a **UI-only draft conversation tab**. Opening or restoring that draft must not call ACP `session/new`, allocate a Pi runtime, create a session-map record, or persist a session id. While untouched, its central workspace shows a searchable saved-session selector above the normal composer.
- A UI-only draft also exposes the same combined model/thinking selector as a real conversation. Desktop obtains draft config options through a read-only, workspace-scoped ACP request that does not create a session-map record or Pi RPC session. Changing model/thinking in the draft updates only draft-local UI state and does not call `session/set_config_option` or `session/new`.
- The embedded selector fills the available transcript height down to the composer. Its heading/search area remains fixed while only the saved-session list scrolls, and each saved conversation occupies one dense row with title and timestamp on the same line.
- The embedded selector omits sessions already represented by open conversation tabs. Preview/Diff are irrelevant to this filter because they are not sessions.
- The embedded selector has no separate **New conversation** row. Typing, path insertion, voice insertion, or adding an attachment marks the draft as edited and removes the selector immediately, but still does **not** create an ACP session.
- The first real prompt submission from the draft creates the ACP session lazily, carrying any staged draft model/thinking selection as a one-session startup override, waits for that runtime to become ready, retargets the unsent attachment draft to the new id, replaces the synthetic conversation tab with the real session tab, and only then sends the prompt. The staged selection must not mutate the persisted global/project default model. Any Preview/Diff placement anchored to the draft is retargeted to the real session id rather than entering session persistence.
- First-prompt materialization uses a draft-scoped busy state instead of the global Desktop operation lock. The composer and session/workspace mutation controls are temporarily disabled while the runtime is starting, but unrelated Preview/Diff workbench navigation remains responsive.
- Draft materialization is generation-guarded. If its workspace/client/draft ownership becomes stale, the created ACP session is discarded asynchronously and a late completion cannot replace newer UI state or surface an obsolete error.
- Pending attachment inspection/caching settles before submit snapshots the composer draft, so pressing Enter immediately after paste/attach cannot race the first prompt and silently omit the file.
- Choosing a saved conversation from the embedded selector closes the UI-only draft and loads that saved session directly; no throwaway ACP session is created or closed. Workbench-only Preview/Diff tabs remain excluded from that saved-session selector.
- Repeated New Conversation actions reuse the existing draft tab instead of creating multiple empty chooser tabs.
- A sole UI-only draft tab is not closable. Its close affordance is omitted, and Delete or middle-click are ignored. Closing the last real session still transitions to one draft conversation tab, which remains the minimum session surface even if Preview/Diff are also open.
- A UI-only draft is never persisted as the active project session, so restarting Pix cannot attempt `session/history` for it. Compatibility recovery for older mapped empty sessions remains unchanged and generation-guarded.
- The New Conversation action uses the shared `session.new` command metadata for its platform shortcut hint; the Command Palette New/Open Conversation actions use the same UI-only draft surface.

## Accessibility and focus invariants

- Focus and selected workbench state are distinct. Arrow navigation can focus a background session, Preview, or Git Diff tab without activating it.
- Conversation activity/runtime-active indication is separate from `aria-selected`; an underlying active session may retain its status dot while Preview/Diff is the selected workbench tab.
- The workbench tablist does not require every tab to be reachable by repeated Tab presses; arrow navigation owns movement inside the composite.
- New Conversation remains a separate control outside the roving-focus sequence.

## Related files

- `desktop/src/components/WorkbenchTabs.svelte`
- `desktop/src/components/SessionStartView.svelte`
- `desktop/src/components/PromptComposer.svelte`
- `desktop/src/lib/workbench-tabs.ts`
- `desktop/src/lib/session-tabs.ts`
- `desktop/src/lib/model-thinking.ts`
- `desktop/src/lib/acp-client.ts`
- `desktop/src/lib/acp-pix-extensions.ts`
- `desktop/src/app/draft-session.svelte.ts`
- `desktop/src/app/session-tab-controller.ts`
- `desktop/src/app/session-tab-selection.ts`
- `desktop/src/app/session-tab-closure.ts`
- `desktop/src/app/desktop-presentation-state.svelte.ts`
- `acp/src/acp/desktop-commands.ts`
- `acp/src/acp/pix-acp-agent.ts`
- `specs/desktop-workbench-tabs.md`
- `specs/desktop-session-parity.md`
- `specs/desktop-project-titlebar.md`

## Verification

- `desktop/src/lib/session-tabs.test.ts` covers session membership/restoration/replacement independently of UI-only workbench tabs.
- `desktop/src/lib/workbench-tabs.test.ts` covers mixed workbench ordering without changing session identity.
- `desktop/src/components/WorkbenchTabs.test.ts` covers unified roving tab semantics and kind-specific close dispatch.
- Desktop draft/concurrency and ACP-client coverage verifies that draft config is loaded without `session/new`, a staged model selection is kept local, and the override is carried only when first-prompt materialization happens.
- `npm --prefix desktop test`
- `npm --prefix desktop run check`
- `npm --prefix desktop run build:web`
