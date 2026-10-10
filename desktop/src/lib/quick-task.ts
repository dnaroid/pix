import type { ProjectTaskType } from "./project-tasks";

/** Only display metadata is derived. Keep the full original text when a title is clipped or multiline. */
export function quickTaskDraft(text: string, type: ProjectTaskType) {
  const original = text.trim();
  if (!original) return undefined;
  const firstLine = original.split(/\r?\n/u, 1)[0]!.trim();
  const title = firstLine.slice(0, 200).trim();
  if (!title) return undefined;
  return {
    title,
    ...(original !== title ? { description: original } : {}),
    type,
    status: "todo" as const,
  };
}
