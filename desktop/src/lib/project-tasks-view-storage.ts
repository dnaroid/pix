import { TASK_STATUSES, type ProjectTaskStatus } from "./project-tasks";

export interface ProjectTasksViewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type ProjectTasksCollapsedStatuses = Record<ProjectTaskStatus, boolean>;

export function defaultProjectTasksCollapsedStatuses(): ProjectTasksCollapsedStatuses {
  return { "in-progress": false, todo: false, backlog: false, done: true, failed: false };
}

export function projectTasksCollapsedStatusesKey(workspace: string): string {
  return `pix.desktop.tasks.collapsedStatuses:${workspace}`;
}

export function loadProjectTasksCollapsedStatuses(workspace: string, storage?: ProjectTasksViewStorage): ProjectTasksCollapsedStatuses {
  const defaults = defaultProjectTasksCollapsedStatuses();
  if (!workspace) return defaults;
  try {
    const parsed: unknown = JSON.parse((storage ?? localStorage).getItem(projectTasksCollapsedStatusesKey(workspace)) ?? "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaults;
    for (const status of TASK_STATUSES) {
      const value = (parsed as Record<string, unknown>)[status];
      if (typeof value === "boolean") defaults[status] = value;
    }
    return defaults;
  } catch {
    return defaults;
  }
}

export function saveProjectTasksCollapsedStatuses(workspace: string, collapsed: ProjectTasksCollapsedStatuses, storage?: ProjectTasksViewStorage): void {
  if (!workspace) return;
  try {
    (storage ?? localStorage).setItem(projectTasksCollapsedStatusesKey(workspace), JSON.stringify(collapsed));
  } catch {
    // Presentation persistence is best-effort; task storage is unaffected.
  }
}
