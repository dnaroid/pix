---
kind: spec
status: active
---

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
- Desktop persists its own ordered visible conversation-tab membership per workspace **within each stable native window label**. Active-session pointers use the same window scope. Two windows, including windows on the same project, cannot overwrite each other's snapshots. Switching projects retains each project's snapshot within that window. Browser preview uses its own namespace. On restart, only the Desktop snapshot determines which real session tabs are restored, including an explicit empty list; stale TUI `pix.tabs` metadata must not resurrect sessions that Desktop had closed. Sessions opened only in Desktop are restored as well. A missing Desktop snapshot is treated as an empty snapshot, so startup opens the UI-only draft rather than falling back to TUI tab state. Ordinary TUI changes may still reconcile into the live Desktop tab list after startup.
- Session snapshots use `pix.desktop.windowLayout.<encoded-window-label>.sessionTabs` and `.activeSessions`. Legacy origin-wide `pix.desktop.sessionTabs` / `pix.desktop.activeSessions` are not imported because their owning window is unknowable; existing windows start with a draft once and remember subsequent tab choices. Saved sessions remain available in the chooser.
- The persisted Desktop active-session id is valid at startup only when it is still a member of the persisted Desktop tab snapshot. If that active id is stale, Desktop falls back to the first still-available persisted tab; if the persisted tab list is empty, startup opens the UI-only draft instead of an old TUI session. Closing the last real Desktop tab clears the persisted active-session pointer.
- A persisted fork session is identified from Pi's native parent-session metadata. ACP exposes `pix.isFork` and, when available from its existing map records, the safe ACP-only `pix.parentSessionId` session-list metadata value to Desktop; no parent path is exposed. Workbench tabs render a branch icon beside fork titles.
- Conversation tabs are `kind: "session"` members of `WorkbenchTabs`. Preview, Git Diff, Terminal, and LSP installer tabs may appear between them visually, but those UI-only tabs never enter the session id arrays used by `buildTabSessions`, restore metadata, saved-session selection, or ACP/TUI synchronization.
- The active conversation runtime and the selected workbench surface are distinct concepts. While an auxiliary workbench tab is selected, the current session remains the underlying active runtime and keeps its activity/status state. Selecting a conversation tab activates/loads that session and selects the shared `conversation-workspace` panel.
- Unsent composer text and staged attachments are owned by the conversation tab that produced them. Switching between real sessions or between a real session and the UI-only draft snapshots the source composer and restores the target composer; content from one conversation must never appear in another tab. Closing a session or discarding a draft removes its composer snapshot, and changing workspace clears all composer snapshots.
- Selecting an existing session makes its composer editable immediately while runtime startup and persisted-history hydration continue. Normal prompt submission snapshots text/attachments, clears the composer, and renders the local user message immediately; the actual ACP prompt waits for that session's runtime and pending hydration. Selection changes do not retarget an accepted send: its hydration continues into that session's cached transcript, preserving older-history pagination without overwriting the newly selected conversation. Close/reopen, workspace changes, or client replacement invalidate its runtime ownership and prevent stale sends; close/reset/replacement also invalidate retained hydration. While one such submission is awaiting startup, further input remains editable but another submission in that session is not consumed; after startup, follow-up input uses the normal running-prompt queue. Runtime-dependent commands retain their startup gates. A failed startup reports that the message was not sent; its local message remains visible unless the conversation is explicitly closed or its workspace is reset. Missing history must not erase it.
- The deferred attachment-ownership effect cancels stale asynchronous additions on conversation changes without clearing the target tab's restored attachments. Workspace changes still invalidate and clear the live attachment draft.
- ACP connection state is not shown as persistent status-bar chrome. Connection failures continue through the existing error feedback/reconnect path. The composer keeps its ordinary chrome while ACP is ready and its active-session-scoped prompt is running: no working border color or pulse is applied, and only the existing input focus and drag borders remain. A separate neutral live-action line sits immediately above the input form in the fixed composer dock, outside the scrolling transcript. It lists every concurrent active tool/thought entry in the current user turn, joined with `•` separators, prioritizes pending input requests, and falls back to `Working` when no specific live action is known. It never shows `Completed`/`Failed` or inherits historical tool failure styling. It disappears when the prompt stops, the runtime disconnects, history is loading, a UI-only draft is selected, or agent control becomes paused/continuable. The loader respects reduced motion; editor-only composers omit the line. Auxiliary workbench tabs retain the underlying runtime state; background conversation activity remains represented only by its existing tab status icon. The transcript does not duplicate this state with a bottom `working` line.
- Each visible composer activity label (including its concurrent-count hint) is held for at least one second before replacement. Rapid updates coalesce to the latest status rather than queueing obsolete actions; repeated updates do not postpone the deadline. Stopping/hiding the activity still removes it immediately. Switching sessions resets the hold and cancels pending updates from the old session.
- The unified workbench tablist owns Left/Right, Home/End, Delete, and middle-click behavior across every visible tab. Arrow/Home/End move focus only; Enter/Space activate through native button behavior.
- Closing a running conversation from the close button, Delete, or middle-click requires explicit confirmation. Confirming removes the conversation tab from the visible Desktop tab membership synchronously, before awaiting the ACP `session/close` teardown response, so titlebar feedback is immediate. If that ACP close fails, Desktop restores the optimistically hidden tab and reports the error; cancelling confirmation leaves the tab and run untouched.
  Desktop uses the native asynchronous warning dialog; duplicate requests are guarded and stale consent after workspace/client replacement is ignored. See [active-run close warning](desktop-close-warning.md) for tab/window/Quit behavior and the view-only council participant exception.
- Session close chooses/loads a valid fallback conversation runtime immediately when the active session is removed, without waiting for ACP teardown or acquiring the Desktop-global operation lock. Closing the last real session immediately opens the UI-only draft. Close/focus callers finish while teardown continues in the background; only the closing session remains action-locked, including saved-session reopen, until teardown settles. Runtime/history/update ownership is invalidated on optimistic removal, preventing stale sends and updates. Transcript and composer snapshots are retained until success; a failed close restores the tab and reports its error without overwriting a later selection or another tab's composer. Stale completion after workspace/client replacement cannot mutate the replacement state. The visible workbench focus fallback may be a neighboring UI-only tab; in that case Pix keeps the fallback conversation runtime active underneath that surface. Consent/completion cannot overwrite workbench navigation made while a close was pending.
- The pointer close affordance is outside the normal Tab sequence because Delete provides keyboard close within the workbench tab composite.
- New Conversation is the only trailing titlebar action outside the tablist and stays immediately after the last visible workbench tab. Unused titlebar space to its right remains the window-drag region.
- Activating New Conversation opens/reuses a **UI-only draft conversation tab**. Opening or restoring that draft must not call ACP `session/new`, allocate a Pi runtime, create a session-map record, persist a session id, or render the session-scoped Session inspector. While untouched, its central workspace shows a searchable saved-session selector above the normal composer.
- A UI-only draft also exposes the same combined model/thinking selector as a real conversation. Desktop obtains draft config options through a read-only, workspace-scoped ACP request that does not create a session-map record or Pi RPC session. The request loads provider registrations from that workspace's extensions and the bundled pi-tools-suite, including Antigravity, without leaking one workspace's providers into another. Changing model/thinking in the draft updates only draft-local UI state and does not call `session/set_config_option` or `session/new`.
- The embedded selector fills the available transcript height down to the composer. Its heading/search area remains fixed while only the saved-session list scrolls, and each saved conversation occupies one dense row with title and timestamp on the same line.
- The embedded saved-conversation selector initially renders at most 30 rows,
  then reveals another 15 when a scroll-container-local intersection sentinel
  approaches the viewport. A visible keyboard-accessible Show more control
  remains as a fallback when intersection observation is unavailable. Pagination
  resets with a new search query or project, but does not discard already shown
  rows for an ordinary catalog refresh. Search matches the full project catalog,
  and the fork tree is sorted and built before slicing so incremental pages
  never break ancestry connectors. This is incremental Desktop rendering of
  the already available ACP session catalog, not a new provider or JSONL fetch.
- The embedded selector omits sessions already represented by open conversation tabs. Preview/Diff are irrelevant to this filter because they are not sessions.
- Saved-session selection surfaces mark sessions carrying Pix fork metadata with the same branch/fork affordance used by conversation tabs, so forks stay visually distinguishable both in the titlebar picker and in the draft's embedded selector.
- With no search text, both saved-session selectors preserve TUI fork ordering (descending-`updatedAt` roots/siblings and parent-adjacent descendants), using thin graphical SVG connectors with rounded turns and small nodes. Separate always-visible, rotating Lucide chevrons expand/collapse branches without opening or deleting a conversation; hover and keyboard focus highlight direct parent/child relationships. Collapse state is local to the selector and resets on project change in the embedded chooser. Nested collapse state survives reopening a parent. Collapse filtering happens before pagination. Searching intentionally switches to flat ranked results, includes collapsed descendants, and keeps the fork affordance.
- The embedded selector has no separate **New conversation** row. Typing, project-path insertion (including dropping a file or folder from Project Explorer into the composer), voice insertion, or adding an attachment marks the draft as edited and removes the selector immediately, but still does **not** create an ACP session.
- After the selector disappears, an edited draft with no session shows the normal empty-conversation prompt rather than an opening/loading status; no conversation is being opened until first submission.
- The first real prompt submission from the draft renders optimistically: Desktop snapshots the draft input, clears the composer, and appends the local user message immediately while ACP startup continues. It then creates the ACP session lazily, carrying any staged draft model/thinking selection as a one-session startup override, waits for that runtime to become ready, retargets the attachment draft to the new id, replaces the synthetic conversation tab with the real session tab, adopts the already-rendered transcript without duplicating the user message, and only then sends the prepared prompt to ACP. The staged selection must not mutate the persisted global/project default model. Any Preview/Diff placement anchored to the draft is retargeted to the real session id rather than entering session persistence.
- First-prompt materialization uses a draft-scoped busy state instead of the global Desktop operation lock. The composer and session/workspace mutation controls (including tab close and New Conversation) are temporarily disabled while the runtime is starting, but existing conversation tabs remain selectable and unrelated Preview/Diff workbench navigation remains responsive.
- Switching away from a materializing draft after an optimistic first-prompt submit does not cancel that accepted send. Materialization continues in the background, the newly created real session tab adopts the optimistic transcript and receives the prepared prompt, while the conversation the user selected remains active and its composer/runtime/config state is not overwritten. Explicitly closing/discarding the draft or invalidating its workspace/client ownership still cancels the generation; any stale created ACP session is discarded asynchronously. If background materialization itself fails, the original draft text and attachments are retained under the draft tab for retry without leaking into the currently selected composer.
- Pending attachment inspection/caching settles before submit snapshots the composer draft, so pressing Enter immediately after paste/attach cannot race the first prompt and silently omit the file.
- Choosing a saved conversation from the embedded selector closes the UI-only draft and loads that saved session directly; no throwaway ACP session is created or closed. Workbench-only Preview/Diff tabs remain excluded from that saved-session selector.
- Repeated New Conversation actions reuse the existing draft tab instead of creating multiple empty chooser tabs.
- Starting a project task while the UI-only draft is active creates and foregrounds the task's real conversation session. The draft tab is deactivated rather than discarded, so its unsent composer text/attachments remain owned by the draft and can be restored later; the task prompt and subsequent runtime state belong only to the new real session.
- A sole UI-only draft tab is not closable. Its close affordance is omitted, and Delete or middle-click are ignored. Closing the last real session still transitions to one draft conversation tab, which remains the minimum session surface even if Preview/Diff are also open.
- Active-session close clears the old conversation error before showing the fallback session or draft. Background teardown success does not clear errors belonging to newer work; a failed close still restores its tab and displays the close error.
- A UI-only draft is never persisted as the active project session, so restarting Pix cannot attempt `session/history` for it. Compatibility recovery for older mapped empty sessions remains unchanged and generation-guarded.
- The New Conversation action uses the shared `session.new` command metadata for its platform shortcut hint; the Command Palette New/Open Conversation actions use the same UI-only draft surface.

- A cached transcript is not proof that persisted history finished loading. If tab navigation interrupted hydration, or hydration failed, selecting that session again retries history loading even when an empty placeholder or partial live updates were cached. Successful hydration, including a genuinely empty history, makes the cache reusable. Submit-owned pending hydration is retained rather than restarted on re-entry, and closing/resetting a session clears its incomplete-history state.
  A failed optimistic close restores incomplete-history and older-page cursor metadata along with tab membership, but never restores retired request ownership. Late updates for the retired attachment cannot recreate a deleted transcript before a fresh attachment opens.

## Accessibility and focus invariants

- Focus and selected workbench state are distinct. Arrow navigation can focus a background session or any auxiliary workbench tab without activating it.
- Conversation activity/runtime-active indication is separate from `aria-selected`; an underlying active session may retain its status dot while an auxiliary workbench tab is selected.
- A session whose agent-control state is `paused` replaces the running spinner in its conversation-tab status slot with a static Pause icon. The paused state wins over the generic prompt-running indicator while the prompt request is settling, so a successfully paused tab never continues to look actively spinning.
- The workbench tablist does not require every tab to be reachable by repeated Tab presses; arrow navigation owns movement inside the composite.
- New Conversation remains a separate control outside the roving-focus sequence.

## Implementation

- `desktop/src/components/StatusBar.svelte`
- `desktop/src/components/TranscriptPane.svelte`
- `desktop/src/components/WorkbenchTabs.svelte`
- `desktop/src/components/SessionStartView.svelte`
- `desktop/src/components/SessionSelector.svelte`
- `desktop/src/components/SavedSessionRow.svelte`
- `desktop/src/lib/saved-session-tree.ts`
- `desktop/src/components/PromptComposer.svelte`
- `desktop/src/lib/workbench-tabs.ts`
- `desktop/src/lib/session-tabs.ts`
- `desktop/src/lib/model-thinking.ts`
- `desktop/src/lib/acp-client.ts`
- `desktop/src/lib/acp-pix-extensions.ts`
- `desktop/src/app/draft-session.svelte.ts`
- `desktop/src/app/composer-drafts.ts`
- `desktop/src/app/attachment-draft-ownership.ts`
- `desktop/src/app/session-tab-controller.ts`
- `desktop/src/app/session-tab-selection.ts`
- `desktop/src/app/session-history.svelte.ts`
- `desktop/src/app/session-tab-closure.ts`
- `desktop/src/app/workbench-controller.ts`
- `desktop/src/app/desktop-root-effects.svelte.ts`
- `desktop/src/app/session-coordinator.ts`
- `desktop/src/app/session-activity.svelte.ts`
- `desktop/src/app/desktop-presentation-state.svelte.ts`
- `acp/src/acp/desktop-commands.ts`
- `acp/src/acp/draft-model-runtime.ts`
- `acp/src/acp/pix-acp-agent.ts`

## Related specifications

- `specs/desktop-workbench-tabs.md`
- `specs/desktop-session-parity.md`
- `specs/desktop-project-titlebar.md`

## Tests

- `desktop/src/components/SessionStartView.test.ts`
- `desktop/src/components/SessionSelector.test.ts`
- `desktop/src/components/SavedSessionRow.test.ts`
- `desktop/src/lib/saved-session-tree.test.ts`
- `desktop/src/app/session-tab-history.test.ts`
- `desktop/src/app/attachment-draft-ownership.test.ts`
- `desktop/src/components/DesktopVisualRegressions.test.ts`
- `desktop/src/components/ComposerActivity.test.ts`
- `desktop/src/lib/composer-activity.test.ts`
- `desktop/src/lib/composer-activity-hold.test.ts`
- `desktop/src/lib/session-tabs.test.ts`
- `desktop/src/app/session-tabs-state.test.ts`
- `desktop/src/lib/workbench-tabs.test.ts`
- `desktop/src/app/workbench-model.test.ts`
- `desktop/src/components/WorkbenchTabs.test.ts`
- `desktop/src/app/session-tab-closure.test.ts`
- `desktop/src/app/workbench-controller.test.ts`
- `desktop/src/app/session-history.test.ts`
- `desktop/src/app/session-coordinator.test.ts`
- `desktop/src/app/prompt-submit.test.ts`
- `desktop/src/app/draft-tab-selection.test.ts`
- `desktop/src/app/prompt-submit-opening.test.ts`
- `desktop/src/app/desktop-workbench-prop-builders.test.ts`
- `desktop/src/app/session-runtime-loading.test.ts`
- `desktop/src/app/desktop-project-action-services.test.ts`

## Verification

- `desktop/src/app/session-tab-history.test.ts` uses deferred history responses to verify retry after interrupted/failed hydration, partial live-cache preservation, retained submit-owned hydration on tab re-entry, and reuse of successfully loaded empty history.
- `desktop/src/app/attachment-draft-ownership.test.ts` verifies image drafts across real/draft tab switches and deferred ownership reconciliation, stale async attachment rejection, workspace clearing, and first-submit ownership retargeting.
- `desktop/src/components/DesktopVisualRegressions.test.ts` verifies ordinary composer borders and no transcript-bottom spinner.
- `desktop/src/components/ComposerActivity.test.ts` verifies composer-dock placement, neutral announcements, and reduced-motion markup; `desktop/src/lib/composer-activity.test.ts` covers current-turn selection, concurrent actions, history/draft/runtime gating, settlement, and pending input; `desktop/src/lib/composer-activity-hold.test.ts` covers the one-second latest-wins hold (immediate first display, coalescing, immediate hide, session reset, dispose).
- `desktop/src/lib/session-tabs.test.ts` covers session membership/restoration/replacement, Desktop-owned tab snapshot parsing/serialization, stale TUI rejection, explicit-empty restore, active-session fallback, plus deterministic fork-tree sibling, nested, malformed/orphan, and flat-search row behavior independently of UI-only workbench tabs.
- `desktop/src/app/session-tabs-state.test.ts` covers persistence after open/close mutations, independent two-window ordered tabs/active pointers across restart, captured write ownership, per-window project switching, rejection of ambiguous legacy snapshots, and explicit empty Desktop snapshots suppressing stale TUI tabs across restart.
- `desktop/src/lib/workbench-tabs.test.ts` covers mixed workbench ordering without changing session identity.
- `desktop/src/app/workbench-model.test.ts` covers fork metadata propagation into workbench session tabs.
- `desktop/src/components/WorkbenchTabs.test.ts` covers unified roving tab semantics and kind-specific close dispatch.
- `desktop/src/app/session-tab-closure.test.ts` controls ACP close completion to verify immediate optimistic removal and fallback/draft navigation before teardown, no global operation lock, per-session duplicate guarding, retained rollback snapshots, and stale-completion isolation. `desktop/src/app/workbench-controller.test.ts` verifies that delayed close consent cannot overwrite later workbench navigation and that conversation-change selection policy preserves auxiliary fallbacks. `desktop/src/app/session-history.test.ts` covers rollback hydration/cursor metadata; `desktop/src/app/session-coordinator.test.ts` covers late-update exclusion and fresh attachment.
- Desktop draft/concurrency and ACP-client coverage verifies that draft config is loaded without `session/new`, a staged model selection is kept local, and the override is carried only when first-prompt materialization happens.
- `desktop/src/app/prompt-submit.test.ts` verifies that the first draft user message renders and clears the composer before materialization resolves and is still sent to the materialized session after another conversation is selected; `desktop/src/app/draft-tab-selection.test.ts` verifies that background materialization does not steal active-session state or discard the created session.
- `desktop/src/app/prompt-submit-opening.test.ts`, `desktop/src/app/desktop-workbench-prop-builders.test.ts`, `desktop/src/app/session-history.test.ts`, and `desktop/src/app/session-runtime-loading.test.ts` cover immediate existing-session editing/optimistic send, captured target and attachments, duplicate-submit rejection without consuming fresh input, invalidated ownership, and history merge/empty-history preservation.
- `desktop/src/app/desktop-project-action-services.test.ts` verifies that launching a project task from the active UI-only draft deactivates/preserves that draft, transfers composer ownership, and foregrounds the created real task session.
- `npm --prefix desktop test`
- `npm --prefix desktop run check`
- `npm --prefix desktop run build:web`
