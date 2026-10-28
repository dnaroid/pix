import {
  PROJECT_TREE_DRAG_STATE_EVENT,
  PROJECT_TREE_DROP_EVENT,
  PROJECT_TREE_DROP_TARGET_SELECTOR,
  projectTreeDragPayload,
  type ProjectTreeEntry,
} from "../lib/project-tree";

const DRAG_THRESHOLD = 4;

export function createProjectExplorerDragController(options?: {
  entries: (entry: ProjectTreeEntry) => ProjectTreeEntry[];
  move: (entries: ProjectTreeEntry[], destination: string) => void;
  native?: (entries: ProjectTreeEntry[], signal: AbortSignal) => Promise<void>;
}) {
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
  let entries = $state<ProjectTreeEntry[]>([]);
  let destination = $state<string | null>(null);
  let suppressTimer: ReturnType<typeof setTimeout> | undefined;
  let nativeActive = false;
  let nativeGeneration = 0;
  let nativeAbort: AbortController | undefined;

  function start(event: PointerEvent, entry: ProjectTreeEntry): void {
    if (event.button !== 0 || nativeActive) return;
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
      entries = options?.entries(draggedEntry) ?? [draggedEntry];
      if (options?.native) {
        event.preventDefault();
        const selected = [...entries];
        const generation = ++nativeGeneration;
        const abort = new AbortController();
        nativeAbort = abort;
        nativeActive = true;
        clear();
        suppressEntryClick = true;
        clearTimeout(suppressTimer);
        // The adapter reports errors; retain click suppression through the OS
        // session and ignore late completion after panel teardown.
        const finishNative = () => {
          if (generation !== nativeGeneration) return;
          nativeActive = false;
          nativeAbort = undefined;
          suppressTimer = setTimeout(() => {
            suppressEntryClick = false;
            suppressTimer = undefined;
          }, 0);
        };
        void options.native(selected, abort.signal).then(finishNative, finishNative);
        return;
      }
    }
    event.preventDefault();
    setDropTarget(dropTargetAt(event.clientX, event.clientY));
    destination = treeDestinationAt(event.clientX, event.clientY);
  }

  function finish(event: PointerEvent): void {
    if (nativeActive) { nativeAbort?.abort(); return; }
    if (event.pointerId !== pointerId) return;
    const started = document.documentElement.dataset.pixProjectPathDragging === "true";
    const entry = draggedEntry;
    if (started && entry) {
      event.preventDefault();
      const destination = treeDestinationAt(event.clientX, event.clientY);
      const target = dropTargetAt(event.clientX, event.clientY);
      if (destination !== null) options?.move(entries, destination);
      else for (const item of entries) target?.dispatchEvent(new CustomEvent(PROJECT_TREE_DROP_EVENT, {
        detail: projectTreeDragPayload(item),
      }));
      suppressEntryClick = true;
      clearTimeout(suppressTimer);
      suppressTimer = setTimeout(() => {
        suppressEntryClick = false;
        suppressTimer = undefined;
      }, 0);
    }
    clear();
  }

  function cancel(event: PointerEvent): void {
    if (nativeActive) { nativeAbort?.abort(); return; }
    if (event.pointerId !== pointerId) return;
    clear();
  }

  function dropTargetAt(x: number, y: number): HTMLElement | null {
    return (document.elementFromPoint(x, y) as HTMLElement | null)
      ?.closest<HTMLElement>(PROJECT_TREE_DROP_TARGET_SELECTOR) ?? null;
  }

  function treeDestinationAt(x: number, y: number): string | null {
    const hit = document.elementFromPoint(x, y);
    const row = hit?.closest<HTMLElement>("[data-project-move-row]")
      ?? hit?.closest<HTMLElement>("[data-project-tree-path]");
    const target = row ?? hit?.closest<HTMLElement>("[data-project-move-target]");
    const path = target?.dataset.projectMoveTarget;
    if (path === undefined || !options || !entries.length) return null;
    if (entries.some((entry) => path === entry.path || path.startsWith(`${entry.path}/`))) return null;
    if (entries.every((entry) => (entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "") === path)) return null;
    return path;
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
    entries = [];
    destination = null;
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
    get destination() { return destination; },
    get count() { return entries.length; },
    start,
    move,
    finish,
    cancel,
    clear() { nativeAbort?.abort(); clear(); },
    dispose() { nativeAbort?.abort(); nativeAbort = undefined; nativeGeneration++; nativeActive = false; clear(); clearTimeout(suppressTimer); suppressEntryClick = false; },
  };
}
