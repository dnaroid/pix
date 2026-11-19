import type { ContentBlock } from "@agentclientprotocol/sdk";
import { SUPERVISOR_DIGEST_ID_PREFIX } from "../../../acp/src/acp/supervisor-contract";
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
  /** True while a quota wait holds the session and must not auto-drain. */
  suppressAutoQueue?: (sessionId: string) => boolean;
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
  const autoFlushRequested = new Set<string>();
  const explicitSendHolds = new Map<string, Set<symbol>>();

  /** Hold the idle gap while a selected queued message replaces the current run. */
  function holdAutoQueue(sessionId: string): () => void {
    const holds = explicitSendHolds.get(sessionId) ?? new Set<symbol>();
    const token = Symbol("explicit queued send");
    holds.add(token);
    explicitSendHolds.set(sessionId, holds);
    return () => {
      if (explicitSendHolds.get(sessionId) !== holds || !holds.delete(token)) return;
      if (holds.size > 0) return;
      explicitSendHolds.delete(sessionId);
      void flushAutoQueue(sessionId);
    };
  }

  function handleQueueState(state: QueueState): void {
    const next = new Map(queueItemsBySession);
    next.set(state.sessionId, [...state.items]);
    queueItemsBySession = next;
    if (autoFlushInProgress.has(state.sessionId)) autoFlushRequested.add(state.sessionId);
    else if (!options.isRunning(state.sessionId)) void flushAutoQueue(state.sessionId);
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

  function autoQueueSuppressed(sessionId: string): boolean {
    return explicitSendHolds.has(sessionId)
      || options.suppressAutoQueue?.(sessionId) === true
      || !agentControlAllowsAutoQueue(options.agentState(sessionId));
  }

  async function flushAutoQueue(sessionId: string): Promise<void> {
    const requestClient = options.client();
    if (
      !requestClient
      || !options.runtimeReady(sessionId)
      || options.isRunning(sessionId)
      || options.hasPromptRun(sessionId)
      || autoFlushInProgress.has(sessionId)
      || autoQueueSuppressed(sessionId)
    ) return;

    autoFlushInProgress.add(sessionId);
    try {
      while (
        requestClient === options.client()
        && options.runtimeReady(sessionId)
        && !options.isRunning(sessionId)
        && !autoQueueSuppressed(sessionId)
      ) {
        const message = await requestClient.takeAutoMessage(sessionId);
        if (!message) return;
        const digestId = message.id.startsWith(SUPERVISOR_DIGEST_ID_PREFIX) ? message.id : undefined;
        const blocks = queuedMessageBlocks(message);
        const requeue = () => digestId
          ? requestClient.queueMessage(sessionId, blocks, message.displayText, [], digestId)
          : requestClient.queueMessage(sessionId, blocks, message.displayText);
        if (autoQueueSuppressed(sessionId)) {
          // An explicit send can acquire ownership while this request is in
          // flight. Preserve the removed payload without racing its prompt.
          if (digestId) await requeue();
          else await requestClient.deferMessage(sessionId, blocks, message.displayText);
          return;
        }
        const transcriptMessageId = options.appendQueuedMessage(sessionId, message);
        try {
          await options.runPromptRequest(
            requestClient,
            sessionId,
            blocks,
            [],
            transcriptMessageId,
          );
        } catch (error) {
          await requeue().catch(() => undefined);
          throw error;
        }
      }
    } catch (error) {
      if (requestClient === options.client() && sessionId === options.activeSessionId()) options.reportError(error);
    } finally {
      autoFlushInProgress.delete(sessionId);
      if (autoFlushRequested.delete(sessionId) && requestClient === options.client()) void flushAutoQueue(sessionId);
    }
  }

  function clearSession(sessionId: string): void {
    if (queueItemsBySession.has(sessionId)) {
      const next = new Map(queueItemsBySession);
      next.delete(sessionId);
      queueItemsBySession = next;
    }
    autoFlushInProgress.delete(sessionId);
    autoFlushRequested.delete(sessionId);
    explicitSendHolds.delete(sessionId);
  }

  function reset(): void {
    queueItemsBySession = new Map();
    autoFlushInProgress.clear();
    autoFlushRequested.clear();
    explicitSendHolds.clear();
  }

  return {
    get queueItemsBySession() { return queueItemsBySession; },
    handleQueueState,
    handleQueueConsumed,
    refreshQueueState,
    flushAutoQueue,
    holdAutoQueue,
    clearSession,
    reset,
  };
}

export type PromptQueueRuntime = ReturnType<typeof createPromptQueueRuntime>;
