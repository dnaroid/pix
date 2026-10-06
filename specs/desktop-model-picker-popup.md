---
kind: spec
status: active
---

# Desktop model picker popup

## Behavior

- Model + Thinking uses a nonmodal popup directly above its status-bar button,
  following the other status-bar detail surfaces. Click, Enter or Space toggle it;
  hover does not open it. Repeating activation while opening cancels that request.
- The native `<dialog open>` stays out of the modal top layer: no backdrop,
  workbench blocking, or focus trap. Opening focuses search. Escape and explicit
  Cancel/Close restore the trigger's focus; outside pointer interaction or focus
  leaving the trigger/panel region dismisses without stealing destination focus.
  Moving the pointer away alone does not dismiss it.
- The popup is at most 520px wide; its full height is capped at the application
  window content height minus 70px and the space on the roomier side of the invoker with an 8px
  top inset (never below zero). Resize recalculates its position; the list and constrained
  panel can scroll. Auto allows forward Tab to leave search normally.
- Existing staged selection, thinking navigation, visibility management and
  defaults are unchanged. Apply/Enter closes and restores composer focus on
  success (including unchanged confirmation); failed Apply keeps the error open.
  See [Desktop live model switching](desktop-live-model-switching.md).
- [BTW](desktop-btw.md) reuses this popup with its own explicit invoker and local
  selection callback. The header invoker opens it below when that side has more
  room; the status-bar invoker opens it above. Its Apply changes only subsequent side questions; it
  shares visibility management but does not expose parent default writes.

## Constraints and failure cases

- Closing or changing owners invalidates pending opening requests. A late Apply
  completion from an unmounted popup cannot close a newer popup or steal focus.
  Dismissal does not cancel a configuration request already sent.
- Teardown removes every owned pointer, key, focus and resize listener. Teardown
  by owner change does not restore focus to the old session's controls.
- Focusout caused by removing a focused popup is deferred until teardown
  completes; a disposed owner or restored focus inside cannot close another
  popup or mutate reactive state during DOM removal.
- Pointer-activated popup buttons explicitly retain focus inside the panel,
  including WebKit's non-focusing button activation; deferred focus dismissal
  must not remove Apply before its click reaches the selection callback. A
  transient focus departure to the document body during an inside pointer
  activation does not dismiss; real outside interaction and keyboard focus
  departure still do.
- This replaces only Model + Thinking's modal lifecycle. Other bounded dialogs
  retain [native modal behavior](desktop-modal-dialogs.md).
- Decision: [0049 — Nonmodal model picker](../docs/decisions/0049-nonmodal-model-picker.md).

## Implementation

- `desktop/src/components/ModelThinkingPicker.svelte`
- `desktop/src/components/StatusBar.svelte`
- `desktop/src/app/model-picker-state.svelte.ts`
- `desktop/src/lib/model-picker-popover.ts`

## Tests

- `desktop/src/components/ModelThinkingPicker.test.ts`
- `desktop/src/components/DesktopModalDialogs.test.ts`
- `desktop/src/app/model-picker-state.test.ts`
- `desktop/src/lib/model-picker-popover.test.ts`

## Verification

- Focused tests cover geometry, dismissal/focus, cleanup and pending-open races;
  source regressions cover nonmodal markup and stale Apply guards.
- Desktop tests, Svelte/TypeScript check and web build must pass.
- Native UI verification should exercise repeat activation, outside interaction,
  Escape, keyboard selection and narrow-window scrolling. Unit/source checks do
  not constitute native UI verification.
