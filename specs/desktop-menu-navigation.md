# Desktop menu keyboard navigation

<!-- markdownlint-disable MD013 -->

## Type

Change.

## Lifecycle

Active implemented contract.

## Goal

Give Pix Desktop command menus one predictable keyboard/focus model instead of
letting each WebView menu behave like an unrelated stack of buttons.

## Shared interaction contract

- Reusable pure navigation helpers in `desktop/src/lib/keyboard-navigation.ts`
  resolve menu movement independently from each component's state owner.
- ArrowUp/ArrowDown wrap across enabled commands and skip disabled commands.
- Home/End move to the first/last enabled command.
- Printable-key type-ahead searches enabled visible command labels using a short
  accumulated query.
- Escape dismisses the menu and restores focus to the invoker when one exists.
- Tab dismisses the transient menu instead of trapping focus inside it.
- Disabled commands remain discoverable and retain native disabled semantics.

## Migrated surfaces

- Composer overflow actions focus the first enabled command on open and reuse the
  command-registry labels for Enhance prompt, Create task, and Pause for later.
- User-message context/ellipsis menus focus the first enabled action and preserve
  the existing four-command Copy/Fork/Fork in new tab/Undo contract.
- Project task status menus initially focus the current status; choosing a status
  restores focus to the status trigger after the menu disappears.
- The Project switcher is a command menu. ArrowDown/ArrowUp from its trigger opens
  it and focuses the first/last enabled command, and menu navigation skips disabled
  current-window project actions while leaving new-window actions available.

## Non-goals

- Replacing bounded content popovers such as DCP statistics with command menus.
- Introducing a third-party menu/component library.
- Moving stateful command execution out of the component/application owner.

## Related files

- `desktop/src/lib/keyboard-navigation.ts`
- `desktop/src/components/PromptComposer.svelte`
- `desktop/src/components/TranscriptPane.svelte`
- `desktop/src/components/WorkspaceSidebar.svelte`
- `desktop/src/components/ProjectSwitcher.svelte`

## Verification

- `desktop/src/lib/keyboard-navigation.test.ts` covers disabled-item skipping,
  wrapping, Home/End, and type-ahead matching.
- Project switcher/sidebar source tests cover menu wiring.
- `npm --prefix desktop test`
- `npm --prefix desktop run check`
- `npm --prefix desktop run build:web`
