import { tick } from "svelte";
import {
  isTypeaheadKey,
  menuFocusIndex,
  menuTypeaheadFocusIndex,
  type MenuNavigationItem,
} from "../lib/keyboard-navigation";
import type { ProjectTreeEntry } from "../lib/project-tree";

interface ProjectExplorerMenuControllerOptions {
  readonly items: (entry: ProjectTreeEntry) => readonly MenuNavigationItem[];
}

const MENU_WIDTH = 224;
const MENU_HEIGHT = 320;
const MENU_MARGIN = 8;

export function createProjectExplorerMenuController(options: ProjectExplorerMenuControllerOptions) {
  const state = $state({
    entry: null as ProjectTreeEntry | null,
    position: null as { left: number; top: number } | null,
    menuElement: null as HTMLDivElement | null,
  });
  let trigger: HTMLElement | null = null;
  let typeaheadQuery = "";
  let typeaheadTimer: number | null = null;

  function close(restoreFocus = false): void {
    state.entry = null;
    state.position = null;
    if (restoreFocus) trigger?.focus({ preventScroll: true });
    trigger = null;
  }

  function buttons(): HTMLButtonElement[] {
    return [...(state.menuElement?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") ?? [])];
  }

  function focusItem(index: number): void {
    buttons()[index]?.focus();
  }

  function focusFirstItem(): void {
    void tick().then(() => {
      if (!state.entry) return;
      const index = menuFocusIndex(options.items(state.entry), -1, "ArrowDown");
      if (index !== null) focusItem(index);
    });
  }

  function openContextMenu(event: MouseEvent, entry: ProjectTreeEntry): void {
    event.preventDefault();
    event.stopPropagation();
    const current = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    const rect = current?.getBoundingClientRect();
    const keyboard = event.clientX === 0 && event.clientY === 0;
    const anchorX = keyboard ? (rect?.left ?? MENU_MARGIN) + 12 : event.clientX;
    const anchorY = keyboard ? rect?.bottom ?? MENU_MARGIN : event.clientY;
    const maxLeft = Math.max(MENU_MARGIN, window.innerWidth - MENU_WIDTH - MENU_MARGIN);
    const maxTop = Math.max(MENU_MARGIN, window.innerHeight - MENU_HEIGHT - MENU_MARGIN);
    trigger = current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    state.entry = entry;
    state.position = {
      left: Math.min(Math.max(anchorX, MENU_MARGIN), maxLeft),
      top: Math.min(Math.max(anchorY, MENU_MARGIN), maxTop),
    };
    focusFirstItem();
  }

  function handleMenuKeydown(event: KeyboardEvent): void {
    if (!state.entry) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      close();
      return;
    }
    const menuButtons = buttons();
    const target = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[role='menuitem']")
      : null;
    const currentIndex = target ? menuButtons.indexOf(target) : -1;
    const items = options.items(state.entry);
    const nextIndex = menuFocusIndex(items, currentIndex, event.key);
    if (nextIndex !== null) {
      event.preventDefault();
      focusItem(nextIndex);
      return;
    }
    if (!isTypeaheadKey(event)) return;
    event.preventDefault();
    const key = event.key.toLocaleLowerCase();
    let query = typeaheadQuery.length === 1 && typeaheadQuery === key ? key : `${typeaheadQuery}${key}`;
    let typeaheadIndex = menuTypeaheadFocusIndex(items, currentIndex, query);
    if (typeaheadIndex === null && query.length > 1) {
      query = key;
      typeaheadIndex = menuTypeaheadFocusIndex(items, currentIndex, query);
    }
    typeaheadQuery = query;
    if (typeaheadTimer !== null) window.clearTimeout(typeaheadTimer);
    typeaheadTimer = window.setTimeout(() => {
      typeaheadQuery = "";
      typeaheadTimer = null;
    }, 700);
    if (typeaheadIndex !== null) focusItem(typeaheadIndex);
  }

  function handleWindowPointerDown(event: PointerEvent): void {
    if (!state.entry) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest("[data-project-explorer-menu]")) close();
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && state.entry) {
      event.preventDefault();
      close(true);
    }
  }

  function handleWindowResize(): void {
    if (state.entry) close();
  }

  function dispose(): void {
    if (typeaheadTimer !== null) window.clearTimeout(typeaheadTimer);
    typeaheadTimer = null;
  }

  return {
    state,
    openContextMenu,
    handleMenuKeydown,
    handleWindowPointerDown,
    handleWindowKeydown,
    handleWindowResize,
    close,
    dispose,
  };
}
