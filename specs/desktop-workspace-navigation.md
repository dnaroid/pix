# Desktop workspace keyboard navigation

<!-- markdownlint-disable MD013 -->

## Type

Change.

## Lifecycle

Active implemented contract.

## Goal

Make Pix Desktop workspace navigation behave like an IDE navigator: the Activity
Bar and Project Explorer are keyboard-first composite controls with stable focus,
while project selection/open state remains separate from transient focus.

## Project Explorer behavior

- The visible project hierarchy is exposed as one ARIA `tree` containing
  `treeitem` rows with `aria-level`; directory rows additionally expose
  `aria-expanded`.
- Exactly one visible tree row participates in the normal Tab sequence. The
  current focused row wins, then the selected/open file when visible, then the
  first visible row.
- ArrowUp/ArrowDown move focus across visible rows without wrapping. Home/End move
  to the visible bounds. Keyboard movement scrolls the focused row into view.
- ArrowRight expands a collapsed directory. On an already expanded directory it
  moves to the first visible child when one exists.
- ArrowLeft collapses an expanded directory. Otherwise it moves to the nearest
  visible parent row; a root item remains in place.
- Enter/Space open files or toggle directories. Printable-key type-ahead uses a
  short accumulated query and wraps to the next visible matching entry name.
- Opening a file updates persistent selected-file styling; moving focus alone
  never changes that selection.
- `Shift+Enter` opens the focused file or directory in the configured external
  editor. The pointer hover icon remains available but is removed from the normal
  Tab sequence so every tree row does not add a second Tab stop.
- Existing pointer drag/drop behavior and lazy directory loading remain unchanged.

## Activity Bar behavior

- The workspace rail is one vertical toolbar with a roving Tab stop.
- ArrowUp/ArrowDown and Home/End move focus without activating a destination.
- Enter/Space/click keeps the existing view-selection/collapse behavior.
- Focus movement does not alter indicator state or acknowledge a destination;
  acknowledgement remains tied to the view actually becoming visible.

## Related files

- `desktop/src/components/ProjectExplorer.svelte`
- `desktop/src/components/WorkspaceSidebar.svelte`
- `desktop/src/lib/keyboard-navigation.ts`
- `desktop/src/lib/project-tree.ts`
- `desktop/src/lib/sidebar-indicators.ts`

## Verification

- `desktop/src/lib/keyboard-navigation.test.ts` covers composite and type-ahead
  navigation primitives.
- `desktop/src/lib/project-tree.test.ts` covers visible parent lookup.
- `desktop/src/components/ProjectExplorer.test.ts` covers tree semantics and the
  keyboard external-editor route.
- `desktop/src/components/WorkspaceSidebar.test.ts` covers Activity Bar composite
  wiring.
- `npm --prefix desktop test`
- `npm --prefix desktop run check`
- `npm --prefix desktop run build:web`
