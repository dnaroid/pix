import { invoke } from "@tauri-apps/api/core";
import type { Attachment } from "../lib/attachments";
import {
  EMPTY_TASK_DOCUMENT,
  moveProjectTask,
  parseTaskDocument,
  type ProjectTask,
  type ProjectTaskDocument,
  type ProjectTaskDropPosition,
  type ProjectTaskStatus,
  type ProjectTaskPriority,
  type ProjectTaskType,
} from "../lib/project-tasks";

export type ProjectTaskDraft = {
  title: string;
  description?: string;
  type: ProjectTaskType;
  expectedTask?: ProjectTask;
  status?: ProjectTaskStatus;
  attachments?: readonly Attachment[];
  links?: readonly string[];
  relatedTaskIds?: readonly string[];
  parentId?: string;
  epic?: boolean;
  modelRef?: string;
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
  let loadedWorkspace = $state<string | null>(null);
  let mutationGeneration = 0;
  let pollGeneration = 0;
  let refreshing = false;

  async function refresh(projectPath = options.workspace(), poll = pollGeneration): Promise<void> {
    if (!projectPath || saving || loading || refreshing) return;
    const generation = loadGeneration;
    const mutation = mutationGeneration;
    refreshing = true;
    try {
      const next = parseTaskDocument(await invoke<unknown>("read_project_tasks", { workspace: projectPath }));
      if (poll !== pollGeneration || generation !== loadGeneration || mutation !== mutationGeneration
        || options.workspace() !== projectPath || saving) return;
      if (JSON.stringify(next) !== JSON.stringify(document)) document = next;
      loadedWorkspace = projectPath;
      loadFailed = false;
    } catch (error) {
      if (poll === pollGeneration && generation === loadGeneration && mutation === mutationGeneration
        && options.workspace() === projectPath) {
        if (!loadFailed) options.reportError(error);
        loadFailed = true;
      }
    } finally {
      refreshing = false;
    }
  }

  // The sidebar owns the timer: it stops on hide, workspace switch, editor open,
  // and teardown. Invalidating its generation also rejects late poll results.
  function observe(): () => void {
    const generation = ++pollGeneration;
    const workspace = options.workspace();
    void refresh(workspace, generation);
    const timer = setInterval(() => void refresh(workspace, generation), 2000);
    return () => {
      clearInterval(timer);
      if (pollGeneration === generation) pollGeneration++;
    };
  }

  async function load(projectPath: string): Promise<void> {
    if (saving) return;
    const generation = ++loadGeneration;
    loading = true;
    loadFailed = false;
    saveError = null;
    try {
      const value = await invoke<unknown>("read_project_tasks", { workspace: projectPath });
      if (generation !== loadGeneration || options.workspace() !== projectPath) return;
      document = parseTaskDocument(value);
      loadedWorkspace = projectPath;
    } catch (error) {
      if (generation === loadGeneration && options.workspace() === projectPath) {
        loadFailed = true;
        options.reportError(error);
      }
    } finally {
      if (generation === loadGeneration && options.workspace() === projectPath) loading = false;
    }
  }

  async function save(next: ProjectTaskDocument, attachments?: readonly Attachment[]): Promise<boolean> {
    const workspace = options.workspace();
    if (!workspace || saving || loading || loadFailed) return false;
    const generation = ++loadGeneration;
    mutationGeneration++;
    const previous = document;
    let validated: ProjectTaskDocument;
    try {
      validated = parseTaskDocument(next);
    } catch (error) {
      options.reportError(error);
      return false;
    }
    let linkedAttachments: { path: string; name: string; size: number }[] | undefined;
    if (attachments !== undefined) {
      linkedAttachments = [];
      for (const item of attachments) {
        if (!item.path || item.size === undefined || !Number.isSafeInteger(item.size) || item.size < 0) {
          options.reportError(new Error("Task attachment must be persisted to a project-owned file before saving."));
          return false;
        }
        linkedAttachments.push({ path: item.path, name: item.name, size: item.size });
      }
    }
    document = validated;
    saving = true;
    saveError = null;
    try {
      await invoke("write_project_tasks", {
        workspace, document: validated, expectedDocument: previous,
        ...(linkedAttachments !== undefined ? { attachments: linkedAttachments } : {}),
      });
      if (options.workspace() !== workspace || generation !== loadGeneration) return false;
      options.afterSave?.(workspace);
      return true;
    } catch (error) {
      if (options.workspace() === workspace && generation === loadGeneration) {
        document = previous;
        saveError = error instanceof Error ? error.message : String(error);
        // A rejected compare-and-save reloads the authoritative document, but
        // never touches the independently owned editor draft.
        if (saveError.includes("Task file conflict")) {
          try {
            const current = parseTaskDocument(await invoke<unknown>("read_project_tasks", { workspace }));
            if (options.workspace() === workspace && generation === loadGeneration) document = current;
          } catch (readError) {
            if (options.workspace() === workspace && generation === loadGeneration) loadFailed = true;
            options.reportError(readError);
          }
        }
      }
      options.reportError(error);
      return false;
    } finally {
      if (generation === loadGeneration) saving = false;
    }
  }

  async function create(draft: ProjectTaskDraft): Promise<boolean> {
    const title = draft.title.trim();
    if (!title) return false;
    const description = draft.description?.trim();
    const timestamp = new Date().toISOString();
    const task: ProjectTask = {
      id: newId(),
      title,
      ...(description ? { description } : {}),
      type: draft.type,
      status: draft.status ?? "todo",
      priority: "medium",
      ...(draft.links?.length ? { links: [...draft.links] } : {}),
      ...(draft.relatedTaskIds?.length ? { relatedTaskIds: [...draft.relatedTaskIds] } : {}),
      ...(draft.parentId ? { parentId: draft.parentId } : {}),
      ...(draft.epic ? { epic: true } : {}),
      ...(draft.modelRef?.trim() ? { modelRef: draft.modelRef.trim() } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return save({ ...document, tasks: [task, ...document.tasks] }, draft.attachments);
  }

  async function update(taskId: string, draft: ProjectTaskDraft): Promise<boolean> {
    const title = draft.title.trim();
    const description = draft.description?.trim();
    if (!title && !description) return false;
    const current = document.tasks.find((task) => task.id === taskId);
    if (!current || (draft.expectedTask && JSON.stringify(current) !== JSON.stringify(draft.expectedTask))) {
      const error = new Error("Task file conflict: this task changed externally. Your draft is preserved; close and reopen the editor to review the latest task before saving.");
      saveError = error.message;
      options.reportError(error);
      return false;
    }
    const timestamp = new Date().toISOString();
    return save({
      ...document,
      tasks: document.tasks.map((task) => task.id === taskId
        ? {
            ...task,
            title,
            ...(description ? { description } : { description: undefined }),
            type: draft.type,
            ...(draft.links !== undefined ? { links: draft.links.length ? [...draft.links] : undefined } : {}),
            ...(draft.relatedTaskIds !== undefined ? { relatedTaskIds: draft.relatedTaskIds.length ? [...draft.relatedTaskIds] : undefined } : {}),
            ...(draft.parentId !== undefined ? { parentId: draft.parentId || undefined } : {}),
            ...(draft.epic !== undefined ? { epic: draft.epic || undefined } : {}),
            ...(draft.modelRef !== undefined ? { modelRef: draft.modelRef.trim() || undefined } : {}),
            updatedAt: timestamp,
          }
        : task),
    }, draft.attachments);
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

  function updatePriority(taskId: string, priority: ProjectTaskPriority): void {
    if (saving || loadFailed) return;
    void save({ ...document, tasks: document.tasks.map((task) => task.id === taskId
      ? { ...task, priority, updatedAt: new Date().toISOString() } : task) });
  }

  function reorder(
    taskId: string,
    targetStatus: ProjectTaskStatus,
    targetTaskId: string | null,
    position: ProjectTaskDropPosition,
  ): void {
    if (saving || loadFailed) return;
    const nextTasks = moveProjectTask(
      document.tasks,
      taskId,
      targetStatus,
      targetTaskId,
      position,
      new Date().toISOString(),
    );
    if (!nextTasks) return;
    const workspace = options.workspace();
    const expectedTask = document.tasks.find((task) => task.id === taskId);
    if (!workspace || !expectedTask) return;
    const generation = ++loadGeneration;
    mutationGeneration++;
    const previous = document;
    document = { ...document, tasks: nextTasks };
    saving = true;
    saveError = null;
    void (async () => {
      try {
        const next = parseTaskDocument(await invoke<unknown>("reorder_project_task", {
          workspace, taskId, targetStatus, targetTaskId, position, expectedTask,
          updatedAt: new Date().toISOString(),
        }));
        if (options.workspace() !== workspace || generation !== loadGeneration) return;
        document = next;
        options.afterSave?.(workspace);
      } catch (error) {
        if (options.workspace() === workspace && generation === loadGeneration) {
          document = previous;
          saveError = error instanceof Error ? error.message : String(error);
          try {
            const current = parseTaskDocument(await invoke<unknown>("read_project_tasks", { workspace }));
            if (options.workspace() === workspace && generation === loadGeneration) document = current;
          } catch (readError) {
            if (options.workspace() === workspace && generation === loadGeneration) loadFailed = true;
            options.reportError(readError);
          }
        }
        options.reportError(error);
      } finally {
        if (generation === loadGeneration) saving = false;
      }
    })();
  }

  function remove(taskId: string): void {
    void save({
      ...document,
      tasks: document.tasks.filter((task) => task.id !== taskId),
    });
  }

  function reset(): void {
    loadGeneration += 1;
    mutationGeneration++;
    pollGeneration++;
    document = EMPTY_TASK_DOCUMENT;
    loadedWorkspace = null;
    loading = false;
    saving = false;
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
    get initialLoading() { return loading && loadedWorkspace !== options.workspace(); },
    get saving() { return saving; },
    get loadFailed() { return loadFailed; },
    get saveError() { return saveError; },
    load,
    refresh,
    observe,
    save,
    create,
    update,
    updateStatus,
    updatePriority,
    reorder,
    remove,
    reset,
    newId,
  };
}
