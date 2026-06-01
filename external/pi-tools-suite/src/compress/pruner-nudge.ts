import type { DcpConfig } from "./config.js";
import type { DcpState } from "./state.js";
import type { NudgeThresholds } from "./pruner-types.js";

export function injectNudge(messages: any[], nudgeText: string): void {
  messages.push({
    role: "user",
    content: nudgeText,
    timestamp: Date.now(),
  });
}

export function getNudgeType(
  contextPercent: number,
  state: DcpState,
  config: DcpConfig,
  toolCallsSinceLastUser: number,
  thresholds: NudgeThresholds = {},
): "context-strong" | "context-soft" | "turn" | "iteration" | null {
  const { nudgeFrequency, nudgeForce, iterationNudgeThreshold } =
    config.compress;
  const minContextPercent = thresholds.minContextPercent ?? config.compress.minContextPercent;
  const maxContextPercent = thresholds.maxContextPercent ?? config.compress.maxContextPercent;
  const cadence = Math.max(1, Math.floor(nudgeFrequency));

  if (contextPercent <= minContextPercent) return null;
  if (state.nudgeCounter < cadence) return null;
  if (state.lastNudgeTurn === state.currentTurn) return null;

  if (contextPercent > maxContextPercent) {
    return nudgeForce === "strong" ? "context-strong" : "context-soft";
  }

  if (toolCallsSinceLastUser >= iterationNudgeThreshold) {
    return "iteration";
  }

  return "turn";
}
