import { tick } from "svelte";
import { isTauri } from "@tauri-apps/api/core";
import { createTaskNativeMenu } from "../lib/task-native-menu";
import {
  TASK_STATUSES,
  TASK_PRIORITIES,
  taskPriorityLabel,
  taskStatusLabel,
  type ProjectTask,
  type ProjectTaskStatus,
  type ProjectTaskPriority,
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
  readonly onPriorityChange: (taskId: string, priority: ProjectTaskPriority) => void;
  readonly onDeleteRequest: (taskId: string) => void;
  readonly workspace?: () => string;
  readonly task?: (taskId: string) => ProjectTask | undefined;
  readonly busy?: () => boolean;
  readonly onCreatePlan?: (task: ProjectTask) => void;
  readonly onOpenPlan?: (path: string) => void;
  readonly canCreatePlan?: () => boolean;
  readonly reportError: (error: unknown) => void;
}

export function createWorkspaceSidebarStatusMenuController(
  options: WorkspaceSidebarStatusMenuControllerOptions,
) {
  let taskId = $state<string | null>(null);
  let section = $state<"all" | "priority">("all");
  let generation = 0;
  let trigger: HTMLButtonElement | null = null;
  let taskStatus: ProjectTaskStatus | null = null;
  let typeaheadQuery = "";
  let typeaheadTimer: number | null = null;
  const nativeMenu = createTaskNativeMenu({
    setStatus, setPriority, requestDelete,
    get createPlan() { return options.onCreatePlan; },
    get openPlan() { return options.onOpenPlan; },
    canCreatePlan: () => options.canCreatePlan?.() ?? false,
  }, options.reportError);

  function items(): MenuNavigationItem[] {
    return [
      ...(section === "all" ? TASK_STATUSES.map((status) => ({ label: taskStatusLabel(status) })) : []),
      ...TASK_PRIORITIES.map((priority) => ({ label: taskPriorityLabel(priority) })),
      ...(section === "all" ? [{ label: "Delete task" }] : []),
    ];
  }

  function buttons(): HTMLButtonElement[] {
    return [...(options.menu()?.querySelectorAll<HTMLButtonElement>("[role='menuitemradio'], [role='menuitem']") ?? [])];
  }

  function focusItem(index: number): void {
    buttons()[index]?.focus();
  }

  // Disabled controls (e.g. while a save is pending) accept focus() calls
  // without becoming the active element, so a disabled target must not be
  // treated as a usable focus-restoration candidate.
  function isFocusable(element: HTMLButtonElement | null | undefined): element is HTMLButtonElement {
    return !!element && element.isConnected && !element.disabled;
  }

  // Task ids are interpolated into attribute selectors; escape them so a
  // valid id containing a quote or other CSS-special character cannot throw
  // and abort the entire focus-restoration fallback chain.
  function idSelector(id: string): string {
    return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(id) : id.replace(/["\\]/g, "\\$&");
  }

  function close(restoreFocus = false): void {
    nativeMenu.close();
    const request = ++generation;
    const focusTarget = trigger;
    taskId = null;
    trigger = null;
    taskStatus = null;
    if (typeaheadTimer !== null) window.clearTimeout(typeaheadTimer);
    typeaheadTimer = null;
    typeaheadQuery = "";
    if (restoreFocus) void tick().then(() => { if (generation === request) focusTarget?.focus(); });
  }

  function toggle(event: MouseEvent, task: ProjectTask, nextSection: "all" | "priority" = "all"): void {
    const nextTrigger = event.currentTarget as HTMLButtonElement;
    if (isTauri()) {
      if (options.busy?.()) return;
      close();
      trigger = nextTrigger;
      taskStatus = task.status;
      const targetWorkspace = options.workspace?.();
      const rect = nextTrigger.getBoundingClientRect();
      void nativeMenu.show(task, nextSection, { x: rect.left, y: rect.bottom }, () =>
        nextTrigger.isConnected && !nextTrigger.disabled && !options.busy?.()
        && options.workspace?.() === targetWorkspace
        && (!options.task || !!options.task(task.id)));
      return;
    }
    if (taskId === task.id && section === nextSection) {
      close();
      return;
    }
    close();
    const request = generation;
    trigger = nextTrigger;
    taskId = task.id;
    taskStatus = task.status;
    section = nextSection;
    const selectedIndex = nextSection === "priority"
      ? Math.max(0, TASK_PRIORITIES.indexOf(task.priority))
      : Math.max(0, TASK_STATUSES.indexOf(task.status));
    void tick().then(() => { if (generation === request && taskId === task.id) focusItem(selectedIndex); });
  }

  function setStatus(nextTaskId: string, status: ProjectTaskStatus): void {
    const focusTarget = trigger;
    close();
    const request = generation;
    options.onStatusChange(nextTaskId, status);
    // A status change can move the card into a different keyed group, which
    // destroys the previous trigger button. Fall back to the equivalent
    // trigger for the same task, or its group toggle if the card is now
    // hidden behind a collapsed group, instead of silently losing focus.
    void tick().then(() => {
      if (request !== generation) return;
      if (isFocusable(focusTarget)) {
        focusTarget.focus();
        return;
      }
      const card = document.querySelector<HTMLElement>(`[data-task-card][data-task-id="${idSelector(nextTaskId)}"]`);
      const revivedTrigger = card?.querySelector<HTMLButtonElement>("[data-task-status-control] button");
      if (isFocusable(revivedTrigger)) {
        revivedTrigger.focus();
        return;
      }
      const groupToggle = document.querySelector<HTMLButtonElement>(`[data-task-status-group="${idSelector(status)}"] [aria-controls="workspace-tasks-${idSelector(status)}-list"]`);
      if (isFocusable(groupToggle)) groupToggle.focus();
    });
  }

  function setPriority(nextTaskId: string, priority: ProjectTaskPriority): void {
    const focusTarget = trigger;
    const fallbackStatus = taskStatus;
    close();
    const request = generation;
    options.onPriorityChange(nextTaskId, priority);
    void tick().then(() => {
      if (request !== generation) return;
      if (isFocusable(focusTarget)) {
        focusTarget.focus();
        return;
      }
      // Medium removes the badge; a priority filter may remove the whole card.
      const revivedTrigger = document.querySelector<HTMLButtonElement>(`[data-task-card][data-task-id="${idSelector(nextTaskId)}"] [data-task-status-control] button`);
      if (isFocusable(revivedTrigger)) {
        revivedTrigger.focus();
        return;
      }
      if (!fallbackStatus) return;
      const groupToggle = document.querySelector<HTMLButtonElement>(`[data-task-status-group="${idSelector(fallbackStatus)}"] [aria-controls="workspace-tasks-${idSelector(fallbackStatus)}-list"]`);
      if (isFocusable(groupToggle)) groupToggle.focus();
    });
  }

  function requestDelete(nextTaskId: string): void {
    close();
    options.onDeleteRequest(nextTaskId);
  }

  function handleKeydown(event: KeyboardEvent): void {
    const menuButtons = buttons();
    const target = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[role='menuitemradio'], [role='menuitem']")
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
    if (!target || (!trigger?.contains(target) && !options.menu()?.contains(target))) close();
  }

  function dispose(): void {
    close();
    nativeMenu.dispose();
  }

  return {
    get taskId() { return taskId; },
    get section() { return section; },
    close,
    toggle,
    setStatus,
    setPriority,
    requestDelete,
    handleKeydown,
    closeOutside,
    dispose,
  };
}
