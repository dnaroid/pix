import type { ContentBlock } from "@agentclientprotocol/sdk";
import type {
  AcpClient,
  PromptFileImage,
  QueueState,
  QueuedUserMessage,
} from "../lib/acp-client";
import {
  agentControlAllowsAutoQueue,
  type AgentControlState,
} from "../lib/agent-control";

type PromptRuntimeOptions = {
  client: () => AcpClient | null;
  activeSessionId: () => string | null;
  runtimeReady: (sessionId: string) => boolean;
  operationRunning: () => boolean;
  sessionHistoryLoading: () => boolean;
  setErrorMessage: (message: string | null) => void;
  reportError: (error: unknown) => void;
  refreshRuntimeStatus: (sessionId: string) => void | Promise<void>;
  appendQueuedMessage: (sessionId: string, message: QueuedUserMessage) => string;
  bindPromptSessionEntry: (
    sessionId: string,
    transcriptMessageId: string,
    sessionEntryId: string | undefined,
  ) => void;
  finalizeTranscriptActivity: (sessionId: string, endedAtMs: number) => void;
};

export function queuedMessageBlocks(message: QueuedUserMessage): ContentBlock[] {
  return [
    ...(message.promptText ? [{ type: "text" as const, text: message.promptText }] : []),
    ...message.images.map((image) => ({
      type: "image" as const,
      data: image.data,
      mimeType: image.mimeType,
    })),
  ];
}

export function createPromptRuntime(options: PromptRuntimeOptions) {
  let runningSessionIds = $state<Set<string>>(new Set());
  let queueItemsBySession = $state<Map<string, QueueState["items"]>>(new Map());
  let agentControlStates = $state<Map<string, AgentControlState>>(new Map());

  const promptRunsBySessionId = new Map<string, Promise<void>>();
  const promptEndedAtBySessionId = new Map<string, number>();
  const autoFlushInProgress = new Set<string>();

  function isRunning(sessionId: string): boolean {
    return runningSessionIds.has(sessionId);
  }

  function agentState(sessionId: string): AgentControlState {
    return agentControlStates.get(sessionId) ?? "idle";
  }

  function setAgentState(sessionId: string, state: AgentControlState): void {
    const next = new Map(agentControlStates);
    next.set(sessionId, state);
    agentControlStates = next;
  }

  function setRunning(sessionId: string, running: boolean): void {
    const next = new Set(runningSessionIds);
    if (running) next.add(sessionId);
    else next.delete(sessionId);
    runningSessionIds = next;
  }

  function handleQueueState(state: QueueState): void {
    const next = new Map(queueItemsBySession);
    next.set(state.sessionId, [...state.items]);
    queueItemsBySession = next;
    if (!runningSessionIds.has(state.sessionId)) void flushAutoQueue(state.sessionId);
  }

  function handleQueueConsumed(sessionId: string, message: QueuedUserMessage): void {
    options.appendQueuedMessage(sessionId, message);
  }

  async function refreshQueueState(sessionId: string): Promise<void> {
    const requestClient = options.client();
    if (!requestClient || !options.runtimeReady(sessionId)) return;
    try {
      const state = await requestClient.queueState(sessionId);
      if (requestClient !== options.client()) return;
      handleQueueState(state);
    } catch (error) {
      if (requestClient === options.client() && sessionId === options.activeSessionId()) options.reportError(error);
    }
  }

  function runPromptRequest(
    requestClient: AcpClient,
    sessionId: string,
    blocks: ContentBlock[],
    fileImages: readonly PromptFileImage[] = [],
    transcriptMessageId?: string,
  ): Promise<void> {
    if (promptRunsBySessionId.has(sessionId)) {
      return Promise.reject(new Error("A prompt is already running for this conversation."));
    }
    promptEndedAtBySessionId.delete(sessionId);
    setRunning(sessionId, true);
    const branchBefore = transcriptMessageId
      ? requestClient.branchUserMessages(sessionId).catch(() => undefined)
      : Promise.resolve(undefined);
    let tracked!: Promise<void>;
    tracked = (async () => {
      const before = await branchBefore;
      let promptError: unknown;
      try {
        await requestClient.prompt(sessionId, blocks, fileImages);
      } catch (error) {
        promptError = error;
      }
      if (transcriptMessageId && before) {
        const after = await requestClient.branchUserMessages(sessionId).catch(() => undefined);
        if (after) {
          const beforeIds = new Set(before.map((message) => message.entryId));
          const sessionEntryId = after.filter((message) => !beforeIds.has(message.entryId)).at(-1)?.entryId;
          options.bindPromptSessionEntry(sessionId, transcriptMessageId, sessionEntryId);
        }
      }
      if (promptError !== undefined) throw promptError;
    })()
      .finally(() => {
        if (promptRunsBySessionId.get(sessionId) !== tracked) return;
        promptRunsBySessionId.delete(sessionId);
        const endedAtMs = Date.now();
        promptEndedAtBySessionId.set(sessionId, endedAtMs);
        setRunning(sessionId, false);
        options.finalizeTranscriptActivity(sessionId, endedAtMs);
        queueMicrotask(() => void options.refreshRuntimeStatus(sessionId));
        queueMicrotask(() => void flushAutoQueue(sessionId));
      });
    promptRunsBySessionId.set(sessionId, tracked);
    return tracked;
  }

  async function flushAutoQueue(sessionId: string): Promise<void> {
    const requestClient = options.client();
    if (
      !requestClient
      || !options.runtimeReady(sessionId)
      || runningSessionIds.has(sessionId)
      || promptRunsBySessionId.has(sessionId)
      || autoFlushInProgress.has(sessionId)
      || !agentControlAllowsAutoQueue(agentControlStates.get(sessionId))
    ) return;

    autoFlushInProgress.add(sessionId);
    try {
      while (
        requestClient === options.client()
        && options.runtimeReady(sessionId)
        && !runningSessionIds.has(sessionId)
        && agentControlAllowsAutoQueue(agentControlStates.get(sessionId))
      ) {
        const message = await requestClient.takeAutoMessage(sessionId);
        if (!message) return;
        const transcriptMessageId = options.appendQueuedMessage(sessionId, message);
        try {
          await runPromptRequest(requestClient, sessionId, queuedMessageBlocks(message), [], transcriptMessageId);
        } catch (error) {
          await requestClient.queueMessage(
            sessionId,
            queuedMessageBlocks(message),
            message.displayText,
          ).catch(() => undefined);
          throw error;
        }
      }
    } catch (error) {
      if (requestClient === options.client() && sessionId === options.activeSessionId()) options.reportError(error);
    } finally {
      autoFlushInProgress.delete(sessionId);
    }
  }

  async function cancelActivePrompt(): Promise<void> {
    const requestClient = options.client();
    const sessionId = options.activeSessionId();
    if (!requestClient || !sessionId || !runningSessionIds.has(sessionId)) return;
    try {
      await requestClient.cancel(sessionId);
    } catch (error) {
      options.reportError(error);
    }
  }

  async function pauseActiveAgent(): Promise<void> {
    const requestClient = options.client();
    const sessionId = options.activeSessionId();
    if (!requestClient || !sessionId || !options.runtimeReady(sessionId) || !runningSessionIds.has(sessionId)) return;
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
      || runningSessionIds.has(sessionId)
      || (state !== "paused" && state !== "continuable")
    ) return;

    options.setErrorMessage(null);
    promptEndedAtBySessionId.delete(sessionId);
    setAgentState(sessionId, "resuming");
    setRunning(sessionId, true);
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
        const endedAtMs = Date.now();
        promptEndedAtBySessionId.set(sessionId, endedAtMs);
        setRunning(sessionId, false);
        options.finalizeTranscriptActivity(sessionId, endedAtMs);
        queueMicrotask(() => void flushAutoQueue(sessionId));
      }
    }
  }

  function endedAt(sessionId: string): number | undefined {
    return promptEndedAtBySessionId.get(sessionId);
  }

  function clearEndedAt(sessionId: string): void {
    promptEndedAtBySessionId.delete(sessionId);
  }

  function hasPromptRun(sessionId: string): boolean {
    return promptRunsBySessionId.has(sessionId);
  }

  function promptRun(sessionId: string): Promise<void> | undefined {
    return promptRunsBySessionId.get(sessionId);
  }

  function clearSession(sessionId: string): void {
    if (queueItemsBySession.has(sessionId)) {
      const next = new Map(queueItemsBySession);
      next.delete(sessionId);
      queueItemsBySession = next;
    }
    if (agentControlStates.has(sessionId)) {
      const next = new Map(agentControlStates);
      next.delete(sessionId);
      agentControlStates = next;
    }
    if (runningSessionIds.has(sessionId)) {
      const next = new Set(runningSessionIds);
      next.delete(sessionId);
      runningSessionIds = next;
    }
    promptRunsBySessionId.delete(sessionId);
    promptEndedAtBySessionId.delete(sessionId);
    autoFlushInProgress.delete(sessionId);
  }

  function reset(): void {
    runningSessionIds = new Set();
    queueItemsBySession = new Map();
    agentControlStates = new Map();
    promptRunsBySessionId.clear();
    promptEndedAtBySessionId.clear();
    autoFlushInProgress.clear();
  }

  return {
    get runningSessionIds() { return runningSessionIds; },
    get queueItemsBySession() { return queueItemsBySession; },
    get agentControlStates() { return agentControlStates; },
    isRunning,
    agentState,
    setAgentState,
    handleQueueState,
    handleQueueConsumed,
    refreshQueueState,
    runPromptRequest,
    flushAutoQueue,
    cancelActivePrompt,
    pauseActiveAgent,
    continueActiveAgent,
    endedAt,
    clearEndedAt,
    hasPromptRun,
    promptRun,
    clearSession,
    reset,
  };
}
