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
} from "./acp-client-types";

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
  if (value.modelUsageRefresh === "ready" && !modelUsage) {
    throw new Error("pix/session/runtime_status returned ready without model usage");
  }
  return {
    sessionId: value.sessionId,
    ...(context ? { context } : {}),
    ...(typeof value.dcpStats === "string" ? { dcpStats: value.dcpStats } : {}),
    modelUsageRefresh: value.modelUsageRefresh as ModelUsageRefresh,
    ...(modelUsage ? { modelUsage } : {}),
  };
}

function parseContextUsageStatus(value: unknown): ContextUsageStatus {
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
