import type { ProjectTaskType } from "../lib/project-tasks";

export type WorkspaceSidebarTaskDropPosition = "before" | "after";
export type WorkspaceSidebarTaskDropTarget = {
  type: ProjectTaskType;
  targetTaskId: string | null;
  position: WorkspaceSidebarTaskDropPosition;
};

interface WorkspaceSidebarTaskDragControllerOptions {
  readonly busy: () => boolean;
  readonly closeStatusMenu: () => void;
  readonly onReorder: (
    taskId: string,
    targetType: ProjectTaskType,
    targetTaskId: string | null,
    position: WorkspaceSidebarTaskDropPosition,
  ) => void;
}

const TASK_TYPES: readonly ProjectTaskType[] = ["bug", "feature", "improvement"];

export function createWorkspaceSidebarTaskDragController(
  options: WorkspaceSidebarTaskDragControllerOptions,
) {
  let taskId = $state<string | null>(null);
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
    event.preventDefault();
    const bounds = card.getBoundingClientRect();
    height = Math.max(36, Math.round(bounds.height));
    width = Math.round(bounds.width);
    pointerId = event.pointerId;
    offsetX = event.clientX - bounds.left;
    offsetY = event.clientY - bounds.top;
    clientX = event.clientX;
    clientY = event.clientY;
    taskId = nextTaskId;
    dropTarget = null;
    setDocumentDragState(true);
    handle.setPointerCapture(event.pointerId);
  }

  function move(event: PointerEvent): void {
    if (event.pointerId !== pointerId || !taskId) return;
    event.preventDefault();
    clientX = event.clientX;
    clientY = event.clientY;
    const hit = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
    if (hit?.closest("[data-task-drop-placeholder]") && dropTarget) return;
    dropTarget = targetAt(event.clientX, event.clientY);
  }

  function targetAt(nextClientX: number, nextClientY: number): WorkspaceSidebarTaskDropTarget | null {
    const groups = [...document.querySelectorAll<HTMLElement>("[data-task-group]")];
    const group = groups.find((candidate) => {
      const bounds = candidate.getBoundingClientRect();
      return nextClientX >= bounds.left - 12
        && nextClientX <= bounds.right + 12
        && nextClientY >= bounds.top
        && nextClientY <= bounds.bottom;
    });
    if (!group) return null;

    const type = group.dataset.taskGroup as ProjectTaskType | undefined;
    if (!type || !TASK_TYPES.includes(type)) return null;
    const cards = [...group.querySelectorAll<HTMLElement>("[data-task-card]")]
      .filter((card) => card.dataset.taskId !== taskId);
    if (cards.length === 0) return { type, targetTaskId: null, position: "after" };

    for (const card of cards) {
      const targetTaskId = card.dataset.taskId;
      if (!targetTaskId) continue;
      const bounds = card.getBoundingClientRect();
      if (nextClientY < bounds.top + bounds.height / 2) {
        return { type, targetTaskId, position: "before" };
      }
    }

    const lastTaskId = cards.at(-1)?.dataset.taskId;
    return lastTaskId ? { type, targetTaskId: lastTaskId, position: "after" } : null;
  }

  function finish(event: PointerEvent): void {
    if (event.pointerId !== pointerId) return;
    const draggedTaskId = taskId;
    const target = dropTarget;
    clear();
    if (!draggedTaskId || !target) return;
    options.onReorder(draggedTaskId, target.type, target.targetTaskId, target.position);
  }

  function cancel(event: PointerEvent): void {
    if (event.pointerId !== pointerId) return;
    clear();
  }

  function clear(): void {
    taskId = null;
    dropTarget = null;
    pointerId = null;
    setDocumentDragState(false);
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
    clear,
    dispose: clear,
  };
}
