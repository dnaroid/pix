import { isCanonicalProjectPlanPath } from "../lib/project-documents";
import type { ProjectActionsOptions } from "./project-actions.svelte";
import { buildProjectPlanPrompt } from "./project-plan-prompt";

type PlanActionsOptions = Pick<ProjectActionsOptions,
  | "client" | "workspace" | "canUseSession" | "sessionMutationRunning" | "planAvailable"
  | "activeSessionId" | "closeProjectSelector" | "closeSessionSelector" | "setOperationRunning"
  | "setErrorMessage" | "ensureRuntime" | "runtimeReady" | "forgetRuntime" | "activateSession"
  | "appendUserMessage" | "runPrompt" | "scrollToLatest" | "refreshSessions" | "reportError"
>;

export function createProjectPlanActions(options: PlanActionsOptions, busy: () => boolean) {
  let actionId = $state<string | null>(null);
  let owner = 0;

  async function runPlan(path: string): Promise<void> {
    const client = options.client();
    const workspace = options.workspace();
    if (!client || !workspace || !isCanonicalProjectPlanPath(path) || busy() || actionId
      || !options.canUseSession() || options.sessionMutationRunning() || options.planAvailable?.(path) === false) return;
    const request = ++owner;
    const current = () => request === owner && options.client() === client && options.workspace() === workspace;
    actionId = `plan:${path}`;
    options.closeProjectSelector();
    options.closeSessionSelector();
    options.setOperationRunning(true);
    options.setErrorMessage(null);
    try {
      const created = await client.newSession(workspace);
      if (!current()) {
        options.forgetRuntime(created.sessionId);
        void client.closeSession(created.sessionId).catch(options.reportError);
        return;
      }
      options.activateSession(created.sessionId, workspace, false);
      const active = () => current() && options.activeSessionId() === created.sessionId;
      await options.ensureRuntime(client, created.sessionId, workspace);
      if (!active() || !options.runtimeReady(created.sessionId)) return;
      const text = buildProjectPlanPrompt(path);
      const messageId = options.appendUserMessage(created.sessionId, text, []);
      await options.scrollToLatest();
      if (!active()) return;
      options.setOperationRunning(false);
      await options.runPrompt(client, created.sessionId, [{ type: "text", text }], [], messageId);
      if (current()) void options.refreshSessions();
    } catch (error) {
      if (current()) options.reportError(error);
    } finally {
      if (request === owner) {
        if (current()) options.setOperationRunning(false);
        actionId = null;
      }
    }
  }

  return {
    get actionId() { return actionId; },
    runPlan,
    reset() { owner += 1; actionId = null; },
  };
}
