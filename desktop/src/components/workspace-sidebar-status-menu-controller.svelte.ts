import { tick } from "svelte";
import {
  TASK_STATUSES,
  taskStatusLabel,
  type ProjectTask,
  type ProjectTaskStatus,
} from "../lib/project-tasks";
import {
  isTypeaheadKey,
  menuFocusIndex,
  menuTypeaheadFocusIndex,
  type MenuNavigationItem,
} from "../lib/keyboard-navigation";

interface WorkspaceSidebarStatusMenuControllerOptions {
  readonly menu: () => HTMLDivElement | null;
  readonly onStatusChange: (taskId: string, status: ProjectTaskStatus) => void;
}

export function createWorkspaceSidebarStatusMenuController(
  options: WorkspaceSidebarStatusMenuControllerOptions,
) {
  let taskId = $state<string | null>(null);
  let trigger: HTMLButtonElement | null = null;
  let typeaheadQuery = "";
  let typeaheadTimer: number | null = null;

  function items(): MenuNavigationItem[] {
    return TASK_STATUSES.map((status: ProjectTaskStatus) => ({ label: taskStatusLabel(status) }));
  }

  function buttons(): HTMLButtonElement[] {
    return [...(options.menu()?.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']") ?? [])];
  }

  function focusItem(index: number): void {
    buttons()[index]?.focus();
  }

  function close(restoreFocus = false): void {
    const focusTarget = trigger;
    taskId = null;
    trigger = null;
    if (restoreFocus) void tick().then(() => focusTarget?.focus());
  }

  function toggle(event: MouseEvent, task: ProjectTask): void {
    const nextTrigger = event.currentTarget as HTMLButtonElement;
    if (taskId === task.id) {
      close();
      return;
    }
    trigger = nextTrigger;
    taskId = task.id;
    const selectedIndex = Math.max(0, TASK_STATUSES.indexOf(task.status));
    void tick().then(() => focusItem(selectedIndex));
  }

  function setStatus(nextTaskId: string, status: ProjectTaskStatus): void {
    const focusTarget = trigger;
    taskId = null;
    trigger = null;
    options.onStatusChange(nextTaskId, status);
    void tick().then(() => focusTarget?.focus());
  }

  function handleKeydown(event: KeyboardEvent): void {
    const menuButtons = buttons();
    const target = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[role='menuitemradio']")
      : null;
    const currentIndex = target ? menuButtons.indexOf(target) : -1;
    const navigationItems = items();

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
    const nextIndex = menuFocusIndex(navigationItems, currentIndex, event.key);
    if (nextIndex !== null) {
      event.preventDefault();
      focusItem(nextIndex);
      return;
    }
    if (!isTypeaheadKey(event)) return;
    event.preventDefault();
    const key = event.key.toLocaleLowerCase();
    let query = typeaheadQuery.length === 1 && typeaheadQuery === key
      ? key
      : `${typeaheadQuery}${key}`;
    let typeaheadIndex = menuTypeaheadFocusIndex(navigationItems, currentIndex, query);
    if (typeaheadIndex === null && query.length > 1) {
      query = key;
      typeaheadIndex = menuTypeaheadFocusIndex(navigationItems, currentIndex, query);
    }
    typeaheadQuery = query;
    if (typeaheadTimer !== null) window.clearTimeout(typeaheadTimer);
    typeaheadTimer = window.setTimeout(() => {
      typeaheadQuery = "";
      typeaheadTimer = null;
    }, 700);
    if (typeaheadIndex !== null) focusItem(typeaheadIndex);
  }

  function closeOutside(event: PointerEvent): void {
    if (!taskId) return;
    const target = event.target as HTMLElement | null;
    if (!target?.closest("[data-task-status-control]")) close();
  }

  function dispose(): void {
    if (typeaheadTimer !== null) window.clearTimeout(typeaheadTimer);
    typeaheadTimer = null;
  }

  return {
    get taskId() { return taskId; },
    close,
    toggle,
    setStatus,
    handleKeydown,
    closeOutside,
    dispose,
  };
}
