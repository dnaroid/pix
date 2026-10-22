---
kind: spec
status: active
---

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

## Non-goals

- Showing more than one tab's custom UI at once.
- Changing the questionnaire layout or answer contract.

## Behavior

- A live inactive tab may create pending custom UI for its own scope.
- Pending UI is hidden and receives no keyboard or mouse input until that tab is active.
- Activating the tab displays the pending UI and lets the user complete it normally.
- Explicit scope cleanup still cancels pending UI and resolves its promise with `undefined`.
- `question` treats both `null` and `undefined` UI results as cancellation; it must not attempt to build successful answers from either value.
- Input from another tab must never be captured or restored as the pending UI's saved editor draft.

### Concurrent dialogs in one scope

Matches upstream Pi 1.4.0 interactive-mode semantics.

- Extension `select`, `confirm`, `input`, `editor` and `custom()` dialogs of one scope form a stack. A newer dialog hides the previous one without settling it; only the top dialog is rendered and receives keyboard/mouse input.
- Settling the top dialog shows the previous one again (a hidden `select`/`confirm` reopens the host popup). Settling a hidden dialog (abort, timeout, late `done`) removes only that dialog and leaves the visible one untouched.
- A hidden `select`/`confirm` ignores stale resolutions from its superseded host popup.
- Editor drafts restore in LIFO order. When a hidden custom dialog closes first, its saved draft is handed to the next custom dialog above it, so the original draft is restored when the stack empties.
- A hidden `select`/`confirm` that resurfaces while its scope is inactive is cancelled (`undefined`/`false`), as for `select`/`confirm` requested from an inactive scope.
- Scope cleanup (`cancelCustomUi`/`clearWidgets`) cancels the whole stack, resolves every pending promise with `undefined` and restores the oldest saved draft.
- Popups opened by a component through its own `tui.menu`/`showMenu` remain direct host popups, not stack entries.

## Related files

- `src/app/extensions/extension-ui-controller.ts`
- `src/bundled-extensions/question/index.ts`
- `src/bundled-extensions/question/tui.ts`
- `tests/extension-ui-controller.test.ts`

## Verification

- Custom UI requested from an inactive scope remains pending and works after activation.
- An async custom UI factory remains reserved while its scope is inactive.
- Concurrent-dialog stacking, out-of-order settlement, stale popup resolutions, LIFO draft restoration and whole-stack cleanup are covered by the `ExtensionUiController concurrent dialogs` tests.
- Existing custom UI input, cleanup, editor restoration, and cancellation tests pass.
- `npm run check` passes.

## Evidence

- Confirmed by code: inactive scopes previously caused `showCustomUi()` to return `undefined` immediately.
- Confirmed by code: `question` previously recognized only `null` as cancellation and passed `undefined` into successful-result construction.
- Confirmed by tests: `tests/extension-ui-controller.test.ts` covers scoped pending custom UI and activation.

## Implementation

- `src/app/extensions/extension-ui-controller.ts`

## Tests

- `tests/extension-ui-controller.test.ts`
