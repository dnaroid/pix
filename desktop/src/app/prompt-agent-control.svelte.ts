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
  /** Serialize rapid Pause clicks, including undo before the first RPC replies. */
  const pauseToggleQueues = new Map<string, { tail?: Promise<void> }>();
  const stateRevisions = new Map<string, number>();
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
    stateRevisions.set(sessionId, (stateRevisions.get(sessionId) ?? 0) + 1);
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
   * Extension-initiated continuations (timed /wait or question recovery) arrive
   * as an unsolicited "running" state with no Desktop prompt run behind it.
   * Also accept the legacy "resuming" busy signal. Adopt a run so the session shows as
   * running and Stop works, and finish it when the run settles.
   */
  function handleAgentControlStatePush(sessionId: string, state: AgentControlState): void {
    if (localControlRequests.has(sessionId) && !extensionRunGenerations.has(sessionId)) {
      setAgentState(sessionId, state);
      return;
    }
    if ((state === "resuming" || state === "running") && !options.runs.isRunning(sessionId)) {
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
    const runGeneration = options.runs.generation(sessionId);
    const queue = pauseToggleQueues.get(sessionId) ?? {};
    pauseToggleQueues.set(sessionId, queue);
    const isCurrent = () => pauseToggleQueues.get(sessionId) === queue
      && requestClient === options.client() && options.runtimeReady(sessionId)
      && options.runs.generation(sessionId) === runGeneration;

    const toggle = async (): Promise<void> => {
      if (!isCurrent() || !options.runs.isRunning(sessionId)) return;
      const state = agentState(sessionId);
      if (state === "resuming" || state === "paused" || state === "continuable") return;
      const action = state === "pause-requested" ? "cancel-pause" : "pause";
      options.setErrorMessage(null);
      if (action === "pause") setAgentState(sessionId, "pause-requested");
      const revision = stateRevisions.get(sessionId);
      localControlRequests.add(sessionId);
      try {
        const next = await requestClient.agentControl(sessionId, action);
        // A newer push (especially paused/settled) outranks an older RPC reply.
        if (isCurrent() && stateRevisions.get(sessionId) === revision) setAgentState(sessionId, next.state);
      } catch (error) {
        if (isCurrent()) {
          const queryRevision = stateRevisions.get(sessionId);
          const next = await requestClient.agentControl(sessionId, "state").catch(() => undefined);
          if (isCurrent() && stateRevisions.get(sessionId) === queryRevision && next) setAgentState(sessionId, next.state);
          if (isCurrent() && sessionId === options.activeSessionId()) options.reportError(error);
        }
      } finally {
        if (pauseToggleQueues.get(sessionId) === queue) localControlRequests.delete(sessionId);
      }
    };

    const task = queue.tail ? queue.tail.then(toggle) : toggle();
    queue.tail = task;
    await task;
    if (pauseToggleQueues.get(sessionId) === queue && queue.tail === task) pauseToggleQueues.delete(sessionId);
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
    pauseToggleQueues.delete(sessionId);
    stateRevisions.delete(sessionId);
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
    pauseToggleQueues.clear();
    stateRevisions.clear();
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
