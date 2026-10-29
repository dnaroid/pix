// Installed only by the Pix Desktop RPC host, never by headless/subagent runtimes.
const HOST = Symbol.for("pix.project-tasks.run");

export interface TaskRunResult {
  sessionId: string;
  outcome: "started" | "opened";
}

export interface TaskModelsResult {
  models: { modelRef: string; name: string; thinkingLevels: string[] }[];
}

export async function requestTaskHost(request: { taskId: string; modelRef?: string } | { op: "models" }, sessionId: string, signal?: AbortSignal): Promise<TaskRunResult | TaskModelsResult> {
  signal?.throwIfAborted();
  const launch = (globalThis as Record<symbol, unknown>)[HOST];
  if (process.env.PI_SUBAGENT_AGENT_DIR || typeof launch !== "function") {
    throw new Error("project_tasks run/models requires Pix Desktop. Use Tasks → Run or a subagent in other hosts.");
  }
  return launch({ ...request, sessionId }, signal);
}
