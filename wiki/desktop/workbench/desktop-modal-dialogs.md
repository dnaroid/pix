---
kind: spec
status: active
---

# Desktop modal dialog lifecycle

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Keep true modal UI limited to bounded decisions, configuration and search, with native focus containment, predictable cancel/default actions, and focus restoration.

## Behavior

- Deletion confirmations (tasks, conversations, files/folders, plans, saved launch commands, diagnostic logs and project scratch cleanup) share `DeleteConfirmationDialog.svelte`: a Pix-styled native HTML `<dialog>`, Cancel first and initially focused, destructive action second, Escape cancels, and focus restores on dismissal. Action-specific titles, messages and destructive labels retain the operation's scope and consequences. Backdrop clicks do not approve or dismiss deletion.
- Imperative deletion callers await `confirmDesktopDeletion`, presented by the window's `DeleteConfirmationHost`. Overlapping requests fail closed instead of queuing stale decisions; host teardown cancels pending consent, and a missing host or modal-open failure cancels with a handled diagnostic. Task and log UI use the same dialog component directly with their existing state owners and busy guards.
- Non-deletion confirmations (such as discarding edits) retain `confirmDesktopAction`. In Tauri it uses the supported `@tauri-apps/plugin-dialog` API rather than the legacy injected `window.confirm` bridge; browser previews accept only a synchronous result exactly equal to `true`. A missing/rejected native dialog fails closed and records a handled diagnostic.
- Destructive operations must await consent before mutating state, recheck workspace/operation ownership after asynchronous consent, and never treat a Promise as approval. Running-conversation tab closure keeps its separate native dialog and user-visible error path described in `desktop-close-warning.md`.

- File/media Preview and Git Diff are explicitly not modal dialogs; they are UI-only tabs in the unified titlebar workbench governed by `wiki/desktop/workbench/desktop-workbench-tabs.md`.
- General form elicitation, Project settings, Command Picker/Palette and [Universal search](../../search/desktop-universal-search.md) use native HTML `<dialog>` with `showModal()` rather than a hand-built fullscreen `role=dialog` overlay. Model + Thinking is instead a [nonmodal status-bar popup](../../configuration/desktop-model-picker-popup.md), per [decision 0049](../../decisions/0049-nonmodal-model-picker.md).
- `desktop/src/lib/modal-dialog.ts` centralizes opening the native modal, intentional initial focus, close-on-unmount, and best-effort focus restoration to the invoker by default. A caller may override the restoration target.
- Escape follows the native dialog `cancel` event. Components prevent the browser's implicit close and route cancellation through their existing state owner so async/saving guards remain authoritative.
- Backdrop click may dismiss only dialogs whose existing workflow treats backdrop dismissal as safe.
- Elicitation is a semantic form: its first field receives initial focus, Cancel rejects the request, and Continue is the submit/default action. ACP string fields tagged with the explicitly recognized `_pix/ui-kind` property metadata render `input` as a single-line text input and `editor` as a textarea; untagged strings default to a single-line input. Select and boolean fields are unchanged. A label matching the dialog heading is visually suppressed but remains available to assistive technology. Editor Enter remains newline input rather than forced submission.
- Project settings is a semantic form with Save as submit/default action; the existing saving/validation guards continue to decide whether Save is enabled.
- Command Picker/Palette focuses its search combobox. Results remain listbox options controlled with `aria-activedescendant`; result rows are not dozens of independent Tab stops.
- Universal search focuses its query input. Escape and teardown abort pending queries and navigation; a completion belonging to a retired dialog cannot close a replacement dialog.
- Model + Thinking's retained search, keyboard and confirmation contract is described in [Desktop live model switching](../../configuration/desktop-live-model-switching.md); its popup lifecycle is not governed by this modal contract.

## Non-goals

- Replacing all transient popovers/menus with `<dialog>`.
- Adding a custom focus-trap library.
- Changing backend elicitation, project-setting persistence, model config, or command execution semantics.

## Verification

- Component source tests verify native dialog usage, shared lifecycle usage, semantic default forms, and combobox/listbox focus ownership.
- `npm --prefix desktop test`
- `npm --prefix desktop run check`
- `npm --prefix desktop run build:web`

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"ddb35b905526ac78d13a4d77c405eeebe132c4dcb7e6a6b1c01e932f3d89386f","checkedAt":"2026-10-31T00:34:04.872Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":62,"reportLanguage":"ru"} -->
