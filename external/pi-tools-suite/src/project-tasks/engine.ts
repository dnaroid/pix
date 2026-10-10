import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { readAttachments, readTaskStore, writeTaskRecord, type ProjectTasksServices, type TaskAttachment } from "./storage.js";
export type { ProjectTasksServices } from "./storage.js";
import {
  enumValue, object, onlyKeys, string, TASK_PRIORITIES,
  TASK_STATUSES, TASK_TYPES, validateTaskDocument, type ProjectTask,
} from "./schema.js";

export interface ProjectTasksParams {
  op: "list" | "get" | "update" | "create" | "delete";
  id?: string;
  title?: string;
  description?: string;
  type?: ProjectTask["type"];
  status?: ProjectTask["status"];
  priority?: ProjectTask["priority"];
}

export function parseProjectTasksParams(value: unknown, allowDelete = false): ProjectTasksParams {
  const label = "Invalid project_tasks request";
  const input = object(value, label);
  enumValue(input.op, allowDelete ? ["list", "get", "update", "create", "delete"] : ["list", "get", "update", "create"], `${label}.op`);
  const fields = input.op === "list" ? ["status", "priority", "type"]
    : (input.op === "get" || input.op === "delete") ? ["id"]
    : input.op === "update" ? ["id", "status", "priority", "title", "description"]
    : ["type", "status", "priority", "title", "description"];
  onlyKeys(input, ["op", ...fields], label);
  if (input.op === "get" || input.op === "update" || input.op === "delete") string(input.id, 1, 128, `${label}.id`);
  if (input.type !== undefined || input.op === "create") enumValue(input.type, TASK_TYPES, `${label}.type`);
  if (input.status !== undefined) enumValue(input.status, TASK_STATUSES, `${label}.status`);
  if (input.priority !== undefined) enumValue(input.priority, TASK_PRIORITIES, `${label}.priority`);
  if (input.title !== undefined) string(input.title, 0, 200, `${label}.title`);
  if (input.description !== undefined) string(input.description, 0, 10_000, `${label}.description`);
  if (input.op === "update" && !["status", "priority", "title", "description"].some(key => input[key] !== undefined)) {
    throw new Error(`${label}: update requires status, priority, title or description`);
  }
  if (input.op === "create" && !(input.title as string | undefined)?.trim() && !(input.description as string | undefined)?.trim()) {
    throw new Error(`${label}: create requires a title or description`);
  }
  return input as unknown as ProjectTasksParams;
}

export interface ProjectTasksResponse {
  projectRoot: string;
  op: ProjectTasksParams["op"];
  tasks?: Omit<ProjectTask, "description">[];
  task?: ProjectTask;
  attachments?: TaskAttachment[];
}

export async function runProjectTasks(cwd: string, input: unknown, signal?: AbortSignal, services?: ProjectTasksServices): Promise<ProjectTasksResponse> {
  // Delete is supported by the engine for explicit user commands, not the agent tool.
  const params = parseProjectTasksParams(input, true);
  signal?.throwIfAborted();
  const root = await realpath(cwd);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory()) throw new Error("Project cwd must be an existing directory");
  const folder = path.join(root, ".pi");
  const newId = params.op === "create" ? randomUUID() : undefined;
  const run = async (): Promise<ProjectTasksResponse> => {
    signal?.throwIfAborted();
    const snapshot = await readTaskStore(folder, signal);
    const doc = snapshot.document;
    if (params.op === "list") return { projectRoot: root, op: params.op, tasks: doc.tasks
      .filter(task => (!params.status || task.status === params.status) && (!params.priority || task.priority === params.priority) && (!params.type || task.type === params.type))
      .map(({ description: _description, ...task }) => task) };
    if (params.op === "get") {
      const task = doc.tasks.find(task => task.id === params.id);
      if (!task) throw new Error(`Unknown project task id: ${params.id}`);
      return { projectRoot: root, op: params.op, task, attachments: await readAttachments(folder, task.id) };
    }
    let task: ProjectTask;
    if (params.op === "create") {
      const now = new Date().toISOString();
      task = { id: newId!, title: params.title ?? "", type: params.type!, status: params.status ?? "todo",
        priority: params.priority ?? "medium", createdAt: now, updatedAt: now,
        ...(params.description !== undefined ? { description: params.description } : {}) };
    } else {
      const existing = doc.tasks.find(task => task.id === params.id);
      if (!existing) throw new Error(`Unknown project task id: ${params.id}`);
      if (params.op === "delete") {
        await writeTaskRecord(folder, snapshot, { id: existing.id, deleted: true }, signal, services);
        return { projectRoot: root, op: params.op, task: existing };
      }
      task = { ...existing };
      for (const field of ["title", "description", "status", "priority"] as const) {
        if (params[field] !== undefined) Object.assign(task, { [field]: params[field] });
      }
      task.updatedAt = new Date().toISOString();
    }
    validateTaskDocument({ version: 1, tasks: [task] }, false);
    await writeTaskRecord(folder, snapshot, task, signal, services);
    return { projectRoot: root, op: params.op, task };
  };
  return run();
}
