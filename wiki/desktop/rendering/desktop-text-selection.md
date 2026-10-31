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
   The file/attachment path or title in the Preview header is an explicit exception: it supports native pointer text selection and Copy, while neighboring navigation buttons and toolbar labels remain non-selectable.
2. Transcript message/content text and text-file Preview surfaces opt back into normal document text selection. Pointer selection that starts in either surface cannot continue selecting sidebar, tab, toolbar, status-bar, or other control labels outside that content surface.
   Within the transcript, entry containers exclude tool/chrome labels from selection while Markdown text, expanded tool output (plain text, highlighted source, and mutation diagnostics), and diff bodies opt in. Tool disclosure labels, diff headers, and diff line-number gutters remain non-selectable. Transcript layout boxes and outer gutters have transparent selection backgrounds. The centered transcript content uses outer margins rather than horizontal padding, with `contain: paint` on the inner column to bound painting; margins alone did not prevent gutter paint in the user's macOS check. Pane-level overlays and the user-message menu remain outside this boundary. Rendered Markdown Preview likewise keeps horizontal gutters outside its paint-contained text column and leaves layout selection backgrounds transparent. The transcript, read-only Markdown/source Preview text, and Preview edit textarea use the theme's `selection` background and `selection-foreground` for selected text and descendants, including links, inline code, and syntax tokens. Native WebKit wrapped-line highlight geometry inside the text surface is accepted. Selection and Copy remain native. Other editable controls (such as the composer and Preview find input) retain normal selection paint.
3. The composer textarea and other editable text controls opt into native text selection independently of those document surfaces.
4. With focus in the composer textarea, `Cmd+A` on macOS or `Ctrl+A` on other desktop platforms selects the composer draft only.
5. With focus outside an editable text control, native Select All is constrained to selectable document content because surrounding desktop chrome is non-selectable.
6. Text-entry inputs and contenteditable editors retain their native local Select All behavior when focused.
7. Buttons, selects, disclosure summaries, tabs, options, checkbox/radio controls, and menu-item chrome remain non-selectable even when nested inside an otherwise selectable content surface.
8. Existing per-component `select-none` behavior remains authoritative for interaction labels that intentionally live inside the transcript, such as disclosure summaries.
9. In Tauri windows, right-click on selected content opens the native application text menu, not the WebView menu. Selection Copy takes priority over whole-user-message actions; the message ellipsis still exposes those actions. Text editing uses native editing commands without replacing the draft value or inventing a separate undo stack. See `desktop-context-menus.md`.

## Related files

- `desktop/src/styles.css`
- `desktop/src/components/TranscriptPane.svelte`
- `desktop/src/components/ToolResult.svelte`
- `desktop/src/components/DiffView.svelte`
- `desktop/src/components/PreviewPane.svelte`
- `desktop/src/components/PromptComposer.svelte`
- `desktop/src/components/WorkspaceSidebar.svelte`
- `desktop/src/components/WorkbenchTabs.svelte`

## Verification

- `npm --prefix desktop run check`
- `npm --prefix desktop run build:web`
- `npm --prefix desktop run test:tool-selection` exercises real transcript tool disclosures, pointer selection, copy, and exclusion of tool/diff chrome in Chromium.
- Manual desktop verification: expand tool output and diffs, drag-select body text, and copy with `Cmd+C` or the native context menu; clipboard text must contain the selection, not disclosure labels or diff line numbers.
- Manual desktop verification: drag-select through a long conversation and confirm selection stops at transcript content rather than extending into sidebar/tabs/status chrome.
- Manual desktop verification: select across three or more wrapped lines in one Markdown paragraph; confirm the theme selection background and foreground are visible across mixed content and Copy returns the selected text. Native WebKit wrapped-line highlight geometry is acceptable inside the text surface, not in its outer gutters.
- Manual desktop verification: drag-select across several messages and confirm selection stays within transcript content, does not paint the outer gutters, and does not spill into surrounding chrome.
- Manual desktop verification: select across wrapped Markdown and source lines in Preview, then edit the file and select inside the textarea; confirm the theme selection background and foreground apply consistently to prose, links, code, and syntax tokens, Markdown Preview's outer horizontal gutters do not paint selection, Copy returns the selected text, and find-input selection keeps its normal paint.
- Manual desktop verification: focus the composer, press `Cmd+A`/`Ctrl+A`, and confirm only the draft is selected.
- Manual desktop verification: move focus to non-editable chrome and invoke Select All; transcript text may select, but chrome/control labels do not.

## Evidence

- Confirmed by code: `PromptComposer.svelte` uses a native textarea, so focused Select All remains local to the draft without a custom keyboard handler.
- Confirmed by code: `TranscriptPane.svelte` exposes the `.transcript-pane` document-style conversation surface and already marks disclosure summaries as non-selectable controls.
- Confirmed by implementation: global desktop CSS defaults the app root to `user-select: none`, opts `.transcript-pane`, `.preview-text-surface`, and editable controls back into text selection, and explicitly keeps common interaction roles non-selectable.
- Confirmed by implementation: transcript and Preview layout boxes have transparent selection backgrounds, while Markdown/tool/diff text and descendants opt into the theme's `--selection` background and `--selection-foreground`; centered transcript and Markdown Preview text columns use outer margins instead of horizontal padding and paint containment. Preview source code and its editor textarea retain the same theme selection colors. Native selection and Copy remain unchanged. The margin-only approach failed the user's macOS transcript check. After adding paint containment there, the user confirmed that selection no longer paints the outer gutters. Automated native QA captured the running app but could not create a text-range selection; the Preview gutter behavior still needs a manual macOS check.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"537d2a77f682516155b07c037e645f7ff2672c2e588f22fa5c641159db730f10","checkedAt":"2026-10-31T00:42:38.745Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":52,"reportLanguage":"ru"} -->
