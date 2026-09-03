import { z } from "zod";

export const TASK_DOCUMENT_VERSION = 1 as const;
export const TASK_TYPES = ["bug", "feature", "improvement"] as const;
export const TASK_STATUSES = ["backlog", "todo", "in-progress", "done"] as const;
export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;

export type ProjectTaskType = (typeof TASK_TYPES)[number];
export type ProjectTaskStatus = (typeof TASK_STATUSES)[number];
export type ProjectTaskPriority = (typeof TASK_PRIORITIES)[number];

export interface ProjectTask {
  id: string;
  title: string;
  description?: string;
  type: ProjectTaskType;
  status: ProjectTaskStatus;
  priority: ProjectTaskPriority;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectTaskDocument {
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
  title: z.string().min(1).max(200),
  description: z.string().max(10_000).optional(),
  type: z.enum(TASK_TYPES),
  status: z.enum(TASK_STATUSES),
  priority: z.enum(TASK_PRIORITIES),
  sessionId: z.string().min(1).max(512).optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

const taskDocumentSchema = z.object({
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
});

export const EMPTY_TASK_DOCUMENT: ProjectTaskDocument = {
  version: TASK_DOCUMENT_VERSION,
  tasks: [],
};

export function parseTaskDocument(value: unknown): ProjectTaskDocument {
  const parsed = taskDocumentSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
  throw new Error(`Invalid .pi/tasks.json${path}: ${issue?.message ?? "unknown error"}`);
}

export function buildTaskPrompt(task: ProjectTask): string {
  const lines = [
    "Work on this project task.",
    "",
    `Type: ${taskTypeLabel(task.type)}`,
    `Priority: ${taskPriorityLabel(task.priority)}`,
    `Task: ${task.title}`,
  ];
  const description = task.description?.trim();
  if (description) lines.push("", "Description:", description);
  lines.push("", "Inspect the existing implementation, make the changes, and verify the result.");
  return lines.join("\n");
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

export function taskTypeLabel(type: ProjectTaskType): string {
  switch (type) {
    case "bug": return "Bug";
    case "feature": return "Feature";
    case "improvement": return "Improvement";
  }
}

export function taskStatusLabel(status: ProjectTaskStatus): string {
  switch (status) {
    case "backlog": return "Backlog";
    case "todo": return "Todo";
    case "in-progress": return "In progress";
    case "done": return "Done";
  }
}

export function taskPriorityLabel(priority: ProjectTaskPriority): string {
  return priority.charAt(0).toUpperCase() + priority.slice(1);
}
