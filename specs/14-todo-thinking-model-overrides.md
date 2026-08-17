# Spec: Todo thinking model overrides

## Type

Change

## Goal

Allow cheaper or less capable models to use one enforced thinking level for every todo mutation, independent of the level requested or omitted by the model.

## Scope

- Add `todoThinkingOverrides` to layered pi-tools-suite configuration.
- Match exact or wildcard provider/model and bare-model keys.
- Force the matched, model-supported level on create/update and batch create/update mutations while `todoThinking` is enabled.
- Default `zai/glm-5.3` to `max`.

## Non-goals

- Rewriting imported or already persisted todo plans eagerly on model selection.
- Enabling todo thinking when `todoThinking` is false.

## Behavior

- Full provider/model matches take precedence over bare-model matches; exact matches take precedence over wildcards; more specific wildcard patterns win.
- A configured level unsupported by the selected model is normalized with the existing nearest-supported-level behavior.
- Later config layers merge entries by key and may remove an inherited entry with `null`.
- Runtime enforcement applies even when the model supplies another valid `thinking` value or omits it.

## Related files

- `external/pi-tools-suite/src/config.ts`
- `external/pi-tools-suite/src/todo/index.ts`
- `external/pi-tools-suite/src/default-pi-tools-suite-config.ts`
- `src/schemas/pi-tools-suite-schema.ts`
- `schemas/pi-tools-suite.json`

## Verification

- Config-layer tests for merge and removal.
- Todo lifecycle tests for forced create/update behavior and thinking switch/restore.
- pi-tools-suite deterministic check and host check.

## Evidence

- Confirmed by code: todo mutations already pass through `prepareMutation` and model-specific thinking normalization.
- Targeted config/todo tests passed (49 tests).
- The pi-tools-suite deterministic check passed (398 tests, 35 skipped live evaluations), including all headless smoke commands.
- The host `npm run check` passed (955 tests).
