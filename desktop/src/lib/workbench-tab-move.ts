import type { WorkbenchTabId } from "./workbench-tabs";

const commands = new WeakMap<HTMLElement, () => void>();

/** Register a component-owned command without adding another DOM tab stop. */
export function workbenchTabMove(node: HTMLElement, start: (() => void) | undefined) {
  function update(value: (() => void) | undefined): void {
    if (value) commands.set(node, value);
    else commands.delete(node);
  }
  update(start);
  return { update, destroy: () => commands.delete(node) };
}

export function workbenchTabMoveCommand(node: HTMLElement): (() => void) | undefined {
  if (!commands.has(node)) return undefined;
  const command = commands.get(node);
  // A menu may outlive a disabled/replaced registration on the same DOM node.
  return () => { if (commands.get(node) === command) command?.(); };
}

export interface WorkbenchTabMoveState {
  id: WorkbenchTabId;
  beforeId: WorkbenchTabId | null;
}

/** Menu-initiated pick-up/place; normal titlebar pointer handling is untouched. */
export function createWorkbenchTabMove(options: {
  tablist: () => HTMLElement | null;
  ids: () => readonly WorkbenchTabId[];
  changed: (state: WorkbenchTabMoveState | null) => void;
  commit: (id: WorkbenchTabId, beforeId: WorkbenchTabId | null) => void;
  focus: (id: WorkbenchTabId) => void;
}) {
  let state: WorkbenchTabMoveState | null = null;
  let host: Window | null = null;

  function finish(commit = false, restoreFocus = true): void {
    const previous = state;
    state = null;
    host?.removeEventListener("pointermove", pointerMove, true);
    host?.removeEventListener("pointerdown", pointerDown, true);
    host?.removeEventListener("click", click, true);
    host?.removeEventListener("keydown", keydown, true);
    host?.removeEventListener("blur", cancel);
    host?.removeEventListener("pointercancel", cancel, true);
    host?.removeEventListener("contextmenu", cancel, true);
    host = null;
    options.changed(null);
    if (!previous) return;
    if (commit) options.commit(previous.id, previous.beforeId);
    if (restoreFocus) options.focus(previous.id);
  }

  function cancel(): void { finish(false, false); }

  function inside(event: MouseEvent): boolean {
    const rect = options.tablist()?.getBoundingClientRect();
    return !!rect && event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom;
  }

  function updatePosition(event: MouseEvent): void {
    const node = options.tablist();
    if (!node || !state || !inside(event)) return;
    const rect = node.getBoundingClientRect();
    if (event.clientX < rect.left + 24) node.scrollLeft -= 24;
    else if (event.clientX > rect.right - 24) node.scrollLeft += 24;
    const buttons = node.querySelectorAll<HTMLElement>("[data-workbench-tab-id]");
    let beforeId: WorkbenchTabId | null = null;
    for (const button of buttons) {
      if (button.dataset.workbenchTabId === state.id) continue;
      const bounds = button.getBoundingClientRect();
      if (event.clientX < bounds.left + bounds.width / 2) {
        beforeId = button.dataset.workbenchTabId as WorkbenchTabId;
        break;
      }
    }
    state = { id: state.id, beforeId };
    options.changed(state);
  }

  function pointerMove(event: PointerEvent): void { updatePosition(event); }

  function pointerDown(event: PointerEvent): void {
    if (!state) return;
    if (event.button !== 0 || !inside(event)) { finish(false, false); return; }
    // Capture beats titlebarDrag's pointerdown listener, but only in move mode.
    event.preventDefault();
    event.stopImmediatePropagation();
    updatePosition(event);
  }

  function click(event: MouseEvent): void {
    if (!state) return;
    if (!inside(event)) { finish(false, false); return; }
    event.preventDefault();
    event.stopImmediatePropagation();
    updatePosition(event);
    finish(true);
  }

  function keydown(event: KeyboardEvent): void {
    if (!state) return;
    const remaining = options.ids().filter((id) => id !== state!.id);
    const index = state.beforeId === null ? remaining.length : remaining.indexOf(state.beforeId);
    let next = index;
    if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); finish(); return; }
    if (event.key === "Tab") { finish(false, false); return; }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault(); event.stopImmediatePropagation(); finish(true); return;
    }
    if (event.key === "ArrowLeft") next = Math.max(0, index - 1);
    else if (event.key === "ArrowRight") next = Math.min(remaining.length, index + 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = remaining.length;
    else return;
    event.preventDefault();
    event.stopImmediatePropagation();
    state = { id: state.id, beforeId: remaining[next] ?? null };
    options.changed(state);
    if (state.beforeId) options.tablist()?.querySelector<HTMLElement>(`[data-workbench-tab-id="${CSS.escape(state.beforeId)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  return {
    start(id: WorkbenchTabId): void {
      finish(false, false);
      const ids = options.ids();
      const index = ids.indexOf(id);
      const node = options.tablist();
      if (!node || index < 0 || ids.length < 2) return;
      state = { id, beforeId: ids[index + 1] ?? null };
      host = node.ownerDocument.defaultView;
      options.changed(state);
      options.focus(id);
      host?.addEventListener("pointermove", pointerMove, true);
      host?.addEventListener("pointerdown", pointerDown, true);
      host?.addEventListener("click", click, true);
      host?.addEventListener("keydown", keydown, true);
      host?.addEventListener("blur", cancel);
      host?.addEventListener("pointercancel", cancel, true);
      host?.addEventListener("contextmenu", cancel, true);
    },
    cancel: () => finish(),
    destroy: cancel,
  };
}
