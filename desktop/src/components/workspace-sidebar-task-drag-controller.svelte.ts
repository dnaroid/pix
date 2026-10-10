import { TASK_STATUSES, type ProjectTaskStatus } from "../lib/project-tasks";

export type WorkspaceSidebarTaskDropPosition = "before" | "after";
export type WorkspaceSidebarTaskDropTarget = {
  status: ProjectTaskStatus;
  targetTaskId: string | null;
  position: WorkspaceSidebarTaskDropPosition;
};

interface WorkspaceSidebarTaskDragControllerOptions {
  readonly busy: () => boolean;
  readonly closeStatusMenu: () => void;
  readonly onReorder: (
    taskId: string,
    targetStatus: ProjectTaskStatus,
    targetTaskId: string | null,
    position: WorkspaceSidebarTaskDropPosition,
  ) => void;
}

export function createWorkspaceSidebarTaskDragController(
  options: WorkspaceSidebarTaskDragControllerOptions,
) {
  const DRAG_THRESHOLD_PX = 7;
  let taskId = $state<string | null>(null);
  let pendingTaskId: string | null = null;
  let pendingHandle: HTMLElement | null = null;
  let startX = 0;
  let startY = 0;
  let blockNextClick = false;
  let dropTarget = $state<WorkspaceSidebarTaskDropTarget | null>(null);
  let height = $state(44);
  let width = $state(0);
  let pointerId = $state<number | null>(null);
  let clientX = $state(0);
  let clientY = $state(0);
  let offsetX = $state(0);
  let offsetY = $state(0);
  let previousUserSelect: string | null = null;
  let previousCursor: string | null = null;

  function start(event: PointerEvent, nextTaskId: string): void {
    if (options.busy() || event.button !== 0) return;
    options.closeStatusMenu();
    const handle = event.currentTarget as HTMLElement;
    const card = handle.closest<HTMLElement>("[data-task-card]");
    if (!card) return;
    blockNextClick = false;
    pendingTaskId = nextTaskId;
    pendingHandle = handle;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    clientX = event.clientX;
    clientY = event.clientY;
    taskId = null;
    dropTarget = null;
  }

  function move(event: PointerEvent): void {
    if (event.pointerId !== pointerId) return;
    if (!taskId && pendingTaskId && pendingHandle) {
      if (Math.hypot(event.clientX - startX, event.clientY - startY) < DRAG_THRESHOLD_PX) return;
      const card = pendingHandle.closest<HTMLElement>("[data-task-card]");
      if (!card) { clear(); return; }
      const bounds = card.getBoundingClientRect();
      height = Math.max(36, Math.round(bounds.height));
      width = Math.round(bounds.width);
      offsetX = startX - bounds.left;
      offsetY = startY - bounds.top;
      taskId = pendingTaskId;
      blockNextClick = true;
      setDocumentDragState(true);
      pendingHandle.setPointerCapture(event.pointerId);
    }
    if (!taskId) return;
    event.preventDefault();
    clientX = event.clientX;
    clientY = event.clientY;
    const hit = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
    if (hit?.closest("[data-task-drop-placeholder]") && dropTarget) return;
    dropTarget = targetAt(event.clientX, event.clientY);
  }

  function targetAt(nextClientX: number, nextClientY: number): WorkspaceSidebarTaskDropTarget | null {
    const groups = [...document.querySelectorAll<HTMLElement>("[data-task-status-group]")];
    const group = groups.find((candidate) => {
      const bounds = candidate.getBoundingClientRect();
      return nextClientX >= bounds.left - 12
        && nextClientX <= bounds.right + 12
        && nextClientY >= bounds.top
        && nextClientY <= bounds.bottom;
    });
    if (!group) return null;

    const status = group.dataset.taskStatusGroup as ProjectTaskStatus | undefined;
    if (!status || !TASK_STATUSES.includes(status)) return null;
    const cards = [...group.querySelectorAll<HTMLElement>("[data-task-card]")]
      .filter((card) => card.dataset.taskId !== taskId);
    if (cards.length === 0) return { status, targetTaskId: null, position: "after" };

    for (const card of cards) {
      const targetTaskId = card.dataset.taskId;
      if (!targetTaskId) continue;
      const bounds = card.getBoundingClientRect();
      if (nextClientY < bounds.top + bounds.height / 2) {
        return { status, targetTaskId, position: "before" };
      }
    }

    const lastTaskId = cards.at(-1)?.dataset.taskId;
    return lastTaskId ? { status, targetTaskId: lastTaskId, position: "after" } : null;
  }

  function finish(event: PointerEvent): void {
    if (event.pointerId !== pointerId) return;
    const draggedTaskId = taskId;
    const target = dropTarget;
    clear();
    if (!draggedTaskId || !target) return;
    options.onReorder(draggedTaskId, target.status, target.targetTaskId, target.position);
  }

  function cancel(event: PointerEvent): void {
    if (event.pointerId !== pointerId) return;
    clear();
  }

  function clear(): void {
    pendingTaskId = null;
    pendingHandle = null;
    taskId = null;
    dropTarget = null;
    pointerId = null;
    setDocumentDragState(false);
  }

  /** Browser dispatches click after pointerup even for captured pointer drags. */
  function consumeClick(): boolean {
    const consumed = blockNextClick;
    blockNextClick = false;
    return consumed;
  }

  function setDocumentDragState(active: boolean): void {
    const root = document.documentElement;
    if (active) {
      if (previousUserSelect === null) previousUserSelect = root.style.userSelect;
      if (previousCursor === null) previousCursor = root.style.cursor;
      root.style.userSelect = "none";
      root.style.cursor = "grabbing";
      return;
    }

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
    get taskId() { return taskId; },
    get dropTarget() { return dropTarget; },
    get height() { return height; },
    get width() { return width; },
    get pointerId() { return pointerId; },
    get clientX() { return clientX; },
    get clientY() { return clientY; },
    get offsetX() { return offsetX; },
    get offsetY() { return offsetY; },
    start,
    move,
    finish,
    cancel,
    consumeClick,
    clear,
    dispose: clear,
  };
}
