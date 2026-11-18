import { isCanonicalProjectPlanPath } from "../lib/project-documents";
import type { PlanLaunchOutcome } from "../lib/plan-launches";
import type { ProjectActionsOptions } from "./project-actions.svelte";
import { buildProjectPlanPrompt, buildProjectPlanResumePrompt } from "./project-plan-prompt";
import { parseDesktopModelRef } from "./desktop-helpers";

type PlanActionsOptions = Pick<ProjectActionsOptions,
  | "client" | "workspace" | "canUseSession" | "sessionMutationRunning" | "workspaceOpening" | "planAvailable"
  | "activeSessionId" | "closeProjectSelector" | "closeSessionSelector" | "setOperationRunning"
  | "setErrorMessage" | "ensureRuntime" | "runtimeReady" | "forgetRuntime" | "activateSession"
  | "appendUserMessage" | "runPrompt" | "scrollToLatest" | "refreshSessions" | "reportError"
  | "recordPlanLaunch" | "settlePlanLaunch"
>;

/** `resume` continues a plan whose earlier run stopped before finishing. */
export type PlanRunMode = "run" | "resume";

/** A plan or free prompt launched in a new session on an agent's request. */
export type AgentSessionItem = { kind: "plan"; path: string } | { kind: "prompt"; text: string };

type AgentLaunch = {
  signal: AbortSignal;
  modelRef?: string;
  /** Prepended to the launch prompt (the supervisor's worker rules). */
  prefix: string;
  started: (sessionId: string) => void;
};

type LaunchItem = { kind: "plan"; path: string; mode: PlanRunMode } | { kind: "prompt"; text: string };

export function createProjectPlanActions(options: PlanActionsOptions, busy: () => boolean) {
  let actionId = $state<string | null>(null);
  let owner = 0;

  async function launch(item: LaunchItem, agent?: AgentLaunch): Promise<void> {
    agent?.signal.throwIfAborted();
    const client = options.client();
    const workspace = options.workspace();
    const path = item.kind === "plan" ? item.path : null;
    if (!client || !workspace || busy() || actionId
      || options.workspaceOpening?.() || !options.canUseSession() || options.sessionMutationRunning()
      || (path !== null && (!isCanonicalProjectPlanPath(path) || options.planAvailable?.(path) === false))) return;
    const request = ++owner;
    // An agent launch stays cancellable until its prompt is dispatched.
    let dispatched = false;
    const current = () => request === owner && options.client() === client && options.workspace() === workspace
      && (dispatched || !agent?.signal.aborted);
    actionId = path !== null ? `plan:${path}` : "prompt";
    options.closeProjectSelector();
    options.closeSessionSelector();
    options.setOperationRunning(true);
    options.setErrorMessage(null);
    // A recorded launch whose prompt never started must still settle, otherwise
    // it would look like it is running until the app restarts.
    let launched: string | null = null;
    let unsent: PlanLaunchOutcome = "cancelled";
    try {
      const chosenModel = agent?.modelRef ? parseDesktopModelRef(agent.modelRef) : undefined;
      if (agent?.modelRef && !chosenModel) throw new Error("Launch model must use provider/model[:thinking] format.");
      const created = chosenModel
        ? await client.newSession(workspace, {
            modelRef: chosenModel.modelRef,
            ...(chosenModel.thinking ? { thinkingLevel: chosenModel.thinking } : {}),
          })
        : await client.newSession(workspace);
      if (!current()) {
        options.forgetRuntime(created.sessionId);
        void client.closeSession(created.sessionId).catch(options.reportError);
        return;
      }
      options.activateSession(created.sessionId, workspace, false);
      if (path !== null) {
        options.recordPlanLaunch?.(workspace, created.sessionId, path);
        launched = created.sessionId;
      }
      const active = () => current() && options.activeSessionId() === created.sessionId;
      await options.ensureRuntime(client, created.sessionId, workspace);
      if (!active()) return;
      if (!options.runtimeReady(created.sessionId)) {
        unsent = "failed";
        return;
      }
      // The plan may be deleted while the session starts; never send a prompt
      // that points at a file that no longer exists.
      if (path !== null && options.planAvailable?.(path) === false) {
        unsent = "failed";
        options.setErrorMessage(`Plan ${path} was removed before the run started.`);
        return;
      }
      const base = item.kind === "prompt" ? item.text
        : item.mode === "resume" ? buildProjectPlanResumePrompt(item.path) : buildProjectPlanPrompt(item.path);
      const text = `${agent?.prefix ?? ""}${base}`;
      const messageId = options.appendUserMessage(created.sessionId, text, []);
      await options.scrollToLatest();
      if (!active()) return;
      options.setOperationRunning(false);
      // From here the prompt lifecycle (settled/error hooks) owns the outcome.
      launched = null;
      dispatched = true;
      // Like agent task runs, only preparation is exclusive: the next supervisor
      // start must not wait for this session's whole turn.
      if (agent) actionId = null;
      const promptRun = options.runPrompt(client, created.sessionId, [{ type: "text", text }], [], messageId);
      agent?.started(created.sessionId);
      await promptRun;
      if (current()) void options.refreshSessions();
    } catch (error) {
      unsent = "failed";
      if (current()) options.reportError(error);
      if (agent && !dispatched) throw error;
    } finally {
      if (launched) options.settlePlanLaunch?.(launched, unsent, workspace);
      if (request === owner) {
        if (current()) options.setOperationRunning(false);
        actionId = null;
      }
    }
  }

  function runPlan(path: string, mode: PlanRunMode = "run"): Promise<void> {
    return launch({ kind: "plan", path, mode });
  }

  /** Resolve on prompt dispatch, never on the new session's eventual completion. */
  function startFromAgent(item: AgentSessionItem, signal: AbortSignal, prefix: string, modelRef?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let started = false;
      const target: LaunchItem = item.kind === "plan" ? { ...item, mode: "run" } : item;
      void launch(target, { signal, prefix, ...(modelRef ? { modelRef } : {}), started: (sessionId) => { started = true; resolve(sessionId); } })
        .then(() => {
          if (!started) reject(new Error("Desktop did not start the session (workspace busy, plan missing or launch interrupted)"));
        }, reject);
    });
  }

  return {
    get actionId() { return actionId; },
    runPlan,
    startFromAgent,
    resumePlan: (path: string) => runPlan(path, "resume"),
    reset() { owner += 1; actionId = null; },
  };
}
