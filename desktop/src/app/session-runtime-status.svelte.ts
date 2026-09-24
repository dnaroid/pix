import type { ContextUsageStatus, RuntimeStatus, SessionUsageReport } from "../lib/acp-client";
import { parseContextUsageStatus } from "../lib/acp-response-parsers";
import { newerDcpContextMap, parseDcpContextMap } from "../lib/dcp-context-map";
import {
  EMPTY_RUNTIME_STATUS_GENERATIONS,
  beginRuntimeStatusRefresh,
  isLatestRuntimeStatusRefresh,
  mergePushedContextUsage,
  mergePushedDcpTokensSaved,
  mergeRuntimeStatusResponse,
  type RuntimeStatusGenerations,
} from "../lib/runtime-status";
import {
  PIX_CONTEXT_USAGE_CHANNEL,
  PIX_DCP_TOKENS_SAVED_CHANNEL,
  PIX_DCP_CONTEXT_MAP_CHANNEL,
  type SessionStateNotification,
} from "../lib/session-state";
import type { SessionRuntimeStoreOptions } from "./session-runtime-options";

type SessionRuntimeStatusOptions = Pick<SessionRuntimeStoreOptions, "client"> & {
  isReady: (sessionId: string) => boolean;
};

export function createSessionRuntimeStatus(options: SessionRuntimeStatusOptions) {
  let statuses = $state<Map<string, RuntimeStatus>>(new Map());
  let modelUsageRefreshing = $state<Set<string>>(new Set());
  let dcpStatsRefreshing = $state<Set<string>>(new Set());
  let sessionUsageBySession = $state<Map<string, SessionUsageReport>>(new Map());
  let sessionUsageRefreshing = $state<Set<string>>(new Set());
  let sessionUsageFailed = $state<Set<string>>(new Set());

  const statusGenerationsBySession = new Map<string, RuntimeStatusGenerations>();
  const dcpStatsRequestGenerations = new Map<string, number>();
  const sessionUsageRequestGenerations = new Map<string, number>();
  let lifecycleGeneration = 0;

  async function refreshStatus(sessionId: string, refreshModelUsage = false): Promise<void> {
    const requestClient = options.client();
    if (!requestClient || !options.isReady(sessionId)) return;
    const requestLifecycleGeneration = lifecycleGeneration;
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
      if (requestLifecycleGeneration !== lifecycleGeneration || requestClient !== options.client() || !options.isReady(sessionId)) return;
      const merged = mergeRuntimeStatusResponse(
        statuses.get(sessionId),
        next,
        isLatestRuntimeStatusRefresh(
          statusGenerationsBySession.get(sessionId) ?? EMPTY_RUNTIME_STATUS_GENERATIONS,
          request.snapshotGeneration,
          request.quotaGeneration,
        ),
      );
      if (!merged) return;
      const nextStatuses = new Map(statuses);
      nextStatuses.set(sessionId, merged);
      statuses = nextStatuses;
    } catch {
      // Runtime chrome is best-effort. Keep the previous snapshot when the
      // private status request races a session reload or transient transport failure.
    } finally {
      const live = statusGenerationsBySession.get(sessionId);
      if (requestLifecycleGeneration === lifecycleGeneration && requestClient === options.client()
        && request.quotaGeneration !== undefined && live?.quota === request.quotaGeneration) {
        const next = new Set(modelUsageRefreshing);
        next.delete(sessionId);
        modelUsageRefreshing = next;
      }
    }
  }

  function handleSessionState(notification: SessionStateNotification): boolean {
    if (notification.channel === PIX_DCP_CONTEXT_MAP_CHANNEL) {
      if (!options.isReady(notification.sessionId)) return true;
      const incoming = parseDcpContextMap(notification.data);
      const previous = statuses.get(notification.sessionId);
      const dcpContextMap = newerDcpContextMap(previous?.dcpContextMap, incoming);
      if (incoming && dcpContextMap !== incoming) return true;
      const generation = beginRuntimeStatusRefresh(
        statusGenerationsBySession.get(notification.sessionId) ?? EMPTY_RUNTIME_STATUS_GENERATIONS,
        false,
      );
      statusGenerationsBySession.set(notification.sessionId, generation.generations);
      const nextStatuses = new Map(statuses);
      nextStatuses.set(notification.sessionId, {
        ...previous,
        sessionId: notification.sessionId,
        modelUsageRefresh: previous?.modelUsageRefresh ?? "skipped",
        dcpContextMap,
      });
      statuses = nextStatuses;
      return true;
    }
    if (notification.channel === PIX_DCP_TOKENS_SAVED_CHANNEL) {
      if (!options.isReady(notification.sessionId)) return true;
      let tokensSaved: number | undefined;
      if (notification.data !== null) {
        if (
          typeof notification.data !== "number"
          || !Number.isFinite(notification.data)
          || notification.data < 0
        ) return true;
        tokensSaved = Math.round(notification.data);
      }
      // This scalar is sampled at the same model boundary as context usage.
      // Advance the snapshot generation as well so an older runtime_status
      // request cannot overwrite the newer saved-token estimate.
      const generation = beginRuntimeStatusRefresh(
        statusGenerationsBySession.get(notification.sessionId) ?? EMPTY_RUNTIME_STATUS_GENERATIONS,
        false,
      );
      statusGenerationsBySession.set(notification.sessionId, generation.generations);
      const nextStatuses = new Map(statuses);
      nextStatuses.set(
        notification.sessionId,
        mergePushedDcpTokensSaved(statuses.get(notification.sessionId), notification.sessionId, tokensSaved),
      );
      statuses = nextStatuses;
      return true;
    }
    if (notification.channel !== PIX_CONTEXT_USAGE_CHANNEL) return false;
    if (!options.isReady(notification.sessionId)) return true;

    let context: ContextUsageStatus | undefined;
    if (notification.data !== null) {
      try {
        context = parseContextUsageStatus(notification.data);
      } catch {
        return true;
      }
    }

    // A pushed context snapshot is newer than any runtime-status request that
    // started before this notification. Advance only the snapshot generation;
    // an in-flight quota refresh may still merge its quota fields later.
    const generation = beginRuntimeStatusRefresh(
      statusGenerationsBySession.get(notification.sessionId) ?? EMPTY_RUNTIME_STATUS_GENERATIONS,
      false,
    );
    statusGenerationsBySession.set(notification.sessionId, generation.generations);

    const nextStatuses = new Map(statuses);
    nextStatuses.set(
      notification.sessionId,
      mergePushedContextUsage(statuses.get(notification.sessionId), notification.sessionId, context),
    );
    statuses = nextStatuses;
    return true;
  }

  async function refreshDcpStats(sessionId: string): Promise<void> {
    const requestClient = options.client();
    if (!requestClient || !options.isReady(sessionId) || dcpStatsRefreshing.has(sessionId)) return;

    const requestLifecycleGeneration = lifecycleGeneration;
    const generation = (dcpStatsRequestGenerations.get(sessionId) ?? 0) + 1;
    dcpStatsRequestGenerations.set(sessionId, generation);
    const refreshing = new Set(dcpStatsRefreshing);
    refreshing.add(sessionId);
    dcpStatsRefreshing = refreshing;
    try {
      const next = await requestClient.dcpStats(sessionId);
      if (
        requestLifecycleGeneration !== lifecycleGeneration
        || requestClient !== options.client()
        || !options.isReady(sessionId)
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
      if (requestLifecycleGeneration !== lifecycleGeneration || requestClient !== options.client()
        || dcpStatsRequestGenerations.get(sessionId) !== generation) return;
      const next = new Set(dcpStatsRefreshing);
      next.delete(sessionId);
      dcpStatsRefreshing = next;
    }
  }

  async function refreshSessionUsage(sessionId: string): Promise<void> {
    const requestClient = options.client();
    if (!requestClient || !options.isReady(sessionId) || sessionUsageRefreshing.has(sessionId)) return;

    const requestLifecycleGeneration = lifecycleGeneration;
    const generation = (sessionUsageRequestGenerations.get(sessionId) ?? 0) + 1;
    sessionUsageRequestGenerations.set(sessionId, generation);
    const refreshing = new Set(sessionUsageRefreshing);
    refreshing.add(sessionId);
    sessionUsageRefreshing = refreshing;
    if (sessionUsageFailed.has(sessionId)) {
      const nextFailed = new Set(sessionUsageFailed);
      nextFailed.delete(sessionId);
      sessionUsageFailed = nextFailed;
    }
    try {
      const next = await requestClient.sessionUsage(sessionId);
      if (
        requestLifecycleGeneration !== lifecycleGeneration
        || requestClient !== options.client()
        || !options.isReady(sessionId)
        || sessionUsageRequestGenerations.get(sessionId) !== generation
        || next.sessionId !== sessionId
      ) return;
      const nextUsage = new Map(sessionUsageBySession);
      nextUsage.set(sessionId, next.usage);
      sessionUsageBySession = nextUsage;
    } catch {
      if (
        requestLifecycleGeneration === lifecycleGeneration
        && requestClient === options.client()
        && options.isReady(sessionId)
        && sessionUsageRequestGenerations.get(sessionId) === generation
      ) {
        const nextFailed = new Set(sessionUsageFailed);
        nextFailed.add(sessionId);
        sessionUsageFailed = nextFailed;
      }
      // Keep the last successfully loaded snapshot; expose a failed refresh so
      // the UI can distinguish it from runtime warm-up and offer a retry.
    } finally {
      if (requestLifecycleGeneration !== lifecycleGeneration || requestClient !== options.client()
        || sessionUsageRequestGenerations.get(sessionId) !== generation) return;
      const next = new Set(sessionUsageRefreshing);
      next.delete(sessionId);
      sessionUsageRefreshing = next;
    }
  }

  function forget(sessionId: string): void {
    const generations = statusGenerationsBySession.get(sessionId) ?? EMPTY_RUNTIME_STATUS_GENERATIONS;
    // Keep a monotonic tombstone. Deleting this entry would let an old request
    // and a reopened runtime both look like generation one (ABA).
    statusGenerationsBySession.set(sessionId, {
      snapshot: generations.snapshot + 1,
      quota: generations.quota + 1,
    });
    dcpStatsRequestGenerations.set(sessionId, (dcpStatsRequestGenerations.get(sessionId) ?? 0) + 1);
    sessionUsageRequestGenerations.set(sessionId, (sessionUsageRequestGenerations.get(sessionId) ?? 0) + 1);
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
    if (sessionUsageBySession.has(sessionId)) {
      const next = new Map(sessionUsageBySession);
      next.delete(sessionId);
      sessionUsageBySession = next;
    }
    if (sessionUsageRefreshing.has(sessionId)) {
      const next = new Set(sessionUsageRefreshing);
      next.delete(sessionId);
      sessionUsageRefreshing = next;
    }
    if (sessionUsageFailed.has(sessionId)) {
      const next = new Set(sessionUsageFailed);
      next.delete(sessionId);
      sessionUsageFailed = next;
    }
  }

  function reset(): void {
    lifecycleGeneration += 1;
    statusGenerationsBySession.clear();
    dcpStatsRequestGenerations.clear();
    sessionUsageRequestGenerations.clear();
    statuses = new Map();
    modelUsageRefreshing = new Set();
    dcpStatsRefreshing = new Set();
    sessionUsageBySession = new Map();
    sessionUsageRefreshing = new Set();
    sessionUsageFailed = new Set();
  }

  return {
    get statuses() { return statuses; },
    get modelUsageRefreshing() { return modelUsageRefreshing; },
    get dcpStatsRefreshing() { return dcpStatsRefreshing; },
    get sessionUsageBySession() { return sessionUsageBySession; },
    get sessionUsageRefreshing() { return sessionUsageRefreshing; },
    get sessionUsageFailed() { return sessionUsageFailed; },
    handleSessionState,
    refreshStatus,
    refreshDcpStats,
    refreshSessionUsage,
    forget,
    reset,
  };
}

export type SessionRuntimeStatus = ReturnType<typeof createSessionRuntimeStatus>;
