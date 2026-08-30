# Spec: Model scope fallback

## Type

Change

## Goal

Remove Pix's arbitrary built-in favorite-model list and follow the SDK's native
model behavior when the user has not configured `enabledModels`.

## Scope

- Build a session model scope only from `SettingsManager.getEnabledModels()`.
- Use authenticated, available models when no explicit scope exists.
- Make `/scoped-models reset`, settings output, and model-menu text describe the
  unscoped behavior accurately.

## Non-goals

- Changing a user's existing `enabledModels` setting.
- Changing model authentication, catalog refresh, or default-model selection.
- Changing how configured scoped-model references and thinking levels resolve.

## Behavior

- A non-empty `enabledModels` setting remains the session's explicit model
  scope.
- Missing or empty `enabledModels` leaves `session.scopedModels` empty. The SDK
  then cycles through `ModelRuntime.getAvailableSnapshot()`.
- The Pix model menu follows the same rule: explicit session scope when present,
  otherwise the available-model snapshot.
- `/scoped-models reset`, `/scoped-models default`, and `/scoped-models clear`
  remove the saved scope and immediately switch the session to unscoped mode.

## Related files

- `src/app/runtime.ts`
- `src/app/popup/menu-items-controller.ts`
- `src/app/commands/command-model-actions.ts`
- `src/app/rendering/popup-menu-renderer.ts`

## Verification

- Model-menu tests cover both explicit scope and the unscoped available-model
  fallback.
- Command tests cover resetting the scope to an empty list.
- The root `npm run check` passes.

## Risks / unknowns

- The available-model snapshot can change after auth or catalog refresh; this is
  intentional SDK behavior and is no longer shadowed by a static Pix list.

## Evidence

- Confirmed by SDK docs and code: `AgentSession.cycleModel()` uses scoped models
  when non-empty and the available-model snapshot otherwise.
- Confirmed by code: Pix previously substituted `PI_FAVORITE_MODEL_REFS` when
  `enabledModels` was missing or empty.
- Confirmed by tests: the focused model/runtime tests pass (20 tests), the root
  check passes (977 tests), and the bundled tools-suite check passes (437 tests,
  37 skipped live evaluations).
