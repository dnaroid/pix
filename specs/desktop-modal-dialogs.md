# Desktop modal dialog lifecycle

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Keep true modal UI limited to bounded decisions/configuration and give those dialogs native focus containment, predictable cancel/default actions, and focus restoration.

## Behavior

- File/media Preview and Git Diff are explicitly not modal dialogs; they are UI-only tabs in the unified titlebar workbench governed by `specs/desktop-workbench-tabs.md`.
- General form elicitation, Project settings, Command Picker/Palette, and Model + Thinking selection use native HTML `<dialog>` with `showModal()` rather than a hand-built fullscreen `role=dialog` overlay.
- `desktop/src/lib/modal-dialog.ts` centralizes opening the native modal, intentional initial focus, close-on-unmount, and best-effort focus restoration to the invoker by default. A caller may override the restoration target; Model + Thinking restores the composer after native dialog teardown, without a competing invoker restore.
- Escape follows the native dialog `cancel` event. Components prevent the browser's implicit close and route cancellation through their existing state owner so async/saving guards remain authoritative.
- Backdrop click may dismiss only dialogs whose existing workflow treats backdrop dismissal as safe.
- Elicitation is a semantic form: its first field receives initial focus, Cancel rejects the request, and Continue is the submit/default action. ACP string fields tagged with the explicitly recognized `_pix/ui-kind` property metadata render `input` as a single-line text input and `editor` as a textarea; untagged strings default to a single-line input. Select and boolean fields are unchanged. A label matching the dialog heading is visually suppressed but remains available to assistive technology. Editor Enter remains newline input rather than forced submission.
- Project settings is a semantic form with Save as submit/default action; the existing saving/validation guards continue to decide whether Save is enabled.
- Command Picker/Palette focuses its search combobox. Results remain listbox options controlled with `aria-activedescendant`; result rows are not dozens of independent Tab stops.
- Model + Thinking focuses its model-search combobox with the actual current model as its initial active row, even when Auto is pinned first. In select mode, Left/Right cycle supported thinking levels throughout the dialog (thinking-radio arrows also move radio focus); Auto has no manual thinking adjustment. Model rows remain outside the normal Tab sequence. `Enter` confirms the staged selection from search, a model row, or a thinking chip like `Apply`, including disabled/in-progress guards. Unchanged confirmation closes without a config request. Footer buttons such as `Set default`/`Cancel` keep native `Enter` activation. Visibility-manage `Enter` toggles the highlighted model's visibility instead of applying. See [Desktop live model switching](desktop-live-model-switching.md).

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
