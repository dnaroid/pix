import {
  PROJECT_TREE_DRAG_STATE_EVENT,
  PROJECT_TREE_DROP_EVENT,
  PROJECT_TREE_DROP_TARGET_SELECTOR,
  projectTreeDragPayload,
  type ProjectTreeEntry,
} from "../lib/project-tree";

const DRAG_THRESHOLD = 4;

export function createProjectExplorerDragController() {
  let draggedEntry = $state<ProjectTreeEntry | null>(null);
  let dragging = $state(false);
  let clientX = $state(0);
  let clientY = $state(0);
  let pointerId: number | null = null;
  let source: HTMLButtonElement | null = null;
  let startX = 0;
  let startY = 0;
  let dropTarget: HTMLElement | null = null;
  let suppressEntryClick = false;
  let previousUserSelect: string | null = null;
  let previousCursor: string | null = null;

  function start(event: PointerEvent, entry: ProjectTreeEntry): void {
    if (event.button !== 0) return;
    clear();
    pointerId = event.pointerId;
    source = event.currentTarget as HTMLButtonElement;
    startX = event.clientX;
    startY = event.clientY;
    clientX = event.clientX;
    clientY = event.clientY;
    draggedEntry = entry;
    try {
      source.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is a convenience; window hit-testing still handles the drop.
    }
  }

  function move(event: PointerEvent): void {
    if (event.pointerId !== pointerId || !draggedEntry) return;
    clientX = event.clientX;
    clientY = event.clientY;
    const started = document.documentElement.dataset.pixProjectPathDragging === "true";
    if (!started) {
      if (Math.hypot(event.clientX - startX, event.clientY - startY) < DRAG_THRESHOLD) return;
      setDocumentDragState(true);
    }
    event.preventDefault();
    setDropTarget(dropTargetAt(event.clientX, event.clientY));
  }

  function finish(event: PointerEvent): void {
    if (event.pointerId !== pointerId) return;
    const started = document.documentElement.dataset.pixProjectPathDragging === "true";
    const entry = draggedEntry;
    if (started && entry) {
      event.preventDefault();
      const target = dropTargetAt(event.clientX, event.clientY);
      target?.dispatchEvent(new CustomEvent(PROJECT_TREE_DROP_EVENT, {
        detail: projectTreeDragPayload(entry),
      }));
      suppressEntryClick = true;
      window.setTimeout(() => {
        suppressEntryClick = false;
      }, 0);
    }
    clear();
  }

  function cancel(event: PointerEvent): void {
    if (event.pointerId !== pointerId) return;
    clear();
  }

  function dropTargetAt(x: number, y: number): HTMLElement | null {
    return (document.elementFromPoint(x, y) as HTMLElement | null)
      ?.closest<HTMLElement>(PROJECT_TREE_DROP_TARGET_SELECTOR) ?? null;
  }

  function setDropTarget(target: HTMLElement | null): void {
    if (dropTarget === target) return;
    dropTarget?.dispatchEvent(new CustomEvent(PROJECT_TREE_DRAG_STATE_EVENT, {
      detail: { active: false },
    }));
    dropTarget = target;
    dropTarget?.dispatchEvent(new CustomEvent(PROJECT_TREE_DRAG_STATE_EVENT, {
      detail: { active: true },
    }));
  }

  function clear(): void {
    setDropTarget(null);
    if (source && pointerId !== null) {
      try {
        if (source.hasPointerCapture(pointerId)) source.releasePointerCapture(pointerId);
      } catch {
        // Ignore stale pointer-capture state during teardown.
      }
    }
    pointerId = null;
    source = null;
    draggedEntry = null;
    setDocumentDragState(false);
  }

  function setDocumentDragState(active: boolean): void {
    const root = document.documentElement;
    if (active) {
      if (root.dataset.pixProjectPathDragging === "true") return;
      dragging = true;
      previousUserSelect = root.style.userSelect;
      previousCursor = root.style.cursor;
      root.dataset.pixProjectPathDragging = "true";
      root.style.userSelect = "none";
      root.style.cursor = "grabbing";
      return;
    }
    dragging = false;
    delete root.dataset.pixProjectPathDragging;
    if (previousUserSelect !== null) {
      root.style.userSelect = previousUserSelect;
      previousUserSelect = null;
    }
    if (previousCursor !== null) {
      root.style.cursor = previousCursor;
      previousCursor = null;
    }
  }

  return {
    get entry() { return draggedEntry; },
    get dragging() { return dragging; },
    get clientX() { return clientX; },
    get clientY() { return clientY; },
    get suppressEntryClick() { return suppressEntryClick; },
    start,
    move,
    finish,
    cancel,
    clear,
  };
}
