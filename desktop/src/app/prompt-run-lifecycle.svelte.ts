import type { ContentBlock, StopReason } from "@agentclientprotocol/sdk";
import type { AcpClient, PromptFileImage } from "../lib/acp-client";
import type { PromptRuntimeOptions } from "./prompt-runtime-options";

type PromptRunLifecycleOptions = Pick<
  PromptRuntimeOptions,
  | "client"
  | "activeSessionId"
  | "reportError"
  | "bindPromptSessionEntry"
  | "finalizeTranscriptActivity"
  | "onPromptStarted"
  | "onPromptSettled"
  | "onPromptError"
> & {
  flushAutoQueue: (sessionId: string) => void | Promise<void>;
};

export function createPromptRunLifecycle(options: PromptRunLifecycleOptions) {
  let runningSessionIds = $state<Set<string>>(new Set());
  const promptRunsBySessionId = new Map<string, Promise<void>>();
  const promptEndedAtBySessionId = new Map<string, number>();
  const runGenerationBySessionId = new Map<string, number>();

  function isRunning(sessionId: string): boolean {
    return runningSessionIds.has(sessionId);
  }

  function setRunning(sessionId: string, running: boolean): void {
    const next = new Set(runningSessionIds);
    if (running) next.add(sessionId);
    else next.delete(sessionId);
    runningSessionIds = next;
  }

  function beginRun(sessionId: string): number {
    const generation = (runGenerationBySessionId.get(sessionId) ?? 0) + 1;
    runGenerationBySessionId.set(sessionId, generation);
    promptEndedAtBySessionId.delete(sessionId);
    setRunning(sessionId, true);
    options.onPromptStarted?.(sessionId);
    return generation;
  }

  function generation(sessionId: string): number {
    return runGenerationBySessionId.get(sessionId) ?? 0;
  }

  function finishRun(sessionId: string): number {
    const endedAtMs = Date.now();
    promptEndedAtBySessionId.set(sessionId, endedAtMs);
    setRunning(sessionId, false);
    options.finalizeTranscriptActivity(sessionId, endedAtMs);
    return endedAtMs;
  }

  function finishRunAndFlush(
    sessionId: string,
    runGeneration: number,
    stopReason?: StopReason,
  ): void {
    finishRun(sessionId);
    queueMicrotask(() => {
      void Promise.resolve(options.flushAutoQueue(sessionId)).then(() => {
        if (
          stopReason !== undefined
          && generation(sessionId) === runGeneration
          && !isRunning(sessionId)
        ) options.onPromptSettled?.(sessionId, stopReason);
      }).catch(options.reportError);
    });
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
    const runGeneration = beginRun(sessionId);
    const branchBefore = transcriptMessageId
      ? requestClient.branchUserMessages(sessionId).catch(() => undefined)
      : Promise.resolve(undefined);
    let tracked!: Promise<void>;
    let stopReason: StopReason | undefined;
    tracked = (async () => {
      const before = await branchBefore;
      let promptError: unknown;
      try {
        const response = await requestClient.prompt(sessionId, blocks, fileImages);
        stopReason = response.stopReason;
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
      if (promptError !== undefined) {
        options.onPromptError?.(sessionId, promptError);
        throw promptError;
      }
    })()
      .finally(() => {
        if (promptRunsBySessionId.get(sessionId) !== tracked) return;
        promptRunsBySessionId.delete(sessionId);
        finishRunAndFlush(sessionId, runGeneration, stopReason);
      });
    promptRunsBySessionId.set(sessionId, tracked);
    return tracked;
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
    if (runningSessionIds.has(sessionId)) {
      const next = new Set(runningSessionIds);
      next.delete(sessionId);
      runningSessionIds = next;
    }
    promptRunsBySessionId.delete(sessionId);
    promptEndedAtBySessionId.delete(sessionId);
    runGenerationBySessionId.delete(sessionId);
  }

  function reset(): void {
    runningSessionIds = new Set();
    promptRunsBySessionId.clear();
    promptEndedAtBySessionId.clear();
    runGenerationBySessionId.clear();
  }

  return {
    get runningSessionIds() { return runningSessionIds; },
    isRunning,
    setRunning,
    beginRun,
    generation,
    finishRun,
    finishRunAndFlush,
    runPromptRequest,
    cancelActivePrompt,
    endedAt,
    clearEndedAt,
    hasPromptRun,
    promptRun,
    clearSession,
    reset,
  };
}

export type PromptRunLifecycle = ReturnType<typeof createPromptRunLifecycle>;
