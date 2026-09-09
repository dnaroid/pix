# Desktop text selection scopes

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Make Pix Desktop text selection behave like a native desktop application: conversation text and editable text fields are selectable, while window chrome and controls are not.

## Scope

- Treat the transcript as the document-style text-selection surface of the main window.
- Keep the prompt composer and other native editable text controls as independent local selection surfaces.
- Exclude sidebar content, session tabs, title/status bars, buttons, pickers, summaries, and other interaction chrome from text selection.
- Preserve native `Cmd+A` / `Ctrl+A` behavior according to the currently focused selection surface.
- Constrain pointer-drag text selection to selectable content instead of allowing it to spill through application chrome.

## Non-goals

- Replacing the browser/WebView selection implementation with a custom selection model.
- Changing clipboard formatting for selected transcript text.
- Making button labels, tabs, tool-row disclosure summaries, or other controls copyable as ordinary text.
- Changing editor-specific keyboard shortcuts or selection behavior inside text inputs, textareas, or contenteditable surfaces.

## Behavior

1. Desktop application chrome is non-selectable by default.
2. Transcript message/content text opts back into normal document text selection. Pointer selection that starts in the transcript cannot continue selecting sidebar, tab, toolbar, status-bar, or other control labels outside that content surface.
3. The composer textarea and other editable text controls opt into native text selection independently of the transcript.
4. With focus in the composer textarea, `Cmd+A` on macOS or `Ctrl+A` on other desktop platforms selects the composer draft only.
5. With focus outside an editable text control, native Select All is constrained to the selectable transcript content because surrounding desktop chrome is non-selectable.
6. Text-entry inputs and contenteditable editors retain their native local Select All behavior when focused.
7. Buttons, selects, disclosure summaries, tabs, options, checkbox/radio controls, and menu-item chrome remain non-selectable even when nested inside an otherwise selectable content surface.
8. Existing per-component `select-none` behavior remains authoritative for interaction labels that intentionally live inside the transcript, such as disclosure summaries.

## Related files

- `desktop/src/styles.css`
- `desktop/src/components/TranscriptPane.svelte`
- `desktop/src/components/PromptComposer.svelte`
- `desktop/src/components/WorkspaceSidebar.svelte`
- `desktop/src/components/SessionTabs.svelte`

## Verification

- `npm --prefix desktop run check`
- `npm --prefix desktop run build:web`
- Manual desktop verification: drag-select through a long conversation and confirm selection stops at transcript content rather than extending into sidebar/tabs/status chrome.
- Manual desktop verification: focus the composer, press `Cmd+A`/`Ctrl+A`, and confirm only the draft is selected.
- Manual desktop verification: move focus to non-editable chrome and invoke Select All; transcript text may select, but chrome/control labels do not.

## Evidence

- Confirmed by code: `PromptComposer.svelte` uses a native textarea, so focused Select All remains local to the draft without a custom keyboard handler.
- Confirmed by code: `TranscriptPane.svelte` exposes the `.transcript-pane` document-style conversation surface and already marks disclosure summaries as non-selectable controls.
- Confirmed by implementation: global desktop CSS defaults the app root to `user-select: none`, opts `.transcript-pane` and editable controls back into text selection, and explicitly keeps common interaction roles non-selectable.
