import { describe, expect, it, vi } from "vitest";
import type { ClaudeQuotaRefreshStatus, RuntimeStatus } from "../lib/acp-client";
import { createSessionRuntimeStatus } from "./session-runtime-status.svelte";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const pending: RuntimeStatus = {
  sessionId: "a", modelUsageRefresh: "unavailable", modelUsageCredentialPending: true,
};
const quota = {
  provider: "anthropic", modelKey: "pi-claude-code-provider/sonnet", updatedAt: Date.now(),
  hourly: { remainingPercent: 80, resetAt: Date.now() + 60_000, windowSeconds: 18_000 },
} as const;

function setup() {
  const requests: ReturnType<typeof deferred<RuntimeStatus>>[] = [];
  const limits: ReturnType<typeof deferred<ClaudeQuotaRefreshStatus>>[] = [];
  const quotaFlags: boolean[] = [];
  const client = {
    runtimeStatus(_id: string, refresh: boolean) {
      const request = deferred<RuntimeStatus>();
      requests.push(request);
      quotaFlags.push(refresh);
      return request.promise;
    },
    claudeQuotaRefresh() {
      const request = deferred<ClaudeQuotaRefreshStatus>();
      limits.push(request);
      return request.promise;
    },
  };
  const store = createSessionRuntimeStatus({
    client: () => client as unknown as NonNullable<ReturnType<Parameters<typeof createSessionRuntimeStatus>[0]["client"]>>,
    isReady: () => true,
  });
  return { store, requests, limits, quotaFlags };
}

describe("Claude Code startup credential recovery", () => {
  it("starts immediately without delaying activation, shares the manual guard, and leaves context updates live", async () => {
    const { store, requests, limits, quotaFlags } = setup();
    const initial = store.refreshStatus("a", true);
    requests[0]!.resolve(pending);
    await initial;
    expect(limits).toHaveLength(1);
    expect(store.modelUsageRefreshing.has("a")).toBe(false);
    expect(store.claudeLimitsRefreshing.has("a")).toBe(true);
    await store.refreshClaudeLimits("a");
    expect(limits).toHaveLength(1);
    const snapshot = store.refreshStatus("a", true);
    expect(quotaFlags).toEqual([true, false]);
    requests[1]!.resolve({ sessionId: "a", modelUsageRefresh: "skipped", context: { tokens: 20, contextWindow: 100, percent: 20 } });
    await snapshot;
    limits[0]!.resolve({ sessionId: "a", launched: true, refresh: "ready", modelUsage: quota });
    await Promise.resolve();
    expect(store.statuses.get("a")?.modelUsage).toEqual(quota);
    expect(store.statuses.get("a")?.context?.tokens).toBe(20);
    expect(store.claudeLimitsRefreshing.has("a")).toBe(false);
  });

  for (const refresh of ["ready", "failed", "unavailable", "skipped"] as const) {
    it(`does not launch the CLI on ${refresh} without the credential-pending flag`, async () => {
      const { store, requests, limits } = setup();
      const initial = store.refreshStatus("a", true);
      requests[0]!.resolve({ sessionId: "a", modelUsageRefresh: refresh });
      await initial;
      expect(limits).toHaveLength(0);
    });
  }

  it("does not launch from a snapshot-only pending hint", async () => {
    const { store, requests, limits } = setup();
    const initial = store.refreshStatus("a");
    requests[0]!.resolve(pending);
    await initial;
    expect(limits).toHaveLength(0);
    const quotaCheck = store.refreshStatus("a", true);
    requests[1]!.resolve(pending);
    await quotaCheck;
    expect(limits).toHaveLength(1);
    store.reset();
    limits[0]!.resolve({ sessionId: "a", launched: false, refresh: "failed" });
    await Promise.resolve();
  });

  it("ignores superseded pending quota even when its snapshot is still mergeable", async () => {
    const { store, requests, limits } = setup();
    const old = store.refreshStatus("a", true);
    const current = store.refreshStatus("a", true);
    requests[1]!.resolve({ sessionId: "a", modelUsageRefresh: "ready", modelUsage: quota });
    await current;
    requests[0]!.resolve(pending);
    await old;
    expect(limits).toHaveLength(0);
    expect(store.statuses.get("a")?.modelUsage).toEqual(quota);
  });

  it("does not turn later credential loss into repeated automatic CLI launches", async () => {
    vi.useFakeTimers();
    try {
      const { store, requests, limits } = setup();
      const initial = store.refreshStatus("a", true);
      requests[0]!.resolve({ sessionId: "a", modelUsageRefresh: "ready", modelUsage: quota });
      await initial;
      const later = store.refreshStatus("a", true);
      requests[1]!.resolve(pending);
      await later;
      expect(limits).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(requests).toHaveLength(3);
      requests[2]!.resolve(pending);
      await vi.advanceTimersByTimeAsync(0);
      expect(limits).toHaveLength(0);
      store.reset();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps local retries after a rejected startup nudge without launching the CLI again", async () => {
    vi.useFakeTimers();
    try {
      const { store, requests, limits } = setup();
      const initial = store.refreshStatus("a", true);
      requests[0]!.resolve(pending);
      await initial;
      limits[0]!.reject(new Error("transport failure"));
      await vi.advanceTimersByTimeAsync(0);
      expect(store.claudeLimitsFailed.has("a")).toBe(true);
      expect(store.claudeLimitsRefreshing.has("a")).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(requests).toHaveLength(2);
      requests[1]!.resolve(pending);
      await vi.advanceTimersByTimeAsync(0);
      expect(limits).toHaveLength(1);
      store.reset();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores pending quota fetched before a pushed API-key usage switch", async () => {
    const { store, requests, limits } = setup();
    const initial = store.refreshStatus("a", true);
    store.handleSessionState({
      sessionId: "a", channel: "model-usage",
      data: { ...quota, modelKey: "anthropic/sonnet", source: "headers" },
    });
    requests[0]!.resolve(pending);
    await initial;
    expect(limits).toHaveLength(0);
    expect(store.statuses.get("a")?.headerUsage?.modelKey).toBe("anthropic/sonnet");
  });

  for (const invalidate of ["forget", "reset"] as const) {
    it(`${invalidate} rejects an old pending reply before launching recovery`, async () => {
      const { store, requests, limits } = setup();
      const initial = store.refreshStatus("a", true);
      if (invalidate === "forget") store.forget("a"); else store.reset();
      requests[0]!.resolve(pending);
      await initial;
      expect(limits).toHaveLength(0);
      expect(store.statuses.has("a")).toBe(false);
    });

    it(`${invalidate} rearms recovery and rejects an old nudge's completion and busy cleanup`, async () => {
      const { store, requests, limits } = setup();
      const initial = store.refreshStatus("a", true);
      requests[0]!.resolve(pending);
      await initial;
      if (invalidate === "forget") store.forget("a"); else store.reset();
      const reopened = store.refreshStatus("a", true);
      requests[1]!.resolve(pending);
      await reopened;
      expect(limits).toHaveLength(2);
      limits[0]!.resolve({ sessionId: "a", launched: true, refresh: "ready", modelUsage: quota });
      await Promise.resolve();
      expect(store.statuses.get("a")?.modelUsage).toBeUndefined();
      expect(store.claudeLimitsRefreshing.has("a")).toBe(true);
      limits[1]!.resolve({ sessionId: "a", launched: false, refresh: "failed" });
      await Promise.resolve();
      expect(store.claudeLimitsRefreshing.has("a")).toBe(false);
      expect(store.claudeLimitsFailed.has("a")).toBe(true);
    });
  }
});
