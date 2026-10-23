import type { ProjectTaskPriority, ProjectTaskStatus, ProjectTaskType } from "../lib/project-tasks";
import { defaultProjectTasksCollapsedStatuses, loadProjectTasksCollapsedStatuses, saveProjectTasksCollapsedStatuses, type ProjectTasksViewStorage } from "../lib/project-tasks-view-storage";

/** Filters are window-local; status-group visibility is workspace-persisted UI state. */
export function createWorkspaceSidebarTasksViewController(storage?: ProjectTasksViewStorage) {
  let workspace = "";
  let collapsedStatuses = $state(defaultProjectTasksCollapsedStatuses());
  let typeFilter = $state<ProjectTaskType | "all">("all");
  let priorityFilter = $state<ProjectTaskPriority | "all">("all");
  let expandedTaskIds = $state<Set<string>>(new Set());
  return {
    selectWorkspace(nextWorkspace: string) {
      if (workspace === nextWorkspace) return;
      workspace = nextWorkspace;
      expandedTaskIds = new Set();
      collapsedStatuses = loadProjectTasksCollapsedStatuses(workspace, storage);
    },
    isStatusCollapsed(status: ProjectTaskStatus) { return collapsedStatuses[status]; },
    toggleStatusCollapsed(status: ProjectTaskStatus) {
      collapsedStatuses = { ...collapsedStatuses, [status]: !collapsedStatuses[status] };
      saveProjectTasksCollapsedStatuses(workspace, collapsedStatuses, storage);
    },
    expandStatus(status: ProjectTaskStatus) {
      if (!collapsedStatuses[status]) return;
      collapsedStatuses = { ...collapsedStatuses, [status]: false };
      saveProjectTasksCollapsedStatuses(workspace, collapsedStatuses, storage);
    },
    get typeFilter() { return typeFilter; }, set typeFilter(value) { typeFilter = value; },
    get priorityFilter() { return priorityFilter; }, set priorityFilter(value) { priorityFilter = value; },
    get expandedTaskIds() { return expandedTaskIds; }, set expandedTaskIds(value: Set<string>) { expandedTaskIds = value; },
  };
}
