import type { AcpClient } from "../lib/acp-client";
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

  function begin(): number {
    loading = true;
    return ++generation;
  }

  function cancel(): void {
    generation += 1;
    loading = false;
    loadingToolResults.clear();
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
    try {
      const history = await requestClient.sessionHistory(sessionId);
      if (!isCurrent(requestClient, sessionId, requestWorkspace, requestGeneration)) return;
      let loadedTranscript = applySessionUpdates(emptyTranscript, history.updates);
      loadedTranscript = markDeferredToolResults(loadedTranscript, history.deferredToolCallIds);

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

  function reset(): void {
    cancel();
  }

  return {
    get loading() { return loading; },
    get generation() { return generation; },
    begin,
    cancel,
    isCurrent,
    hydrate,
    loadDeferredToolResult,
    reset,
  };
}
