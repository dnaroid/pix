import type { SessionTodoTask } from "./session-todos";

/** Same-session follow-up asking the agent to redo exactly one step. */
export function buildSessionStepRerunPrompt(task: Pick<SessionTodoTask, "id" | "subject" | "description">): string {
  const lines = [
    `Rerun session step #${task.id}: ${task.subject}`,
  ];
  if (task.description?.trim()) lines.push(`Step details: ${task.description.trim()}`);
  lines.push(
    "Redo only this step. Inspect what the earlier attempt changed, then fix or redo it so the step's outcome holds against the current code.",
    `Use the todo tool to mark step #${task.id} in_progress while you work and completed only after verifying it. Do not start or rework other steps unless this step requires it; report anything else you notice instead.`,
  );
  return lines.join("\n");
}
