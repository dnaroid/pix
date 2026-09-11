# Desktop modal dialog lifecycle

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Keep true modal UI limited to bounded decisions/configuration and give those dialogs native focus containment, predictable cancel/default actions, and focus restoration.

## Behavior

- File/media Preview and Git Diff are explicitly not modal dialogs; they are workspace editor tabs governed by `specs/desktop-editor-tabs.md`.
- General form elicitation, Project settings, Command Picker/Palette, and Model + Thinking selection use native HTML `<dialog>` with `showModal()` rather than a hand-built fullscreen `role=dialog` overlay.
- `desktop/src/lib/modal-dialog.ts` centralizes opening the native modal, intentional initial focus, close-on-unmount, and best-effort focus restoration to the invoker.
- Escape follows the native dialog `cancel` event. Components prevent the browser's implicit close and route cancellation through their existing state owner so async/saving guards remain authoritative.
- Backdrop click may dismiss only dialogs whose existing workflow treats backdrop dismissal as safe.
- Elicitation is a semantic form: its first field receives initial focus, Cancel rejects the request, and Continue is the submit/default action. Textarea Enter remains newline input rather than forced submission.
- Project settings is a semantic form with Save as submit/default action; the existing saving/validation guards continue to decide whether Save is enabled.
- Command Picker/Palette focuses its search combobox. Results remain listbox options controlled with `aria-activedescendant`; result rows are not dozens of independent Tab stops.
- Model + Thinking focuses its model-search combobox. Model rows are listbox options outside the normal Tab sequence; its existing arrow/search/thinking controls and staged Apply semantics remain unchanged.

## Non-goals

- Replacing all transient popovers/menus with `<dialog>`.
- Adding a custom focus-trap library.
- Changing backend elicitation, project-setting persistence, model config, or command execution semantics.

## Related files

- `desktop/src/lib/modal-dialog.ts`
- `desktop/src/components/ElicitationDialog.svelte`
- `desktop/src/components/ProjectSettingsDialog.svelte`
- `desktop/src/components/CommandPicker.svelte`
- `desktop/src/components/ModelThinkingPicker.svelte`

## Verification

- Component source tests verify native dialog usage, shared lifecycle usage, semantic default forms, and combobox/listbox focus ownership.
- `npm --prefix desktop test`
- `npm --prefix desktop run check`
- `npm --prefix desktop run build:web`
