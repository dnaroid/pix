# question in an inactive tab

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Allow the renderer-owned `question` tool to wait for input when its session tab is inactive instead of failing the tool call.

## Scope

- Per-tab custom UI lifecycle in `ExtensionUiController`.
- Cancellation handling in the bundled `question` extension.
- Optional per-session remote question handling used by the Telegram connector.

## Non-goals

- Showing more than one tab's custom UI at once.
- Changing the questionnaire layout or answer contract.

## Behavior

- If a per-session remote question handler is registered, `question` tries that
  handler before creating TUI custom UI. A successful remote answer completes
  the same structured result contract; a remote user cancellation or the
  tool's AbortSignal cancels the remote wait; a missing/failed remote handler
  falls back to the behavior below.
- A live inactive tab may create one pending custom UI for its own scope.
- Pending UI is hidden and receives no keyboard or mouse input until that tab is active.
- Activating the tab displays the pending UI and lets the user complete it normally.
- Explicit scope cleanup still cancels pending UI and resolves its promise with `undefined`.
- `question` treats both `null` and `undefined` UI results as cancellation; it must not attempt to build successful answers from either value.
- Input from another tab must never be captured or restored as the pending UI's saved editor draft.

## Related files

- `src/app/extensions/extension-ui-controller.ts`
- `src/bundled-extensions/question/index.ts`
- `src/bundled-extensions/question/remote.ts`
- `src/bundled-extensions/question/tui.ts`
- `src/bundled-extensions/telegram-connector/coordinator.ts`
- `tests/extension-ui-controller.test.ts`
- `tests/telegram-connector.test.ts`

## Verification

- Custom UI requested from an inactive scope remains pending and works after activation.
- An async custom UI factory remains reserved while its scope is inactive.
- Existing custom UI input, cleanup, editor restoration, and cancellation tests pass.
- Telegram remote answers bypass local UI without changing the normalized
  `QuestionSelection`/result shape.
- `npm run check` passes.

## Evidence

- Confirmed by code: inactive scopes previously caused `showCustomUi()` to return `undefined` immediately.
- Confirmed by code: `question` previously recognized only `null` as cancellation and passed `undefined` into successful-result construction.
- Confirmed by tests: `tests/extension-ui-controller.test.ts` covers scoped pending custom UI and activation.
