import type { DcpConfig } from "./config.js";
import { modelKeysFromContext } from "./config.js";
import type { DcpState } from "./state.js";
import { estimateMessageTokens, getActiveSummaryTokenEstimate, resolveContextThresholds } from "./pruner-metadata.js";
import { planDcpBudget } from "./progress-controller.js";
import type { ProviderEvidenceCompletion } from "./provider-tool-results.js";

function observedCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Final adapter output, not an upstream API-call ledger or a cost estimate.
 * A provider may aggregate internal/recovery calls. Refused correlation must
 * never acquire a request ID merely because it is adjacent in the transcript. */
export function dcpUsageObservation(message: any, completion: ProviderEvidenceCompletion, epoch: string) {
  return {
    scope: "assistant-message-reported",
    firstRequestId: completion.status === "promote" ? `${epoch}:${completion.firstAttemptId}` : null,
    lastRequestId: completion.status === "promote" ? `${epoch}:${completion.lastAttemptId}` : null,
    correlation: completion.status,
    refusalReason: completion.status === "refused" ? completion.reason : null,
    attempts: completion.attempts,
    provider: typeof message.provider === "string" ? message.provider : null,
    model: typeof message.model === "string" ? message.model : null,
    stopReason: typeof message.stopReason === "string" ? message.stopReason : null,
    messageTimestamp: observedCount(message.timestamp),
    input: observedCount(message.usage?.input),
    output: observedCount(message.usage?.output),
    cacheRead: observedCount(message.usage?.cacheRead),
    cacheWrite: observedCount(message.usage?.cacheWrite),
    cacheWrite1h: observedCount(message.usage?.cacheWrite1h),
    totalTokens: observedCount(message.usage?.totalTokens),
  };
}

/** Scalar-only diagnostic snapshot; never stores raw messages or credentials.
 * These records are observational, never journal/recovery authority. */
export function dcpRequestSnapshot(config: DcpConfig, state: DcpState, model: any,
  usage: { tokens?: number | null; contextWindow?: number } | undefined,
  raw: any[], projected: any[], reason: string) {
  const contextWindow = Number.isFinite(model?.contextWindow) && model.contextWindow > 0
    ? model.contextWindow : usage?.contextWindow;
  const rawTokens = raw.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  const projectedTokens = projected.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  const thresholds = resolveContextThresholds(config, modelKeysFromContext({ model } as any), contextWindow);
  const budget = contextWindow ? planDcpBudget({
    providerUsageTokens: usage?.tokens, repoProjectedTokens: projectedTokens, contextWindow,
    reservedOutputTokens: model?.maxTokens ?? 0, reservedToolTokens: 0,
    maxContextPercent: thresholds.maxContextPercent,
    hardContextPercent: config.strategies.emergencyCurrentTurnPruning.hardContextPercent,
    targetContextPercent: Math.min(config.strategies.emergencyCurrentTurnPruning.targetContextPercent, thresholds.maxContextPercent * 0.9),
    summaryBufferEnabled: config.compress.summaryBuffer,
    activeSummaryTokens: getActiveSummaryTokenEstimate(state), summaryBufferMaxBonusRatio: 0.05,
    estimatorMarginTokens: Math.max(256, Math.ceil(contextWindow * 0.0025)),
  }) : undefined;
  const routineTokens = contextWindow ? thresholds.minContextPercent * contextWindow : undefined;
  let pressure = "unknown";
  if (budget && routineTokens !== undefined) {
    pressure = budget.capacityExceeded ? "over capacity" : budget.hardPressure ? "hard" : budget.pressured ? "strong"
      : budget.projectedBeforeTokens > routineTokens ? "routine" : "below routine threshold";
  }
  return { model: model?.provider && model?.id ? `${model.provider}/${model.id}` : undefined,
    contextWindow, rawTokens, projectedTokens, inputCapacityTokens: budget?.inputCapacityTokens,
    reservedOutputTokens: budget?.reservedOutputTokens, routineTokens, strongTokens: budget?.softHeadroomTokens,
    hardTokens: budget?.hardHeadroomTokens, enabled: config.enabled, manualMode: state.manualMode,
    autoEnabled: config.compress.autoCompress.enabled, ignored: state.consecutiveIgnoredNudges,
    routineProjectedTokens: budget?.projectedBeforeTokens ?? projectedTokens,
    routineUsageAdjustmentTokens: 0,
    pressure, reason, createdAt: Date.now() };
}
