import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AcpClient, RuntimeStatus } from "../lib/acp-client";
import {
  EMPTY_RUNTIME_STATUS_GENERATIONS,
  beginRuntimeStatusRefresh,
  isLatestRuntimeStatusRefresh,
  mergeRuntimeStatusResponse,
  type RuntimeStatusGenerations,
} from "../lib/runtime-status";

type SessionRuntimeStoreOptions = {
  client: () => AcpClient | null;
  workspace: () => string;
  activeSessionId: () => string | null;
  setActiveReady: (ready: boolean) => void;
  setActiveConfigOptions: (options: SessionConfigOption[]) => void;
  refreshQueueState: (sessionId: string) => void | Promise<void>;
  reportError: (error: unknown) => void;
};

export function createSessionRuntimeStore(options: SessionRuntimeStoreOptions) {
  let statuses = $state<Map<string, RuntimeStatus>>(new Map());
  let modelUsageRefreshing = $state<Set<string>>(new Set());
  let dcpStatsRefreshing = $state<Set<string>>(new Set());
  let changingConfig = $state<Map<string, string>>(new Map());

  const readySessionIds = new Set<string>();
  const loadsBySessionId = new Map<string, Promise<void>>();
  const loadGenerations = new Map<string, number>();
  const configOptionsBySessionId = new Map<string, SessionConfigOption[]>();
  const statusGenerationsBySession = new Map<string, RuntimeStatusGenerations>();
  const dcpStatsRequestGenerations = new Map<string, number>();
  const configChangeGenerations = new Map<string, number>();
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
    configChangeGenerations.set(sessionId, (configChangeGenerations.get(sessionId) ?? 0) + 1);
    if (changingConfig.has(sessionId)) {
      const next = new Map(changingConfig);
      next.delete(sessionId);
      changingConfig = next;
    }
    statusGenerationsBySession.delete(sessionId);
    dcpStatsRequestGenerations.set(sessionId, (dcpStatsRequestGenerations.get(sessionId) ?? 0) + 1);
    if (statuses.has(sessionId)) {
      const next = new Map(statuses);
      next.delete(sessionId);
      statuses = next;
    }
    if (modelUsageRefreshing.has(sessionId)) {
      const next = new Set(modelUsageRefreshing);
      next.delete(sessionId);
      modelUsageRefreshing = next;
    }
    if (dcpStatsRefreshing.has(sessionId)) {
      const next = new Set(dcpStatsRefreshing);
      next.delete(sessionId);
      dcpStatsRefreshing = next;
    }
    if (sessionId === options.activeSessionId()) options.setActiveReady(false);
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

  async function refreshStatus(sessionId: string, refreshModelUsage = false): Promise<void> {
    const requestClient = options.client();
    if (!requestClient || !readySessionIds.has(sessionId)) return;
    const request = beginRuntimeStatusRefresh(
      statusGenerationsBySession.get(sessionId) ?? EMPTY_RUNTIME_STATUS_GENERATIONS,
      refreshModelUsage,
    );
    statusGenerationsBySession.set(sessionId, request.generations);

    if (refreshModelUsage) {
      const next = new Set(modelUsageRefreshing);
      next.add(sessionId);
      modelUsageRefreshing = next;
    }

    try {
      const next = await requestClient.runtimeStatus(sessionId, refreshModelUsage);
      if (requestClient !== options.client() || !readySessionIds.has(sessionId)) return;
      const merged = mergeRuntimeStatusResponse(
        statuses.get(sessionId),
        next,
        isLatestRuntimeStatusRefresh(
          statusGenerationsBySession.get(sessionId) ?? EMPTY_RUNTIME_STATUS_GENERATIONS,
          request.snapshotGeneration,
          request.quotaGeneration,
        ),
      );
      const nextStatuses = new Map(statuses);
      nextStatuses.set(sessionId, merged);
      statuses = nextStatuses;
    } catch {
      // Runtime chrome is best-effort. Keep the previous snapshot when the
      // private status request races a session reload or transient transport failure.
    } finally {
      const live = statusGenerationsBySession.get(sessionId);
      if (request.quotaGeneration !== undefined && live?.quota === request.quotaGeneration) {
        const next = new Set(modelUsageRefreshing);
        next.delete(sessionId);
        modelUsageRefreshing = next;
      }
    }
  }

  async function refreshDcpStats(sessionId: string): Promise<void> {
    const requestClient = options.client();
    if (!requestClient || !readySessionIds.has(sessionId) || dcpStatsRefreshing.has(sessionId)) return;

    const generation = (dcpStatsRequestGenerations.get(sessionId) ?? 0) + 1;
    dcpStatsRequestGenerations.set(sessionId, generation);
    const refreshing = new Set(dcpStatsRefreshing);
    refreshing.add(sessionId);
    dcpStatsRefreshing = refreshing;
    try {
      const next = await requestClient.dcpStats(sessionId);
      if (
        requestClient !== options.client()
        || !readySessionIds.has(sessionId)
        || dcpStatsRequestGenerations.get(sessionId) !== generation
      ) return;
      const previous = statuses.get(sessionId);
      if (!previous) return;
      const { dcpStats: _staleDcpStats, ...withoutDcpStats } = previous;
      const nextStatuses = new Map(statuses);
      nextStatuses.set(sessionId, {
        ...withoutDcpStats,
        ...(next.dcpStats ? { dcpStats: next.dcpStats } : {}),
      });
      statuses = nextStatuses;
    } catch {
      // DCP telemetry is best-effort; keep the last successfully loaded snapshot.
    } finally {
      if (dcpStatsRequestGenerations.get(sessionId) !== generation) return;
      const next = new Set(dcpStatsRefreshing);
      next.delete(sessionId);
      dcpStatsRefreshing = next;
    }
  }

  function configChangeInProgress(sessionId: string): boolean {
    return changingConfig.has(sessionId);
  }

  function beginConfigChange(sessionId: string, value: string): number {
    const generation = (configChangeGenerations.get(sessionId) ?? 0) + 1;
    configChangeGenerations.set(sessionId, generation);
    const next = new Map(changingConfig);
    next.set(sessionId, value);
    changingConfig = next;
    return generation;
  }

  function endConfigChange(sessionId: string, generation: number): void {
    if (configChangeGenerations.get(sessionId) !== generation) return;
    const next = new Map(changingConfig);
    next.delete(sessionId);
    changingConfig = next;
  }

  function configChangeIsCurrent(sessionId: string, generation: number): boolean {
    return configChangeGenerations.get(sessionId) === generation;
  }

  function reset(): void {
    invalidatePrewarm();
    readySessionIds.clear();
    loadsBySessionId.clear();
    loadGenerations.clear();
    configOptionsBySessionId.clear();
    statusGenerationsBySession.clear();
    dcpStatsRequestGenerations.clear();
    configChangeGenerations.clear();
    statuses = new Map();
    modelUsageRefreshing = new Set();
    dcpStatsRefreshing = new Set();
    changingConfig = new Map();
    options.setActiveReady(false);
  }

  return {
    get statuses() { return statuses; },
    get modelUsageRefreshing() { return modelUsageRefreshing; },
    get dcpStatsRefreshing() { return dcpStatsRefreshing; },
    get changingConfig() { return changingConfig; },
    isReady,
    isLoading,
    getConfigOptions,
    setConfigOptions,
    ensure,
    markReady,
    forget,
    invalidatePrewarm,
    schedulePrewarm,
    refreshStatus,
    refreshDcpStats,
    configChangeInProgress,
    beginConfigChange,
    endConfigChange,
    configChangeIsCurrent,
    reset,
  };
}
