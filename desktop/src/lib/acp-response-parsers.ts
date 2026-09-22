import type {
  ContextUsageStatus,
  ModelUsageLimitWindow,
  ModelUsageRefresh,
  ModelUsageStatus,
  QueuedImage,
  QueuedUserMessage,
  QueueItem,
  QueueSource,
  QueueState,
  RuntimeStatus,
  SessionUsageProvider,
  SessionUsageReport,
  SessionUsageStatus,
  SessionUsageTotals,
} from "./acp-client-types";

import { parseDcpContextMap } from "./dcp-context-map";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRuntimeStatus(value: unknown): RuntimeStatus {
  if (
    !isRecord(value)
    || typeof value.sessionId !== "string"
    || !["skipped", "ready", "unavailable", "failed"].includes(String(value.modelUsageRefresh))
  ) {
    throw new Error("pix/session/runtime_status returned an invalid response");
  }

  const context = value.context === undefined ? undefined : parseContextUsageStatus(value.context);
  const modelUsage = value.modelUsage === undefined ? undefined : parseModelUsageStatus(value.modelUsage);
  const dcpContextMap = parseDcpContextMap(value.dcpContextMap);
  if (
    value.dcpTokensSaved !== undefined
    && (!isFiniteNumber(value.dcpTokensSaved) || value.dcpTokensSaved < 0)
  ) {
    throw new Error("pix/session/runtime_status returned invalid DCP token savings");
  }
  if (value.modelUsageRefresh === "ready" && !modelUsage) {
    throw new Error("pix/session/runtime_status returned ready without model usage");
  }
  return {
    sessionId: value.sessionId,
    ...(dcpContextMap ? { dcpContextMap } : {}),
    ...(context ? { context } : {}),
    ...(typeof value.dcpTokensSaved === "number" ? { dcpTokensSaved: Math.round(value.dcpTokensSaved) } : {}),
    ...(typeof value.dcpStats === "string" ? { dcpStats: value.dcpStats } : {}),
    modelUsageRefresh: value.modelUsageRefresh as ModelUsageRefresh,
    ...(modelUsage ? { modelUsage } : {}),
  };
}

export function parseContextUsageStatus(value: unknown): ContextUsageStatus {
  if (
    !isRecord(value)
    || (value.tokens !== null && !isFiniteNumber(value.tokens))
    || !isFiniteNumber(value.contextWindow)
    || (value.percent !== null && !isFiniteNumber(value.percent))
  ) throw new Error("invalid Pix context usage");
  return {
    tokens: value.tokens === null ? null : Number(value.tokens),
    contextWindow: Number(value.contextWindow),
    percent: value.percent === null ? null : Number(value.percent),
  };
}

export function parseSessionUsageStatus(value: unknown): SessionUsageStatus {
  if (!isRecord(value) || typeof value.sessionId !== "string") {
    throw new Error("pix/session/usage returned an invalid response");
  }
  return { sessionId: value.sessionId, usage: parseSessionUsageReport(value.usage) };
}

function parseSessionUsageReport(value: unknown): SessionUsageReport {
  if (!isRecord(value) || !Array.isArray(value.providers)) throw new Error("invalid Pix session usage");
  return {
    totals: parseSessionUsageTotals(value.totals),
    providers: value.providers.map(parseSessionUsageProvider),
    unattributed: parseSessionUsageTotals(value.unattributed),
  };
}

function parseSessionUsageProvider(value: unknown): SessionUsageProvider {
  if (!isRecord(value) || typeof value.provider !== "string" || !Array.isArray(value.models)) {
    throw new Error("invalid Pix session usage provider");
  }
  return {
    provider: value.provider,
    totals: parseSessionUsageTotals(value.totals),
    models: value.models.map(parseSessionUsageModel),
  };
}

function parseSessionUsageModel(value: unknown): SessionUsageProvider["models"][number] {
  if (!isRecord(value) || typeof value.model !== "string") throw new Error("invalid Pix session usage model");
  return { model: value.model, totals: parseSessionUsageTotals(value.totals) };
}

function parseSessionUsageTotals(value: unknown): SessionUsageTotals {
  if (!isRecord(value)) throw new Error("invalid Pix session usage totals");
  const fields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"] as const;
  if (!fields.every((field) => isFiniteNumber(value[field]) && Number(value[field]) >= 0)) {
    throw new Error("invalid Pix session usage totals");
  }
  return {
    input: Number(value.input), output: Number(value.output), cacheRead: Number(value.cacheRead),
    cacheWrite: Number(value.cacheWrite), totalTokens: Number(value.totalTokens), cost: Number(value.cost),
  };
}

function parseModelUsageStatus(value: unknown): ModelUsageStatus {
  if (
    !isRecord(value)
    || typeof value.modelKey !== "string"
    || !["openai", "zhipu", "google-antigravity"].includes(String(value.provider))
    || !isFiniteNumber(value.updatedAt)
  ) throw new Error("invalid Pix model usage");
  const hourly = value.hourly === undefined ? undefined : parseModelUsageLimitWindow(value.hourly);
  const weekly = value.weekly === undefined ? undefined : parseModelUsageLimitWindow(value.weekly);
  return {
    modelKey: value.modelKey,
    provider: value.provider as ModelUsageStatus["provider"],
    updatedAt: Number(value.updatedAt),
    ...(typeof value.accountEmail === "string" ? { accountEmail: value.accountEmail } : {}),
    ...(hourly ? { hourly } : {}),
    ...(weekly ? { weekly } : {}),
  };
}

function parseModelUsageLimitWindow(value: unknown): ModelUsageLimitWindow {
  if (
    !isRecord(value)
    || !isFiniteNumber(value.remainingPercent)
    || !isFiniteNumber(value.resetAt)
    || !isFiniteNumber(value.windowSeconds)
    || (value.hasKnownWindowDuration !== undefined && typeof value.hasKnownWindowDuration !== "boolean")
  ) throw new Error("invalid Pix model usage window");
  return {
    remainingPercent: Number(value.remainingPercent),
    resetAt: Number(value.resetAt),
    windowSeconds: Number(value.windowSeconds),
    ...(typeof value.hasKnownWindowDuration === "boolean" ? { hasKnownWindowDuration: value.hasKnownWindowDuration } : {}),
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function parseQueueState(value: unknown): QueueState {
  if (!isRecord(value) || typeof value.sessionId !== "string" || !Array.isArray(value.items)) {
    throw new Error("invalid Pix queue state");
  }
  const items: QueueItem[] = [];
  for (const candidate of value.items) {
    if (
      !isRecord(candidate)
      || typeof candidate.id !== "string"
      || !["sdk-steering", "sdk-follow-up", "auto", "deferred"].includes(String(candidate.source))
      || !["steering", "follow-up"].includes(String(candidate.mode))
      || !Number.isSafeInteger(candidate.index)
      || typeof candidate.text !== "string"
    ) throw new Error("invalid Pix queue item");
    const queued = candidate.message === undefined ? undefined : parseQueuedUserMessage(candidate.message);
    if (candidate.message !== undefined && !queued) throw new Error("invalid Pix queued message");
    items.push({
      id: candidate.id,
      source: candidate.source as QueueSource,
      mode: candidate.mode as "steering" | "follow-up",
      index: Number(candidate.index),
      text: candidate.text,
      ...(queued ? { message: queued } : {}),
    });
  }
  return { sessionId: value.sessionId, items };
}

export function parseQueuedUserMessage(value: unknown): QueuedUserMessage | undefined {
  if (
    !isRecord(value)
    || typeof value.id !== "string"
    || typeof value.promptText !== "string"
    || typeof value.displayText !== "string"
    || !Array.isArray(value.images)
  ) return undefined;
  const images: QueuedImage[] = [];
  for (const image of value.images) {
    if (!isRecord(image) || image.type !== "image" || typeof image.data !== "string" || typeof image.mimeType !== "string") return undefined;
    images.push({ type: "image", data: image.data, mimeType: image.mimeType });
  }
  return { id: value.id, promptText: value.promptText, displayText: value.displayText, images };
}
