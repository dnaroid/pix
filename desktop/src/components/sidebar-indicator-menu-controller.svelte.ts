import { tick } from "svelte";
import { isTypeaheadKey, menuFocusIndex, menuTypeaheadFocusIndex, type MenuNavigationItem } from "../lib/keyboard-navigation";
import type { SidebarIndicatorTab } from "../lib/sidebar-indicator-types";

export function createSidebarIndicatorMenuController(options: {
  bounds?: () => { top: number; bottom: number } | undefined;
  items: (tab: SidebarIndicatorTab, query: string) => readonly MenuNavigationItem[];
}) {
  const state = $state({
    tab: null as SidebarIndicatorTab | null,
    position: null as { left: number; top: number } | null,
    element: null as HTMLDivElement | null,
    filter: "",
    filterInput: null as HTMLInputElement | null,
    maxHeight: null as number | null,
  });
  let trigger: HTMLElement | null = null;
  let generation = 0;
  let query = "";
  let timer: ReturnType<typeof setTimeout> | undefined;

  function resetTypeahead(): void {
    clearTimeout(timer);
    timer = undefined;
    query = "";
  }

  function close(restoreFocus = false): void {
    generation++;
    resetTypeahead();
    state.filter = "";
    state.maxHeight = null;
    state.tab = null;
    state.position = null;
    if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
    trigger = null;
  }

  function buttons(): HTMLButtonElement[] {
    return [...(state.element?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") ?? [])];
  }

  function open(event: MouseEvent, tab: SidebarIndicatorTab): void {
    event.preventDefault();
    event.stopPropagation();
    close();
    if (!options.items(tab, "").length) return;
    trigger = event.currentTarget instanceof HTMLElement ? event.currentTarget
      : document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const rect = trigger?.getBoundingClientRect();
    const keyboard = event.clientX === 0 && event.clientY === 0;
    const bounds = options.bounds?.();
    const top = Math.max(8, (bounds?.top ?? 0) + 8);
    const bottom = Math.min(window.innerHeight, bounds?.bottom ?? window.innerHeight) - 8;
    if (bounds) state.maxHeight = Math.max(0, bottom - top);
    state.tab = tab;
    state.position = {
      left: keyboard ? rect?.right ?? 8 : event.clientX,
      top: keyboard ? rect?.top ?? 8 : event.clientY,
    };
    const request = generation;
    void tick().then(() => {
      if (request !== generation || state.tab !== tab || !state.element) return;
      const menuRect = state.element.getBoundingClientRect();
      state.position = {
        left: Math.max(8, Math.min(state.position!.left, window.innerWidth - menuRect.width - 8)),
        top: Math.max(top, Math.min(state.position!.top, bottom - menuRect.height)),
      };
      if (tab === "scripts" && state.filterInput) { state.filterInput.focus(); return; }
      const index = menuFocusIndex(options.items(tab, state.filter), -1, "ArrowDown");
      if (index !== null) buttons()[index]?.focus();
      else state.element.focus();
    });
  }

  function keydown(event: KeyboardEvent): void {
    if (!state.tab) return;
    if (event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab") { close(true); return; }
    const elements = buttons();
    const current = elements.indexOf(event.target as HTMLButtonElement);
    const items = options.items(state.tab, state.filter);
    if (state.tab === "scripts" && state.filterInput) {
      if (event.target === state.filterInput) {
        if (event.key === "Enter") {
          event.preventDefault();
          const first = menuFocusIndex(items, -1, "ArrowDown");
          if (first !== null) elements[first]?.click();
          return;
        }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      } else if (event.key === "ArrowUp" && current === menuFocusIndex(items, -1, "ArrowDown")) {
        event.preventDefault();
        state.filterInput.focus();
        return;
      } else if (isTypeaheadKey(event) && event.key !== " ") {
        event.preventDefault();
        state.filter += event.key;
        state.filterInput.focus();
        return;
      }
    }
    let next = menuFocusIndex(items, current, event.key);
    if (next === null && isTypeaheadKey(event)) {
      const key = event.key.toLocaleLowerCase();
      query = query.length === 1 && query === key ? key : query + key;
      next = menuTypeaheadFocusIndex(items, current, query);
      if (next === null && query.length > 1) {
        query = key;
        next = menuTypeaheadFocusIndex(items, current, query);
      }
      clearTimeout(timer);
      timer = setTimeout(resetTypeahead, 700);
      event.preventDefault();
    }
    if (next !== null) { event.preventDefault(); elements[next]?.focus(); }
  }

  function outside(event: PointerEvent): void {
    if (state.tab && !(event.target instanceof Node && state.element?.contains(event.target))) close();
  }

  return { state, open, close, keydown, outside, dispose: close };
}
