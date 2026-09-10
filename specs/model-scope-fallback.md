# Model scope fallback

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Remove Pix's arbitrary built-in favorite-model list and follow the SDK's native
model behavior when the user has not configured `enabledModels`.

## Scope

- Build a session model scope only from `SettingsManager.getEnabledModels()`.
- Use authenticated, available models when no explicit scope exists.
- Make `/scoped-models reset` and settings output describe the unscoped behavior
  accurately. Picker visibility is a separate Pix UI preference.

## Non-goals

- Changing a user's existing `enabledModels` setting.
- Changing model authentication or catalog refresh. Default-model fallback is a
  separate contract in `specs/model-selector-fallbacks.md`.
- Changing how configured scoped-model references and thinking levels resolve.

## Behavior

- A non-empty `enabledModels` setting remains the session's explicit model
  scope.
- Missing or empty `enabledModels` leaves `session.scopedModels` empty. The SDK
  then cycles through `ModelRuntime.getAvailableSnapshot()`.
- Session scope still controls SDK model cycling, but it no longer truncates the
  Pix model picker. The picker starts from the full available-model snapshot and
  applies Pix's separate `visibleModels` UI whitelist.
- `/scoped-models reset`, `/scoped-models default`, and `/scoped-models clear`
  remove the saved scope and immediately switch the session to unscoped mode.

## Related files

- `src/app/runtime.ts`
- `src/app/popup/menu-items-controller.ts`
- `src/app/commands/command-model-actions.ts`
- `src/app/rendering/popup-menu-renderer.ts`

## Verification

- Model-menu tests cover the full available-model snapshot with and without an
  explicit session scope.
- Command tests cover resetting the scope to an empty list.
- The equivalent root check steps (schema generation check, SDK pin check,
  TypeScript, and the full root test suite) pass.

## Risks / unknowns

- The available-model snapshot can change after auth or catalog refresh; this is
  intentional SDK behavior and is no longer shadowed by a static Pix list.

## Evidence

- Confirmed by SDK docs and code: `AgentSession.cycleModel()` uses scoped models
  when non-empty and the available-model snapshot otherwise.
- Confirmed by code: Pix previously substituted `PI_FAVORITE_MODEL_REFS` when
  `enabledModels` was missing or empty.
- Confirmed by current verification: schema generation and SDK pin checks pass,
  TypeScript is clean, and the full root test suite passes (1078 tests).
