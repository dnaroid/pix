import { invoke } from "@tauri-apps/api/core";
import {
  EMPTY_TASK_DOCUMENT,
  moveProjectTask,
  parseTaskDocument,
  type ProjectTask,
  type ProjectTaskDocument,
  type ProjectTaskDropPosition,
  type ProjectTaskStatus,
  type ProjectTaskType,
} from "../lib/project-tasks";

export type ProjectTaskDraft = {
  title: string;
  description?: string;
  type: ProjectTaskType;
};

type ProjectTasksStoreOptions = {
  workspace: () => string;
  afterSave?: (workspace: string) => void;
  reportError: (error: unknown) => void;
};

export function createProjectTasksStore(options: ProjectTasksStoreOptions) {
  let document = $state<ProjectTaskDocument>(EMPTY_TASK_DOCUMENT);
  let loading = $state(false);
  let saving = $state(false);
  let loadFailed = $state(false);
  let saveError = $state<string | null>(null);
  let loadGeneration = 0;

  async function load(projectPath: string): Promise<void> {
    const generation = ++loadGeneration;
    loading = true;
    loadFailed = false;
    saveError = null;
    try {
      const value = await invoke<unknown>("read_project_tasks", { workspace: projectPath });
      if (generation !== loadGeneration || options.workspace() !== projectPath) return;
      document = parseTaskDocument(value);
    } catch (error) {
      if (generation === loadGeneration && options.workspace() === projectPath) {
        loadFailed = true;
        options.reportError(error);
      }
    } finally {
      if (generation === loadGeneration && options.workspace() === projectPath) loading = false;
    }
  }

  async function save(next: ProjectTaskDocument): Promise<boolean> {
    const workspace = options.workspace();
    if (!workspace || saving || loadFailed) return false;
    const previous = document;
    let validated: ProjectTaskDocument;
    try {
      validated = parseTaskDocument(next);
    } catch (error) {
      options.reportError(error);
      return false;
    }
    document = validated;
    saving = true;
    saveError = null;
    try {
      await invoke("write_project_tasks", { workspace, document: validated });
      if (options.workspace() !== workspace) return false;
      options.afterSave?.(workspace);
      return true;
    } catch (error) {
      if (options.workspace() === workspace) document = previous;
      if (options.workspace() === workspace) {
        saveError = error instanceof Error ? error.message : String(error);
      }
      options.reportError(error);
      return false;
    } finally {
      saving = false;
    }
  }

  function create(draft: ProjectTaskDraft): void {
    const title = draft.title.trim();
    if (!title) return;
    const description = draft.description?.trim();
    const timestamp = new Date().toISOString();
    const task: ProjectTask = {
      id: newId(),
      title,
      ...(description ? { description } : {}),
      type: draft.type,
      status: "todo",
      priority: "medium",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    void save({ ...document, tasks: [task, ...document.tasks] });
  }

  function update(taskId: string, draft: ProjectTaskDraft): void {
    const title = draft.title.trim();
    const description = draft.description?.trim();
    if (!title && !description) return;
    const timestamp = new Date().toISOString();
    void save({
      ...document,
      tasks: document.tasks.map((task) => task.id === taskId
        ? {
            ...task,
            title,
            ...(description ? { description } : { description: undefined }),
            type: draft.type,
            updatedAt: timestamp,
          }
        : task),
    });
  }

  function updateStatus(taskId: string, status: ProjectTaskStatus): void {
    if (saving || loadFailed) return;
    const timestamp = new Date().toISOString();
    void save({
      ...document,
      tasks: document.tasks.map((task) => task.id === taskId
        ? { ...task, status, updatedAt: timestamp }
        : task),
    });
  }

  function reorder(
    taskId: string,
    targetType: ProjectTaskType,
    targetTaskId: string | null,
    position: ProjectTaskDropPosition,
  ): void {
    if (saving || loadFailed) return;
    const nextTasks = moveProjectTask(
      document.tasks,
      taskId,
      targetType,
      targetTaskId,
      position,
      new Date().toISOString(),
    );
    if (!nextTasks) return;
    void save({ ...document, tasks: nextTasks });
  }

  function remove(taskId: string): void {
    void save({
      ...document,
      tasks: document.tasks.filter((task) => task.id !== taskId),
    });
  }

  function reset(): void {
    loadGeneration += 1;
    document = EMPTY_TASK_DOCUMENT;
    loading = false;
    loadFailed = false;
    saveError = null;
  }

  function newId(): string {
    return typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `task-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  return {
    get document() { return document; },
    get loading() { return loading; },
    get saving() { return saving; },
    get loadFailed() { return loadFailed; },
    get saveError() { return saveError; },
    load,
    save,
    create,
    update,
    updateStatus,
    reorder,
    remove,
    reset,
    newId,
  };
}
