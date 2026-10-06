import type { ContextUsageStatus, RuntimeStatus, SessionUsageReport } from "../lib/acp-client";
import { parseContextUsageStatus, parseModelUsageStatus } from "../lib/acp-response-parsers";
import { newerDcpContextMap, parseDcpContextMap } from "../lib/dcp-context-map";
import {
  EMPTY_RUNTIME_STATUS_GENERATIONS,
  beginRuntimeStatusRefresh,
  isLatestRuntimeStatusRefresh,
  mergeClaudeQuotaRefresh,
  mergePushedContextUsage,
  mergePushedDcpTokensSaved,
  mergePushedModelUsage,
  mergeRuntimeStatusResponse,
  type RuntimeStatusGenerations,
} from "../lib/runtime-status";
import {
  PIX_CONTEXT_USAGE_CHANNEL,
  PIX_DCP_TOKENS_SAVED_CHANNEL,
  PIX_DCP_CONTEXT_MAP_CHANNEL,
  PIX_MODEL_USAGE_CHANNEL,
  type SessionStateNotification,
} from "../lib/session-state";
import type { SessionRuntimeStoreOptions } from "./session-runtime-options";

type SessionRuntimeStatusOptions = Pick<SessionRuntimeStoreOptions, "client"> & {
  isReady: (sessionId: string) => boolean;
};

/**
 * Delay before retrying a quota refresh whose response flagged
 * `modelUsageCredentialPending`: the Claude Code credential was missing, so
 * the retry's provider query reads only local credentials (Keychain /
 * `.credentials.json`) and performs no provider network traffic until Claude
 * Code refreshes its login. The chain stops at the first response that is
 * ready, failed, or unavailable without the flag.
 */
const MODEL_USAGE_CREDENTIAL_RETRY_MS = 60_000;

export function createSessionRuntimeStatus(options: SessionRuntimeStatusOptions) {
  let statuses = $state<Map<string, RuntimeStatus>>(new Map());
  let modelUsageRefreshing = $state<Set<string>>(new Set());
  let dcpStatsRefreshing = $state<Set<string>>(new Set());
  let sessionUsageBySession = $state<Map<string, SessionUsageReport>>(new Map());
  let sessionUsageRefreshing = $state<Set<string>>(new Set());
  let sessionUsageFailed = $state<Set<string>>(new Set());
  let claudeLimitsRefreshing = $state<Set<string>>(new Set());
  let claudeLimitsFailed = $state<Set<string>>(new Set());

  type StatusOwner = {
    generations: RuntimeStatusGenerations;
    dcp: number;
    usage: number;
    claudeLimits: number;
    startupQuotaChecked?: boolean;
    headerPushSnapshotGeneration?: number;
  };
  const owners = new Map<string, StatusOwner>();
  const credentialRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let lifecycleGeneration = 0;

  function ownerFor(sessionId: string): StatusOwner {
    let owner = owners.get(sessionId);
    if (!owner) {
      owner = { generations: EMPTY_RUNTIME_STATUS_GENERATIONS, dcp: 0, usage: 0, claudeLimits: 0 };
      owners.set(sessionId, owner);
    }
    return owner;
  }

  async function refreshStatus(sessionId: string, refreshModelUsage = false): Promise<void> {
    const requestClient = options.client();
    if (!requestClient || !options.isReady(sessionId)) return;
    // A login nudge owns the quota lane until its credential reread
    // completes. Ordinary snapshot updates may still proceed in parallel.
    if (claudeLimitsRefreshing.has(sessionId)) refreshModelUsage = false;
    const requestLifecycleGeneration = lifecycleGeneration;
    const owner = ownerFor(sessionId);
    let startupClaudeNudge = false;
    const request = beginRuntimeStatusRefresh(
      owner.generations,
      refreshModelUsage,
    );
    owner.generations = request.generations;

    if (refreshModelUsage) {
      const next = new Set(modelUsageRefreshing);
      next.add(sessionId);
      modelUsageRefreshing = next;
    }

    try {
      const next = await requestClient.runtimeStatus(sessionId, refreshModelUsage);
      if (requestLifecycleGeneration !== lifecycleGeneration || requestClient !== options.client() || !options.isReady(sessionId) || owners.get(sessionId) !== owner) return;
      // A quota request that started before the newest header-usage push was
      // issued under the previous credential/model; its reply is stale after a
      // mid-session auth switch or model switch and must not override the
      // pushed API-key header snapshot. Evaluated at settlement so pushes that
      // land while the request is in flight count too.
      const quotaPredatesHeaderPush = request.quotaGeneration !== undefined
        && owner.headerPushSnapshotGeneration !== undefined
        && request.snapshotGeneration < owner.headerPushSnapshotGeneration;
      const merged = mergeRuntimeStatusResponse(
        statuses.get(sessionId),
        next,
        {
          ...isLatestRuntimeStatusRefresh(
            owner.generations,
            request.snapshotGeneration,
            request.quotaGeneration,
          ),
          ...(quotaPredatesHeaderPush ? { quotaPredatesHeaderPush: true } : {}),
        },
      );
      if (!merged) return;
      const nextStatuses = new Map(statuses);
      nextStatuses.set(sessionId, merged);
      statuses = nextStatuses;
      // Only an authoritative quota reply may trigger credential recovery.
      // Context pushes do not supersede this lane; newer quota requests do.
      if (
        request.quotaGeneration !== undefined
        && owner.generations.quota === request.quotaGeneration
        && !quotaPredatesHeaderPush
        && next.modelUsageRefresh !== "skipped"
      ) {
        const firstQuotaCheck = !owner.startupQuotaChecked;
        owner.startupQuotaChecked = true;
        if (
          next.modelUsageRefresh === "unavailable"
          && next.modelUsageCredentialPending === true
        ) {
          // ACP sets this flag only for missing Claude Code credentials.
          // Try the existing bounded login nudge once at runtime startup;
          // subsequent polling stays local-only until credentials return.
          startupClaudeNudge = firstQuotaCheck;
          if (!startupClaudeNudge) scheduleModelUsageCredentialRetry(sessionId);
        } else {
          clearModelUsageCredentialRetry(sessionId);
        }
      }
    } catch {
      // Runtime chrome is best-effort. Keep the previous snapshot when the
      // private status request races a session reload or transient transport failure.
    } finally {
      if (requestLifecycleGeneration === lifecycleGeneration && requestClient === options.client()
        && owners.get(sessionId) === owner && request.quotaGeneration !== undefined && owner.generations.quota === request.quotaGeneration) {
        const next = new Set(modelUsageRefreshing);
        next.delete(sessionId);
        modelUsageRefreshing = next;
        // Release the automatic quota busy flag before the nudge takes its
        // own quota generation. Do not await CLI work on the activation path.
        if (startupClaudeNudge) void refreshClaudeLimits(sessionId, true);
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
      const owner = ownerFor(notification.sessionId);
      owner.generations = beginRuntimeStatusRefresh(owner.generations, false).generations;
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
      const owner = ownerFor(notification.sessionId);
      owner.generations = beginRuntimeStatusRefresh(owner.generations, false).generations;
      const nextStatuses = new Map(statuses);
      nextStatuses.set(
        notification.sessionId,
        mergePushedDcpTokensSaved(statuses.get(notification.sessionId), notification.sessionId, tokensSaved),
      );
      statuses = nextStatuses;
      return true;
    }
    if (notification.channel === PIX_MODEL_USAGE_CHANNEL) {
      if (!options.isReady(notification.sessionId)) return true;
      let headerUsage: RuntimeStatus["headerUsage"] = undefined;
      if (notification.data !== null) {
        try {
          headerUsage = parseModelUsageStatus(notification.data);
        } catch {
          return true;
        }
      }
      // A pushed header-usage snapshot is newer than any runtime-status
      // request that started before this notification. Advance only the
      // snapshot generation; header usage lives outside the quota fields, so
      // an in-flight quota refresh may still merge its own results later —
      // unless it started before this push (recorded below), in which case its
      // quota was fetched under the pre-push credential/model.
      const owner = ownerFor(notification.sessionId);
      const pushRequest = beginRuntimeStatusRefresh(owner.generations, false);
      owner.generations = pushRequest.generations;
      // Remember the snapshot generation this push stamped so quota requests
      // that started earlier are recognized as stale when they settle. A
      // clearing push (null data) drops the marker: with no header snapshot,
      // fresh quota replies may merge normally again (OAuth is authoritative).
      if (headerUsage) owner.headerPushSnapshotGeneration = pushRequest.snapshotGeneration;
      else owner.headerPushSnapshotGeneration = undefined;
      const nextStatuses = new Map(statuses);
      nextStatuses.set(
        notification.sessionId,
        mergePushedModelUsage(statuses.get(notification.sessionId), notification.sessionId, headerUsage),
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
    const owner = ownerFor(notification.sessionId);
    owner.generations = beginRuntimeStatusRefresh(owner.generations, false).generations;

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
    const owner = ownerFor(sessionId);
    const generation = ++owner.dcp;
    const refreshing = new Set(dcpStatsRefreshing);
    refreshing.add(sessionId);
    dcpStatsRefreshing = refreshing;
    try {
      const next = await requestClient.dcpStats(sessionId);
      if (
        requestLifecycleGeneration !== lifecycleGeneration
        || requestClient !== options.client()
        || !options.isReady(sessionId)
        || owners.get(sessionId) !== owner || owner.dcp !== generation
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
        || owners.get(sessionId) !== owner || owner.dcp !== generation) return;
      const next = new Set(dcpStatsRefreshing);
      next.delete(sessionId);
      dcpStatsRefreshing = next;
    }
  }

  async function refreshSessionUsage(sessionId: string): Promise<void> {
    const requestClient = options.client();
    if (!requestClient || !options.isReady(sessionId) || sessionUsageRefreshing.has(sessionId)) return;

    const requestLifecycleGeneration = lifecycleGeneration;
    const owner = ownerFor(sessionId);
    const generation = ++owner.usage;
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
        || owners.get(sessionId) !== owner || owner.usage !== generation
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
        && owners.get(sessionId) === owner && owner.usage === generation
      ) {
        const nextFailed = new Set(sessionUsageFailed);
        nextFailed.add(sessionId);
        sessionUsageFailed = nextFailed;
      }
      // Keep the last successfully loaded snapshot; expose a failed refresh so
      // the UI can distinguish it from runtime warm-up and offer a retry.
    } finally {
      if (requestLifecycleGeneration !== lifecycleGeneration || requestClient !== options.client()
        || owners.get(sessionId) !== owner || owner.usage !== generation) return;
      const next = new Set(sessionUsageRefreshing);
      next.delete(sessionId);
      sessionUsageRefreshing = next;
    }
  }

  /**
   * Claude Code quota refresh (popover button or one startup recovery). The
   * request briefly launches the Claude CLI headless on the agent side and
   * can therefore run long; per-session generation guards (owner, lifecycle,
   * client, readiness, and this refresh's own counter) ensure a completion
   * that lands after forget/reset or a superseding refresh can never
   * repopulate another selection's status.
   */
  async function refreshClaudeLimits(sessionId: string, startupRecovery = false): Promise<void> {
    const requestClient = options.client();
    if (!requestClient || !options.isReady(sessionId) || claudeLimitsRefreshing.has(sessionId)) return;

    const requestLifecycleGeneration = lifecycleGeneration;
    const owner = ownerFor(sessionId);
    // An explicit refresh also consumes startup recovery; never follow a
    // manual attempt with another automatic CLI launch for this owner.
    owner.startupQuotaChecked = true;
    const generation = ++owner.claudeLimits;
    // Discard quota responses begun before the login/credential change.
    owner.generations = { ...owner.generations, quota: owner.generations.quota + 1 };
    clearModelUsageCredentialRetry(sessionId);
    const refreshing = new Set(claudeLimitsRefreshing);
    refreshing.add(sessionId);
    claudeLimitsRefreshing = refreshing;
    if (claudeLimitsFailed.has(sessionId)) {
      const nextFailed = new Set(claudeLimitsFailed);
      nextFailed.delete(sessionId);
      claudeLimitsFailed = nextFailed;
    }
    try {
      const next = await requestClient.claudeQuotaRefresh(sessionId);
      if (
        requestLifecycleGeneration !== lifecycleGeneration
        || requestClient !== options.client()
        || !options.isReady(sessionId)
        || owners.get(sessionId) !== owner || owner.claudeLimits !== generation
        || next.sessionId !== sessionId
      ) return;
      const nextStatuses = new Map(statuses);
      nextStatuses.set(sessionId, mergeClaudeQuotaRefresh(statuses.get(sessionId), sessionId, next));
      statuses = nextStatuses;
      if (next.refresh !== "ready" || !next.launched) {
        const nextFailed = new Set(claudeLimitsFailed);
        nextFailed.add(sessionId);
        claudeLimitsFailed = nextFailed;
      }
      // A successful refresh means the credential exists again; the
      // bounded credential-pending retry is no longer needed.
      if (next.modelUsageCredentialPending) scheduleModelUsageCredentialRetry(sessionId);
    } catch {
      if (
        requestLifecycleGeneration === lifecycleGeneration
        && requestClient === options.client()
        && options.isReady(sessionId)
        && owners.get(sessionId) === owner && owner.claudeLimits === generation
      ) {
        const nextFailed = new Set(claudeLimitsFailed);
        nextFailed.add(sessionId);
        claudeLimitsFailed = nextFailed;
        // A rejected startup nudge must not lose the original pending
        // credential retry. It rechecks locally without launching more CLI work.
        if (startupRecovery) scheduleModelUsageCredentialRetry(sessionId);
      }
      // Keep the last successfully merged quota; expose the failure so the
      // popover can offer an explicit retry.
    } finally {
      if (requestLifecycleGeneration === lifecycleGeneration && requestClient === options.client()
        && owners.get(sessionId) === owner && owner.claudeLimits === generation) {
        const next = new Set(claudeLimitsRefreshing);
        next.delete(sessionId);
        claudeLimitsRefreshing = next;
      }
    }
  }

  function scheduleModelUsageCredentialRetry(sessionId: string): void {
    if (credentialRetryTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      credentialRetryTimers.delete(sessionId);
      void refreshStatus(sessionId, true);
    }, MODEL_USAGE_CREDENTIAL_RETRY_MS);
    credentialRetryTimers.set(sessionId, timer);
  }

  function clearModelUsageCredentialRetry(sessionId: string): void {
    const timer = credentialRetryTimers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    credentialRetryTimers.delete(sessionId);
  }

  function forget(sessionId: string): void {
    // Pending continuations retain their owner object; a reopened ID gets a
    // different owner even when its local counters start from one again.
    owners.delete(sessionId);
    clearModelUsageCredentialRetry(sessionId);
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
    if (claudeLimitsRefreshing.has(sessionId)) {
      const next = new Set(claudeLimitsRefreshing);
      next.delete(sessionId);
      claudeLimitsRefreshing = next;
    }
    if (claudeLimitsFailed.has(sessionId)) {
      const next = new Set(claudeLimitsFailed);
      next.delete(sessionId);
      claudeLimitsFailed = next;
    }
  }

  function reset(): void {
    lifecycleGeneration += 1;
    for (const timer of credentialRetryTimers.values()) clearTimeout(timer);
    credentialRetryTimers.clear();
    owners.clear();
    statuses = new Map();
    modelUsageRefreshing = new Set();
    dcpStatsRefreshing = new Set();
    sessionUsageBySession = new Map();
    sessionUsageRefreshing = new Set();
    sessionUsageFailed = new Set();
    claudeLimitsRefreshing = new Set();
    claudeLimitsFailed = new Set();
  }

  return {
    get ownedSessionCount() { return owners.size; },
    get statuses() { return statuses; },
    get modelUsageRefreshing() { return modelUsageRefreshing; },
    get dcpStatsRefreshing() { return dcpStatsRefreshing; },
    get sessionUsageBySession() { return sessionUsageBySession; },
    get sessionUsageRefreshing() { return sessionUsageRefreshing; },
    get sessionUsageFailed() { return sessionUsageFailed; },
    get claudeLimitsRefreshing() { return claudeLimitsRefreshing; },
    get claudeLimitsFailed() { return claudeLimitsFailed; },
    handleSessionState,
    refreshStatus,
    refreshDcpStats,
    refreshSessionUsage,
    refreshClaudeLimits,
    forget,
    reset,
  };
}

export type SessionRuntimeStatus = ReturnType<typeof createSessionRuntimeStatus>;
