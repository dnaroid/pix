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
  canCancelIdle?: (sessionId: string) => boolean;
};

export type PromptRunCompletion = {
  stopReason: StopReason;
  /** False after cancellation, client replacement, teardown, or a newer run. */
  isCurrent: () => boolean;
};

export function createPromptRunLifecycle(options: PromptRunLifecycleOptions) {
  let runningSessionIds = $state<Set<string>>(new Set());
  const promptRunsBySessionId = new Map<string, Promise<void>>();
  const promptEndedAtBySessionId = new Map<string, number>();
  const runGenerationBySessionId = new Map<string, number>();
  const cancellationBySessionId = new Map<string, { requested: boolean }>();
  const cancelSnapshotWaits = new Map<number, () => void>();
  // Never reuse an owner generation after clearSession/reset while old requests settle.
  let nextRunGeneration = 0;

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
    cancellationBySessionId.set(sessionId, { requested: false });
    const generation = ++nextRunGeneration;
    runGenerationBySessionId.set(sessionId, generation);
    promptEndedAtBySessionId.delete(sessionId);
    setRunning(sessionId, true);
    options.onPromptStarted?.(sessionId);
    return generation;
  }

  function generation(sessionId: string): number {
    return runGenerationBySessionId.get(sessionId) ?? 0;
  }

  function isCancellationRequested(sessionId: string): boolean {
    return cancellationState(sessionId)?.requested === true;
  }

  function cancellationState(sessionId: string): { readonly requested: boolean } | undefined {
    return cancellationBySessionId.get(sessionId);
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
    if (generation(sessionId) !== runGeneration) return;
    finishRun(sessionId);
    queueMicrotask(() => {
      if (generation(sessionId) !== runGeneration) return;
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
    onCompletion?: (completion: PromptRunCompletion) => void,
  ): Promise<void> {
    if (promptRunsBySessionId.has(sessionId)) {
      return Promise.reject(new Error("A prompt is already running for this conversation."));
    }
    const runGeneration = beginRun(sessionId);
    const cancellation = cancellationState(sessionId)!;
    const snapshotCancelled = new Promise<undefined>((resolve) => {
      cancelSnapshotWaits.set(runGeneration, () => resolve(undefined));
    });
    const branchBefore = transcriptMessageId
      ? requestClient.branchUserMessages(sessionId).catch(() => undefined)
      : Promise.resolve(undefined);
    let tracked!: Promise<void>;
    let stopReason: StopReason | undefined;
    tracked = (async () => {
      const before = await Promise.race([branchBefore, snapshotCancelled]);
      if (cancellation.requested) {
        stopReason = "cancelled";
        return;
      }
      if (generation(sessionId) !== runGeneration || requestClient !== options.client()) return;
      let promptError: unknown;
      try {
        const response = await requestClient.prompt(sessionId, blocks, fileImages);
        stopReason = response.stopReason;
      } catch (error) {
        promptError = error;
      }
      if (transcriptMessageId && before && !cancellation.requested) {
        const after = await Promise.race([
          requestClient.branchUserMessages(sessionId).catch(() => undefined),
          snapshotCancelled,
        ]);
        if (after && generation(sessionId) === runGeneration && requestClient === options.client()) {
          const beforeIds = new Set(before.map((message) => message.entryId));
          // The submitted prompt is the first new user entry; steering/follow-up
          // entries can be appended before the same prompt request settles.
          const sessionEntryId = after.find((message) => !beforeIds.has(message.entryId))?.entryId;
          options.bindPromptSessionEntry(sessionId, transcriptMessageId, sessionEntryId);
        }
      }
      if (promptError !== undefined) {
        options.onPromptError?.(sessionId, promptError);
        throw promptError;
      }
    })()
      .finally(() => {
        const cancelled = cancellation.requested;
        if (cancelled) stopReason = "cancelled";
        cancelSnapshotWaits.delete(runGeneration);
        if (promptRunsBySessionId.get(sessionId) !== tracked) return;
        promptRunsBySessionId.delete(sessionId);
        finishRunAndFlush(sessionId, runGeneration, stopReason);
        if (stopReason !== undefined) onCompletion?.({
          stopReason,
          isCurrent: () => !cancelled && generation(sessionId) === runGeneration
            && requestClient === options.client(),
        });
      });
    promptRunsBySessionId.set(sessionId, tracked);
    return tracked;
  }

  async function runPromptRequestWithResult(
    requestClient: AcpClient,
    sessionId: string,
    blocks: ContentBlock[],
    transcriptMessageId?: string,
  ): Promise<PromptRunCompletion | undefined> {
    let completion: PromptRunCompletion | undefined;
    await runPromptRequest(requestClient, sessionId, blocks, [], transcriptMessageId,
      (result) => { completion = result; });
    return completion;
  }

  async function cancelActivePrompt(): Promise<void> {
    const requestClient = options.client();
    const sessionId = options.activeSessionId();
    if (!requestClient || !sessionId
      || (!runningSessionIds.has(sessionId) && !options.canCancelIdle?.(sessionId))) return;
    const cancellation = cancellationBySessionId.get(sessionId);
    if (cancellation) cancellation.requested = true;
    else cancellationBySessionId.set(sessionId, { requested: true });
    cancelSnapshotWaits.get(generation(sessionId))?.();
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
    cancelSnapshotWaits.get(generation(sessionId))?.();
    cancelSnapshotWaits.delete(generation(sessionId));
    cancellationBySessionId.delete(sessionId);
    if (runningSessionIds.has(sessionId)) {
      const next = new Set(runningSessionIds);
      next.delete(sessionId);
      runningSessionIds = next;
    }
    promptRunsBySessionId.delete(sessionId);
    promptEndedAtBySessionId.delete(sessionId);
    runGenerationBySessionId.delete(sessionId);
    // Any late result is already invalidated by deleting its generation.
  }

  function reset(): void {
    for (const cancelWait of cancelSnapshotWaits.values()) cancelWait();
    cancelSnapshotWaits.clear();
    runningSessionIds = new Set();
    promptRunsBySessionId.clear();
    promptEndedAtBySessionId.clear();
    runGenerationBySessionId.clear();
    cancellationBySessionId.clear();
  }

  return {
    get runningSessionIds() { return runningSessionIds; },
    isRunning,
    isCancellationRequested,
    cancellationState,
    setRunning,
    beginRun,
    generation,
    finishRun,
    finishRunAndFlush,
    runPromptRequest,
    runPromptRequestWithResult,
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
