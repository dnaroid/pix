# Spec: question in an inactive tab

## Type

Change

## Goal

Allow the renderer-owned `question` tool to wait for input when its session tab is inactive instead of failing the tool call.

## Scope

- Per-tab custom UI lifecycle in `ExtensionUiController`.
- Cancellation handling in the bundled `question` extension.

## Non-goals

- Showing more than one tab's custom UI at once.
- Changing the questionnaire layout or answer contract.

## Behavior

- A live inactive tab may create one pending custom UI for its own scope.
- Pending UI is hidden and receives no keyboard or mouse input until that tab is active.
- Activating the tab displays the pending UI and lets the user complete it normally.
- Explicit scope cleanup still cancels pending UI and resolves its promise with `undefined`.
- `question` treats both `null` and `undefined` UI results as cancellation; it must not attempt to build successful answers from either value.
- Input from another tab must never be captured or restored as the pending UI's saved editor draft.

## Related files

- `src/app/extensions/extension-ui-controller.ts`
- `src/bundled-extensions/question/index.ts`
- `src/bundled-extensions/question/tui.ts`
- `tests/extension-ui-controller.test.ts`

## Verification

- Custom UI requested from an inactive scope remains pending and works after activation.
- An async custom UI factory remains reserved while its scope is inactive.
- Existing custom UI input, cleanup, editor restoration, and cancellation tests pass.
- `npm run check` passes.

## Evidence

- Confirmed by code: inactive scopes previously caused `showCustomUi()` to return `undefined` immediately.
- Confirmed by code: `question` previously recognized only `null` as cancellation and passed `undefined` into successful-result construction.
- Confirmed by tests: `tests/extension-ui-controller.test.ts` covers scoped pending custom UI and activation.
