import { z } from "zod";
import type { Attachment } from "./attachments";

export const TASK_DOCUMENT_VERSION = 1 as const;
export const TASK_SCHEMA_URL = "https://unpkg.com/pi-ui-extend/schemas/tasks.json";
export const TASK_TYPES = ["bug", "feature", "improvement", "idea"] as const;
export const TASK_STATUSES = ["backlog", "todo", "in-progress", "done", "failed"] as const;
export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;

export type ProjectTaskType = (typeof TASK_TYPES)[number];
export type ProjectTaskStatus = (typeof TASK_STATUSES)[number];
export type ProjectTaskPriority = (typeof TASK_PRIORITIES)[number];
export type ProjectTaskDropPosition = "before" | "after";

export interface ProjectTask {
  id: string;
  title: string;
  description?: string;
  type: ProjectTaskType;
  status: ProjectTaskStatus;
  priority: ProjectTaskPriority;
  sessionId?: string;
  links?: string[];
  /** Directional task links; reverse relations are derived without mutating peers. */
  relatedTaskIds?: string[];
  /** Optional task hierarchy; a task has at most one parent. */
  parentId?: string;
  /** Mark a top-level task as an epic in the Tasks view. */
  epic?: boolean;
  /** Optional model for a newly launched task session; omitted = normal default. */
  modelRef?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectTaskDocument {
  $schema?: string;
  version: typeof TASK_DOCUMENT_VERSION;
  tasks: ProjectTask[];
}

export interface ProjectTaskFilters {
  type: ProjectTaskType | "all";
  status: ProjectTaskStatus | "all";
  priority: ProjectTaskPriority | "all";
}

const timestampSchema = z.string().refine(
  (value) => Number.isFinite(Date.parse(value)),
  "Expected an ISO timestamp",
);

const projectTaskSchema = z.object({
  id: z.string().min(1).max(128),
  title: z.string().max(200),
  description: z.string().max(10_000).optional(),
  type: z.enum(TASK_TYPES),
  status: z.enum(TASK_STATUSES),
  priority: z.enum(TASK_PRIORITIES),
  sessionId: z.string().min(1).max(512).optional(),
  links: z.array(z.string().min(1).max(1024)).max(50).optional(),
  relatedTaskIds: z.array(z.string().min(1).max(128)).max(50).optional(),
  parentId: z.string().min(1).max(128).optional(),
  epic: z.boolean().optional(),
  modelRef: z.string().min(3).max(256).regex(/^[^\s/]+\/[^\s/]+(?:\/[^\s]+)*(?::(?:off|minimal|low|medium|high|xhigh|max))?$/, "Use provider/model[:thinking]").optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict().superRefine((task, context) => {
  if (task.title.trim() || task.description?.trim()) return;
  context.addIssue({
    code: "custom",
    message: "Expected a title or description",
    path: ["description"],
  });
});

const taskDocumentSchema = z.object({
  $schema: z.string().min(1).max(2_048).optional(),
  version: z.literal(TASK_DOCUMENT_VERSION),
  tasks: z.array(projectTaskSchema).max(10_000),
}).strict().superRefine((document, context) => {
  const seen = new Set<string>();
  document.tasks.forEach((task, index) => {
    if (!seen.has(task.id)) {
      seen.add(task.id);
      return;
    }
    context.addIssue({
      code: "custom",
      message: `Duplicate task id: ${task.id}`,
      path: ["tasks", index, "id"],
    });
  });
  const byId = new Map(document.tasks.map((task) => [task.id, task]));
  for (const [index, task] of document.tasks.entries()) {
    if (task.relatedTaskIds) {
      const related = new Set<string>();
      for (const id of task.relatedTaskIds) {
        if (related.has(id) || id === task.id || !byId.has(id)) {
          context.addIssue({ code: "custom", message: "Related tasks must exist and be distinct from this task", path: ["tasks", index, "relatedTaskIds"] });
          break;
        }
        related.add(id);
      }
    }
    if (!task.parentId) continue;
    if (!byId.has(task.parentId)) {
      context.addIssue({ code: "custom", message: "Unknown parent task", path: ["tasks", index, "parentId"] });
      continue;
    }
    const visited = new Set<string>([task.id]);
    let cursor: string | undefined = task.parentId;
    while (cursor) {
      if (visited.has(cursor)) {
        context.addIssue({ code: "custom", message: "Task hierarchy cannot contain a cycle", path: ["tasks", index, "parentId"] });
        break;
      }
      visited.add(cursor);
      cursor = byId.get(cursor)?.parentId;
    }
    if (task.epic && task.parentId) context.addIssue({ code: "custom", message: "An epic must be a top-level task", path: ["tasks", index, "epic"] });
  }
});

export const EMPTY_TASK_DOCUMENT: ProjectTaskDocument = {
  $schema: TASK_SCHEMA_URL,
  version: TASK_DOCUMENT_VERSION,
  tasks: [],
};

export function parseTaskDocument(value: unknown): ProjectTaskDocument {
  const parsed = taskDocumentSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
  throw new Error(`Invalid SQLite task view${path}: ${issue?.message ?? "unknown error"}`);
}

export function projectTaskPromptDraft(task: ProjectTask): {
  text: string;
  attachments: Attachment[];
} {
  const isIdea = task.type === "idea";
  const lines = [
    isIdea ? "Discuss and refine this project idea." : "Work on this project task.",
    "",
    `Task id: ${task.id}`,
    `Type: ${taskTypeLabel(task.type)}`,
  ];
  const title = task.title.trim();
  if (title) lines.push(`Task: ${title}`);
  const description = (task.description ?? "").trim();
  if (description) lines.push("", "Description:", description);
  if (task.links?.length) lines.push("", "Related documents:", ...task.links.map((link) => `- ${link}`));
  if (task.parentId) lines.push(`Parent task id: ${task.parentId}`);
  if (task.relatedTaskIds?.length) lines.push("Related task ids:", ...task.relatedTaskIds.map((id) => `- ${id}`));
  if (task.epic) lines.push("This task is an epic.");
  lines.push(
    "",
    isIdea
      ? "Discuss and clarify the idea, propose options, and define readiness criteria. Do not change code without agreement."
      : "Inspect the existing implementation, make the changes, and verify the result.",
    "",
    "Launching this task authorizes updating only this task's final status without another confirmation.",
    `At the end, use project_tasks with op: update and id: ${JSON.stringify(task.id)} to set status: done after successful completion and verification, or status: failed if you could not complete the task. Do not mark a transient error as failed while still retrying.`,
    "If the status update cannot be saved, report that clearly; do not claim it was saved or create a replacement task. Other task status changes still require explicit user confirmation.",
  );
  // Task attachments are resolved by task ID from the SQLite association table,
  // never reconstructed from legacy file:// markers in descriptions.
  return { text: lines.join("\n"), attachments: [] };
}

export function projectTaskFromComposerDraft(
  text: string,
  attachments: readonly Attachment[],
  id: string,
  timestamp: string,
): ProjectTask | undefined {
  // Persist attachments separately in SQLite; descriptions are human-readable
  // and never contain file:// markers or local paths.
  const description = text.trim() || attachments.map((attachment) => `Attachment: ${attachment.name}`).join("\n");
  if (!description) return undefined;
  return {
    id,
    title: "",
    description,
    type: "feature",
    status: "todo",
    priority: "medium",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function projectTaskDisplayLabel(task: ProjectTask): string {
  const title = task.title.trim();
  if (title) return title;
  const description = task.description ?? "";
  const firstLine = description.split(/\r?\n/u).map((line: string) => line.trim()).find(Boolean);
  return firstLine ? firstLine.slice(0, 120) : "Untitled task";
}

/** Prevent choosing one's descendant as a new parent (including deeper levels). */
export function possibleTaskParents(tasks: readonly ProjectTask[], taskId: string | null): ProjectTask[] {
  if (!taskId) return [...tasks];
  const descendants = new Set([taskId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const task of tasks) {
      if (task.parentId && descendants.has(task.parentId) && !descendants.has(task.id)) {
        descendants.add(task.id);
        grew = true;
      }
    }
  }
  return tasks.filter((task) => !descendants.has(task.id));
}

export function taskHierarchyHoverRelation(
  task: ProjectTask, hoveredTaskId: string | null, tasks: readonly ProjectTask[],
): "parent" | "sibling" | null {
  if (!hoveredTaskId) return null;
  const hovered = tasks.find((item) => item.id === hoveredTaskId);
  if (!hovered?.parentId) return null;
  if (task.id === hovered.parentId) return "parent";
  if (task.id !== hoveredTaskId && task.parentId === hovered.parentId) return "sibling";
  return null;
}

/** Existing URLs may be linked, but local file references must stay project-relative. */
export function normalizeProjectTaskLink(source: string): string | undefined {
  const value = source.trim().replaceAll("\\", "/");
  if (!value || value.length > 1024) return undefined;
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
    } catch { return undefined; }
  }
  if (value.startsWith("/") || value.startsWith("~") || /^[a-z][a-z\d+.-]*:/i.test(value)
    || value.split("/").some((part) => !part || part === "." || part === "..")
    || value.includes("\0")) return undefined;
  return value;
}

export function buildTaskPrompt(task: ProjectTask): string {
  return projectTaskPromptDraft(task).text;
}

export function filterProjectTasks(
  tasks: readonly ProjectTask[],
  filters: ProjectTaskFilters,
): ProjectTask[] {
  return tasks.filter((task) =>
    (filters.type === "all" || task.type === filters.type)
    && (filters.status === "all" || task.status === filters.status)
    && (filters.priority === "all" || task.priority === filters.priority)
  );
}

export function moveProjectTask(
  tasks: readonly ProjectTask[],
  taskId: string,
  targetStatus: ProjectTaskStatus,
  targetTaskId: string | null,
  position: ProjectTaskDropPosition,
  updatedAt: string,
): ProjectTask[] | undefined {
  const source = tasks.find((task) => task.id === taskId);
  if (!source || targetTaskId === taskId) return undefined;

  const statusOrder: readonly ProjectTaskStatus[] = ["in-progress", "todo", "backlog", "done", "failed"];
  const grouped = new Map<ProjectTaskStatus, ProjectTask[]>(
    statusOrder.map((status) => [
      status,
      tasks.filter((task) => task.id !== taskId && task.status === status),
    ]),
  );
  const targetGroup = grouped.get(targetStatus);
  if (!targetGroup) return undefined;

  let insertIndex = targetGroup.length;
  if (targetTaskId !== null) {
    const targetIndex = targetGroup.findIndex((task) => task.id === targetTaskId);
    if (targetIndex < 0) return undefined;
    insertIndex = targetIndex + (position === "after" ? 1 : 0);
  }

  const movedTask = source.status === targetStatus
    ? source
    : { ...source, status: targetStatus, updatedAt };
  targetGroup.splice(insertIndex, 0, movedTask);
  const nextTasks = statusOrder.flatMap((status) => grouped.get(status) ?? []);
  const unchanged = nextTasks.length === tasks.length
    && nextTasks.every((task, index) => {
      const previous = tasks[index];
      return previous?.id === task.id && previous.status === task.status;
    });
  return unchanged ? undefined : nextTasks;
}

export function taskTypeLabel(type: ProjectTaskType): string {
  switch (type) {
    case "bug": return "Bug";
    case "feature": return "Feature";
    case "improvement": return "Improvement";
    case "idea": return "Idea";
  }
}

export function taskStatusLabel(status: ProjectTaskStatus): string {
  switch (status) {
    case "backlog": return "Backlog";
    case "todo": return "Todo";
    case "in-progress": return "In progress";
    case "done": return "Done";
    case "failed": return "Failed";
  }
}

export function taskPriorityLabel(priority: ProjectTaskPriority): string {
  return priority.charAt(0).toUpperCase() + priority.slice(1);
}
