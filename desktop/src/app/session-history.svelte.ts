import type { AcpClient } from "../lib/acp-client";
import type { LazySessionHistory } from "../lib/acp-client-types";
import {
  applyDeferredToolResult,
  applySessionUpdates,
  emptyTranscript,
  markDeferredToolResults,
  setToolResultLoading,
  type TranscriptState,
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

export function createSessionHistory(options: SessionHistoryOptions) {
  let loading = $state(false);
  let generation = 0;
  const loadingToolResults = new Set<string>();
  const olderCursorBySessionId = new Map<string, string>();
  const loadingOlderSessionIds = new Set<string>();

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

  async function hydrate(
    requestClient: AcpClient,
    sessionId: string,
    requestWorkspace: string,
    requestGeneration: number,
  ): Promise<void> {
    olderCursorBySessionId.delete(sessionId);
    try {
      const history = await requestClient.sessionHistory(sessionId);
      if (!isCurrent(requestClient, sessionId, requestWorkspace, requestGeneration)) return;
      let loadedTranscript = applySessionUpdates(emptyTranscript, history.updates);
      loadedTranscript = markDeferredToolResults(loadedTranscript, history.deferredToolCallIds);
      if (history.cursor) olderCursorBySessionId.set(sessionId, history.cursor);
      else olderCursorBySessionId.delete(sessionId);

      const currentItems = options.state.transcript.items;
      const nextTranscript = currentItems.length === 0
        ? loadedTranscript
        : { items: [...loadedTranscript.items, ...currentItems] };
      options.state.setTranscript(nextTranscript);
      options.state.setSessionTranscript(sessionId, nextTranscript);
      options.scheduleScrollToLatest();
    } catch (error) {
      if (!isCurrent(requestClient, sessionId, requestWorkspace, requestGeneration)) return;
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes(`session history ${sessionId} is unavailable`)) {
        await options.ensureRuntime(requestClient, sessionId, requestWorkspace);
        if (!isCurrent(requestClient, sessionId, requestWorkspace, requestGeneration)) return;
        if (options.runtimeReady(sessionId)) {
          options.state.setTranscript(emptyTranscript);
          options.state.setSessionTranscript(sessionId, emptyTranscript);
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

  async function loadOlder(): Promise<boolean> {
    const requestClient = options.client();
    const sessionId = options.state.sessionId;
    const requestWorkspace = options.workspace();
    const requestGeneration = generation;
    if (!requestClient || !sessionId || loading || loadingOlderSessionIds.has(sessionId)) return false;

    let cursor: string | undefined = olderCursorBySessionId.get(sessionId);
    if (!cursor) return false;
    loadingOlderSessionIds.add(sessionId);
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
      loadingOlderSessionIds.delete(sessionId);
    }
  }

  async function loadDeferredToolResult(toolCallId: string): Promise<void> {
    const requestClient = options.client();
    const sessionId = options.state.sessionId;
    const requestWorkspace = options.workspace();
    const requestGeneration = generation;
    if (!requestClient || !sessionId) return;
    const key = `${sessionId}\0${toolCallId}`;
    if (loadingToolResults.has(key)) return;
    loadingToolResults.add(key);
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
      loadingToolResults.delete(key);
    }
  }

  function markFullyLoaded(sessionId = options.state.sessionId): void {
    if (sessionId) olderCursorBySessionId.delete(sessionId);
  }

  function reset(): void {
    cancel();
    olderCursorBySessionId.clear();
  }

  return {
    get loading() { return loading; },
    get generation() { return generation; },
    begin,
    cancel,
    isCurrent,
    hydrate,
    loadOlder,
    loadDeferredToolResult,
    markFullyLoaded,
    reset,
  };
}
