import { canonicalMessageHash } from "./conversation-index.js";
import type { CompressionBlock } from "./state.js";

interface ProjectionFrame {
  owner: string;
  avoidedTokens: number;
  blocks: string;
}

export interface RoutinePressureEstimate {
  projectedTokens: number;
  adjustmentTokens: number;
}

function usableUsage(message: any): boolean {
  if (message?.role !== "assistant" || ["error", "aborted"].includes(message.stopReason)) return false;
  const usage = message.usage;
  if (!usage) return false;
  const tokens = usage.totalTokens || [usage.input, usage.output, usage.cacheRead, usage.cacheWrite]
    .reduce((sum, value) => sum + (typeof value === "number" && Number.isFinite(value) ? value : 0), 0);
  return typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0;
}

function blockVersion(blocks: readonly CompressionBlock[]): string {
  return blocks.filter((block) => block.active).map((block) => block.id).join(",");
}

/**
 * Runtime-only calibration for ROUTINE nudges, never a provider-send budget.
 * The SDK's last assistant usage still includes history removed by a later DCP
 * rewrite. Subtract only the additional locally measured raw/projected delta
 * since that assistant's correlated request. This keeps provider overhead and
 * tail growth, and avoids counting older compression twice. Uncorrelated usage
 * and lifecycle changes fall back to the existing conservative estimate.
 */
export class RoutinePressureTracker {
  private prepared: ProjectionFrame | undefined;
  private pending: ProjectionFrame | undefined;
  private sample: (ProjectionFrame & { hash: string; timestamp: unknown }) | undefined;

  reset(): void {
    this.prepared = undefined;
    this.pending = undefined;
    this.sample = undefined;
  }

  prepare(owner: string, rawTokens: number, projectedTokens: number, blocks: readonly CompressionBlock[]): void {
    this.prepared = { owner, avoidedTokens: rawTokens - projectedTokens, blocks: blockVersion(blocks) };
  }

  beforeRequest(): void {
    this.pending = this.prepared;
  }

  complete(message: any, correlated: boolean): void {
    const pending = this.pending;
    this.pending = undefined;
    if (!usableUsage(message)) return;
    this.sample = correlated && pending && typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
      ? { ...pending, hash: canonicalMessageHash(message), timestamp: message.timestamp }
      : undefined;
  }

  estimate(owner: string, nativeTokens: number | null | undefined, raw: readonly any[],
    rawTokens: number, projectedTokens: number, blocks: readonly CompressionBlock[]): RoutinePressureEstimate {
    const fallback = Math.max(projectedTokens, nativeTokens ?? 0);
    const unchanged = { projectedTokens: fallback, adjustmentTokens: 0 };
    const sample = this.sample;
    if (!sample || sample.owner !== owner || nativeTokens === null || nativeTokens === undefined) return unchanged;
    const version = blockVersion(blocks);
    if (!version || version === sample.blocks) return unchanged;
    // Confirm the SDK is still based on this exact successful assistant, not
    // an unrelated/new response, failed stream or a sample from another owner.
    let latest: any;
    for (let index = raw.length - 1; index >= 0; index--) {
      if (usableUsage(raw[index])) {
        latest = raw[index];
        break;
      }
    }
    if (!latest || latest.timestamp !== sample.timestamp || canonicalMessageHash(latest) !== sample.hash) return unchanged;
    const newSavings = Math.max(0, rawTokens - projectedTokens - sample.avoidedTokens);
    const adjusted = Math.max(projectedTokens, nativeTokens - newSavings);
    return { projectedTokens: adjusted, adjustmentTokens: fallback - adjusted };
  }
}
