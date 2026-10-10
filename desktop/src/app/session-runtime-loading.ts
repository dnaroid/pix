import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AcpClient } from "../lib/acp-client";
import type { SessionRuntimeStoreOptions } from "./session-runtime-options";

export function createSessionRuntimeLoading(options: SessionRuntimeStoreOptions) {
  const readySessionIds = new Set<string>();
  const loadsBySessionId = new Map<string, Promise<void>>();
  const configOptionsBySessionId = new Map<string, SessionConfigOption[]>();
  const ownersBySessionId = new Map<string, object>();
  let prewarmGeneration = 0;

  function isReady(sessionId: string): boolean {
    return readySessionIds.has(sessionId);
  }

  function isLoading(sessionId: string): boolean {
    return loadsBySessionId.has(sessionId);
  }

  function getConfigOptions(sessionId: string): SessionConfigOption[] | undefined {
    return configOptionsBySessionId.get(sessionId);
  }

  function setConfigOptions(sessionId: string, value: SessionConfigOption[]): void {
    configOptionsBySessionId.set(sessionId, value);
    options.onConfigOptions?.(sessionId, value);
    if (sessionId === options.activeSessionId()) options.setActiveConfigOptions(value);
  }

  function ensure(
    requestClient: AcpClient,
    sessionId: string,
    requestWorkspace: string,
  ): Promise<void> {
    if (readySessionIds.has(sessionId)) {
      if (sessionId === options.activeSessionId()) options.setActiveReady(true);
      void options.refreshQueueState(sessionId);
      return Promise.resolve();
    }
    const existing = loadsBySessionId.get(sessionId);
    if (existing) return existing;

    options.onOpen?.(sessionId);
    ownersBySessionId.set(sessionId, {});

    const pending = requestClient.loadSession(sessionId, requestWorkspace)
      .then((response) => {
        if (
          requestClient !== options.client()
          || requestWorkspace !== options.workspace()
          || loadsBySessionId.get(sessionId) !== pending
        ) return;
        const configOptions = response.configOptions ?? [];
        readySessionIds.add(sessionId);
        setConfigOptions(sessionId, configOptions);
        void options.refreshQueueState(sessionId);
        if (sessionId === options.activeSessionId()) {
          options.setActiveReady(true);
        }
      })
      .catch((error) => {
        if (
          requestClient === options.client()
          && requestWorkspace === options.workspace()
          && loadsBySessionId.get(sessionId) === pending
        ) {
          options.onLoadFailed?.(sessionId);
          if (sessionId === options.activeSessionId()) {
            options.setActiveReady(false);
            options.reportError(error);
          }
        }
      })
      .finally(() => {
        if (loadsBySessionId.get(sessionId) === pending) loadsBySessionId.delete(sessionId);
      });
    loadsBySessionId.set(sessionId, pending);
    return pending;
  }

  function markReady(sessionId: string, configOptions: SessionConfigOption[]): void {
    // An externally ready runtime supersedes any outstanding load for this ID.
    loadsBySessionId.delete(sessionId);
    if (!ownersBySessionId.has(sessionId)) ownersBySessionId.set(sessionId, {});
    options.onOpen?.(sessionId);
    readySessionIds.add(sessionId);
    configOptionsBySessionId.set(sessionId, configOptions);
    options.onConfigOptions?.(sessionId, configOptions);
    void options.refreshQueueState(sessionId);
    if (sessionId === options.activeSessionId()) options.setActiveReady(true);
  }

  function forget(sessionId: string): void {
    ownersBySessionId.delete(sessionId);
    readySessionIds.delete(sessionId);
    loadsBySessionId.delete(sessionId);
    configOptionsBySessionId.delete(sessionId);
  }

  function invalidatePrewarm(): void {
    prewarmGeneration += 1;
  }

  function schedulePrewarm(
    requestClient: AcpClient,
    requestWorkspace: string,
    sessionIds: readonly string[],
    limit = 2,
  ): void {
    const generation = ++prewarmGeneration;
    setTimeout(() => {
      void (async () => {
        let warmed = 0;
        for (const sessionId of sessionIds) {
          if (
            generation !== prewarmGeneration
            || requestClient !== options.client()
            || requestWorkspace !== options.workspace()
            || warmed >= limit
          ) return;
          if (readySessionIds.has(sessionId) || loadsBySessionId.has(sessionId)) continue;
          await ensure(requestClient, sessionId, requestWorkspace);
          if (readySessionIds.has(sessionId)) warmed += 1;
        }
      })();
    }, 0);
  }

  function reset(): void {
    invalidatePrewarm();
    readySessionIds.clear();
    ownersBySessionId.clear();
    loadsBySessionId.clear();
    configOptionsBySessionId.clear();
  }

  return {
    get pendingLoadCount() { return loadsBySessionId.size; },
    isReady,
    isLoading,
    getConfigOptions,
    setConfigOptions,
    ensure,
    captureOwnership: (sessionId: string) => {
      const owner = ownersBySessionId.get(sessionId);
      return () => owner !== undefined && ownersBySessionId.get(sessionId) === owner;
    },
    markReady,
    forget,
    invalidatePrewarm,
    schedulePrewarm,
    reset,
  };
}

export type SessionRuntimeLoading = ReturnType<typeof createSessionRuntimeLoading>;
