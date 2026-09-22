# Desktop unified workbench tabs

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Present conversations, file/media Preview, and Source Control Git Diff as sibling tabs in one titlebar workbench strip while preserving the existing runtime/session lifecycle separately from workspace-only UI surfaces.

## Behavior

- Pix Desktop has one top `WorkbenchTabs` tablist. There is no second nested editor-tab strip inside the central workspace.
- Conversation tabs are derived from the existing `buildTabSessions` order plus the UI-only draft conversation. Their session membership, Desktop/TUI reconciliation, active-session storage, runtime ownership, and ACP close semantics are unchanged.
- Preview and Git Diff are UI-only workbench tabs. They never enter `buildTabSessions`, restored/local session id arrays, saved-session selectors, active-session persistence, ACP session maps, or TUI `pix.tabs` metadata.
- Preview/Diff are inserted beside the visible tab that opened them when possible while the relative order of the canonical session list remains authoritative. If the opener disappears, the UI-only tab remains workspace-scoped and falls back to a valid location in the same strip.
- Exactly one workbench tab is visually/ARIA selected. Selecting a session tab activates/loads that conversation and displays `conversation-workspace`. Selecting Preview or Git Diff changes only the visible central work surface; the active conversation runtime remains available in the background for status/review operations.
- Opening a project/local file or supported media creates/updates the single Preview tab and selects it. Preview retains its existing browser-like back/forward history instead of opening one tab per followed link.
- Opening Source Control diff/review creates/updates the single Git Diff tab and selects it. Opening a file reference from Git Diff selects Preview while Git Diff remains open.
- Conversation, Preview, and Git Diff remain mounted while merely hidden by another workbench tab so composer/transcript state, Preview edit draft/history/scroll, media state, and Git review output do not reset on ordinary tab switching.
- Switching to a different conversation selects that session's workbench tab but does not discard workspace-scoped Preview or Git Diff tabs. Their state remains available until explicitly closed or the workspace lifecycle invalidates it.
- Preview shows a dirty indicator while its Markdown draft differs from the loaded file. Closing dirty Preview asks before discard; cancellation keeps the tab/state intact. Workspace changes and project-reloading Git mutations keep the existing dirty-preview confirmation.
- File reads and attachment preparation share Preview load ownership. Closing, navigating, opening an immediate preview, or invalidating the workspace prevents an older load from replacing/reopening the current Preview or reporting an obsolete error.
- Markdown saves capture their workspace and originating Preview entry. Writes to the same workspace/path are serialized; a late save cannot replace a reopened entry with the same path, unlock another edit's save, or close a newer edit. Text typed while saving remains an editable dirty draft rather than being replaced by the saved snapshot.
- Git Diff shows a compact busy indicator during LLM review/resolve work without becoming a modal.
- The unified tablist uses roving focus: Left/Right and Home/End move focus without activation, Enter/Space activate via native button behavior, Delete closes a closable focused tab, and middle-click uses the same close path.
- Closing Preview/Diff removes only that UI surface. Closing a session uses the existing session-close flow, including running-session confirmation and ACP teardown. When an active session closes next to Preview/Diff, Pix may keep the necessary fallback session runtime active underneath while selecting the logical neighboring workbench tab.
- A sole UI-only draft conversation remains non-closable. New Conversation remains the one trailing action outside the roving tab sequence. The tablist/action group shrink-wraps their contents; the tablist may shrink and scroll horizontally in a narrow titlebar, while New Conversation is fixed immediately after the last visible tab and unused space remains the drag region. Each tab's preferred width matches its flex basis (220px, or 200px below the 760px breakpoint), may shrink to 120px, and has no larger intrinsic maximum.
- Session-kind tabs keep their semantic session-status icon even while Preview/Diff is selected. Status and workbench selection are independent: the icon reports session execution/attention/completion state while the tab border/background remains the only selected-surface affordance.
- A real session tab whose ACP session metadata marks it as a fork shows a compact branch icon before its title, alongside (not instead of) the session status icon. Draft, Preview, and Git Diff tabs never show this fork marker.
- The saved-session selector and embedded draft selector remain session-only. Preview/Diff never appear as resumable conversations.
- Command Palette entries **Show Conversation**, **Show Preview**, **Show Git Diff**, and **Close Active Editor** target this unified workbench model. Focus Composer first selects the active conversation tab before focusing the hidden/mounted composer.

## Non-goals

- Persisting Preview or Git Diff tabs across application restarts.
- Treating Preview/Diff as ACP sessions or TUI tabs.
- Opening multiple independent Preview tabs; Preview keeps one history-bearing work surface.
- Converting bounded settings, elicitation, or model-selection flows into workbench tabs.

## Related files

- `desktop/src/app/workbench-model.ts`
- `desktop/src/app/workbench-controller.ts`
- `desktop/src/app/desktop-presentation-state.svelte.ts`
- `desktop/src/app/preview-state.svelte.ts`
- `desktop/src/app/preview-file-io.ts`
- `desktop/src/app/project-documents.svelte.ts`
- `desktop/src/app/desktop-project-services.ts`
- `desktop/src/app/session-tab-controller.ts`
- `desktop/src/components/WorkbenchTabs.svelte`
- `desktop/src/components/PreviewPane.svelte`
- `desktop/src/components/preview-editor-controller.svelte.ts`
- `desktop/src/components/preview-scroll-controller.svelte.ts`
- `desktop/src/components/preview-markdown-controller.svelte.ts`
- `desktop/src/components/GitDiffPane.svelte`
- `desktop/src/lib/workbench-tabs.ts`
- `desktop/src/lib/session-tabs.ts`
- `desktop/src/lib/preview-history.ts`
- `desktop/src/lib/desktop-commands.ts`
- `specs/desktop-session-tabs.md`
- `specs/desktop-session-parity.md`

## Verification

- `desktop/src/lib/workbench-tabs.test.ts` covers mixed insertion, session-id separation, close fallback, and stale-active normalization.
- `desktop/src/components/WorkbenchTabs.test.ts` covers the unified roving tablist, shrink-wrapped non-growing tablist/action layout, tab preferred-width/flex-basis consistency, semantic session-status icon set, and kind-specific close dispatch.
- `desktop/src/app/workbench-model.test.ts` covers propagation of fork metadata into the session-tab presentation model; `desktop/src/lib/session-tab-status.test.ts` covers status precedence and unseen-completion semantics.
- Existing session-tab/draft tests verify that session membership and lazy draft materialization remain session-only.
- `desktop/src/app/preview.test.ts`, `desktop/src/app/project-documents.test.ts`, and `desktop/src/components/preview-editor-controller.test.ts` use controlled promises to verify late-load/save ownership, same-file write serialization, and preservation of newer drafts.
- `npm --prefix desktop test`
- `npm --prefix desktop run check`
- `npm --prefix desktop run build:web`
