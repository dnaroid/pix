import type { ModelUsageLimitWindow, RuntimeStatus } from "./acp-client";

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

export function mergeRuntimeStatusResponse(
  previous: RuntimeStatus | undefined,
  next: RuntimeStatus,
  latest: { snapshot: boolean; quotaRefresh: boolean },
): RuntimeStatus {
  const snapshot = latest.snapshot || !previous ? next : previous;
  const dcpStats = next.dcpStats ?? previous?.dcpStats;
  let modelUsage = previous?.modelUsage ?? snapshot.modelUsage;
  let modelUsageRefresh = snapshot.modelUsageRefresh;
  if (latest.quotaRefresh) {
    modelUsageRefresh = next.modelUsageRefresh;
    if (next.modelUsageRefresh === "ready") modelUsage = next.modelUsage;
    else if (next.modelUsageRefresh === "unavailable") modelUsage = undefined;
  }
  const { modelUsage: _snapshotModelUsage, dcpStats: _snapshotDcpStats, ...snapshotWithoutModelUsage } = snapshot;
  return {
    ...snapshotWithoutModelUsage,
    modelUsageRefresh,
    ...(dcpStats ? { dcpStats } : {}),
    ...(modelUsage ? { modelUsage } : {}),
  };
}

function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}
