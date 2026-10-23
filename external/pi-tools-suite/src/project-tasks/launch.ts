// Installed only by the Pix Desktop RPC host, never by headless/subagent runtimes.
const HOST = Symbol.for("pix.project-tasks.run");

export interface TaskRunResult {
  sessionId: string;
  outcome: "started" | "opened";
}

export async function launchProjectTask(id: string, sessionId: string, signal?: AbortSignal): Promise<TaskRunResult> {
  signal?.throwIfAborted();
  const launch = (globalThis as Record<symbol, unknown>)[HOST];
  if (process.env.PI_SUBAGENT_AGENT_DIR || typeof launch !== "function") {
    throw new Error("project_tasks run requires Pix Desktop. Use Tasks → Run or a subagent in other hosts.");
  }
  return launch({ taskId: id, sessionId }, signal);
}
