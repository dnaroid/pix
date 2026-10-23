/** Agent-initiated Desktop Tasks Run, not an ACP session/prompt replacement. */
export const TASK_RUN_METHOD = "pix/tasks/run";
export const TASK_RUN_CANCEL_METHOD = "pix/tasks/run_cancel";
export const TASK_RUN_RESPONSE_PREFIX = "\u0000pix:task-run-response:";

export interface TaskRunRequest {
  requestId: string;
  sourceSessionId: string;
  cwd: string;
  taskId: string;
}
export interface TaskRunResult {
  sessionId: string;
  outcome: "started" | "opened";
}

export function parseTaskRunRequest(value: unknown): TaskRunRequest {
  if (!value || typeof value !== "object") throw new Error("Invalid task launch request");
  const row = value as Record<string, unknown>;
  for (const key of ["requestId", "sourceSessionId", "cwd", "taskId"] as const) {
    if (typeof row[key] !== "string" || !row[key].trim() || row[key].length > (key === "cwd" ? 32_768 : 128)) {
      throw new Error("Invalid task launch request");
    }
  }
  return row as unknown as TaskRunRequest;
}

export function parseTaskRunResult(value: unknown): TaskRunResult {
  if (!value || typeof value !== "object") throw new Error("Task launch returned no receipt; inspect the task before retrying");
  const row = value as Record<string, unknown>;
  if (typeof row.sessionId !== "string" || !row.sessionId || row.sessionId.length > 128
    || (row.outcome !== "started" && row.outcome !== "opened")) throw new Error("Invalid task launch receipt; inspect the task before retrying");
  return { sessionId: row.sessionId, outcome: row.outcome };
}
