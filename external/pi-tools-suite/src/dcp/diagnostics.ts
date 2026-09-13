import type { DcpConfig } from "./config.js";
import { modelKeysFromContext } from "./config.js";
import type { DcpState } from "./state.js";
import { estimateMessageTokens, getActiveSummaryTokenEstimate, resolveContextThresholds } from "./pruner-metadata.js";
import { planDcpBudget } from "./progress-controller.js";

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
    pressure, reason, createdAt: Date.now() };
}
