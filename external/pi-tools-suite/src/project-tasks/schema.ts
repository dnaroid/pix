/** Standalone mirror of the version-1 Desktop task contract; no workspace imports. */
export const TASK_TYPES = ["bug", "feature", "improvement", "idea"] as const;
export const TASK_STATUSES = ["backlog", "todo", "in-progress", "done", "failed"] as const;
export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export const MAX_TASK_BYTES = 1024 * 1024;
export const TASK_SCHEMA_URL = "https://unpkg.com/pi-ui-extend/schemas/tasks.json";

export interface ProjectTask {
  id: string;
  title: string;
  description?: string;
  type: typeof TASK_TYPES[number];
  status: typeof TASK_STATUSES[number];
  priority: typeof TASK_PRIORITIES[number];
  sessionId?: string;
  links?: string[];
  relatedTaskIds?: string[];
  parentId?: string;
  epic?: boolean;
  modelRef?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDocument {
  $schema?: string;
  version: 1;
  tasks: ProjectTask[];
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: expected an object`);
  return value as Record<string, unknown>;
}

export function onlyKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${label}: unsupported field ${key}`);
}

export function string(value: unknown, min: number, max: number, label: string): asserts value is string {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new Error(`${label}: expected a string of ${min}–${max} characters`);
  }
}

export function enumValue(value: unknown, choices: readonly string[], label: string): void {
  if (typeof value !== "string" || !choices.includes(value)) throw new Error(`${label}: expected ${choices.join(" | ")}`);
}

export function validateTaskDocument(value: unknown, verifyHierarchy = true): TaskDocument {
  const label = "Invalid .pi/tasks.sqlite payload";
  const doc = object(value, label);
  onlyKeys(doc, ["$schema", "version", "tasks"], label);
  if (doc.version !== 1) throw new Error(`${label}: expected version 1`);
  if (doc.$schema !== undefined) string(doc.$schema, 1, 2048, `${label}.$schema`);
  if (!Array.isArray(doc.tasks) || doc.tasks.length > 10_000) throw new Error(`${label}: expected at most 10,000 tasks`);
  const ids = new Set<string>();
  for (const [index, raw] of doc.tasks.entries()) {
    const at = `${label} at tasks.${index}`;
    const task = object(raw, at);
    onlyKeys(task, ["id", "title", "description", "type", "status", "priority", "sessionId", "links", "relatedTaskIds", "parentId", "epic", "modelRef", "createdAt", "updatedAt"], at);
    string(task.id, 1, 128, `${at}.id`);
    if (ids.has(task.id)) throw new Error(`${at}: duplicate task id ${task.id}`);
    ids.add(task.id);
    string(task.title, 0, 200, `${at}.title`);
    if (task.description !== undefined) string(task.description, 0, 10_000, `${at}.description`);
    if (!task.title.trim() && !(task.description as string | undefined)?.trim()) throw new Error(`${at}: expected a title or description`);
    enumValue(task.type, TASK_TYPES, `${at}.type`);
    enumValue(task.status, TASK_STATUSES, `${at}.status`);
    enumValue(task.priority, TASK_PRIORITIES, `${at}.priority`);
    if (task.sessionId !== undefined) string(task.sessionId, 1, 512, `${at}.sessionId`);
    if (task.links !== undefined) {
      if (!Array.isArray(task.links) || task.links.length > 50) throw new Error(`${at}.links: expected at most 50 links`);
      for (const link of task.links) string(link, 1, 1024, `${at}.links`);
    }
    if (task.relatedTaskIds !== undefined) {
      if (!Array.isArray(task.relatedTaskIds) || task.relatedTaskIds.length > 50) throw new Error(`${at}.relatedTaskIds: expected at most 50 related tasks`);
      for (const related of task.relatedTaskIds) string(related, 1, 128, `${at}.relatedTaskIds`);
      if (new Set(task.relatedTaskIds).size !== task.relatedTaskIds.length || task.relatedTaskIds.includes(task.id)) {
        throw new Error(`${at}.relatedTaskIds: duplicate or self reference`);
      }
    }
    if (task.parentId !== undefined) string(task.parentId, 1, 128, `${at}.parentId`);
    if (task.epic !== undefined && typeof task.epic !== "boolean") throw new Error(`${at}.epic: expected boolean`);
    if (task.epic && task.parentId) throw new Error(`${at}.epic: an epic must be top-level`);
    if (task.modelRef !== undefined) {
      string(task.modelRef, 3, 256, `${at}.modelRef`);
      if (!/^[^\s/]+\/[^\s/]+(?:\/[^\s]+)*(?::(?:off|minimal|low|medium|high|xhigh|max))?$/.test(task.modelRef as string)) {
        throw new Error(`${at}.modelRef: expected provider/model[:thinking]`);
      }
    }
    for (const field of ["createdAt", "updatedAt"]) {
      string(task[field], 1, Number.MAX_SAFE_INTEGER, `${at}.${field}`);
      // Matches Desktop parseTaskDocument's timestamp refinement.
      if (!Number.isFinite(Date.parse(task[field] as string))) throw new Error(`${at}.${field}: expected an ISO timestamp`);
    }
  }
  if (verifyHierarchy) {
    const byId = new Map((doc.tasks as ProjectTask[]).map(task => [task.id, task]));
    for (const task of doc.tasks as ProjectTask[]) {
      if (task.relatedTaskIds?.some(id => !byId.has(id))) throw new Error(`${label}: task ${task.id} references a missing related task`);
      if (!task.parentId) continue;
      if (!byId.has(task.parentId)) throw new Error(`${label}: unknown parent task ${task.parentId}`);
      const visited = new Set([task.id]);
      let cursor: string | undefined = task.parentId;
      while (cursor) {
        if (visited.has(cursor)) throw new Error(`${label}: task hierarchy contains a cycle`);
        visited.add(cursor);
        cursor = byId.get(cursor)?.parentId;
      }
    }
  }
  return doc as unknown as TaskDocument;
}
