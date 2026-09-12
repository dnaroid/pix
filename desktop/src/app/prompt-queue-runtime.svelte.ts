import type { ContentBlock } from "@agentclientprotocol/sdk";
import type {
  AcpClient,
  PromptFileImage,
  QueueState,
  QueuedUserMessage,
} from "../lib/acp-client";
import { agentControlAllowsAutoQueue, type AgentControlState } from "../lib/agent-control";
import type { PromptRuntimeOptions } from "./prompt-runtime-options";

type RunPromptRequest = (
  requestClient: AcpClient,
  sessionId: string,
  blocks: ContentBlock[],
  fileImages?: readonly PromptFileImage[],
  transcriptMessageId?: string,
) => Promise<void>;

type PromptQueueRuntimeOptions = Pick<
  PromptRuntimeOptions,
  "client" | "activeSessionId" | "runtimeReady" | "reportError" | "appendQueuedMessage"
> & {
  isRunning: (sessionId: string) => boolean;
  hasPromptRun: (sessionId: string) => boolean;
  runPromptRequest: RunPromptRequest;
  agentState: (sessionId: string) => AgentControlState;
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

export function createPromptQueueRuntime(options: PromptQueueRuntimeOptions) {
  let queueItemsBySession = $state<Map<string, QueueState["items"]>>(new Map());
  const autoFlushInProgress = new Set<string>();

  function handleQueueState(state: QueueState): void {
    const next = new Map(queueItemsBySession);
    next.set(state.sessionId, [...state.items]);
    queueItemsBySession = next;
    if (!options.isRunning(state.sessionId)) void flushAutoQueue(state.sessionId);
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

  async function flushAutoQueue(sessionId: string): Promise<void> {
    const requestClient = options.client();
    if (
      !requestClient
      || !options.runtimeReady(sessionId)
      || options.isRunning(sessionId)
      || options.hasPromptRun(sessionId)
      || autoFlushInProgress.has(sessionId)
      || !agentControlAllowsAutoQueue(options.agentState(sessionId))
    ) return;

    autoFlushInProgress.add(sessionId);
    try {
      while (
        requestClient === options.client()
        && options.runtimeReady(sessionId)
        && !options.isRunning(sessionId)
        && agentControlAllowsAutoQueue(options.agentState(sessionId))
      ) {
        const message = await requestClient.takeAutoMessage(sessionId);
        if (!message) return;
        const transcriptMessageId = options.appendQueuedMessage(sessionId, message);
        try {
          await options.runPromptRequest(
            requestClient,
            sessionId,
            queuedMessageBlocks(message),
            [],
            transcriptMessageId,
          );
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

  function clearSession(sessionId: string): void {
    if (queueItemsBySession.has(sessionId)) {
      const next = new Map(queueItemsBySession);
      next.delete(sessionId);
      queueItemsBySession = next;
    }
    autoFlushInProgress.delete(sessionId);
  }

  function reset(): void {
    queueItemsBySession = new Map();
    autoFlushInProgress.clear();
  }

  return {
    get queueItemsBySession() { return queueItemsBySession; },
    handleQueueState,
    handleQueueConsumed,
    refreshQueueState,
    flushAutoQueue,
    clearSession,
    reset,
  };
}

export type PromptQueueRuntime = ReturnType<typeof createPromptQueueRuntime>;
