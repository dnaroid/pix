import {
  isUsageSourceId,
  USAGE_SOURCE_STATUSES,
  USAGE_UNITS,
  type UsageBucket,
  type UsageSessionSummary,
  type UsageSourceSnapshot,
  type UsageStatsChangedNotification,
  type UsageStatsResponse,
  type UsageValues,
} from "../../../acp/src/acp/usage-stats-contract";

const VALUE_KEYS = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens", "calls", "cost"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function invalid(): never {
  throw new Error("pix/usage/stats returned an invalid response");
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : invalid();
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  return isFiniteNonNegative(value) ? value : invalid();
}

function parseValues(value: unknown): UsageValues {
  if (!isRecord(value)) invalid();
  const values: UsageValues = {};
  for (const key of VALUE_KEYS) {
    const number = optionalNumber(value[key]);
    if (number !== undefined) values[key] = number;
  }
  if (value.costEstimated !== undefined) {
    if (typeof value.costEstimated !== "boolean") invalid();
    if (value.costEstimated) values.costEstimated = true;
  }
  return values;
}

function parseBucket(value: unknown): UsageBucket {
  if (!isRecord(value) || !isFiniteNonNegative(value.startMs) || (value.width !== "hour" && value.width !== "day")) invalid();
  if (value.provider !== null && typeof value.provider !== "string") invalid();
  if (value.model !== null && typeof value.model !== "string") invalid();
  const sessionId = optionalString(value.sessionId);
  const projectCwd = optionalString(value.projectCwd);
  return {
    startMs: value.startMs,
    width: value.width,
    provider: value.provider,
    model: value.model,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(projectCwd !== undefined ? { projectCwd } : {}),
    values: parseValues(value.values),
  };
}

function parseSession(value: unknown): UsageSessionSummary {
  if (!isRecord(value) || typeof value.sessionId !== "string" || !isFiniteNonNegative(value.userTurns)) invalid();
  const name = optionalString(value.name);
  const sessionFile = optionalString(value.sessionFile);
  const projectCwd = optionalString(value.projectCwd);
  const firstAtMs = optionalNumber(value.firstAtMs);
  const lastAtMs = optionalNumber(value.lastAtMs);
  return {
    sessionId: value.sessionId,
    userTurns: value.userTurns,
    ...(sessionFile !== undefined ? { sessionFile } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(projectCwd !== undefined ? { projectCwd } : {}),
    ...(firstAtMs !== undefined ? { firstAtMs } : {}),
    ...(lastAtMs !== undefined ? { lastAtMs } : {}),
  };
}

function parseSnapshot(value: Record<string, unknown>): UsageSourceSnapshot {
  if (!isUsageSourceId(value.source)) invalid();
  if (typeof value.status !== "string" || !(USAGE_SOURCE_STATUSES as readonly string[]).includes(value.status)) invalid();
  if (typeof value.unit !== "string" || !(USAGE_UNITS as readonly string[]).includes(value.unit)) invalid();
  if (!Array.isArray(value.buckets) || !isFiniteNonNegative(value.fetchedAtMs)) invalid();
  let coverage: UsageSourceSnapshot["coverage"] = null;
  if (value.coverage !== null) {
    if (!isRecord(value.coverage) || !isFiniteNonNegative(value.coverage.fromMs) || !isFiniteNonNegative(value.coverage.toMs)) invalid();
    coverage = { fromMs: value.coverage.fromMs, toMs: value.coverage.toMs };
  }
  if (value.sessions !== undefined && !Array.isArray(value.sessions)) invalid();
  const skippedFiles = optionalNumber(value.skippedFiles);
  const untimedRecords = optionalNumber(value.untimedRecords);
  const message = optionalString(value.message);
  return {
    source: value.source,
    status: value.status as UsageSourceSnapshot["status"],
    unit: value.unit as UsageSourceSnapshot["unit"],
    coverage,
    buckets: value.buckets.map(parseBucket),
    ...(Array.isArray(value.sessions) ? { sessions: value.sessions.map(parseSession) } : {}),
    fetchedAtMs: value.fetchedAtMs,
    ...(skippedFiles !== undefined ? { skippedFiles } : {}),
    ...(untimedRecords !== undefined ? { untimedRecords } : {}),
    ...(message !== undefined ? { message } : {}),
  };
}

/**
 * Strict structural validation. Snapshots of source ids unknown to this
 * Desktop build are skipped (forward compatibility); any other malformed
 * field rejects the whole response.
 */
export function parseUsageStatsResponse(value: unknown): UsageStatsResponse {
  if (!isRecord(value) || !Array.isArray(value.snapshots)) invalid();
  const snapshots: UsageSourceSnapshot[] = [];
  for (const entry of value.snapshots) {
    if (!isRecord(entry)) invalid();
    if (!isUsageSourceId(entry.source)) continue;
    snapshots.push(parseSnapshot(entry));
  }
  return { snapshots };
}

/** `undefined` for malformed notifications or unknown sources. */
export function parseUsageStatsChangedNotification(value: unknown): UsageStatsChangedNotification | undefined {
  if (!isRecord(value) || !isUsageSourceId(value.source)) return undefined;
  return { source: value.source };
}
