import { LogicalPosition } from "@tauri-apps/api/dpi";
import { Menu, type MenuItemOptions, type CheckMenuItemOptions, type PredefinedMenuItemOptions } from "@tauri-apps/api/menu";
import { linkedTaskPlan } from "./project-task-plans";
import { TASK_PRIORITIES, TASK_STATUSES, taskPriorityLabel, taskStatusLabel, type ProjectTask, type ProjectTaskPriority, type ProjectTaskStatus } from "./project-tasks";
import type { ContextMenuPosition, NativeContextMenu } from "./native-context-menu";

type TaskMenuItem = MenuItemOptions | CheckMenuItemOptions | PredefinedMenuItemOptions;

interface TaskMenuActions {
  setStatus: (taskId: string, status: ProjectTaskStatus) => void;
  setPriority: (taskId: string, priority: ProjectTaskPriority) => void;
  requestDelete: (taskId: string) => void;
  createPlan?: (task: ProjectTask) => void;
  openPlan?: (path: string) => void;
  canCreatePlan: () => boolean;
}

/** System checkmarks and separators replace the task card's styled popup. */
export function taskNativeMenuItems(task: ProjectTask, section: "all" | "priority", actions: TaskMenuActions, run: (action: () => void) => () => void): TaskMenuItem[] {
  const items: TaskMenuItem[] = [];
  if (section === "all") {
    items.push({ id: "status", text: "Status", enabled: false });
    for (const status of TASK_STATUSES) items.push({
      id: `status.${status}`, text: taskStatusLabel(status), checked: task.status === status,
      action: run(() => actions.setStatus(task.id, status)),
    });
    items.push({ item: "Separator" });
  }
  items.push({ id: "priority", text: "Priority", enabled: false });
  for (const priority of TASK_PRIORITIES) items.push({
    id: `priority.${priority}`, text: taskPriorityLabel(priority), checked: task.priority === priority,
    action: run(() => actions.setPriority(task.id, priority)),
  });
  if (section === "all") {
    items.push({ item: "Separator" });
    const planPath = linkedTaskPlan(task);
    if (planPath && actions.openPlan) items.push({ id: "plan.open", text: "Open plan", action: run(() => actions.openPlan!(planPath)) });
    else if (!planPath && actions.createPlan) items.push({ id: "plan.create", text: "Create plan", enabled: actions.canCreatePlan(), action: run(() => { if (actions.canCreatePlan()) actions.createPlan!(task); }) });
    items.push({ id: "delete", text: "Delete task", action: run(() => actions.requestDelete(task.id)) });
  }
  return items;
}

export function createTaskNativeMenu(actions: TaskMenuActions, reportError: (error: unknown) => void) {
  const namespace = `task-menu:${crypto.randomUUID()}`;
  let pending: Promise<unknown> = Promise.resolve();
  let generation = 0;
  let disposed = false;
  let active: { menu: NativeContextMenu; valid: boolean } | null = null;
  const released = new WeakSet<NativeContextMenu>();

  async function release(menu: NativeContextMenu): Promise<void> {
    if (released.has(menu)) return;
    released.add(menu);
    try { await menu.close(); }
    catch (error) { if (!disposed) reportError(error); }
  }

  function close(): void {
    generation++;
    if (active) {
      active.valid = false;
      void release(active.menu);
      active = null;
    }
  }

  async function show(task: ProjectTask, section: "all" | "priority", position: ContextMenuPosition, isTargetCurrent: () => boolean): Promise<void> {
    close();
    const request = generation;
    const current = () => !disposed && request === generation && isTargetCurrent();
    let owned: { menu: NativeContextMenu; valid: boolean } | null = null;
    const run = (action: () => void) => () => {
      if (!current() || !owned?.valid) return;
      // Native callbacks cannot throw into the host callback registry.
      try { action(); } catch (error) { reportError(error); }
    };
    try {
      // Tauri callback ids are app-wide; serialize registration and namespace owners.
      const result = pending.then(async () => {
        if (!current()) return null;
        const items = taskNativeMenuItems(task, section, actions, run).map((item) =>
          "id" in item ? { ...item, id: `${namespace}:${item.id}` } : item);
        const menu = await Menu.new({ items });
        return {
          popup: ({ x, y }: ContextMenuPosition) => menu.popup(new LogicalPosition(x, y)),
          close: () => menu.close(),
        };
      });
      pending = result.catch(() => undefined);
      const menu = await result;
      if (!menu) return;
      owned = { menu, valid: false };
      if (!current()) { await release(menu); return; }
      owned.valid = true;
      active = owned;
      await menu.popup(position);
      // Retain ownership until replacement/disposal; popup is not a dismissal event.
    } catch (error) {
      if (owned) {
        owned.valid = false;
        if (active === owned) active = null;
        await release(owned.menu);
      }
      if (current()) reportError(error);
    }
  }

  return { show, close, dispose() { disposed = true; close(); } };
}
