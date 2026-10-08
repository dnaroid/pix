import { assert, describe, expect, it } from "vitest";
import type { ModelUsageLimitWindow, ModelUsageStatus, RuntimeStatus } from "./acp-client";
import {
  EMPTY_RUNTIME_STATUS_GENERATIONS,
  beginRuntimeStatusRefresh,
  contextUsageTone,
  dcpStatsBody,
  displayModelUsage,
  formatCompactTokens,
  formatResetDuration,
  isLatestRuntimeStatusRefresh,
  limitingRateWindow,
  liveModelUsage,
  mergePushedContextUsage,
  mergePushedDcpTokensSaved,
  mergePushedModelUsage,
  mergeRuntimeStatusResponse,
  modelUsageTone,
  modelUsageWindowLabel,
  modelUsageWindowExceedsDailyBudget,
  shortModelUsageAccountLabel,
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
/** Anthropic API-key usage observed from response headers (RPM + TPM). */
const headerRateUsage: ModelUsageStatus = {
  modelKey: "anthropic/claude-sonnet-4-6",
  provider: "anthropic",
  updatedAt,
  rateWindows: [
    { remainingPercent: 40, resetAt: updatedAt + 30_000, windowSeconds: 60, hasKnownWindowDuration: true, label: "RPM" },
    { remainingPercent: 25, resetAt: updatedAt + 41_000, windowSeconds: 60, hasKnownWindowDuration: true, label: "TPM" },
  ],
};

describe("desktop runtime status helpers", () => {
  it("drops banked credits from stale quota instead of presenting old grants as available", () => {
    const stale = liveModelUsage({ ...freshQuotaUsage, stale: true, resetCredits: [{ title: "Full reset", count: 3 }], resetCreditsAvailableCount: 3 }, updatedAt);
    expect(stale?.hourly).toEqual(freshQuotaUsage.hourly);
    expect(stale?.stale).toBe(true);
    expect(stale?.resetCredits).toBeUndefined();
    expect(stale?.resetCreditsAvailableCount).toBeUndefined();
  });
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

  it("warns on cumulative daily budget overrun, matching the TUI", () => {
    const now = Date.UTC(2026, 8, 11, 12, 0, 0);
    expect(modelUsageWindowExceedsDailyBudget({
      remainingPercent: 20,
      resetAt: now + 5 * 24 * 60 * 60_000,
      windowSeconds: 7 * 24 * 60 * 60,
      hasKnownWindowDuration: true,
    }, now)).toBe(true);
    expect(modelUsageWindowExceedsDailyBudget({
      remainingPercent: 90,
      resetAt: now + 5 * 24 * 60 * 60_000,
      windowSeconds: 7 * 24 * 60 * 60,
      hasKnownWindowDuration: true,
    }, now)).toBe(false);
  });

  it("allocates whole days from the window start and carries unused budget forward", () => {
    const start = Date.UTC(2026, 8, 11, 15, 30);
    const day = 86_400_000;
    const window = { remainingPercent: 80, resetAt: start + 7 * day, windowSeconds: 7 * 86_400, hasKnownWindowDuration: true };
    expect(modelUsageWindowExceedsDailyBudget(window, start)).toBe(true);
    expect(modelUsageWindowExceedsDailyBudget(window, start + day - 1)).toBe(true);
    expect(modelUsageWindowExceedsDailyBudget(window, start + day)).toBe(false);
    expect(modelUsageWindowExceedsDailyBudget({ ...window, remainingPercent: 70 }, start + day)).toBe(true);
    expect(modelUsageWindowExceedsDailyBudget({ ...window, remainingPercent: 1 }, start + 6 * day)).toBe(false);
    expect(modelUsageWindowExceedsDailyBudget(window, start - 1)).toBe(false);
    expect(modelUsageWindowExceedsDailyBudget(window, window.resetAt)).toBe(false);
    expect(modelUsageWindowExceedsDailyBudget({ ...window, remainingPercent: 0 }, start)).toBe(false);
    expect(modelUsageWindowExceedsDailyBudget({ ...window, hasKnownWindowDuration: false }, start)).toBe(false);
    expect(modelUsageWindowExceedsDailyBudget({ ...window, windowSeconds: 86_400 }, window.resetAt - day)).toBe(false);
    const tenDays = { ...window, resetAt: start + 10 * day, windowSeconds: 10 * 86_400, remainingPercent: 90 };
    expect(modelUsageWindowExceedsDailyBudget(tenDays, start)).toBe(false);
    expect(modelUsageWindowExceedsDailyBudget({ ...tenDays, remainingPercent: 89.9 }, start)).toBe(true);
    const partialDay = { ...window, resetAt: start + 2.5 * day, windowSeconds: 2.5 * 86_400, remainingPercent: 1 };
    expect(modelUsageWindowExceedsDailyBudget(partialDay, start + 2 * day)).toBe(false);
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
    assert(afterSnapshot);
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
    assert(merged);
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

    assert(merged);
    expect(merged.dcpStats).toBe(previous.dcpStats);
    expect(merged.context?.percent).toBe(2);
  });

  it("merges pushed context without disturbing quota or DCP state", () => {
    const previous: RuntimeStatus = {
      ...snapshotOnlyStatus,
      dcpTokensSaved: 12_345,
      dcpStats: "DCP Session Statistics:\nTokens saved: 123",
      modelUsageRefresh: "ready",
      modelUsage: freshQuotaUsage,
    };
    const pushed = mergePushedContextUsage(previous, "session-1", {
      tokens: 128_000,
      contextWindow: 200_000,
      percent: 64,
    });

    expect(pushed.context).toEqual({ tokens: 128_000, contextWindow: 200_000, percent: 64 });
    expect(pushed.dcpTokensSaved).toBe(12_345);
    expect(pushed.dcpStats).toBe(previous.dcpStats);
    expect(pushed.modelUsageRefresh).toBe("ready");
    expect(pushed.modelUsage).toEqual(freshQuotaUsage);

    const cleared = mergePushedContextUsage(pushed, "session-1", undefined);
    expect(cleared.context).toBeUndefined();
    expect(cleared.dcpTokensSaved).toBe(12_345);
    expect(cleared.dcpStats).toBe(previous.dcpStats);
    expect(cleared.modelUsage).toEqual(freshQuotaUsage);
  });

  it("merges pushed DCP savings without disturbing context, quota, or DCP detail text", () => {
    const previous: RuntimeStatus = {
      ...snapshotOnlyStatus,
      context: { tokens: 64_000, contextWindow: 200_000, percent: 32 },
      dcpStats: "DCP Session Statistics:\nMeasured commit gain: 10,000 tokens",
      modelUsageRefresh: "ready",
      modelUsage: freshQuotaUsage,
    };
    const pushed = mergePushedDcpTokensSaved(previous, "session-1", 24_680);
    expect(pushed.dcpTokensSaved).toBe(24_680);
    expect(pushed.context?.percent).toBe(32);
    expect(pushed.dcpStats).toBe(previous.dcpStats);
    expect(pushed.modelUsage).toEqual(freshQuotaUsage);

    const cleared = mergePushedDcpTokensSaved(pushed, "session-1", undefined);
    expect(cleared.dcpTokensSaved).toBeUndefined();
    expect(cleared.context?.percent).toBe(32);
  });

  it("keeps pushed context when an older quota request settles afterward", () => {
    const quotaRequest = beginRuntimeStatusRefresh(EMPTY_RUNTIME_STATUS_GENERATIONS, true);
    const pushedGeneration = beginRuntimeStatusRefresh(quotaRequest.generations, false);
    const pushed = mergePushedContextUsage(undefined, "session-1", {
      tokens: 128_000,
      contextWindow: 200_000,
      percent: 64,
    });

    const merged = mergeRuntimeStatusResponse(
      pushed,
      {
        ...quotaReadyStatus,
        context: { tokens: 80_000, contextWindow: 200_000, percent: 40 },
      },
      isLatestRuntimeStatusRefresh(
        pushedGeneration.generations,
        quotaRequest.snapshotGeneration,
        quotaRequest.quotaGeneration,
      ),
    );

    assert(merged);
    expect(merged.context?.percent).toBe(64);
    expect(merged.modelUsage).toEqual(freshQuotaUsage);
    expect(merged.modelUsageRefresh).toBe("ready");
  });

  it("keeps pushed DCP savings when an older quota request settles afterward", () => {
    const quotaRequest = beginRuntimeStatusRefresh(EMPTY_RUNTIME_STATUS_GENERATIONS, true);
    const pushedGeneration = beginRuntimeStatusRefresh(quotaRequest.generations, false);
    const pushed = mergePushedDcpTokensSaved(undefined, "session-1", 24_680);

    const merged = mergeRuntimeStatusResponse(
      pushed,
      {
        ...quotaReadyStatus,
        dcpTokensSaved: 10_000,
      },
      isLatestRuntimeStatusRefresh(
        pushedGeneration.generations,
        quotaRequest.snapshotGeneration,
        quotaRequest.quotaGeneration,
      ),
    );

    assert(merged);
    expect(merged.dcpTokensSaved).toBe(24_680);
    expect(merged.modelUsage).toEqual(freshQuotaUsage);
    expect(merged.modelUsageRefresh).toBe("ready");
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
    assert(merged);
    expect(merged.modelUsage).toEqual(staleQuotaUsage);
    expect(merged.modelUsageRefresh).toBe("skipped");
  });

  it("merges pushed header usage without disturbing quota state", () => {
    const previous: RuntimeStatus = {
      ...snapshotOnlyStatus,
      context: { tokens: 64_000, contextWindow: 200_000, percent: 32 },
      modelUsageRefresh: "ready",
      modelUsage: freshQuotaUsage,
    };
    const pushed = mergePushedModelUsage(previous, "session-1", headerRateUsage);

    expect(pushed.headerUsage).toEqual(headerRateUsage);
    expect(pushed.modelUsage).toEqual(freshQuotaUsage);
    expect(pushed.modelUsageRefresh).toBe("ready");
    expect(pushed.context?.percent).toBe(32);

    const cleared = mergePushedModelUsage(pushed, "session-1", undefined);
    expect(cleared.headerUsage).toBeUndefined();
    expect(cleared.modelUsage).toEqual(freshQuotaUsage);

    // A push without any prior snapshot still creates a minimal status.
    const fresh = mergePushedModelUsage(undefined, "session-2", headerRateUsage);
    expect(fresh.sessionId).toBe("session-2");
    expect(fresh.modelUsageRefresh).toBe("skipped");
    expect(fresh.headerUsage).toEqual(headerRateUsage);
  });

  it("keeps pushed header usage when an older quota request settles afterward", () => {
    const quotaRequest = beginRuntimeStatusRefresh(EMPTY_RUNTIME_STATUS_GENERATIONS, true);
    const pushedGeneration = beginRuntimeStatusRefresh(quotaRequest.generations, false);
    const pushed = mergePushedModelUsage(undefined, "session-1", headerRateUsage);

    // The quota response settles after the push moved the snapshot generation;
    // only its quota fields may merge, and the pushed header usage survives.
    const merged = mergeRuntimeStatusResponse(
      pushed,
      quotaReadyStatus,
      isLatestRuntimeStatusRefresh(
        pushedGeneration.generations,
        quotaRequest.snapshotGeneration,
        quotaRequest.quotaGeneration,
      ),
    );

    assert(merged);
    expect(merged.modelUsage).toEqual(freshQuotaUsage);
    expect(merged.modelUsageRefresh).toBe("ready");
    expect(merged.headerUsage).toEqual(headerRateUsage);
  });

  it("keeps a stale in-flight OAuth quota reply from hiding a fresher pushed header snapshot", () => {
    // An OAuth quota request is in flight when the credential switches to an
    // API key: the fresh header snapshot is pushed before the OAuth reply.
    const quotaRequest = beginRuntimeStatusRefresh(EMPTY_RUNTIME_STATUS_GENERATIONS, true);
    const pushedGeneration = beginRuntimeStatusRefresh(quotaRequest.generations, false);
    const pushed = mergePushedModelUsage(undefined, "session-1", headerRateUsage);

    // The stale OAuth reply settles last — even with a newer updatedAt — and
    // must not claim display precedence over the pushed header snapshot.
    const lateOAuthReply: RuntimeStatus = {
      sessionId: "session-1",
      modelUsageRefresh: "ready",
      modelUsage: { ...freshQuotaUsage, updatedAt: updatedAt + 60_000 },
    };
    const merged = mergeRuntimeStatusResponse(
      pushed,
      lateOAuthReply,
      {
        ...isLatestRuntimeStatusRefresh(
          pushedGeneration.generations,
          quotaRequest.snapshotGeneration,
          quotaRequest.quotaGeneration,
        ),
        quotaPredatesHeaderPush: true,
      },
    );

    assert(merged);
    expect(merged.modelUsage).toBeUndefined();
    expect(merged.modelUsageRefresh).toBe("skipped");
    expect(merged.headerUsage).toEqual(headerRateUsage);
    expect(displayModelUsage(merged)).toEqual(headerRateUsage);
  });

  it("keeps a stale in-flight quota clearing from erasing fresher pushed header usage", () => {
    // The same staleness guard applies when the stale reply reports
    // "unavailable": the push, not the pre-switch reply, owns the truth.
    const quotaRequest = beginRuntimeStatusRefresh(EMPTY_RUNTIME_STATUS_GENERATIONS, true);
    const pushedGeneration = beginRuntimeStatusRefresh(quotaRequest.generations, false);
    const pushed = mergePushedModelUsage(undefined, "session-1", headerRateUsage);
    const merged = mergeRuntimeStatusResponse(
      pushed,
      { ...quotaReadyStatus, modelUsageRefresh: "unavailable" },
      {
        ...isLatestRuntimeStatusRefresh(
          pushedGeneration.generations,
          quotaRequest.snapshotGeneration,
          quotaRequest.quotaGeneration,
        ),
        quotaPredatesHeaderPush: true,
      },
    );

    assert(merged);
    expect(merged.modelUsage).toBeUndefined();
    expect(merged.modelUsageRefresh).toBe("skipped");
    expect(merged.headerUsage).toEqual(headerRateUsage);
  });

  it("displays the freshest usage source across auth and model switches", () => {
    // A single known source is displayed as-is.
    expect(displayModelUsage(undefined)).toBeUndefined();
    expect(displayModelUsage(quotaReadyStatus)).toEqual(freshQuotaUsage);
    expect(displayModelUsage({ ...snapshotOnlyStatus, headerUsage: headerRateUsage })).toEqual(headerRateUsage);

    // OAuth stays authoritative while its quota refreshes stay freshest, even
    // with an older API-key header snapshot still around.
    const oauthQuota: ModelUsageStatus = { ...freshQuotaUsage, updatedAt: updatedAt + 30_000 };
    expect(displayModelUsage({
      ...snapshotOnlyStatus,
      modelUsage: oauthQuota,
      headerUsage: headerRateUsage,
    })).toEqual(oauthQuota);

    // A header snapshot pushed after the last quota sample means the session
    // switched to API-key auth mid-session: the stale OAuth quota must not
    // hide it.
    const pushedHeaderUsage: ModelUsageStatus = { ...headerRateUsage, updatedAt: updatedAt + 30_000 };
    expect(displayModelUsage({
      ...snapshotOnlyStatus,
      modelUsage: freshQuotaUsage,
      headerUsage: pushedHeaderUsage,
    })).toEqual(pushedHeaderUsage);

    // Model switches follow the same rule: quota left over from the previous
    // model loses to a fresh header snapshot for the current model.
    const previousModelQuota: ModelUsageStatus = {
      ...freshQuotaUsage,
      modelKey: "anthropic/claude-opus-4-6",
      updatedAt: updatedAt - 30_000,
    };
    expect(displayModelUsage({
      ...snapshotOnlyStatus,
      modelUsage: previousModelQuota,
      headerUsage: headerRateUsage,
    })).toEqual(headerRateUsage);
    // A fresh quota for the current model stays authoritative over a leftover
    // header snapshot from the previous model.
    const currentModelHeader: ModelUsageStatus = { ...headerRateUsage, updatedAt: updatedAt - 30_000 };
    expect(displayModelUsage({
      ...snapshotOnlyStatus,
      modelUsage: freshQuotaUsage,
      headerUsage: currentModelHeader,
    })).toEqual(freshQuotaUsage);
  });

  it("keeps a stale snapshot's header usage while a newer quota refresh merges", () => {
    const request = beginRuntimeStatusRefresh(EMPTY_RUNTIME_STATUS_GENERATIONS, true);
    const withHeader: RuntimeStatus = {
      ...snapshotOnlyStatus,
      modelUsageRefresh: "ready",
      modelUsage: freshQuotaUsage,
      headerUsage: headerRateUsage,
    };
    const merged = mergeRuntimeStatusResponse(
      withHeader,
      { ...quotaReadyStatus, modelUsage: staleQuotaUsage },
      isLatestRuntimeStatusRefresh(
        request.generations,
        request.snapshotGeneration - 1,
        request.quotaGeneration,
      ),
    );
    assert(merged);
    expect(merged.modelUsage).toEqual(staleQuotaUsage);
    expect(merged.headerUsage).toEqual(headerRateUsage);
  });

  it("collapses header rate windows into the single most-limiting window", () => {
    expect(limitingRateWindow(headerRateUsage)?.label).toBe("TPM");
    expect(limitingRateWindow(headerRateUsage)?.remainingPercent).toBe(25);
    // Ties resolve to the window that resets first.
    const tied: ModelUsageStatus = {
      ...headerRateUsage,
      rateWindows: [
        { remainingPercent: 10, resetAt: updatedAt + 90_000, windowSeconds: 60, label: "TPM" },
        { remainingPercent: 10, resetAt: updatedAt + 30_000, windowSeconds: 60, label: "RPM" },
      ],
    };
    expect(limitingRateWindow(tied)?.label).toBe("RPM");
    expect(limitingRateWindow({ ...headerRateUsage, rateWindows: [] })).toBeUndefined();
    expect(limitingRateWindow(undefined)).toBeUndefined();
    expect(limitingRateWindow(freshQuotaUsage)).toBeUndefined();
  });

  it("labels short rate windows and truncates long account labels", () => {
    const minute: ModelUsageLimitWindow = { remainingPercent: 40, resetAt: updatedAt + 30_000, windowSeconds: 60 };
    expect(modelUsageWindowLabel("H", minute)).toBe("Min");
    expect(modelUsageWindowLabel("W", { ...minute, windowSeconds: 604_800 })).toBe("Weekly");
    expect(modelUsageWindowLabel("R", { ...minute, label: "TPM" })).toBe("TPM");
    expect(modelUsageWindowLabel("R", minute)).toBe("Rate");

    expect(shortModelUsageAccountLabel(undefined)).toBeUndefined();
    expect(shortModelUsageAccountLabel("  ")).toBeUndefined();
    expect(shortModelUsageAccountLabel("dev@example.com")).toBe("dev@example.com");
    expect(shortModelUsageAccountLabel("sk-ant-api03-abcdefgh")).toBe("sk-ant-api03-ab…");
    expect(shortModelUsageAccountLabel("short", 4)).toBe("sho…");
  });
});
