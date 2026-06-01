import type { DcpConfig } from "./config.js";
import type { DcpState } from "./state.js";
import type { NudgeThresholds } from "./pruner-types.js";

function coercePercentThreshold(value: number | string | undefined, fallback: number): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value !== "string") return fallback;

  const trimmed = value.trim();
  if (!trimmed) return fallback;
  const parsed = Number.parseFloat(trimmed.endsWith("%") ? trimmed.slice(0, -1) : trimmed);
  if (!Number.isFinite(parsed)) return fallback;
  if (trimmed.endsWith("%")) return parsed / 100;
  return parsed <= 1 ? parsed : fallback;
}

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
  const minContextPercent = coercePercentThreshold(
    thresholds.minContextPercent ?? config.compress.minContextPercent,
    0.4,
  );
  const maxContextPercent = coercePercentThreshold(
    thresholds.maxContextPercent ?? config.compress.maxContextPercent,
    0.8,
  );
  const cadence = Math.max(1, Math.floor(nudgeFrequency));

  if (!Number.isFinite(contextPercent)) return null;
  if (contextPercent <= minContextPercent) return null;
  if (state.nudgeCounter + 1 < cadence) return null;

  if (contextPercent > maxContextPercent) {
    return nudgeForce === "strong" ? "context-strong" : "context-soft";
  }

  if (toolCallsSinceLastUser >= iterationNudgeThreshold) {
    return "iteration";
  }

  return "turn";
}
