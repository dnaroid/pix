import type { ListSessionsResponse, SessionInfo } from "@agentclientprotocol/sdk";
import type { AcpClient } from "../lib/acp-client";
import { restoredTabSessionIds } from "../lib/session-tabs";
import type { createSessionTabsState } from "./session-tabs-state.svelte";

type SessionTabsState = ReturnType<typeof createSessionTabsState>;

type SessionCatalogOptions = {
  client: () => AcpClient | null;
  workspace: () => string;
  tabs: SessionTabsState;
  reportError: (error: unknown) => void;
};

export function createSessionCatalog(options: SessionCatalogOptions) {
  let sessions = $state<SessionInfo[]>([]);
  let refreshRequest: { client: AcpClient; workspace: string; promise: Promise<void> } | null = null;
  let generation = 0;

  function responseIsCurrent(
    requestClient: AcpClient,
    requestWorkspace: string,
    requestGeneration: number,
  ): boolean {
    return requestGeneration === generation
      && requestClient === options.client()
      && requestWorkspace === options.workspace();
  }

  function applyResponse(response: ListSessionsResponse): void {
    sessions = response.sessions;
    options.tabs.mergeRestored(restoredTabSessionIds(response));
  }

  async function listNow(): Promise<ListSessionsResponse | null> {
    const requestClient = options.client();
    const requestWorkspace = options.workspace();
    if (!requestClient || !requestWorkspace) return null;
    const requestGeneration = ++generation;
    try {
      const response = await requestClient.listSessions(requestWorkspace);
      if (!responseIsCurrent(requestClient, requestWorkspace, requestGeneration)) return null;
      applyResponse(response);
      return response;
    } catch (error) {
      if (responseIsCurrent(requestClient, requestWorkspace, requestGeneration)) options.reportError(error);
      return null;
    }
  }

  async function refresh(): Promise<void> {
    const requestClient = options.client();
    const requestWorkspace = options.workspace();
    if (!requestClient || !requestWorkspace) return;
    const existing = refreshRequest;
    if (existing && existing.client === requestClient && existing.workspace === requestWorkspace) return existing.promise;
    const requestGeneration = ++generation;
    const promise = requestClient.listSessions(requestWorkspace)
      .then((response) => {
        if (!responseIsCurrent(requestClient, requestWorkspace, requestGeneration)) return;
        applyResponse(response);
      })
      .catch((error) => {
        if (!responseIsCurrent(requestClient, requestWorkspace, requestGeneration)) return;
        options.reportError(error);
      })
      .finally(() => {
        if (refreshRequest?.promise === promise) refreshRequest = null;
      });
    refreshRequest = { client: requestClient, workspace: requestWorkspace, promise };
    return promise;
  }

  function ensureProvisional(sessionId: string, cwd: string): void {
    if (sessions.some((session) => session.sessionId === sessionId)) return;
    sessions = [{ sessionId, cwd, updatedAt: new Date().toISOString() }, ...sessions];
  }

  function remove(sessionId: string): void {
    sessions = sessions.filter((session) => session.sessionId !== sessionId);
  }

  function updateInfo(sessionId: string, patch: Pick<SessionInfo, "title" | "updatedAt">): void {
    sessions = sessions.map((session) => session.sessionId === sessionId
      ? { ...session, ...patch }
      : session);
  }

  function invalidate(): void {
    generation += 1;
    refreshRequest = null;
  }

  function reset(): void {
    invalidate();
    sessions = [];
  }

  return {
    get sessions() { return sessions; },
    listNow,
    refresh,
    ensureProvisional,
    remove,
    updateInfo,
    invalidate,
    reset,
  };
}
