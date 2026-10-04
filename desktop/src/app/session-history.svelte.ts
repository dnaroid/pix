import type { AcpClient } from "../lib/acp-client";
import type { LazySessionHistory } from "../lib/acp-client-types";
import {
  applyDeferredToolResult,
  applySessionUpdates,
  emptyTranscript,
  markDeferredToolResults,
  setToolResultLoading,
} from "../lib/transcript";
import type { ActiveSessionState } from "./active-session-state.svelte";

type SessionHistoryOptions = {
  client: () => AcpClient | null;
  state: ActiveSessionState;
  workspace: () => string;
  ensureRuntime: (client: AcpClient, sessionId: string, workspace: string) => Promise<void>;
  runtimeReady: (sessionId: string) => boolean;
  scheduleScrollToLatest: () => void;
  recoverUnavailableSession: (
    client: AcpClient,
    sessionId: string,
    workspace: string,
  ) => void | Promise<void>;
  reportError: (error: unknown) => void;
};

type HistoryRequestOwner = { client: AcpClient; workspace: string; generation: number };

export function createSessionHistory(options: SessionHistoryOptions) {
  let loading = $state(false);
  let generation = 0;
  const loadingToolResults = new Map<string, HistoryRequestOwner>();
  const olderCursorBySessionId = new Map<string, string>();
  const loadingOlderSessionIds = new Map<string, HistoryRequestOwner>();
  const hydrationBySessionId = new Map<string, { promise: Promise<void>; generation: number }>();
  const retainedHydrationBySessionId = new Map<string, number>();
  const backgroundOwners = new Map<string, object>();

  function begin(): number {
    loading = true;
    return ++generation;
  }

  function cancel(): void {
    generation += 1;
    loading = false;
    loadingToolResults.clear();
    loadingOlderSessionIds.clear();
  }

  function isCurrent(
    requestClient: AcpClient,
    sessionId: string,
    requestWorkspace: string,
    requestGeneration: number,
  ): boolean {
    return requestClient === options.client()
      && sessionId === options.state.sessionId
      && requestWorkspace === options.workspace()
      && requestGeneration === generation;
  }

  function hydrate(
    requestClient: AcpClient,
    sessionId: string,
    requestWorkspace: string,
    requestGeneration: number,
  ): Promise<void> {
    retainedHydrationBySessionId.delete(sessionId);
    const pending = hydrateRequest(requestClient, sessionId, requestWorkspace, requestGeneration)
      .finally(() => {
        if (hydrationBySessionId.get(sessionId)?.promise !== pending) return;
        hydrationBySessionId.delete(sessionId);
        retainedHydrationBySessionId.delete(sessionId);
      });
    hydrationBySessionId.set(sessionId, { promise: pending, generation: requestGeneration });
    return pending;
  }

  function isHydrationCurrent(
    requestClient: AcpClient,
    sessionId: string,
    requestWorkspace: string,
    requestGeneration: number,
  ): boolean {
    if (isCurrent(requestClient, sessionId, requestWorkspace, requestGeneration)) return true;
    return requestClient === options.client()
      && requestWorkspace === options.workspace()
      && retainedHydrationBySessionId.get(sessionId) === requestGeneration
      && hydrationBySessionId.get(sessionId)?.generation === requestGeneration;
  }

  function waitForHydration(sessionId: string): Promise<void> {
    const pending = hydrationBySessionId.get(sessionId);
    if (!pending) return Promise.resolve();
    // A captured submit owns this hydration even after another tab is selected.
    // Close/reset/replacement still invalidate it; only selection may outlive it.
    retainedHydrationBySessionId.set(sessionId, pending.generation);
    return pending.promise;
  }

  async function hydrateRequest(
    requestClient: AcpClient,
    sessionId: string,
    requestWorkspace: string,
    requestGeneration: number,
  ): Promise<void> {
    olderCursorBySessionId.delete(sessionId);
    try {
      const history = await requestClient.sessionHistory(sessionId);
      if (!isHydrationCurrent(requestClient, sessionId, requestWorkspace, requestGeneration)) return;
      let loadedTranscript = applySessionUpdates(emptyTranscript, history.updates);
      loadedTranscript = markDeferredToolResults(loadedTranscript, history.deferredToolCallIds);
      if (history.cursor) olderCursorBySessionId.set(sessionId, history.cursor);
      else olderCursorBySessionId.delete(sessionId);

      const currentItems = options.state.transcriptFor(sessionId)?.items ?? [];
      const nextTranscript = currentItems.length === 0
        ? loadedTranscript
        : { items: [...loadedTranscript.items, ...currentItems] };
      options.state.setTranscriptFor(sessionId, nextTranscript);
      if (options.state.sessionId === sessionId) options.scheduleScrollToLatest();
    } catch (error) {
      if (!isCurrent(requestClient, sessionId, requestWorkspace, requestGeneration)) return;
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes(`session history ${sessionId} is unavailable`)) {
        await options.ensureRuntime(requestClient, sessionId, requestWorkspace);
        if (!isCurrent(requestClient, sessionId, requestWorkspace, requestGeneration)) return;
        if (options.runtimeReady(sessionId)) {
          // Input accepted during startup is not history and must survive an
          // empty/unavailable persisted history response.
          options.state.setSessionTranscript(sessionId, options.state.transcript);
          loading = false;
          return;
        }

        cancel();
        await options.recoverUnavailableSession(requestClient, sessionId, requestWorkspace);
        return;
      }
      options.reportError(error);
    } finally {
      if (isCurrent(requestClient, sessionId, requestWorkspace, requestGeneration)) loading = false;
    }
  }

  /** Prime an unopened background fork without disturbing active hydration. */
  async function primeBackground(requestClient: AcpClient, sessionId: string, requestWorkspace: string): Promise<boolean> {
    const owner = {};
    backgroundOwners.set(sessionId, owner);
    try {
      const history = await requestClient.sessionHistory(sessionId);
      if (requestClient !== options.client() || requestWorkspace !== options.workspace()
        || backgroundOwners.get(sessionId) !== owner) return false;
      if (!options.state.sessionTranscript(sessionId)) {
        let transcript = applySessionUpdates(emptyTranscript, history.updates);
        transcript = markDeferredToolResults(transcript, history.deferredToolCallIds);
        if (history.cursor) olderCursorBySessionId.set(sessionId, history.cursor);
        options.state.setSessionTranscript(sessionId, transcript);
      }
      return true;
    } finally {
      if (backgroundOwners.get(sessionId) === owner) backgroundOwners.delete(sessionId);
    }
  }

  async function loadOlder(): Promise<boolean> {
    const requestClient = options.client();
    const sessionId = options.state.sessionId;
    const requestWorkspace = options.workspace();
    const requestGeneration = generation;
    if (!requestClient || !sessionId || loading) return false;
    const pending = loadingOlderSessionIds.get(sessionId);
    if (pending && isCurrent(pending.client, sessionId, pending.workspace, pending.generation)) return false;

    let cursor: string | undefined = olderCursorBySessionId.get(sessionId);
    if (!cursor) return false;
    const owner = { client: requestClient, workspace: requestWorkspace, generation: requestGeneration };
    loadingOlderSessionIds.set(sessionId, owner);
    try {
      while (cursor) {
        const history: LazySessionHistory = await requestClient.sessionHistory(sessionId, false, cursor);
        if (!isCurrent(requestClient, sessionId, requestWorkspace, requestGeneration)) return false;

        const previousCursor: string = cursor;
        cursor = history.cursor;
        if (cursor) olderCursorBySessionId.set(sessionId, cursor);
        else olderCursorBySessionId.delete(sessionId);

        let olderTranscript = applySessionUpdates(emptyTranscript, history.updates);
        olderTranscript = markDeferredToolResults(olderTranscript, history.deferredToolCallIds);
        if (olderTranscript.items.length === 0) {
          if (!cursor || cursor === previousCursor) return false;
          continue;
        }

        const currentTranscript = options.state.transcript;
        const nextTranscript = { items: [...olderTranscript.items, ...currentTranscript.items] };
        options.state.setTranscript(nextTranscript);
        options.state.setSessionTranscript(sessionId, nextTranscript);
        return true;
      }
      return false;
    } catch (error) {
      if (isCurrent(requestClient, sessionId, requestWorkspace, requestGeneration)) options.reportError(error);
      return false;
    } finally {
      if (loadingOlderSessionIds.get(sessionId) === owner) loadingOlderSessionIds.delete(sessionId);
    }
  }

  async function loadDeferredToolResult(toolCallId: string): Promise<void> {
    const requestClient = options.client();
    const sessionId = options.state.sessionId;
    const requestWorkspace = options.workspace();
    const requestGeneration = generation;
    if (!requestClient || !sessionId) return;
    const tool = options.state.transcript.items.find((item) => item.type === "tool" && item.toolCallId === toolCallId);
    if (tool?.type !== "tool" || !tool.deferredResult) return;
    const key = `${sessionId}\0${toolCallId}`;
    const pending = loadingToolResults.get(key);
    if (pending && isCurrent(pending.client, sessionId, pending.workspace, pending.generation)) return;
    const owner = { client: requestClient, workspace: requestWorkspace, generation: requestGeneration };
    loadingToolResults.set(key, owner);
    options.state.setTranscript(setToolResultLoading(options.state.transcript, toolCallId, true));
    try {
      const update = await requestClient.toolResult(sessionId, toolCallId);
      if (!isCurrent(requestClient, sessionId, requestWorkspace, requestGeneration)) return;
      const nextTranscript = applyDeferredToolResult(options.state.transcript, update);
      options.state.setTranscript(nextTranscript);
      options.state.setSessionTranscript(sessionId, nextTranscript);
    } catch (error) {
      if (isCurrent(requestClient, sessionId, requestWorkspace, requestGeneration)) {
        options.state.setTranscript(setToolResultLoading(
          options.state.transcript,
          toolCallId,
          false,
          error instanceof Error ? error.message : String(error),
        ));
      }
    } finally {
      // Cancellation may already have installed a new request with the same key.
      if (loadingToolResults.get(key) === owner) loadingToolResults.delete(key);
    }
  }

  function markFullyLoaded(sessionId = options.state.sessionId): void {
    if (sessionId) olderCursorBySessionId.delete(sessionId);
  }

  function forget(sessionId: string): void {
    backgroundOwners.delete(sessionId);
    retainedHydrationBySessionId.delete(sessionId);
    olderCursorBySessionId.delete(sessionId);
    loadingOlderSessionIds.delete(sessionId);
    for (const key of loadingToolResults.keys()) {
      if (key.startsWith(`${sessionId}\0`)) loadingToolResults.delete(key);
    }
    // Invalidate an active history request even if this ID is reopened before
    // its previous page or hydration completes.
    if (options.state.sessionId === sessionId) cancel();
  }

  function reset(): void {
    backgroundOwners.clear();
    cancel();
    retainedHydrationBySessionId.clear();
    hydrationBySessionId.clear();
    olderCursorBySessionId.clear();
  }

  return {
    get olderCursorCount() { return olderCursorBySessionId.size; },
    get loading() { return loading; },
    get generation() { return generation; },
    begin,
    cancel,
    isCurrent,
    hydrate,
    primeBackground,
    waitForHydration,
    loadOlder,
    loadDeferredToolResult,
    markFullyLoaded,
    forget,
    reset,
  };
}
