import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AcpClient } from "../lib/acp-client";
import type { SessionRuntimeStoreOptions } from "./session-runtime-options";

export function createSessionRuntimeLoading(options: SessionRuntimeStoreOptions) {
  const readySessionIds = new Set<string>();
  const loadsBySessionId = new Map<string, Promise<void>>();
  const loadGenerations = new Map<string, number>();
  const configOptionsBySessionId = new Map<string, SessionConfigOption[]>();
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

    const generation = (loadGenerations.get(sessionId) ?? 0) + 1;
    loadGenerations.set(sessionId, generation);

    const pending = requestClient.loadSession(sessionId, requestWorkspace)
      .then((response) => {
        if (
          requestClient !== options.client()
          || requestWorkspace !== options.workspace()
          || loadGenerations.get(sessionId) !== generation
        ) return;
        const configOptions = response.configOptions ?? [];
        readySessionIds.add(sessionId);
        configOptionsBySessionId.set(sessionId, configOptions);
        void options.refreshQueueState(sessionId);
        if (sessionId === options.activeSessionId()) {
          options.setActiveConfigOptions(configOptions);
          options.setActiveReady(true);
        }
      })
      .catch((error) => {
        if (
          requestClient === options.client()
          && requestWorkspace === options.workspace()
          && loadGenerations.get(sessionId) === generation
          && sessionId === options.activeSessionId()
        ) {
          options.setActiveReady(false);
          options.reportError(error);
        }
      })
      .finally(() => {
        if (loadsBySessionId.get(sessionId) === pending) loadsBySessionId.delete(sessionId);
      });
    loadsBySessionId.set(sessionId, pending);
    return pending;
  }

  function markReady(sessionId: string, configOptions: SessionConfigOption[]): void {
    readySessionIds.add(sessionId);
    configOptionsBySessionId.set(sessionId, configOptions);
    void options.refreshQueueState(sessionId);
    if (sessionId === options.activeSessionId()) options.setActiveReady(true);
  }

  function forget(sessionId: string): void {
    loadGenerations.set(sessionId, (loadGenerations.get(sessionId) ?? 0) + 1);
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
    loadsBySessionId.clear();
    loadGenerations.clear();
    configOptionsBySessionId.clear();
  }

  return {
    isReady,
    isLoading,
    getConfigOptions,
    setConfigOptions,
    ensure,
    markReady,
    forget,
    invalidatePrewarm,
    schedulePrewarm,
    reset,
  };
}

export type SessionRuntimeLoading = ReturnType<typeof createSessionRuntimeLoading>;
