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
  let listRequest: { client: AcpClient; workspace: string; promise: Promise<ListSessionsResponse | null> } | null = null;
  let initialListings = 0;
  let pendingNativeRefresh: { client: AcpClient; workspace: string } | null = null;
  let generation = 0;
  /** Sessions created locally whose ACP record may not be listed yet. */
  const provisionalIds = new Set<string>();

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
    options.tabs.mergeRestored(
      options.workspace(),
      restoredTabSessionIds(response),
      response.sessions.map((session) => session.sessionId),
    );
  }

  async function listAndApply(
    requestClient: AcpClient,
    requestWorkspace: string,
    requestGeneration: number,
  ): Promise<ListSessionsResponse | null> {
    let requestedTabs = options.tabs.sessionTabsForProject(requestWorkspace) ?? [];
    let response = await requestClient.listSessions(requestWorkspace);
    if (!responseIsCurrent(requestClient, requestWorkspace, requestGeneration)) return null;
    const savedTabs = options.tabs.sessionTabsForProject(requestWorkspace) ?? [];
    const available = new Set(response.sessions.map((session) => session.sessionId));
    if (savedTabs.some((id) => !available.has(id))) {
      // A fast map snapshot can precede native discovery. Never persist its
      // omissions as closed tabs before reconciliation succeeds.
      requestedTabs = savedTabs;
      response = await requestClient.listSessions(requestWorkspace, { waitForDiscovery: true });
    }
    if (!responseIsCurrent(requestClient, requestWorkspace, requestGeneration)) return null;

    // The request cannot confirm that tabs opened after it began are gone.
    // Keep their local catalog entries until a later list can reconcile them.
    // A just-created session can be listed before ACP registers its record
    // (lazy runtime start); its tab must survive until a list includes it.
    const requested = new Set(requestedTabs);
    const listed = new Set(response.sessions.map((session) => session.sessionId));
    for (const sessionId of listed) provisionalIds.delete(sessionId);
    const currentTabs = new Set(options.tabs.sessionTabsForProject(requestWorkspace) ?? []);
    const newer = sessions.filter(({ sessionId, cwd }) => cwd === requestWorkspace
      && currentTabs.has(sessionId) && !listed.has(sessionId)
      && (!requested.has(sessionId) || provisionalIds.has(sessionId)));
    const reconciled = newer.length ? { ...response, sessions: [...newer, ...response.sessions] } : response;
    applyResponse(reconciled);
    return reconciled;
  }

  function flushNativeRefresh(): void {
    const pending = pendingNativeRefresh;
    if (!pending || initialListings > 0 || refreshRequest) return;
    pendingNativeRefresh = null;
    if (pending.client === options.client() && pending.workspace === options.workspace()) {
      void refresh();
    }
  }

  function listNow(): Promise<ListSessionsResponse | null> {
    const requestClient = options.client();
    const requestWorkspace = options.workspace();
    if (!requestClient || !requestWorkspace) return Promise.resolve(null);
    const request: NonNullable<typeof listRequest> = {
      client: requestClient,
      workspace: requestWorkspace,
      promise: Promise.resolve(null),
    };
    request.promise = listNowRequest(request);
    listRequest = request;
    return request.promise;
  }

  async function listNowRequest(request: NonNullable<typeof listRequest>): Promise<ListSessionsResponse | null> {
    const { client: requestClient, workspace: requestWorkspace } = request;
    const requestGeneration = ++generation;
    initialListings += 1;
    try {
      return await listAndApply(requestClient, requestWorkspace, requestGeneration);
    } catch (error) {
      if (responseIsCurrent(requestClient, requestWorkspace, requestGeneration)) options.reportError(error);
      return null;
    } finally {
      initialListings -= 1;
      // Clear before flushing so a deferred native refresh issues a new request.
      if (listRequest === request) listRequest = null;
      flushNativeRefresh();
    }
  }

  /** Native discovery can finish before the initial list response is delivered. */
  function nativeCatalogChanged(cwd: string): void {
    const requestClient = options.client();
    if (!requestClient || cwd !== options.workspace()) return;
    if (initialListings > 0 || refreshRequest) {
      pendingNativeRefresh = { client: requestClient, workspace: cwd };
      return;
    }
    void refresh();
  }

  async function refresh(): Promise<void> {
    const requestClient = options.client();
    const requestWorkspace = options.workspace();
    if (!requestClient || !requestWorkspace) return;
    // Startup consumes the initial list response. A refresh started meanwhile
    // (selector open, native discovery) must join it instead of superseding it,
    // otherwise startup sees a stale null and never restores a session.
    const initial = listRequest;
    if (initial && initial.client === requestClient && initial.workspace === requestWorkspace) {
      return initial.promise.then(() => undefined);
    }
    const existing = refreshRequest;
    if (existing && existing.client === requestClient && existing.workspace === requestWorkspace) return existing.promise;
    const requestGeneration = ++generation;
    const promise = listAndApply(requestClient, requestWorkspace, requestGeneration)
      .then(() => undefined)
      .catch((error) => {
        if (!responseIsCurrent(requestClient, requestWorkspace, requestGeneration)) return;
        options.reportError(error);
      })
      .finally(() => {
        if (refreshRequest?.promise === promise) refreshRequest = null;
        flushNativeRefresh();
      });
    refreshRequest = { client: requestClient, workspace: requestWorkspace, promise };
    return promise;
  }

  function ensureProvisional(sessionId: string, cwd: string): void {
    if (sessions.some((session) => session.sessionId === sessionId)) return;
    provisionalIds.add(sessionId);
    sessions = [{ sessionId, cwd, updatedAt: new Date().toISOString() }, ...sessions];
  }

  function remove(sessionId: string): void {
    provisionalIds.delete(sessionId);
    sessions = sessions.filter((session) => session.sessionId !== sessionId);
  }

  function updateInfo(sessionId: string, patch: Partial<Pick<SessionInfo, "cwd" | "title" | "updatedAt">>): void {
    sessions = sessions.map((session) => session.sessionId === sessionId
      ? { ...session, ...patch }
      : session);
  }

  function invalidate(): void {
    generation += 1;
    refreshRequest = null;
    listRequest = null;
    pendingNativeRefresh = null;
  }

  function reset(): void {
    invalidate();
    provisionalIds.clear();
    sessions = [];
  }

  return {
    get sessions() { return sessions; },
    listNow,
    refresh,
    nativeCatalogChanged,
    ensureProvisional,
    remove,
    updateInfo,
    invalidate,
    reset,
  };
}
