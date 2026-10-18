import { isCanonicalProjectPlanPath } from "./project-documents";
import { projectTaskPromptDraft, type ProjectTask } from "./project-tasks";

/** Deterministic plan location for a task, linked before the file exists. */
export function taskPlanPath(task: Pick<ProjectTask, "id" | "title">): string {
  const slug = (value: string, limit: number) => value.toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, limit)
    .replace(/-+$/g, "");
  const id = slug(task.id, 40) || "task";
  const title = slug(task.title, 48);
  return `.pi/plans/tasks/${title ? `${id}-${title}` : id}.md`;
}

/** First saved-plan link of a task; other links stay ordinary related documents. */
export function linkedTaskPlan(task: Pick<ProjectTask, "links">): string | undefined {
  return task.links?.find((link) => isCanonicalProjectPlanPath(link));
}

/** One recorded launch of a saved plan, shown under the plan row. */
export type PlanRun = { sessionId: string; title: string; launchedAt: number; status: import("./plan-launches").PlanRunStatus };

/** Plan path -> owning task (first task whose first saved-plan link is that path). */
export function planOwners(tasks: readonly ProjectTask[]): Readonly<Record<string, ProjectTask>> {
  const owners: Record<string, ProjectTask> = {};
  for (const task of tasks) {
    const path = linkedTaskPlan(task);
    if (path && !owners[path]) owners[path] = task;
  }
  return owners;
}

export function withTaskPlanLink(task: ProjectTask, path: string, updatedAt: string): ProjectTask {
  const links = task.links ?? [];
  if (links.includes(path)) return task;
  return { ...task, links: [path, ...links].slice(0, 50), updatedAt };
}

export function buildTaskPlanAuthoringPrompt(task: ProjectTask, path: string): string {
  const context = projectTaskPromptDraft({ ...task, links: task.links?.filter((link) => link !== path) }).text
    .split("\n")
    .filter((line) => !line.startsWith("Launching this task authorizes"));
  return [
    `Write an implementation plan for this project task and save it at ${JSON.stringify(path)}.`,
    "Follow the project's plan-writing guide. Investigate the current code first; do not implement the plan or change other files. The task already links to this plan path.",
    "",
    ...context.slice(1),
  ].join("\n").trim();
}

/** Task context appended to a plan launched from its task. */
export function taskPlanRunContext(task: ProjectTask): string {
  const title = task.title.trim();
  return [
    "",
    `This plan belongs to project task ${task.id}${title ? ` (${title})` : ""}.`,
    "Launching it authorizes updating only this task's final status without another confirmation.",
  ].join("\n");
}
