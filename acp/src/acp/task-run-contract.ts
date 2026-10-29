/** Agent-initiated Desktop Tasks Run, not an ACP session/prompt replacement. */
export const TASK_RUN_METHOD = "pix/tasks/run";
export const TASK_RUN_CANCEL_METHOD = "pix/tasks/run_cancel";
export const TASK_RUN_RESPONSE_PREFIX = "\u0000pix:task-run-response:";

interface TaskRequestOwner {
  requestId: string;
  sourceSessionId: string;
  cwd: string;
}
export type TaskRunRequest = TaskRequestOwner & (
  | { op: "models" }
  | { op?: "run"; taskId: string; modelRef?: string }
);
export interface TaskRunResult {
  sessionId: string;
  outcome: "started" | "opened";
}
export interface TaskModelsResult {
  models: { modelRef: string; name: string; thinkingLevels: string[] }[];
}
export type TaskRunResponse = TaskRunResult | TaskModelsResult;

export function parseTaskRunRequest(value: unknown): TaskRunRequest {
  if (!value || typeof value !== "object") throw new Error("Invalid task launch request");
  const row = value as Record<string, unknown>;
  for (const key of ["requestId", "sourceSessionId", "cwd"] as const) {
    if (typeof row[key] !== "string" || !row[key].trim() || row[key].length > (key === "cwd" ? 32_768 : 128)) {
      throw new Error("Invalid task launch request");
    }
  }
  if (row.op !== undefined && row.op !== "run" && row.op !== "models") throw new Error("Invalid task launch operation");
  if (row.op === "models") {
    if (row.taskId !== undefined || row.modelRef !== undefined) throw new Error("Model listing accepts no task or model override");
  } else {
    if (typeof row.taskId !== "string" || !row.taskId.trim() || row.taskId.length > 128) throw new Error("Invalid task launch request");
    if (row.modelRef !== undefined && (typeof row.modelRef !== "string" || !row.modelRef.trim() || row.modelRef.length > 512)) {
      throw new Error("Invalid task model reference");
    }
  }
  return row as unknown as TaskRunRequest;
}

export function parseTaskRunResponse(value: unknown, models = false): TaskRunResponse {
  if (!models) return parseTaskRunResult(value);
  const rows = (value as TaskModelsResult | null)?.models;
  if (!Array.isArray(rows) || rows.length > 10_000 || rows.some(row => !row
    || typeof row.modelRef !== "string" || !row.modelRef || row.modelRef.length > 512
    || typeof row.name !== "string" || row.name.length > 512
    || !Array.isArray(row.thinkingLevels) || row.thinkingLevels.length > 16
    || row.thinkingLevels.some((level: unknown) => typeof level !== "string" || level.length > 32))) {
    throw new Error("Invalid task model catalog");
  }
  return { models: rows.map(({ modelRef, name, thinkingLevels }) => ({ modelRef, name, thinkingLevels: [...thinkingLevels] })) };
}

export function parseTaskRunResult(value: unknown): TaskRunResult {
  if (!value || typeof value !== "object") throw new Error("Task launch returned no receipt; inspect the task before retrying");
  const row = value as Record<string, unknown>;
  if (typeof row.sessionId !== "string" || !row.sessionId || row.sessionId.length > 128
    || (row.outcome !== "started" && row.outcome !== "opened")) throw new Error("Invalid task launch receipt; inspect the task before retrying");
  return { sessionId: row.sessionId, outcome: row.outcome };
}
