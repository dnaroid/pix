import { TASK_RUN_METHOD, parseTaskRunRequest, parseTaskRunResult, type TaskRunRequest, type TaskRunResult } from "./task-run-contract.js";
import type { Logger } from "../logging.js";

type LaunchResponse = { result?: TaskRunResult; error?: string };
type LaunchSession = {
  acpSessionId: string;
  cwd: string;
  client: { request(method: typeof TASK_RUN_METHOD, params: TaskRunRequest): Promise<TaskRunResult> };
  pi: { respondToTaskRun?: (requestId: string, response: LaunchResponse) => Promise<void> };
};

/** The physical runtime owns replies; never deliver an old receipt to its replacement. */
export async function forwardTaskRun(
  session: LaunchSession,
  event: { requestId: string; taskId: string },
  current: () => boolean,
  logger: Logger,
): Promise<void> {
  if (!session.pi.respondToTaskRun || !current()) return;
  let response: LaunchResponse;
  try {
    const request = parseTaskRunRequest({ ...event, cwd: session.cwd, sourceSessionId: session.acpSessionId });
    response = { result: parseTaskRunResult(await session.client.request(TASK_RUN_METHOD, request)) };
  } catch (error) {
    logger.warn("task launch failed", { module: "project-tasks" });
    const detail = error instanceof Error ? error.message : "Desktop task launch unavailable";
    response = { error: `${detail.slice(0, 2000)}; inspect the task sessionId before retrying` };
  }
  if (!current()) return;
  try { await session.pi.respondToTaskRun(event.requestId, response); }
  catch { logger.warn("task launch receipt delivery failed", { module: "project-tasks" }); }
}
