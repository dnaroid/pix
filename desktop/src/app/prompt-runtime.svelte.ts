import { createPromptAgentControl } from "./prompt-agent-control.svelte";
import { createPromptQueueRuntime, queuedMessageBlocks } from "./prompt-queue-runtime.svelte";
import { createPromptRunLifecycle } from "./prompt-run-lifecycle.svelte";
import type { PromptRuntimeOptions } from "./prompt-runtime-options";

export { queuedMessageBlocks } from "./prompt-queue-runtime.svelte";

export function createPromptRuntime(options: PromptRuntimeOptions) {
  let queue!: ReturnType<typeof createPromptQueueRuntime>;
  let agent!: ReturnType<typeof createPromptAgentControl>;

  const runs = createPromptRunLifecycle({
    client: options.client,
    activeSessionId: options.activeSessionId,
    reportError: options.reportError,
    bindPromptSessionEntry: options.bindPromptSessionEntry,
    finalizeTranscriptActivity: options.finalizeTranscriptActivity,
    onPromptStarted: options.onPromptStarted,
    onPromptSettled: options.onPromptSettled,
    onPromptError: options.onPromptError,
    flushAutoQueue: (sessionId) => queue.flushAutoQueue(sessionId),
  });

  queue = createPromptQueueRuntime({
    client: options.client,
    activeSessionId: options.activeSessionId,
    runtimeReady: options.runtimeReady,
    reportError: options.reportError,
    appendQueuedMessage: options.appendQueuedMessage,
    isRunning: runs.isRunning,
    hasPromptRun: runs.hasPromptRun,
    runPromptRequest: runs.runPromptRequest,
    agentState: (sessionId) => agent.agentState(sessionId),
  });

  agent = createPromptAgentControl({
    client: options.client,
    activeSessionId: options.activeSessionId,
    runtimeReady: options.runtimeReady,
    operationRunning: options.operationRunning,
    setErrorMessage: options.setErrorMessage,
    reportError: options.reportError,
    runs,
  });

  function clearSession(sessionId: string): void {
    queue.clearSession(sessionId);
    agent.clearSession(sessionId);
    runs.clearSession(sessionId);
    options.onSessionCleared?.(sessionId);
  }

  function reset(): void {
    runs.reset();
    queue.reset();
    agent.reset();
    options.onReset?.();
  }

  return {
    get runningSessionIds() { return runs.runningSessionIds; },
    get queueItemsBySession() { return queue.queueItemsBySession; },
    get agentControlStates() { return agent.agentControlStates; },
    isRunning: runs.isRunning,
    agentState: agent.agentState,
    setAgentState: agent.setAgentState,
    handleQueueState: queue.handleQueueState,
    handleQueueConsumed: queue.handleQueueConsumed,
    refreshQueueState: queue.refreshQueueState,
    runPromptRequest: runs.runPromptRequest,
    flushAutoQueue: queue.flushAutoQueue,
    cancelActivePrompt: runs.cancelActivePrompt,
    pauseActiveAgent: agent.pauseActiveAgent,
    continueActiveAgent: agent.continueActiveAgent,
    endedAt: runs.endedAt,
    clearEndedAt: runs.clearEndedAt,
    hasPromptRun: runs.hasPromptRun,
    promptRun: runs.promptRun,
    clearSession,
    reset,
  };
}
