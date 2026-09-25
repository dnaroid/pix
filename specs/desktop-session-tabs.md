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
- Desktop persists its own ordered visible conversation-tab membership per workspace. On restart, only the Desktop snapshot determines which real session tabs are restored, including an explicit empty list; stale TUI `pix.tabs` metadata must not resurrect sessions that Desktop had closed. Sessions opened only in Desktop are restored as well. A missing Desktop snapshot is treated as an empty snapshot, so startup opens the UI-only draft rather than falling back to TUI tab state. Ordinary TUI changes may still reconcile into the live Desktop tab list after startup.
- The persisted Desktop active-session id is valid at startup only when it is still a member of the persisted Desktop tab snapshot. If that active id is stale, Desktop falls back to the first still-available persisted tab; if the persisted tab list is empty, startup opens the UI-only draft instead of an old TUI session. Closing the last real Desktop tab clears the persisted active-session pointer.
- A persisted fork session is identified from Pi's native parent-session metadata. ACP exposes `pix.isFork` and, when available from its existing map records, the safe ACP-only `pix.parentSessionId` session-list metadata value to Desktop; no parent path is exposed. Workbench tabs render a branch icon beside fork titles.
- Conversation tabs are `kind: "session"` members of `WorkbenchTabs`. Preview, Git Diff, Terminal, and LSP installer tabs may appear between them visually, but those UI-only tabs never enter the session id arrays used by `buildTabSessions`, restore metadata, saved-session selection, or ACP/TUI synchronization.
- The active conversation runtime and the selected workbench surface are distinct concepts. While an auxiliary workbench tab is selected, the current session remains the underlying active runtime and keeps its activity/status state. Selecting a conversation tab activates/loads that session and selects the shared `conversation-workspace` panel.
- Unsent composer text and staged attachments are owned by the conversation tab that produced them. Switching between real sessions or between a real session and the UI-only draft snapshots the source composer and restores the target composer; content from one conversation must never appear in another tab. Closing a session or discarding a draft removes its composer snapshot, and changing workspace clears all composer snapshots.
- The StatusBar ACP connection dot reflects only that underlying active conversation runtime: when ACP is ready and its active-session-scoped prompt is running, the dot uses the semantic primary color with a restrained pulse (static primary with reduced motion). Auxiliary workbench tabs therefore retain this indication for their underlying active runtime; background conversation activity remains represented only by its existing tab status dot. The transcript does not duplicate this state with a bottom `working` line.
- The unified workbench tablist owns Left/Right, Home/End, Delete, and middle-click behavior across every visible tab. Arrow/Home/End move focus only; Enter/Space activate through native button behavior.
- Closing a running conversation from the close button, Delete, or middle-click requires explicit confirmation. Confirming closes the ACP session through the existing `session/close` teardown path; cancelling leaves the tab and run untouched.
- Session close still chooses/loads a valid fallback conversation runtime when the active session is removed. The visible workbench focus fallback may be a neighboring UI-only tab; in that case Pix keeps the fallback conversation runtime active underneath that surface.
- The pointer close affordance is outside the normal Tab sequence because Delete provides keyboard close within the workbench tab composite.
- New Conversation is the only trailing titlebar action outside the tablist and stays immediately after the last visible workbench tab. Unused titlebar space to its right remains the window-drag region.
- Activating New Conversation opens/reuses a **UI-only draft conversation tab**. Opening or restoring that draft must not call ACP `session/new`, allocate a Pi runtime, create a session-map record, persist a session id, or render the session-scoped Session inspector. While untouched, its central workspace shows a searchable saved-session selector above the normal composer.
- A UI-only draft also exposes the same combined model/thinking selector as a real conversation. Desktop obtains draft config options through a read-only, workspace-scoped ACP request that does not create a session-map record or Pi RPC session. The request loads provider registrations from that workspace's extensions and the bundled pi-tools-suite, including Antigravity, without leaking one workspace's providers into another. Changing model/thinking in the draft updates only draft-local UI state and does not call `session/set_config_option` or `session/new`.
- The embedded selector fills the available transcript height down to the composer. Its heading/search area remains fixed while only the saved-session list scrolls, and each saved conversation occupies one dense row with title and timestamp on the same line.
- The embedded selector omits sessions already represented by open conversation tabs. Preview/Diff are irrelevant to this filter because they are not sessions.
- Saved-session selection surfaces mark sessions carrying Pix fork metadata with the same branch/fork affordance used by conversation tabs, so forks stay visually distinguishable both in the titlebar picker and in the draft's embedded selector.
- With no search text, both saved-session selectors present TUI-style fork hierarchy: descending-`updatedAt` roots/siblings, parent-adjacent descendants, and monospaced `├─`/`└─`/`│` nesting. Searching intentionally switches to flat ranked results but keeps the fork affordance.
- The embedded selector has no separate **New conversation** row. Typing, path insertion, voice insertion, or adding an attachment marks the draft as edited and removes the selector immediately, but still does **not** create an ACP session.
- After the selector disappears, an edited draft with no session shows the normal empty-conversation prompt rather than an opening/loading status; no conversation is being opened until first submission.
- The first real prompt submission from the draft creates the ACP session lazily, carrying any staged draft model/thinking selection as a one-session startup override, waits for that runtime to become ready, retargets the unsent attachment draft to the new id, replaces the synthetic conversation tab with the real session tab, and only then sends the prompt. The staged selection must not mutate the persisted global/project default model. Any Preview/Diff placement anchored to the draft is retargeted to the real session id rather than entering session persistence.
- First-prompt materialization uses a draft-scoped busy state instead of the global Desktop operation lock. The composer and session/workspace mutation controls (including tab close and New Conversation) are temporarily disabled while the runtime is starting, but existing conversation tabs remain selectable and unrelated Preview/Diff workbench navigation remains responsive.
- Switching away from a materializing draft invalidates that generation while retaining the unsent draft text and attachments for return. If its workspace/client/draft ownership becomes stale, any created ACP session is discarded asynchronously and a late completion cannot replace the selected session or send the original prompt there, nor surface an obsolete error.
- Pending attachment inspection/caching settles before submit snapshots the composer draft, so pressing Enter immediately after paste/attach cannot race the first prompt and silently omit the file.
- Choosing a saved conversation from the embedded selector closes the UI-only draft and loads that saved session directly; no throwaway ACP session is created or closed. Workbench-only Preview/Diff tabs remain excluded from that saved-session selector.
- Repeated New Conversation actions reuse the existing draft tab instead of creating multiple empty chooser tabs.
- A sole UI-only draft tab is not closable. Its close affordance is omitted, and Delete or middle-click are ignored. Closing the last real session still transitions to one draft conversation tab, which remains the minimum session surface even if Preview/Diff are also open.
- A UI-only draft is never persisted as the active project session, so restarting Pix cannot attempt `session/history` for it. Compatibility recovery for older mapped empty sessions remains unchanged and generation-guarded.
- The New Conversation action uses the shared `session.new` command metadata for its platform shortcut hint; the Command Palette New/Open Conversation actions use the same UI-only draft surface.

## Accessibility and focus invariants

- Focus and selected workbench state are distinct. Arrow navigation can focus a background session or any auxiliary workbench tab without activating it.
- Conversation activity/runtime-active indication is separate from `aria-selected`; an underlying active session may retain its status dot while an auxiliary workbench tab is selected.
- A session whose agent-control state is `paused` replaces the running spinner in its conversation-tab status slot with a static Pause icon. The paused state wins over the generic prompt-running indicator while the prompt request is settling, so a successfully paused tab never continues to look actively spinning.
- The workbench tablist does not require every tab to be reachable by repeated Tab presses; arrow navigation owns movement inside the composite.
- New Conversation remains a separate control outside the roving-focus sequence.

## Related files

- `desktop/src/components/StatusBar.svelte`
- `desktop/src/components/TranscriptPane.svelte`
- `desktop/src/components/WorkbenchTabs.svelte`
- `desktop/src/components/SessionStartView.svelte`
- `desktop/src/components/PromptComposer.svelte`
- `desktop/src/lib/workbench-tabs.ts`
- `desktop/src/lib/session-tabs.ts`
- `desktop/src/lib/model-thinking.ts`
- `desktop/src/lib/acp-client.ts`
- `desktop/src/lib/acp-pix-extensions.ts`
- `desktop/src/app/draft-session.svelte.ts`
- `desktop/src/app/composer-drafts.ts`
- `desktop/src/app/session-tab-controller.ts`
- `desktop/src/app/session-tab-selection.ts`
- `desktop/src/app/session-tab-closure.ts`
- `desktop/src/app/desktop-presentation-state.svelte.ts`
- `acp/src/acp/desktop-commands.ts`
- `acp/src/acp/draft-model-runtime.ts`
- `acp/src/acp/pix-acp-agent.ts`
- `specs/desktop-workbench-tabs.md`
- `specs/desktop-session-parity.md`
- `specs/desktop-project-titlebar.md`

## Verification

- `desktop/src/components/DesktopVisualRegressions.test.ts` verifies that active-session work is shown by the ready ACP dot, respects reduced motion, and is not duplicated by a transcript-bottom spinner.
- `desktop/src/lib/session-tabs.test.ts` covers session membership/restoration/replacement, Desktop-owned tab snapshot parsing/serialization, stale TUI rejection, explicit-empty restore, active-session fallback, plus deterministic fork-tree sibling, nested, malformed/orphan, and flat-search row behavior independently of UI-only workbench tabs.
- `desktop/src/app/session-tabs-state.test.ts` covers persistence after open/close mutations and proves that an explicit empty Desktop snapshot suppresses stale TUI tabs across restart.
- `desktop/src/lib/workbench-tabs.test.ts` covers mixed workbench ordering without changing session identity.
- `desktop/src/app/workbench-model.test.ts` covers fork metadata propagation into workbench session tabs.
- `desktop/src/components/WorkbenchTabs.test.ts` covers unified roving tab semantics and kind-specific close dispatch.
- Desktop draft/concurrency and ACP-client coverage verifies that draft config is loaded without `session/new`, a staged model selection is kept local, and the override is carried only when first-prompt materialization happens.
- `npm --prefix desktop test`
- `npm --prefix desktop run check`
- `npm --prefix desktop run build:web`
