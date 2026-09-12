import type { AgentControlState } from "../lib/agent-control";
import type { PromptRunLifecycle } from "./prompt-run-lifecycle.svelte";
import type { PromptRuntimeOptions } from "./prompt-runtime-options";

type PromptAgentControlOptions = Pick<
  PromptRuntimeOptions,
  | "client"
  | "activeSessionId"
  | "runtimeReady"
  | "operationRunning"
  | "setErrorMessage"
  | "reportError"
> & {
  runs: PromptRunLifecycle;
  flushAutoQueue: (sessionId: string) => void | Promise<void>;
};

export function createPromptAgentControl(options: PromptAgentControlOptions) {
  let agentControlStates = $state<Map<string, AgentControlState>>(new Map());

  function agentState(sessionId: string): AgentControlState {
    return agentControlStates.get(sessionId) ?? "idle";
  }

  function setAgentState(sessionId: string, state: AgentControlState): void {
    const next = new Map(agentControlStates);
    next.set(sessionId, state);
    agentControlStates = next;
  }

  async function pauseActiveAgent(): Promise<void> {
    const requestClient = options.client();
    const sessionId = options.activeSessionId();
    if (!requestClient || !sessionId || !options.runtimeReady(sessionId) || !options.runs.isRunning(sessionId)) return;
    const state = agentState(sessionId);
    if (state === "pause-requested" || state === "resuming") return;

    options.setErrorMessage(null);
    setAgentState(sessionId, "pause-requested");
    try {
      const next = await requestClient.agentControl(sessionId, "pause");
      if (requestClient === options.client() && options.runtimeReady(sessionId)) setAgentState(sessionId, next.state);
    } catch (error) {
      if (requestClient === options.client() && options.runtimeReady(sessionId)) {
        const next = await requestClient.agentControl(sessionId, "state").catch(() => undefined);
        setAgentState(sessionId, next?.state ?? "idle");
        if (sessionId === options.activeSessionId()) options.reportError(error);
      }
    }
  }

  async function continueActiveAgent(): Promise<void> {
    const requestClient = options.client();
    const sessionId = options.activeSessionId();
    if (!requestClient || !sessionId || !options.runtimeReady(sessionId)) return;
    const state = agentState(sessionId);
    if (
      options.operationRunning()
      || options.runs.isRunning(sessionId)
      || (state !== "paused" && state !== "continuable")
    ) return;

    options.setErrorMessage(null);
    options.runs.clearEndedAt(sessionId);
    setAgentState(sessionId, "resuming");
    options.runs.setRunning(sessionId, true);
    try {
      const next = await requestClient.agentControl(sessionId, "continue");
      if (requestClient === options.client() && options.runtimeReady(sessionId)) setAgentState(sessionId, next.state);
    } catch (error) {
      if (requestClient === options.client() && options.runtimeReady(sessionId)) {
        const next = await requestClient.agentControl(sessionId, "state").catch(() => undefined);
        setAgentState(sessionId, next?.state ?? "idle");
        if (sessionId === options.activeSessionId()) options.reportError(error);
      }
    } finally {
      if (requestClient === options.client()) {
        options.runs.finishRun(sessionId);
        queueMicrotask(() => void options.flushAutoQueue(sessionId));
      }
    }
  }

  function clearSession(sessionId: string): void {
    if (!agentControlStates.has(sessionId)) return;
    const next = new Map(agentControlStates);
    next.delete(sessionId);
    agentControlStates = next;
  }

  function reset(): void {
    agentControlStates = new Map();
  }

  return {
    get agentControlStates() { return agentControlStates; },
    agentState,
    setAgentState,
    pauseActiveAgent,
    continueActiveAgent,
    clearSession,
    reset,
  };
}

export type PromptAgentControl = ReturnType<typeof createPromptAgentControl>;
