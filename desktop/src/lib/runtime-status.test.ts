import { describe, expect, it } from "vitest";
import type { ModelUsageStatus, RuntimeStatus } from "./acp-client";
import {
  EMPTY_RUNTIME_STATUS_GENERATIONS,
  beginRuntimeStatusRefresh,
  contextUsageTone,
  dcpStatsBody,
  formatCompactTokens,
  formatResetDuration,
  isLatestRuntimeStatusRefresh,
  mergeRuntimeStatusResponse,
  modelUsageTone,
  modelUsageWindowWillExhaustBeforeReset,
} from "./runtime-status";

const updatedAt = Date.UTC(2026, 8, 11, 12, 0, 0);
const freshQuotaUsage: ModelUsageStatus = {
  modelKey: "pix/test-model",
  provider: "openai",
  updatedAt,
  hourly: { remainingPercent: 42, resetAt: updatedAt + 3_600_000, windowSeconds: 3_600 },
};
const staleQuotaUsage: ModelUsageStatus = {
  ...freshQuotaUsage,
  hourly: { remainingPercent: 90, resetAt: updatedAt + 3_600_000, windowSeconds: 3_600 },
};
const snapshotOnlyStatus: RuntimeStatus = {
  sessionId: "session-1",
  context: { tokens: 1_200, contextWindow: 200_000, percent: 1 },
  modelUsageRefresh: "skipped",
};
const quotaReadyStatus: RuntimeStatus = {
  sessionId: "session-1",
  modelUsageRefresh: "ready",
  modelUsage: freshQuotaUsage,
};

describe("desktop runtime status helpers", () => {
  it("matches the TUI context and remaining-limit thresholds", () => {
    expect(contextUsageTone(30)).toBe("success");
    expect(contextUsageTone(31)).toBe("warning");
    expect(contextUsageTone(51)).toBe("error");
    expect(modelUsageTone(50)).toBe("success");
    expect(modelUsageTone(49)).toBe("warning");
    expect(modelUsageTone(19)).toBe("error");
  });

  it("formats compact context values and reset durations for status chrome", () => {
    const now = Date.UTC(2026, 8, 11, 12, 0, 0);
    expect(formatCompactTokens(128_400)).toBe("128.4K");
    expect(formatCompactTokens(1_000_000)).toBe("1M");
    expect(formatResetDuration(now + 95 * 60_000, now)).toBe("1h35m");
    expect(formatResetDuration(now - 1, now)).toBe("reset");
  });

  it("keeps the TUI long-window exhaustion warning heuristic", () => {
    const now = Date.UTC(2026, 8, 11, 12, 0, 0);
    expect(modelUsageWindowWillExhaustBeforeReset({
      remainingPercent: 20,
      resetAt: now + 5 * 24 * 60 * 60_000,
      windowSeconds: 7 * 24 * 60 * 60,
      hasKnownWindowDuration: true,
    }, now)).toBe(true);
    expect(modelUsageWindowWillExhaustBeforeReset({
      remainingPercent: 90,
      resetAt: now + 5 * 24 * 60 * 60_000,
      windowSeconds: 7 * 24 * 60 * 60,
      hasKnownWindowDuration: true,
    }, now)).toBe(false);
  });

  it("removes the TUI dialog heading before rendering the desktop popover body", () => {
    expect(dcpStatsBody("DCP Session Statistics:\nTokens saved: 123")).toBe("Tokens saved: 123");
  });

  it("keeps a successful in-flight quota refresh when a non-quota snapshot refresh settles first", () => {
    // A quota refresh starts: snapshot generation 1, independent quota generation 1.
    const quotaRequest = beginRuntimeStatusRefresh(EMPTY_RUNTIME_STATUS_GENERATIONS, true);
    expect(quotaRequest.quotaGeneration).toBe(1);

    // A non-quota snapshot refresh starts and settles before the quota response.
    const snapshotRequest = beginRuntimeStatusRefresh(quotaRequest.generations, false);
    expect(snapshotRequest.generations.snapshot).toBe(2);
    expect(snapshotRequest.generations.quota).toBe(1);
    const afterSnapshot = mergeRuntimeStatusResponse(
      undefined,
      snapshotOnlyStatus,
      isLatestRuntimeStatusRefresh(
        snapshotRequest.generations,
        snapshotRequest.snapshotGeneration,
        snapshotRequest.quotaGeneration,
      ),
    );
    expect(afterSnapshot.modelUsageRefresh).toBe("skipped");
    expect(afterSnapshot.modelUsage).toBeUndefined();

    // The quota response settles after the shared snapshot generation moved on;
    // the untouched quota generation must still mark it as the latest refresh.
    const merged = mergeRuntimeStatusResponse(
      afterSnapshot,
      quotaReadyStatus,
      isLatestRuntimeStatusRefresh(
        snapshotRequest.generations,
        quotaRequest.snapshotGeneration,
        quotaRequest.quotaGeneration,
      ),
    );
    expect(merged.modelUsage).toEqual(freshQuotaUsage);
    expect(merged.modelUsageRefresh).toBe("ready");
    expect(merged.context).toEqual(snapshotOnlyStatus.context);
  });

  it("preserves lazily loaded DCP telemetry across periodic runtime snapshots", () => {
    const previous: RuntimeStatus = {
      ...snapshotOnlyStatus,
      dcpStats: "DCP Session Statistics:\nTokens saved: 123",
    };
    const request = beginRuntimeStatusRefresh(EMPTY_RUNTIME_STATUS_GENERATIONS, false);
    const merged = mergeRuntimeStatusResponse(
      previous,
      { ...snapshotOnlyStatus, context: { tokens: 2_000, contextWindow: 200_000, percent: 2 } },
      isLatestRuntimeStatusRefresh(request.generations, request.snapshotGeneration, request.quotaGeneration),
    );

    expect(merged.dcpStats).toBe(previous.dcpStats);
    expect(merged.context?.percent).toBe(2);
  });

  it("still supersedes an older in-flight quota refresh once a newer quota refresh starts", () => {
    const first = beginRuntimeStatusRefresh(EMPTY_RUNTIME_STATUS_GENERATIONS, true);
    const second = beginRuntimeStatusRefresh(first.generations, true);
    const staleStatus: RuntimeStatus = {
      sessionId: "session-1",
      modelUsageRefresh: "skipped",
      modelUsage: staleQuotaUsage,
    };
    const merged = mergeRuntimeStatusResponse(
      staleStatus,
      quotaReadyStatus,
      isLatestRuntimeStatusRefresh(second.generations, first.snapshotGeneration, first.quotaGeneration),
    );
    expect(merged.modelUsage).toEqual(staleQuotaUsage);
    expect(merged.modelUsageRefresh).toBe("skipped");
  });
});
