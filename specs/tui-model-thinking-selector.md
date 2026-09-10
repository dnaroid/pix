# TUI combined model and thinking selector

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Make changing the active session model and reasoning effort one staged TUI interaction, so users can choose both before mutating the live session.

## Scope

- The active-session `/model` and `/thinking` selectors.
- Clicks on the TUI status-line model and thinking targets.
- Model fuzzy search, model-specific thinking availability, keyboard navigation, visibility management, cancellation, and apply behavior.
- Existing model/thinking semantic coloring in the combined popup.

## Non-goals

- `/default-model` and `/default-thinking`; those configure future-session defaults and remain separate persistent-setting menus.
- Changing model scope or fallback-model configuration.
- Removing the explicit argument forms `/model provider/model[:thinking]` or `/thinking level`.

## Behavior

- `/model` and `/thinking` without an argument expose the same combined `Select model & thinking` popup. The model and thinking status-line targets open that same popup.
- The popup starts from `ModelRuntime.getAvailableSnapshot()` even when the session has an explicit `enabledModels` scope. It then applies the separate Pix `visibleModels` whitelist used by both TUI and Desktop.
- The popup reuses the model selector's fuzzy search contract: current model first, then stable provider/model ordering, with matching across model ref, model id, model name, and provider.
- `Up`/`Down` move the staged model selection. Selecting a model does not mutate the session.
- A separate `Thinking  ← level →` row reflects the staged thinking level for the selected model. `Left`/`Right` cycle only through levels supported by that model.
- When the staged model changes, the current staged thinking level is preserved when supported; otherwise it is clamped to the nearest supported level using Pi's ordered `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` scale.
- `Enter` applies the staged model and thinking together. `Escape` closes the popup and discards the staged values.
- `Shift+Tab` switches between normal selection and `Manage visible models`. Management mode shows the full available catalog, including currently hidden entries; `Enter` toggles the highlighted model in the whitelist without applying a session model change. The current active model cannot be hidden.
- An omitted `visibleModels` setting means every currently available model is shown. The first hide/show edit materializes an explicit whitelist in the user Pix config; an explicit empty list therefore hides every non-current model.
- Mouse selection of a model row stages that model rather than applying immediately; `Enter` remains the apply action.
- Applying a changed model sets the selected thinking level before the model-specific resource reload. A thinking-only change does not trigger a resource reload.
- Model rows keep the existing `modelColors` / provider fallback coloring. The staged thinking value uses the existing rank-based thinking palette for the selected model's supported levels.
- Inline `/model provider/model:level` initializes both staged values. Inline `/thinking level` initializes the staged thinking value while keeping the current model selected. Tab completion canonicalizes an active combined selection as `/model provider/model:level`; `Shift+Tab` is reserved for visibility management while this popup is active.

## Related files

- `src/app/popup/popup-menu-controller.ts`
- `src/app/popup/popup-action-controller.ts`
- `src/app/rendering/popup-menu-renderer.ts`
- `src/app/input/input-controller.ts`
- `src/app/commands/command-model-actions.ts`
- `src/app/commands/command-controller.ts`
- `src/app/screen/mouse-controller.ts`
- `src/app/types.ts`
- `tests/popup-menu-controller.test.ts`
- `tests/input-controller.test.ts`
- `tests/command-model-actions.test.ts`

## Verification

- Popup tests cover shared `/thinking`/model-menu routing, model-specific thinking clamping, left/right staging, direct status-popup behavior, and thinking-row coloring.
- Input tests cover routing left/right to staged thinking before editor cursor movement.
- Model action tests cover applying thinking before a changed-model reload and avoiding reload for a thinking-only change.
- Root TypeScript checks and the full Pix test suite must pass.
