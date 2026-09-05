export type DcpProgressPhase =
  | "normal"
  | "pressure"
  | "awaiting_opportunity"
  | "preparing"
  | "committed"
  | "cooldown"
  | "blocked"
  | "degraded";

export type DcpBlockedReason =
  | "live-head-only"
  | "protected-budget-exceeded"
  | "evidence-unknown"
  | "summarizer-unavailable"
  | "non-positive-gain"
  | "missing-source"
  | "budget-exhausted";

export interface DcpBlockedReasonInput {
  pressured: boolean;
  candidateAvailable: boolean;
  messageCandidateCount?: number;
  requiredSavingsTokens?: number;
  capacityExceeded?: boolean;
  emergencyStats?: {
    totalPairs: number;
    eligiblePairs: number;
    eligibleRecoverableTokens: number;
    preservedRecentPairs: number;
    preservedUnseenPairs: number;
    preservedProtectedPairs: number;
  };
}

/**
 * Classify an exhausted E05 planning pass without guessing beyond the facts
 * available from the emergency eligibility analysis. This is deliberately
 * conservative: when a safe body candidate still exists, the controller is
 * waiting for an opportunity rather than terminally blocked.
 */
export function inferDcpBlockedReason(input: DcpBlockedReasonInput): DcpBlockedReason | undefined {
  if (!input.pressured || input.candidateAvailable || (input.messageCandidateCount ?? 0) > 0) return undefined;

  const stats = input.emergencyStats;
  if (!stats || stats.totalPairs === 0) return "live-head-only";

  const requiredSavings = Math.max(0, Math.floor(input.requiredSavingsTokens ?? 0));
  if (
    stats.eligiblePairs > 0 &&
    requiredSavings > 0 &&
    stats.eligibleRecoverableTokens < requiredSavings
  ) {
    return "budget-exhausted";
  }

  if (stats.preservedUnseenPairs > 0 && stats.eligiblePairs === 0) return "evidence-unknown";
  if (
    stats.preservedProtectedPairs > 0 &&
    (stats.eligiblePairs === 0 || input.capacityExceeded === true)
  ) {
    return "protected-budget-exceeded";
  }
  if (stats.preservedRecentPairs >= stats.totalPairs && stats.eligiblePairs === 0) return "live-head-only";
  return "budget-exhausted";
}

export interface DcpProgressInput {
  enabled: boolean;
  autoEnabled: boolean;
  pressure: boolean;
  candidateAvailable: boolean;
  ignoredOpportunities: number;
  patience: number;
  preparing?: boolean;
  justCommitted?: boolean;
  cooldown?: boolean;
  blockedReason?: DcpBlockedReason;
  degradedReason?: string;
}

export interface DcpProgressDecision {
  phase: DcpProgressPhase;
  shouldPrepare: boolean;
  reason: string;
  blockedReason?: DcpBlockedReason;
}

/**
 * Pure E05 progress policy. Runtime hooks own opportunity accounting; this
 * function only maps the current pressure/candidate/budget state to the next
 * observable phase. In particular, context callback count is not an input.
 */
export function decideDcpProgress(input: DcpProgressInput): DcpProgressDecision {
  if (!input.enabled) return { phase: "blocked", shouldPrepare: false, reason: "disabled" };
  if (input.justCommitted) return { phase: "committed", shouldPrepare: false, reason: "committed" };
  if (input.cooldown) return { phase: "cooldown", shouldPrepare: false, reason: "cooldown" };
  if (input.degradedReason) return { phase: "degraded", shouldPrepare: false, reason: input.degradedReason };
  if (input.blockedReason) {
    return {
      phase: "blocked",
      shouldPrepare: false,
      reason: input.blockedReason,
      blockedReason: input.blockedReason,
    };
  }
  if (!input.pressure) return { phase: "normal", shouldPrepare: false, reason: "below-pressure" };
  if (input.preparing) return { phase: "preparing", shouldPrepare: false, reason: "already-preparing" };
  if (!input.autoEnabled) return { phase: "pressure", shouldPrepare: false, reason: "auto-disabled" };
  if (!input.candidateAvailable) {
    return { phase: "awaiting_opportunity", shouldPrepare: false, reason: "no-candidate" };
  }

  const ignored = Math.max(0, Math.floor(input.ignoredOpportunities));
  const patience = Math.max(0, Math.floor(input.patience));
  if (ignored <= patience) {
    return { phase: "awaiting_opportunity", shouldPrepare: false, reason: "below-patience" };
  }
  return { phase: "preparing", shouldPrepare: true, reason: "ignored-opportunities" };
}

export type DcpBudgetProjectionOrigin = "repo-fallback" | "provider-native" | "repo-over-provider";

export interface DcpBudgetInput {
  providerUsageTokens?: number | null;
  repoProjectedTokens: number;
  contextWindow: number;
  reservedOutputTokens?: number;
  reservedToolTokens?: number;
  maxContextPercent: number;
  hardContextPercent: number;
  targetContextPercent?: number;
  summaryBufferEnabled?: boolean;
  activeSummaryTokens?: number;
  summaryBufferMaxBonusRatio?: number;
  estimatorMarginTokens?: number;
}

export interface DcpBudgetPlan {
  projectedBeforeTokens: number;
  projectionOrigin: DcpBudgetProjectionOrigin;
  contextWindow: number;
  reservedOutputTokens: number;
  reservedToolTokens: number;
  inputCapacityTokens: number;
  summaryBufferTokensApplied: number;
  softHeadroomTokens: number;
  hardHeadroomTokens: number;
  targetHeadroomTokens: number;
  requiredSavingsTokens: number;
  pressured: boolean;
  hardPressure: boolean;
  capacityExceeded: boolean;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function clampFraction(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

/**
 * Pure E05 budget planner. Provider-native usage is useful evidence but may be
 * stale between completed requests, so the fresh repo projection is always a
 * lower bound. Capacity is distinct from policy thresholds and explicitly
 * reserves output/tool budget. `summaryBuffer` may relax the soft policy only
 * inside that hard capacity.
 */
export function planDcpBudget(input: DcpBudgetInput): DcpBudgetPlan {
  const contextWindow = Math.max(1, Math.floor(finiteNonNegative(input.contextWindow) ?? 1));
  const repoProjectedTokens = Math.floor(finiteNonNegative(input.repoProjectedTokens) ?? 0);
  const providerUsageTokens = finiteNonNegative(input.providerUsageTokens);
  const projectedBeforeTokens = Math.max(repoProjectedTokens, Math.floor(providerUsageTokens ?? 0));
  const projectionOrigin: DcpBudgetProjectionOrigin = providerUsageTokens === undefined
    ? "repo-fallback"
    : repoProjectedTokens > providerUsageTokens
      ? "repo-over-provider"
      : "provider-native";

  const reservedOutputTokens = Math.min(
    contextWindow,
    Math.floor(finiteNonNegative(input.reservedOutputTokens) ?? 0),
  );
  const reservedToolTokens = Math.min(
    Math.max(0, contextWindow - reservedOutputTokens),
    Math.floor(finiteNonNegative(input.reservedToolTokens) ?? 0),
  );
  const inputCapacityTokens = Math.max(0, contextWindow - reservedOutputTokens - reservedToolTokens);

  const baseSoftHeadroom = Math.min(
    inputCapacityTokens,
    Math.floor(clampFraction(input.maxContextPercent) * contextWindow),
  );
  const summaryBufferCap = Math.floor(
    clampFraction(input.summaryBufferMaxBonusRatio ?? 0.05) * contextWindow,
  );
  const requestedSummaryBuffer = input.summaryBufferEnabled
    ? Math.floor(finiteNonNegative(input.activeSummaryTokens) ?? 0)
    : 0;
  const summaryBufferTokensApplied = Math.min(
    requestedSummaryBuffer,
    summaryBufferCap,
    Math.max(0, inputCapacityTokens - baseSoftHeadroom),
  );
  const softHeadroomTokens = baseSoftHeadroom + summaryBufferTokensApplied;
  const hardHeadroomTokens = Math.min(
    inputCapacityTokens,
    Math.floor(clampFraction(input.hardContextPercent) * contextWindow),
  );
  const capacityExceeded = projectedBeforeTokens > inputCapacityTokens;
  const hardPressure = capacityExceeded || projectedBeforeTokens > hardHeadroomTokens;
  const pressured = hardPressure || projectedBeforeTokens > softHeadroomTokens;

  const configuredTarget = clampFraction(input.targetContextPercent ?? input.maxContextPercent);
  const recoveryHeadroom = Math.min(
    inputCapacityTokens,
    softHeadroomTokens,
    Math.floor(configuredTarget * contextWindow),
  );
  const targetHeadroomTokens = hardPressure ? recoveryHeadroom : softHeadroomTokens;
  const estimatorMarginTokens = Math.floor(finiteNonNegative(input.estimatorMarginTokens) ?? 0);
  const requiredSavingsTokens = pressured
    ? Math.max(0, projectedBeforeTokens - targetHeadroomTokens + estimatorMarginTokens)
    : 0;

  return {
    projectedBeforeTokens,
    projectionOrigin,
    contextWindow,
    reservedOutputTokens,
    reservedToolTokens,
    inputCapacityTokens,
    summaryBufferTokensApplied,
    softHeadroomTokens,
    hardHeadroomTokens,
    targetHeadroomTokens,
    requiredSavingsTokens,
    pressured,
    hardPressure,
    capacityExceeded,
  };
}
