# TUI combined model and thinking selector

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Make choosing the model and reasoning effort one staged TUI interaction, including before a UI-only draft has materialized its first session.

## Scope

- The active-session `/model` and `/thinking` selectors and the draft-tab model/thinking state used before first-prompt materialization.
- Clicks on the TUI status-line model and thinking targets.
- Model fuzzy search, model-specific thinking availability, keyboard navigation, visibility management, cancellation, and apply behavior.
- Existing model/thinking semantic coloring in the combined popup.

## Non-goals

- `/default-model` and `/default-thinking`; those configure future-session defaults and remain separate persistent-setting menus.
- Changing model scope or fallback-model configuration.
- Removing the explicit argument forms `/model provider/model[:thinking]` or `/thinking level`.

## Behavior

- `/model` and `/thinking` without an argument expose the same combined `Select model & thinking` popup. The model and thinking status-line targets open that same popup.
- On a real session the popup starts from `ModelRuntime.getAvailableSnapshot()` even when the session has an explicit `enabledModels` scope. On a UI-only draft Pix builds the same locally available model catalogue without allocating an `AgentSession`. Both paths then apply the separate Pix `visibleModels` whitelist used by TUI and Desktop.
- The popup reuses the model selector's fuzzy search contract: current model first, then stable provider/model ordering, with matching across model ref, model id, model name, and provider.
- `Up`/`Down` move the staged model selection. Selecting a model does not mutate the session.
- A separate `Thinking  ← level →` row reflects the staged thinking level for the selected model. `Left`/`Right` cycle only through levels supported by that model.
- Thinking is remembered independently per model. During one open selector, a model first restores the thinking value already staged for that model. Otherwise a non-current model restores its persisted user-level `thinkingByModel` preference; a missing preference falls back to the current staged/session thinking. Any restored value is clamped to the nearest supported level using Pi's ordered `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` scale.
- The current model's actual session/draft thinking remains authoritative when the selector opens even if `thinkingByModel` contains an older value for that model.
- `Enter` applies the staged model and thinking together. On a real session this mutates that session; on a UI-only draft it updates only draft-local state and becomes the model/thinking override supplied when the first normal prompt materializes the runtime. `Escape` closes the popup and discards the staged values.
- After a successful `Enter`, Pix stores the effective selected model/thinking pair in user `~/.config/pi/pix.jsonc` `thinkingByModel`. Escape/cancel never persists staged-only changes. The preference is shared with Desktop and project config cannot override it; see `model-thinking-preferences.md`.
- `Shift+Tab` switches between normal selection and `Manage visible models`. Management mode shows the full available catalog, including currently hidden entries; `Enter` toggles the highlighted model in the whitelist without applying a session model change. The current active model cannot be hidden.
- An omitted `visibleModels` setting means every currently available model is shown. The first hide/show edit materializes an explicit whitelist in the user Pix config; an explicit empty list therefore hides every non-current model.
- Mouse selection of a model row stages that model rather than applying immediately; `Enter` remains the apply action.
- Applying a changed model sets the selected thinking level before the model-specific resource reload. A thinking-only change does not trigger a resource reload.
- Model rows keep the existing `modelColors` / provider fallback coloring. The staged thinking value uses the existing rank-based thinking palette for the selected model's supported levels.
- Inline `/model provider/model:level` initializes both staged values. Inline `/thinking level` initializes the staged thinking value while keeping the current model selected. Tab completion canonicalizes an active combined selection as `/model provider/model:level`; `Shift+Tab` is reserved for visibility management while this popup is active.

## Related files

- `src/app/popup/popup-menu-controller.ts`
- `src/app/popup/popup-action-controller.ts`
- `src/app/runtime.ts`
- `src/app/screen/status-controller.ts`
- `src/app/rendering/status-line-renderer.ts`
- `src/app/rendering/popup-menu-renderer.ts`
- `src/app/input/input-controller.ts`
- `src/app/commands/command-model-actions.ts`
- `src/app/commands/command-controller.ts`
- `src/app/screen/mouse-controller.ts`
- `src/app/types.ts`
- `src/config.ts`
- `schemas/pix.json`
- `tests/popup-menu-controller.test.ts`
- `tests/popup-action-controller.test.ts`
- `tests/input-controller.test.ts`
- `tests/command-model-actions.test.ts`

## Verification

- Popup tests cover shared `/thinking`/model-menu routing, model-specific thinking clamping, per-model staged/persisted restoration, current-session precedence, left/right staging, direct status-popup behavior, and thinking-row coloring.
- Popup action/config tests cover durable per-model preference writes only after successful apply and enforce user-only ownership over project config.
- Input tests cover routing left/right to staged thinking before editor cursor movement.
- Model action tests cover applying thinking before a changed-model reload and avoiding reload for a thinking-only change.
- Draft menu/action/status tests cover listing and staging model/thinking values without a runtime and exposing model/thinking click targets before the first prompt.
- Root TypeScript checks and the full Pix test suite must pass.
