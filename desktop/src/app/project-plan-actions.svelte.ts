import { isCanonicalProjectPlanPath } from "../lib/project-documents";
import type { PlanLaunchOutcome } from "../lib/plan-launches";
import type { ProjectActionsOptions } from "./project-actions.svelte";
import { buildProjectPlanPrompt, buildProjectPlanResumePrompt } from "./project-plan-prompt";

type PlanActionsOptions = Pick<ProjectActionsOptions,
  | "client" | "workspace" | "canUseSession" | "sessionMutationRunning" | "workspaceOpening" | "planAvailable"
  | "activeSessionId" | "closeProjectSelector" | "closeSessionSelector" | "setOperationRunning"
  | "setErrorMessage" | "ensureRuntime" | "runtimeReady" | "forgetRuntime" | "activateSession"
  | "appendUserMessage" | "runPrompt" | "scrollToLatest" | "refreshSessions" | "reportError"
  | "recordPlanLaunch" | "settlePlanLaunch"
>;

/** `resume` continues a plan whose earlier run stopped before finishing. */
export type PlanRunMode = "run" | "resume";

export function createProjectPlanActions(options: PlanActionsOptions, busy: () => boolean) {
  let actionId = $state<string | null>(null);
  let owner = 0;

  async function runPlan(path: string, mode: PlanRunMode = "run"): Promise<void> {
    const client = options.client();
    const workspace = options.workspace();
    if (!client || !workspace || !isCanonicalProjectPlanPath(path) || busy() || actionId
      || options.workspaceOpening?.() || !options.canUseSession() || options.sessionMutationRunning()
      || options.planAvailable?.(path) === false) return;
    const request = ++owner;
    const current = () => request === owner && options.client() === client && options.workspace() === workspace;
    actionId = `plan:${path}`;
    options.closeProjectSelector();
    options.closeSessionSelector();
    options.setOperationRunning(true);
    options.setErrorMessage(null);
    // A recorded launch whose prompt never started must still settle, otherwise
    // it would look like it is running until the app restarts.
    let launched: string | null = null;
    let unsent: PlanLaunchOutcome = "cancelled";
    try {
      const created = await client.newSession(workspace);
      if (!current()) {
        options.forgetRuntime(created.sessionId);
        void client.closeSession(created.sessionId).catch(options.reportError);
        return;
      }
      options.activateSession(created.sessionId, workspace, false);
      options.recordPlanLaunch?.(workspace, created.sessionId, path);
      launched = created.sessionId;
      const active = () => current() && options.activeSessionId() === created.sessionId;
      await options.ensureRuntime(client, created.sessionId, workspace);
      if (!active()) return;
      if (!options.runtimeReady(created.sessionId)) {
        unsent = "failed";
        return;
      }
      // The plan may be deleted while the session starts; never send a prompt
      // that points at a file that no longer exists.
      if (options.planAvailable?.(path) === false) {
        unsent = "failed";
        options.setErrorMessage(`Plan ${path} was removed before the run started.`);
        return;
      }
      const text = mode === "resume" ? buildProjectPlanResumePrompt(path) : buildProjectPlanPrompt(path);
      const messageId = options.appendUserMessage(created.sessionId, text, []);
      await options.scrollToLatest();
      if (!active()) return;
      options.setOperationRunning(false);
      // From here the prompt lifecycle (settled/error hooks) owns the outcome.
      launched = null;
      await options.runPrompt(client, created.sessionId, [{ type: "text", text }], [], messageId);
      if (current()) void options.refreshSessions();
    } catch (error) {
      unsent = "failed";
      if (current()) options.reportError(error);
    } finally {
      if (launched) options.settlePlanLaunch?.(launched, unsent, workspace);
      if (request === owner) {
        if (current()) options.setOperationRunning(false);
        actionId = null;
      }
    }
  }

  return {
    get actionId() { return actionId; },
    runPlan,
    resumePlan: (path: string) => runPlan(path, "resume"),
    reset() { owner += 1; actionId = null; },
  };
}
