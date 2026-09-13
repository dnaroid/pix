import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { AcpClient, PromptFileImage } from "../lib/acp-client";
import type { PromptRuntimeOptions } from "./prompt-runtime-options";

type PromptRunLifecycleOptions = Pick<
  PromptRuntimeOptions,
  | "client"
  | "activeSessionId"
  | "reportError"
  | "bindPromptSessionEntry"
  | "finalizeTranscriptActivity"
> & {
  flushAutoQueue: (sessionId: string) => void | Promise<void>;
};

export function createPromptRunLifecycle(options: PromptRunLifecycleOptions) {
  let runningSessionIds = $state<Set<string>>(new Set());
  const promptRunsBySessionId = new Map<string, Promise<void>>();
  const promptEndedAtBySessionId = new Map<string, number>();

  function isRunning(sessionId: string): boolean {
    return runningSessionIds.has(sessionId);
  }

  function setRunning(sessionId: string, running: boolean): void {
    const next = new Set(runningSessionIds);
    if (running) next.add(sessionId);
    else next.delete(sessionId);
    runningSessionIds = next;
  }

  function finishRun(sessionId: string): number {
    const endedAtMs = Date.now();
    promptEndedAtBySessionId.set(sessionId, endedAtMs);
    setRunning(sessionId, false);
    options.finalizeTranscriptActivity(sessionId, endedAtMs);
    return endedAtMs;
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
        finishRun(sessionId);
        queueMicrotask(() => void options.flushAutoQueue(sessionId));
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
  }

  function reset(): void {
    runningSessionIds = new Set();
    promptRunsBySessionId.clear();
    promptEndedAtBySessionId.clear();
  }

  return {
    get runningSessionIds() { return runningSessionIds; },
    isRunning,
    setRunning,
    finishRun,
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
