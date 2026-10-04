import { tick } from "svelte";
import {
  isTypeaheadKey,
  menuFocusIndex,
  menuTypeaheadFocusIndex,
  type MenuNavigationItem,
} from "../lib/keyboard-navigation";
import type { ProjectTreeEntry } from "../lib/project-tree";
import { createProjectExplorerNativeMenu, type ProjectExplorerMenuAction } from "../lib/project-explorer-native-menu";

interface ProjectExplorerMenuControllerOptions {
  readonly items: (entry: ProjectTreeEntry) => readonly MenuNavigationItem[];
  readonly native?: {
    items: (entry: ProjectTreeEntry) => readonly ProjectExplorerMenuAction[];
    prepare: (entry: ProjectTreeEntry) => Promise<void>;
    reportError: (error: unknown) => void;
  };
  readonly onClose?: () => void;
}

const MENU_WIDTH = 224;
const MENU_MARGIN = 8;

export function createProjectExplorerMenuController(options: ProjectExplorerMenuControllerOptions) {
  const native = options.native ? createProjectExplorerNativeMenu(options.native) : null;
  const state = $state({
    entry: null as ProjectTreeEntry | null,
    position: null as { left: number; top: number } | null,
    menuElement: null as HTMLDivElement | null,
  });
  let trigger: HTMLElement | null = null;
  let typeaheadQuery = "";
  let typeaheadTimer: number | null = null;
  let anchor: { left: number; top: number } | null = null;
  let generation = 0;
  let menuObserver: ResizeObserver | null = null;

  function positionMenu(element: HTMLDivElement): void {
    if (!state.entry || !anchor) return;
    const { width, height } = element.getBoundingClientRect();
    state.position = {
      left: Math.min(Math.max(anchor.left, MENU_MARGIN), Math.max(MENU_MARGIN, window.innerWidth - width - MENU_MARGIN)),
      top: Math.min(Math.max(anchor.top, MENU_MARGIN), Math.max(MENU_MARGIN, window.innerHeight - height - MENU_MARGIN)),
    };
  }

  // Observe rendered dimensions: directory commands and late Git eligibility
  // can change the height while this same menu element remains mounted.
  function observeMenu(element: HTMLDivElement): { destroy: () => void } {
    menuObserver?.disconnect();
    let active = true;
    const observer = new ResizeObserver(() => {
      if (active) positionMenu(element);
    });
    menuObserver = observer;
    observer.observe(element);
    positionMenu(element);
    return {
      destroy() {
        active = false;
        observer.disconnect();
        if (menuObserver === observer) menuObserver = null;
      },
    };
  }

  function close(restoreFocus = false): void {
    native?.close();
    options.onClose?.();
    generation++;
    anchor = null;
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
    const request = generation;
    void tick().then(() => {
      if (!state.entry || request !== generation) return;
      if (state.menuElement) positionMenu(state.menuElement);
      const index = menuFocusIndex(options.items(state.entry), -1, "ArrowDown");
      if (index !== null) focusItem(index);
    });
  }

  function openContextMenu(event: MouseEvent, entry: ProjectTreeEntry): void {
    event.preventDefault();
    event.stopPropagation();
    let current = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    if (!current && document.activeElement instanceof HTMLElement) current = document.activeElement;
    const rect = current?.getBoundingClientRect();
    const keyboard = event.clientX === 0 && event.clientY === 0;
    const anchorX = keyboard ? (rect?.left ?? MENU_MARGIN) + 12 : event.clientX;
    const anchorY = keyboard ? rect?.bottom ?? MENU_MARGIN : event.clientY;
    const maxLeft = Math.max(MENU_MARGIN, window.innerWidth - MENU_WIDTH - MENU_MARGIN);
    if (native) current?.focus({ preventScroll: true });
    close();
    anchor = { left: anchorX, top: anchorY };
    trigger = current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    state.entry = entry;
    if (native) {
      const request = generation;
      void native.show(entry, { x: anchorX, y: anchorY }, () => request === generation && (!current || current.isConnected));
      return;
    }
    state.position = {
      left: Math.min(Math.max(anchorX, MENU_MARGIN), maxLeft),
      top: MENU_MARGIN,
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
    native?.dispose();
    close();
    menuObserver?.disconnect();
    menuObserver = null;
    if (typeaheadTimer !== null) window.clearTimeout(typeaheadTimer);
    typeaheadTimer = null;
  }

  return {
    state,
    observeMenu,
    openContextMenu,
    handleMenuKeydown,
    handleWindowPointerDown,
    handleWindowKeydown,
    handleWindowResize,
    close,
    dispose,
    installNativeCancellation() {
      if (!native) return () => {};
      // Capture runs before a row opens a new keyboard/pointer menu.
      const events = ["pointerdown", "keydown", "input", "focusin", "blur", "scroll", "resize"] as const;
      // Native popup focus/keyboard events must not invalidate its callbacks.
      // Only cancel IPC/preparation that has not presented a menu yet.
      const cancel = () => { if (!native.hasActiveMenu()) close(); };
      for (const event of events) window.addEventListener(event, cancel, true);
      return () => { for (const event of events) window.removeEventListener(event, cancel, true); };
    },
  };
}
