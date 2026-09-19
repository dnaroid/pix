# Model-specific thinking preferences

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Remember the user's last applied thinking level independently for each model in both Pix TUI and Desktop combined model/thinking selectors without sharing preference storage between the frontends.

## Persistence

- TUI preferences live in `~/.config/pi/pix.jsonc`; Desktop preferences live independently in `~/.config/pi/pix-desktop.jsonc`, both under `thinkingByModel`.
- The shape is a map from normalized `provider/model` reference to one canonical thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.
- Example:

  ```jsonc
  {
    "thinkingByModel": {
      "openai-codex/gpt-5.6-sol": "high",
      "zai/glm-5-turbo": "max"
    }
  }
  ```

- A valid thinking suffix on a model key is stripped before storage so `provider/model:high` and `provider/model` address the same preference.
- Invalid values are ignored when the config is loaded.
- Project profile files cannot override `thinkingByModel`; it is a user UI preference. TUI and Desktop use separate user files, matching the ownership model of `visibleModels`.
- `defaultModel.thinking` remains the default for creating a new session. `thinkingByModel` is selector memory and does not replace the default-model contract.

## Selector behavior

- The combined model/thinking selector keeps staged thinking independently for each model while the selector is open.
- When the highlighted/staged model changes, the selector first restores a value already staged for that model during the current picker interaction.
- Otherwise a non-current model uses its persisted `thinkingByModel` preference when present.
- The actual current session or draft thinking is authoritative for the currently active model when the selector opens. A stale persisted preference must not make the selector display a thinking level different from the session/draft that is really active.
- If the remembered level is not supported by the selected model, the existing canonical clamp behavior chooses the nearest supported level. A missing preference falls back to the current staged/session thinking and is clamped the same way.
- Changing a model's thinking, navigating to another model, then navigating back restores the newly staged value even before Apply/Enter.

## Commit semantics

- Durable `thinkingByModel` state changes only after the combined selection is successfully applied.
- TUI persists after a successful draft selection or successful runtime model/thinking command.
- Desktop persists after a successful draft selection or after the runtime config options report the effective applied thinking level.
- Escape/cancel does not persist merely highlighted or staged model/thinking changes.
- A preference-write failure does not roll back an already successful model/thinking change. The UI reports the persistence failure best-effort while preserving the applied session/draft state.

## Related files

- `src/config.ts`
- `src/default-pix-config.ts`
- `schemas/pix.json`
- `schemas/pix-desktop.json`
- `src/app/app.ts`
- `src/app/popup/popup-menu-controller.ts`
- `src/app/popup/popup-action-controller.ts`
- `desktop/src/app/model-preferences.svelte.ts`
- `desktop/src/app/model-draft-config.svelte.ts`
- `desktop/src/app/model-config-actions.ts`
- `desktop/src/app/model-picker-state.svelte.ts`
- `desktop/src/components/ModelThinkingPicker.svelte`
- `desktop/src/lib/model-thinking-preferences.ts`
- `specs/tui-model-thinking-selector.md`
- `specs/desktop-live-model-switching.md`

## Verification

- Root config tests cover parsing, normalization, JSONC-preserving persistence, and rejection of project overrides.
- TUI popup tests cover current-session precedence plus persisted and current-picker per-model restoration.
- TUI action tests cover persistence after successful draft/runtime apply.
- Desktop preference/helper and source regression tests cover loading the shared map, picker seeding, and persistence after draft/runtime apply.
- `node --import tsx --test "tests/**/*.test.ts"`
- `./node_modules/.bin/tsc --noEmit`
- `npm --prefix desktop test`
- `npm --prefix desktop run check`
- `npm --prefix desktop run build:web`
