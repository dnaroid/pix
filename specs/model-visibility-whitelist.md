# Model visibility whitelist

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Give Pix TUI and Desktop one shared, user-controlled model-picker whitelist while keeping the underlying runtime/ACP catalogs complete.

## Scope

- `visibleModels` in the user `~/.config/pi/pix.jsonc` configuration.
- The TUI combined model/thinking picker.
- The Desktop combined model/thinking picker.
- Model-picker filtering only; session scope and model availability remain separate concepts.

## Behavior

- `visibleModels` is an optional array of exact `provider/model` refs. When omitted, both Pix model pickers show every model in their complete available catalog.
- An explicit whitelist, including `[]`, is authoritative for picker visibility. The current active model is always kept visible so the picker cannot enter an invalid current-selection state.
- The preference is user-level and shared across TUI and Desktop. Project `.pi/pix.jsonc` files do not override it.
- TUI builds its picker from the complete `ModelRuntime.getAvailableSnapshot()` rather than `session.scopedModels`; `enabledModels` continues to control SDK session scope/cycling but not picker visibility.
- TUI `Shift+Tab` toggles `Manage visible models`. Management mode exposes hidden models, `Enter`/mouse click toggles the highlighted model, and the current model cannot be hidden. Edits are persisted immediately.
- Desktop exposes a `Manage` mode in the same model/thinking dialog. It shows the complete ACP model option catalog with visibility checkmarks, saves changes immediately to the same `visibleModels` key, and prevents hiding the current model. `Shift+Tab` also toggles the mode while focus is in model search.
- Normal model selection never removes entries from the runtime or ACP model catalog; the whitelist is a presentation filter only.

## Related files

- `src/config.ts`
- `src/default-pix-config.ts`
- `src/schemas/pix-schema.ts`
- `schemas/pix.json`
- `src/app/popup/menu-items-controller.ts`
- `src/app/popup/popup-menu-controller.ts`
- `src/app/popup/popup-action-controller.ts`
- `src/app/rendering/popup-menu-renderer.ts`
- `src/app/input/input-controller.ts`
- `desktop/src/App.svelte`
- `desktop/src/components/ModelThinkingPicker.svelte`
- `desktop/src/lib/model-visibility.ts`

## Verification

- Root config tests cover normalization, persistence, explicit empty whitelists, and project-override suppression.
- TUI menu tests cover full-catalog behavior under an explicit session scope and normal-vs-management whitelist filtering.
- TUI popup/input tests cover the visibility mode and `Shift+Tab` routing.
- Desktop unit tests cover JSONC whitelist parsing/updating; `svelte-check` covers the picker integration.
