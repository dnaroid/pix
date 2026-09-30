# Todo thinking model overrides

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Allow per-model inclusive Min/Max bounds on todo thinking, including a fixed level when both bounds are equal.

## Scope

- Add `todoThinkingOverrides` to layered pi-tools-suite configuration.
- Match exact or wildcard provider/model and bare-model keys.
- Clamp thinking on create/update and batch create/update mutations while `todoThinking` is enabled.
- Default `zai/glm-5.3` to `{ "min": "max", "max": "max" }`.

## Non-goals

- Rewriting imported or already persisted todo plans eagerly on model selection.
- Enabling todo thinking when `todoThinking` is false.

## Behavior

- Full provider/model matches take precedence over bare-model matches; exact matches take precedence over wildcards; more specific wildcard patterns win.
- Values accept only `{ "min": "low", "max": "medium" }` ranges. String
  values are not supported or migrated and do not overwrite inherited policies.
- Bounds must be known levels in ascending order (`off`, `minimal`, `low`,
  `medium`, `high`, `xhigh`, `max`). Invalid ranges are ignored by the runtime;
  they do not overwrite an inherited valid policy.
- Range candidates use the explicit thinking value, then the existing task's
  thinking, then session thinking, then Min. Supported choices inside the range
  are retained; out-of-range values are clamped. Unsupported choices round up
  only within the supported intersection, never above Max if a supported lower
  level exists. With no supported intersection, prefer the highest supported
  level at or below Max; if even that is impossible, use the model's lowest level.
- Later config layers merge entries by key and may remove an inherited entry with `null`.
- Runtime enforcement applies even when the model supplies another valid `thinking` value or omits it.
- Selecting a model re-applies its policy to a uniquely active thinking task,
  without eagerly rewriting the saved plan. Activation also clamps old/imported
  task thinking at the switch boundary. Existing multiple-active-task targeting
  semantics are unchanged.
- Session baseline restore bypasses todo limits; disabling `todoThinking` bypasses
  policy enforcement and model-selection reapplication.
- Pix Desktop's structured Settings UI edits these overrides as model/pattern rows
  with Min and Max selectors rather than a raw JSON value. Reversed bounds show an
  error and are not saved; the rejected selector restores its previous value
  without losing keyboard focus. Each existing row and the add form use two lines: a full-width
  searchable model selector with provider icons above inline Min/Max labels,
  selectors, and remove/restore or add controls. Thin separators divide each
  existing two-line pair. The add form is collapsed behind **+ Add override**
  by default; policy explanations and inherited status use tooltip hints rather
  than extra text rows. The selector offers known catalog models and
  an explicit **Use** choice for typed wildcard, bare-model, or unavailable model
  patterns, including when the catalog is empty. Inherited patterns cannot be
  renamed. Inherited
  rows remain visible, and choosing **No override** stores the `null` removal
  marker; Advanced JSONC remains the escape hatch for direct source editing.

## Related files

- `external/pi-tools-suite/src/config.ts`
- `external/pi-tools-suite/src/todo/index.ts`
- `external/pi-tools-suite/src/todo/thinking-policy.ts`
- `external/pi-tools-suite/src/todo/tool/types.ts`
- `external/pi-tools-suite/src/default-pi-tools-suite-config.ts`
- `src/schemas/pi-tools-suite-schema.ts`
- `schemas/pi-tools-suite.json`
- `desktop/src/components/settings/ToolsSuiteSettingsEditor.svelte`
- `desktop/src/components/settings/SettingsTodoThinkingOverrides.svelte`
- `desktop/src/components/settings/SettingsModelSelect.svelte`
- `desktop/src/components/settings/SettingsSelect.svelte`
- `desktop/src/lib/settings-model-search.ts`
- `desktop/src/lib/todo-thinking-overrides-settings.ts`

## Verification

- Config-layer tests for merge and removal.
- `external/pi-tools-suite/test/todo-thinking-policy.test.ts` covers validation,
  clamping, sparse supported levels, and impossible ranges.
- Todo lifecycle tests for forced create/update behavior and thinking switch/restore.
- Desktop settings helper/component tests cover inherited rows, `null` removal
  markers, wildcard entry UI, and replacement of the generic JSON textarea.
- `desktop/src/lib/settings-model-search.test.ts` covers opt-in custom patterns,
  empty catalogs, trimming, and avoiding duplicate known/configured options.
- `tests/pi-tools-suite-schema.test.ts` accepts ranges/null and rejects string policies.
- pi-tools-suite deterministic check and host check.

## Evidence

- Confirmed by code: todo mutations already pass through `prepareMutation` and model-specific thinking normalization.
- Verification evidence for Min/Max is recorded with the implementation task;
  earlier fixed-level verification does not establish current range coverage.
