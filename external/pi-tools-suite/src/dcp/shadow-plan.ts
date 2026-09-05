import type { DcpConfig } from "./config.js"
import { applyPruning, detectCompressionCandidate, detectEmergencyCompressionCandidate, detectMessageCompressionCandidates, getActiveSummaryTokenEstimate, resolveContextThresholds } from "./pruner.js"
import { estimateMessageTokens } from "./pruner-metadata.js"
import type { CompressionCandidate, MessageCompressionCandidate } from "./pruner-types.js"
import { planDcpBudget, type DcpBudgetPlan } from "./progress-controller.js"
import type { DcpState } from "./state.js"

export interface DcpShadowPlanInput {
  messages: any[]
  state: DcpState
  config: DcpConfig
  contextWindow: number
  providerUsageTokens?: number | null
  reservedOutputTokens?: number
  reservedToolTokens?: number
  modelKeys?: string[]
}

export interface DcpShadowPlanResult {
  projectedTokens: number
  contextPercent: number
  budget: DcpBudgetPlan
  routineCandidate: CompressionCandidate | null
  emergencyCandidate: CompressionCandidate | null
  messageCandidates: MessageCompressionCandidate[]
  projectedMessageCount: number
}

function cloneDcpState(state: DcpState): DcpState {
  return {
    ...state,
    toolCalls: new Map([...state.toolCalls].map(([id, record]) => [id, {
      ...record,
      inputArgs: { ...(record.inputArgs ?? {}) },
    }])),
    prunedToolIds: new Set(state.prunedToolIds),
    prunedToolReasons: new Map(state.prunedToolReasons),
    providerSeenToolIds: new Set(state.providerSeenToolIds),
    compressionBlocks: state.compressionBlocks.map((block) => ({
      ...block,
      coveredBlockIds: block.coveredBlockIds ? [...block.coveredBlockIds] : undefined,
      protectedFragments: block.protectedFragments?.map((fragment) => ({ ...fragment })),
      sourceCoverage: block.sourceCoverage ? { ...block.sourceCoverage } : undefined,
    })),
    messageIdSnapshot: new Map(state.messageIdSnapshot),
    messageMetaSnapshot: new Map([...state.messageMetaSnapshot].map(([id, meta]) => [id, {
      ...meta,
      toolCallIds: meta.toolCallIds ? [...meta.toolCallIds] : undefined,
    }])),
    conversationIndexSnapshot: state.conversationIndexSnapshot.map((entry) => ({
      ...entry,
      toolCallIds: entry.toolCallIds ? [...entry.toolCallIds] : undefined,
    })),
    messageIdsByStableId: new Map(state.messageIdsByStableId),
    accountedCompressionBlockIds: new Set(state.accountedCompressionBlockIds),
    compressionTokenSavings: new Map(state.compressionTokenSavings),
    accountedPrunedToolIds: new Set(state.accountedPrunedToolIds),
    nudgeAnchors: state.nudgeAnchors.map((anchor) => ({ ...anchor })),
    lastNudge: state.lastNudge ? { ...state.lastNudge } : undefined,
    progressRecovery: state.progressRecovery ? { ...state.progressRecovery } : undefined,
  }
}

/**
 * E10 dry-run planner. All DCP transforms and candidate discovery run against a
 * detached state clone; the supplied live state is never published, persisted,
 * or passed to a model. This is intended for rollout diagnostics/shadow checks.
 */
export function planDcpShadow(input: DcpShadowPlanInput): DcpShadowPlanResult {
  const shadowState = cloneDcpState(input.state)
  const projected = applyPruning(input.messages, shadowState, input.config)
  const projectedTokens = projected.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
  const contextWindow = Math.max(1, Math.floor(input.contextWindow))
  const emergency = input.config.strategies.emergencyCurrentTurnPruning
  const thresholds = resolveContextThresholds(input.config, input.modelKeys ?? [], contextWindow)
  const budget = planDcpBudget({
    providerUsageTokens: input.providerUsageTokens,
    repoProjectedTokens: projectedTokens,
    contextWindow,
    reservedOutputTokens: input.reservedOutputTokens ?? 0,
    reservedToolTokens: input.reservedToolTokens ?? 0,
    maxContextPercent: thresholds.maxContextPercent,
    hardContextPercent: emergency.hardContextPercent,
    targetContextPercent: Math.min(
      emergency.targetContextPercent,
      Math.max(0, thresholds.maxContextPercent * 0.9),
    ),
    summaryBufferEnabled: input.config.compress.summaryBuffer,
    activeSummaryTokens: getActiveSummaryTokenEstimate(shadowState),
    estimatorMarginTokens: Math.max(256, Math.ceil(contextWindow * 0.0025)),
  })
  const contextPercent = budget.projectedBeforeTokens / contextWindow
  const recovery = budget.pressured ? { requiredSavingsTokens: budget.requiredSavingsTokens } : undefined
  const routineCandidate = detectCompressionCandidate(
    projected,
    shadowState,
    input.config,
    contextPercent,
    recovery,
  )
  const emergencyCandidate = routineCandidate === null && budget.pressured
    ? detectEmergencyCompressionCandidate(
      projected,
      shadowState,
      input.config,
      contextPercent,
      budget.softHeadroomTokens / contextWindow,
      recovery,
    )
    : null
  const messageCandidates = detectMessageCompressionCandidates(
    projected,
    shadowState,
    input.config,
    contextPercent,
  )

  return {
    projectedTokens,
    contextPercent,
    budget,
    routineCandidate,
    emergencyCandidate,
    messageCandidates,
    projectedMessageCount: projected.length,
  }
}
