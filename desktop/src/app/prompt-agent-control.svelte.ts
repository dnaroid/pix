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
  | "onPromptError"
  | "onAgentPaused"
> & {
  runs: PromptRunLifecycle;
};

export function createPromptAgentControl(options: PromptAgentControlOptions) {
  let agentControlStates = $state<Map<string, AgentControlState>>(new Map());
  /** Sessions with a locally initiated pause/continue request in flight. */
  const localControlRequests = new Set<string>();
  /** Run generations adopted from extension-initiated continuations. */
  const extensionRunGenerations = new Map<string, number>();

  function agentState(sessionId: string): AgentControlState {
    return agentControlStates.get(sessionId) ?? "idle";
  }

  function setAgentState(sessionId: string, state: AgentControlState): void {
    const previous = agentControlStates.get(sessionId);
    const next = new Map(agentControlStates);
    next.set(sessionId, state);
    agentControlStates = next;
    if (previous !== undefined && previous !== "paused" && state === "paused") {
      try {
        options.onAgentPaused?.(sessionId);
      } catch {
        // Native attention is best effort and must not affect agent-control state.
      }
    }
  }

  /**
   * Handle an agent-control state pushed by the ACP side.
   *
   * Extension-initiated continuations (for example a timed /wait resuming a
   * paused transcript) arrive as an unsolicited "resuming" state with no
   * Desktop prompt run behind it. Adopt a run so the session shows as
   * running and Stop works, and finish it when the run settles.
   */
  function handleAgentControlStatePush(sessionId: string, state: AgentControlState): void {
    if (localControlRequests.has(sessionId) && !extensionRunGenerations.has(sessionId)) {
      setAgentState(sessionId, state);
      return;
    }
    if (state === "resuming" && !options.runs.isRunning(sessionId)) {
      extensionRunGenerations.set(sessionId, options.runs.beginRun(sessionId));
    } else if (extensionRunGenerations.has(sessionId) && !options.runs.isRunning(sessionId)) {
      finishExtensionRun(sessionId);
    } else if (extensionRunGenerations.has(sessionId)
      && (state === "idle" || state === "paused" || state === "continuable")
      && !options.runs.hasPromptRun(sessionId)) {
      finishExtensionRun(sessionId);
    }
    setAgentState(sessionId, state);
  }

  function finishExtensionRun(sessionId: string): void {
    const generation = extensionRunGenerations.get(sessionId);
    if (generation === undefined) return;
    extensionRunGenerations.delete(sessionId);
    options.runs.finishRunAndFlush(sessionId, generation, undefined);
  }

  async function pauseActiveAgent(): Promise<void> {
    const requestClient = options.client();
    const sessionId = options.activeSessionId();
    if (!requestClient || !sessionId || !options.runtimeReady(sessionId) || !options.runs.isRunning(sessionId)) return;
    const state = agentState(sessionId);
    if (state === "pause-requested" || state === "resuming") return;

    options.setErrorMessage(null);
    setAgentState(sessionId, "pause-requested");
    localControlRequests.add(sessionId);
    try {
      const next = await requestClient.agentControl(sessionId, "pause");
      if (requestClient === options.client() && options.runtimeReady(sessionId)) setAgentState(sessionId, next.state);
    } catch (error) {
      if (requestClient === options.client() && options.runtimeReady(sessionId)) {
        const next = await requestClient.agentControl(sessionId, "state").catch(() => undefined);
        setAgentState(sessionId, next?.state ?? "idle");
        if (sessionId === options.activeSessionId()) options.reportError(error);
      }
    } finally {
      localControlRequests.delete(sessionId);
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
    const runGeneration = options.runs.beginRun(sessionId);
    let stopReason: Awaited<ReturnType<typeof requestClient.agentControl>>["stopReason"];
    localControlRequests.add(sessionId);
    try {
      const next = await requestClient.agentControl(sessionId, "continue");
      stopReason = next.stopReason;
      if (requestClient === options.client() && options.runtimeReady(sessionId)) setAgentState(sessionId, next.state);
    } catch (error) {
      if (requestClient !== options.client()) return;
      if (options.runtimeReady(sessionId)) {
        const next = await requestClient.agentControl(sessionId, "state").catch(() => undefined);
        setAgentState(sessionId, next?.state ?? "idle");
      }
      options.onPromptError?.(sessionId, error);
      if (sessionId === options.activeSessionId()) options.reportError(error);
    } finally {
      localControlRequests.delete(sessionId);
      if (requestClient === options.client()) {
        options.runs.finishRunAndFlush(sessionId, runGeneration, stopReason);
      }
    }
  }

  function clearSession(sessionId: string): void {
    if (!agentControlStates.has(sessionId)) return;
    const next = new Map(agentControlStates);
    next.delete(sessionId);
    agentControlStates = next;
    localControlRequests.delete(sessionId);
    extensionRunGenerations.delete(sessionId);
  }

  function reset(): void {
    agentControlStates = new Map();
    localControlRequests.clear();
    extensionRunGenerations.clear();
  }

  return {
    get agentControlStates() { return agentControlStates; },
    agentState,
    setAgentState,
    handleAgentControlStatePush,
    pauseActiveAgent,
    continueActiveAgent,
    clearSession,
    reset,
  };
}

export type PromptAgentControl = ReturnType<typeof createPromptAgentControl>;
