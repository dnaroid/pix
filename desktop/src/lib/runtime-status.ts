import type { ContextUsageStatus, ModelUsageLimitWindow, ModelUsageStatus, RuntimeStatus } from "./acp-client";
import { newerDcpContextMap } from "./dcp-context-map";

export type UsageTone = "success" | "warning" | "error";

const DAY_SECONDS = 86_400;
const WARNING_MIN_USED_PERCENT = 5;
const WARNING_MIN_ELAPSED_SECONDS = 6 * 3_600;

export function clampUsagePercent(percent: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
}

export function contextUsageTone(percent: number): UsageTone {
  if (percent <= 30) return "success";
  if (percent <= 50) return "warning";
  return "error";
}

export function modelUsageTone(remainingPercent: number): UsageTone {
  if (remainingPercent < 20) return "error";
  if (remainingPercent < 50) return "warning";
  return "success";
}

export function formatResetDuration(resetAt: number, now = Date.now()): string {
  if (resetAt <= now) return "reset";
  const totalMinutes = Math.max(0, Math.ceil((resetAt - now) / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

export function formatCompactTokens(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${trimDecimal(value / 1_000_000)}M`;
  if (abs >= 1_000) return `${trimDecimal(value / 1_000)}K`;
  return Math.round(value).toLocaleString();
}

export function modelUsageWindowWillExhaustBeforeReset(
  window: ModelUsageLimitWindow,
  now = Date.now(),
): boolean {
  if (!window.hasKnownWindowDuration || window.windowSeconds <= DAY_SECONDS || window.remainingPercent <= 0) return false;
  const timeUntilResetSeconds = Math.max(0, (window.resetAt - now) / 1000);
  const elapsedSeconds = Math.max(0, window.windowSeconds - timeUntilResetSeconds);
  if (elapsedSeconds < WARNING_MIN_ELAPSED_SECONDS) return false;
  const used = 100 - window.remainingPercent;
  if (used < WARNING_MIN_USED_PERCENT) return false;
  const averageRate = used / elapsedSeconds;
  return window.remainingPercent / averageRate < timeUntilResetSeconds;
}

export function dcpStatsBody(text: string | undefined): string | undefined {
  const value = text?.trim();
  if (!value) return undefined;
  return value.replace(/^DCP Session Statistics:\s*/i, "").trim();
}

// Snapshot (context/DCP) and quota refreshes count generations independently so
// a non-quota snapshot refresh can never invalidate an in-flight quota refresh.
export interface RuntimeStatusGenerations {
  readonly snapshot: number;
  readonly quota: number;
}

export const EMPTY_RUNTIME_STATUS_GENERATIONS: RuntimeStatusGenerations = {
  snapshot: 0,
  quota: 0,
};

export interface RuntimeStatusRefreshRequest {
  readonly generations: RuntimeStatusGenerations;
  readonly snapshotGeneration: number;
  readonly quotaGeneration?: number;
}

export function beginRuntimeStatusRefresh(
  generations: RuntimeStatusGenerations,
  refreshModelUsage: boolean,
): RuntimeStatusRefreshRequest {
  const snapshot = generations.snapshot + 1;
  const quota = refreshModelUsage ? generations.quota + 1 : generations.quota;
  return {
    generations: { snapshot, quota },
    snapshotGeneration: snapshot,
    ...(refreshModelUsage ? { quotaGeneration: quota } : {}),
  };
}

export function isLatestRuntimeStatusRefresh(
  generations: RuntimeStatusGenerations,
  snapshotGeneration: number,
  quotaGeneration?: number,
): { snapshot: boolean; quotaRefresh: boolean } {
  return {
    snapshot: generations.snapshot === snapshotGeneration,
    quotaRefresh: quotaGeneration !== undefined && generations.quota === quotaGeneration,
  };
}

export interface RuntimeStatusMergeLatest {
  readonly snapshot: boolean;
  readonly quotaRefresh: boolean;
  /**
   * A header-usage push arrived after this quota request started. The reply's
   * quota fields were fetched under the pre-push credential/model, so merging
   * them would let a stale OAuth quota hide the fresh pushed API-key header
   * snapshot after a mid-session auth switch.
   */
  readonly quotaPredatesHeaderPush?: boolean;
}

export function mergeRuntimeStatusResponse(
  previous: RuntimeStatus | undefined,
  next: RuntimeStatus,
  latest: RuntimeStatusMergeLatest,
): RuntimeStatus | undefined {
  if (!latest.snapshot && !latest.quotaRefresh) return previous;
  // A stale request has no safe base to merge into after a forget/reset. In
  // particular, do not recreate a just-forgotten session from its late reply.
  if (!latest.snapshot && !previous) return undefined;
  // Quota fields from a request that predates the newest header-usage push
  // describe the previous credential (OAuth quota after a switch to an API
  // key) and must not claim display precedence over the pushed header sample.
  const quotaRefresh = latest.quotaRefresh && latest.quotaPredatesHeaderPush !== true;
  const snapshot = latest.snapshot ? next : previous!;
  const dcpStats = (latest.snapshot ? next.dcpStats : undefined) ?? previous?.dcpStats;
  // Header-derived usage rides the snapshot; a stale snapshot keeps the last
  // pushed header usage instead of clearing it.
  const headerUsage = latest.snapshot ? next.headerUsage : previous?.headerUsage;
  let modelUsage = previous?.modelUsage ?? snapshot.modelUsage;
  let modelUsageRefresh = snapshot.modelUsageRefresh;
  if (quotaRefresh) {
    modelUsageRefresh = next.modelUsageRefresh;
    if (next.modelUsageRefresh === "ready") modelUsage = next.modelUsage;
    else if (next.modelUsageRefresh === "unavailable") modelUsage = undefined;
  }
  const { modelUsage: _snapshotModelUsage, headerUsage: _snapshotHeaderUsage, dcpStats: _snapshotDcpStats, ...snapshotWithoutModelUsage } = snapshot;
  return {
    ...snapshotWithoutModelUsage,
    dcpContextMap: newerDcpContextMap(previous?.dcpContextMap, snapshot.dcpContextMap),
    modelUsageRefresh,
    ...(dcpStats ? { dcpStats } : {}),
    ...(modelUsage ? { modelUsage } : {}),
    ...(headerUsage ? { headerUsage } : {}),
  };
}

export function mergePushedContextUsage(
  previous: RuntimeStatus | undefined,
  sessionId: string,
  context: ContextUsageStatus | undefined,
): RuntimeStatus {
  const base: RuntimeStatus = previous ?? {
    sessionId,
    modelUsageRefresh: "skipped",
  };
  const { context: _previousContext, ...withoutContext } = base;
  return {
    ...withoutContext,
    sessionId,
    ...(context ? { context } : {}),
  };
}

export function mergePushedDcpTokensSaved(
  previous: RuntimeStatus | undefined,
  sessionId: string,
  tokensSaved: number | undefined,
): RuntimeStatus {
  const base: RuntimeStatus = previous ?? {
    sessionId,
    modelUsageRefresh: "skipped",
  };
  const { dcpTokensSaved: _previousTokensSaved, ...withoutTokensSaved } = base;
  return {
    ...withoutTokensSaved,
    sessionId,
    ...(tokensSaved !== undefined ? { dcpTokensSaved: tokensSaved } : {}),
  };
}

/**
 * Merge a pushed Anthropic API-key header-usage snapshot. Only the
 * header-derived field is replaced; quota `modelUsage` and its refresh state
 * stay untouched so an in-flight quota refresh still merges cleanly.
 */
export function mergePushedModelUsage(
  previous: RuntimeStatus | undefined,
  sessionId: string,
  headerUsage: ModelUsageStatus | undefined,
): RuntimeStatus {
  const base: RuntimeStatus = previous ?? {
    sessionId,
    modelUsageRefresh: "skipped",
  };
  const { headerUsage: _previousHeaderUsage, ...withoutHeaderUsage } = base;
  return {
    ...withoutHeaderUsage,
    sessionId,
    ...(headerUsage ? { headerUsage } : {}),
  };
}

/**
 * The usage source the status bar displays. The provider quota stays
 * authoritative while its refreshes remain the freshest observation (OAuth
 * sessions); an API-key header snapshot newer than the quota sample means the
 * credential switched mid-session — or the quota describes a previous model —
 * so the stale quota must not hide the fresh header snapshot.
 */
export function displayModelUsage(status: RuntimeStatus | undefined): ModelUsageStatus | undefined {
  const quota = status?.modelUsage;
  const header = status?.headerUsage;
  if (!quota || !header) return quota ?? header;
  return header.updatedAt > quota.updatedAt ? header : quota;
}

/** Hard cap for the status-bar account label; long masked keys must stay short. */
export const MODEL_USAGE_ACCOUNT_LABEL_MAX_LENGTH = 16;

/**
 * Short, bounded account label for the compact status bar. Header-derived
 * usage labels (for example masked API keys) can be long; the label is
 * truncated with an ellipsis so the usage windows keep their space.
 */
export function shortModelUsageAccountLabel(
  label: string | undefined,
  maxLength = MODEL_USAGE_ACCOUNT_LABEL_MAX_LENGTH,
): string | undefined {
  const value = label?.trim();
  if (!value) return undefined;
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(1, maxLength - 1))}…`;
}

/** Status-bar window label; short (sub-5-minute) header windows get a "Min" label. */
export function modelUsageWindowLabel(field: "H" | "W" | "R", window: ModelUsageLimitWindow): string {
  if (field === "R") return window.label ?? "Rate";
  if (window.windowSeconds > 0 && window.windowSeconds <= 300) return "Min";
  return field === "H" ? "Hourly" : "Weekly";
}

/**
 * The single most-limiting short rate-limit window (lowest remaining
 * percentage; ties resolved by the earliest reset). Anthropic API-key sessions
 * get one compact indicator instead of parallel RPM/TPM tracks; OAuth quota
 * windows never appear here.
 */
export function limitingRateWindow(status: ModelUsageStatus | undefined): ModelUsageLimitWindow | undefined {
  const windows = status?.rateWindows;
  if (!windows || windows.length === 0) return undefined;
  let limiting = windows[0]!;
  for (const window of windows.slice(1)) {
    if (
      window.remainingPercent < limiting.remainingPercent
      || (window.remainingPercent === limiting.remainingPercent && window.resetAt < limiting.resetAt)
    ) limiting = window;
  }
  return limiting;
}

function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}
