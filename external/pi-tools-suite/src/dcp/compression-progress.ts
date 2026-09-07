import type { DcpState } from "./state.js"

/** Routine recovery aims for up to five percentage points, never below min. */
export function routineRecoveryTokens(tokens: number, window: number, minPercent: number): number {
  return Math.max(1, Math.ceil(Math.min(window * 0.05, Math.max(0, tokens - window * minPercent))))
}

export interface CompressionProgressInput {
  projectedTokens: number
  contextWindow: number
  requiredTokens: number
  kind: "routine" | "emergency"
  observedTokens?: number
  targetHeadroomTokens?: number
}

/** Remaining debt follows new content/usage, not a stale pre-compression sample. */
export function outstandingCompressionTokens(state: DcpState, input: CompressionProgressInput): number | undefined {
  const previous = state.compressionProgress
  if (!previous || previous.contextWindow !== input.contextWindow) return undefined
  const projectionChange = input.projectedTokens - previous.projectedTokens
  const observedGrowth = input.observedTokens !== undefined && previous.observedTokens !== undefined
    ? Math.max(0, input.observedTokens - previous.observedTokens) : 0
  const growth = observedGrowth > 0 ? Math.max(projectionChange, observedGrowth) : projectionChange
  const stricterTarget = previous.kind === input.kind && previous.targetHeadroomTokens !== undefined && input.targetHeadroomTokens !== undefined
    ? Math.max(0, previous.targetHeadroomTokens - input.targetHeadroomTokens) : 0
  return Math.max(0, previous.remainingTokens + growth + stricterTarget)
}

/** Follow actual projection growth, not context callback/retry count. */
export function trackCompressionProgress(
  state: DcpState,
  input: CompressionProgressInput,
): void {
  const previous = state.compressionProgress
  const remaining = outstandingCompressionTokens(state, input)
  state.compressionProgress = {
    projectedTokens: input.projectedTokens,
    contextWindow: input.contextWindow,
    // The unchanged native sample still describes the input before a manual
    // commit. Do not charge the same already-recovered tokens on every callback.
    remainingTokens: previous && previous.kind === input.kind && remaining !== undefined && remaining > 0
      ? remaining : Math.max(1, input.requiredTokens, remaining ?? 0),
    kind: input.kind,
    observedTokens: input.observedTokens,
    targetHeadroomTokens: previous?.kind === input.kind && previous.targetHeadroomTokens !== undefined && input.targetHeadroomTokens !== undefined
      ? Math.min(previous.targetHeadroomTokens, input.targetHeadroomTokens) : input.targetHeadroomTokens,
  }
}

export function resetCompressionProgress(state: DcpState): void {
  state.consecutiveIgnoredStrongNudges = 0
  state.consecutiveIgnoredNudges = 0
  state.compressionProgress = undefined
}

/** Called on a detached state only after positive full-projection gain is proved. */
export function settleCompressionProgress(state: DcpState, gain: number, projectedAfterTokens: number): boolean {
  const goal = state.compressionProgress
  if (!goal || gain >= goal.remainingTokens) {
    resetCompressionProgress(state)
    return true
  }
  state.compressionProgress = {
    ...goal,
    remainingTokens: goal.remainingTokens - gain,
    projectedTokens: projectedAfterTokens,
  }
  return false
}
