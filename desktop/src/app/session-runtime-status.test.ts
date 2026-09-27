import { describe, expect, it } from "vitest";
import type { RuntimeStatus, SessionUsageStatus } from "../lib/acp-client";
import { displayModelUsage } from "../lib/runtime-status";
import { createSessionRuntimeStatus } from "./session-runtime-status.svelte";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function status(tokens: number, dcpStats?: string): RuntimeStatus {
  return { sessionId: "a", context: { tokens, contextWindow: 100, percent: tokens }, modelUsageRefresh: "skipped", ...(dcpStats ? { dcpStats } : {}) };
}

function setup() {
  let ready = true;
  const requests: ReturnType<typeof deferred<RuntimeStatus>>[] = [];
  const stats: ReturnType<typeof deferred<{ dcpStats: string }>>[] = [];
  const usage: ReturnType<typeof deferred<SessionUsageStatus>>[] = [];
  const client = {
    runtimeStatus() { const request = deferred<RuntimeStatus>(); requests.push(request); return request.promise; },
    dcpStats() { const request = deferred<{ dcpStats: string }>(); stats.push(request); return request.promise; },
    sessionUsage() { const request = deferred<SessionUsageStatus>(); usage.push(request); return request.promise; },
  };
  const store = createSessionRuntimeStatus({
    client: () => client as unknown as NonNullable<ReturnType<Parameters<typeof createSessionRuntimeStatus>[0]["client"]>>,
    isReady: () => ready,
  });
  return { store, requests, stats, usage, setReady: (value: boolean) => { ready = value; } };
}

function usageStatus(cost: number): SessionUsageStatus {
  const totals = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost };
  return { sessionId: "a", usage: { totals, providers: [], unattributed: { ...totals, cost: 0, totalTokens: 0, input: 0, output: 0 } } };
}

describe("runtime status lifecycle", () => {
  it("preserves a pushed map against pending replies and out-of-order revisions, then clears null", async () => {
    const { store, requests } = setup();
    const old = store.refreshStatus("a", true);
    const map = { revision: 2, sessionEpoch: 1, generatedAt: 1,
      tokenEstimates: { candidate: 0, protected: 0, compressed: 0, retained: 100 } };
    const push = (data: unknown) => store.handleSessionState({ sessionId: "a", channel: "dcp-context-map", data });
    push(map);
    requests[0]!.resolve({ ...status(90), dcpContextMap: { ...map, revision: 1 } });
    await old;
    expect(store.statuses.get("a")?.dcpContextMap).toEqual(map);
    push({ ...map, revision: 1 });
    expect(store.statuses.get("a")?.dcpContextMap).toEqual(map);
    push(null);
    expect(store.statuses.get("a")?.dcpContextMap).toBeUndefined();
    push(map);
    store.forget("a");
    expect(store.statuses.has("a")).toBe(false);
  });
  for (const invalidate of ["forget", "reset"] as const) {
    it(`${invalidate} rejects old status and preserves a newer busy flag`, async () => {
      const { store, requests } = setup();
      const old = store.refreshStatus("a", true);
      if (invalidate === "forget") store.forget("a"); else store.reset();
      const current = store.refreshStatus("a", true);
      requests[0]!.resolve(status(90));
      await old;
      expect(store.statuses.has("a")).toBe(false);
      expect(store.modelUsageRefreshing.has("a")).toBe(true);
      requests[1]!.resolve(status(20));
      await current;
      expect(store.statuses.get("a")?.context?.tokens).toBe(20);
      expect(store.modelUsageRefreshing.has("a")).toBe(false);
    });

    it(`${invalidate} rejects stale DCP completion and its cleanup`, async () => {
      const { store, requests, stats } = setup();
      const initial = store.refreshStatus("a");
      requests[0]!.resolve(status(10));
      await initial;
      const old = store.refreshDcpStats("a");
      if (invalidate === "forget") store.forget("a"); else store.reset();
      const fresh = store.refreshStatus("a");
      requests[1]!.resolve(status(20));
      await fresh;
      const current = store.refreshDcpStats("a");
      stats[0]!.resolve({ dcpStats: "old" });
      await old;
      expect(store.statuses.get("a")?.dcpStats).toBeUndefined();
      expect(store.dcpStatsRefreshing.has("a")).toBe(true);
      stats[1]!.resolve({ dcpStats: "current" });
      await current;
      expect(store.statuses.get("a")?.dcpStats).toBe("current");
      expect(store.dcpStatsRefreshing.has("a")).toBe(false);
    });

    it(`${invalidate} rejects stale session-usage completion and its cleanup`, async () => {
      const { store, usage } = setup();
      const old = store.refreshSessionUsage("a");
      if (invalidate === "forget") store.forget("a"); else store.reset();
      const current = store.refreshSessionUsage("a");
      usage[0]!.resolve(usageStatus(9));
      await old;
      expect(store.sessionUsageBySession.has("a")).toBe(false);
      expect(store.sessionUsageRefreshing.has("a")).toBe(true);
      usage[1]!.resolve(usageStatus(1));
      await current;
      expect(store.sessionUsageBySession.get("a")?.totals.cost).toBe(1);
      expect(store.sessionUsageRefreshing.has("a")).toBe(false);
    });
  }

  it("does not start a session-usage request before the runtime is ready", async () => {
    const { store, usage, setReady } = setup();
    setReady(false);
    await store.refreshSessionUsage("a");
    expect(usage).toHaveLength(0);
    expect(store.sessionUsageRefreshing.has("a")).toBe(false);
    expect(store.sessionUsageFailed.has("a")).toBe(false);
  });

  it("exposes a current session-usage failure and clears it on retry", async () => {
    const { store, usage } = setup();
    const failed = store.refreshSessionUsage("a");
    usage[0]!.reject(new Error("temporary usage failure"));
    await failed;
    expect(store.sessionUsageFailed.has("a")).toBe(true);
    expect(store.sessionUsageRefreshing.has("a")).toBe(false);

    const retry = store.refreshSessionUsage("a");
    expect(store.sessionUsageFailed.has("a")).toBe(false);
    expect(store.sessionUsageRefreshing.has("a")).toBe(true);
    usage[1]!.resolve(usageStatus(3));
    await retry;
    expect(store.sessionUsageBySession.get("a")?.totals.cost).toBe(3);
    expect(store.sessionUsageFailed.has("a")).toBe(false);
  });

  it("ignores a late response after forget even without a replacement snapshot", async () => {
    const { store, requests } = setup();
    const old = store.refreshStatus("a");
    store.forget("a");
    requests[0]!.resolve(status(90));
    await old;
    expect(store.statuses.size).toBe(0);
  });

  it("never restores old report data when a reopened snapshot settles first", async () => {
    const { store, requests } = setup();
    const old = store.refreshStatus("a", true);
    store.forget("a");
    const current = store.refreshStatus("a");
    requests[1]!.resolve(status(20, "current"));
    await current;
    requests[0]!.resolve(status(90, "old"));
    await old;
    expect(store.statuses.get("a")).toEqual(status(20, "current"));
  });

  it("bounds generations to live owners across many closed sessions while keeping background status", async () => {
    const { store, requests, usage } = setup();
    const background = store.refreshStatus("background");
    requests[0]!.resolve({ ...status(12), sessionId: "background" });
    await background;
    for (let i = 0; i < 500; i++) {
      const id = `closed-${i}`;
      const pending = store.refreshSessionUsage(id);
      store.forget(id);
      usage[i]!.resolve({ ...usageStatus(4), sessionId: id });
      await pending;
    }
    expect(store.ownedSessionCount).toBe(1);
    expect(store.statuses.get("background")?.context?.tokens).toBe(12);
    expect(store.sessionUsageBySession.size).toBe(0);
    expect(store.sessionUsageRefreshing.size).toBe(0);
    store.reset();
    expect(store.ownedSessionCount).toBe(0);
  });

  const headerUsage = {
    modelKey: "anthropic/claude-sonnet-4-6",
    provider: "anthropic",
    updatedAt: 1_757_590_400_000,
    rateWindows: [
      { remainingPercent: 25, resetAt: 1_757_590_441_000, windowSeconds: 60, hasKnownWindowDuration: true, label: "TPM" },
    ],
  } as const;

  const pushUsage = (store: ReturnType<typeof createSessionRuntimeStatus>, sessionId: string, data: unknown) =>
    store.handleSessionState({ sessionId, channel: "model-usage", data });

  it("merges pushed header usage without quota refreshes and clears it on demand", async () => {
    const { store, requests } = setup();
    const initial = store.refreshStatus("a");
    requests[0]!.resolve({
      ...status(10),
      modelUsageRefresh: "ready",
      modelUsage: { modelKey: "openai/gpt-5", provider: "openai", updatedAt: 1, hourly: { remainingPercent: 80, resetAt: 2, windowSeconds: 3_600 } },
    });
    await initial;

    expect(pushUsage(store, "a", headerUsage)).toBe(true);
    const merged = store.statuses.get("a");
    expect(merged?.headerUsage).toEqual(headerUsage);
    expect(merged?.modelUsage?.hourly?.remainingPercent).toBe(80);
    expect(merged?.context?.tokens).toBe(10);

    // Invalid payloads are ignored, and null clears only the header usage.
    expect(pushUsage(store, "a", { modelKey: 5 })).toBe(true);
    expect(store.statuses.get("a")?.headerUsage).toEqual(headerUsage);
    expect(pushUsage(store, "a", null)).toBe(true);
    expect(store.statuses.get("a")?.headerUsage).toBeUndefined();
    expect(store.statuses.get("a")?.modelUsage?.hourly?.remainingPercent).toBe(80);

    // Unknown channels stay unhandled.
    expect(store.handleSessionState({ sessionId: "a", channel: "unknown", data: null })).toBe(false);
  });

  it("ignores pushed header usage until the runtime is ready", () => {
    const { store, setReady } = setup();
    setReady(false);
    expect(pushUsage(store, "a", headerUsage)).toBe(true);
    expect(store.statuses.size).toBe(0);
  });

  it("keeps pushed header usage over an older in-flight status reply", async () => {
    const { store, requests } = setup();
    const first = store.refreshStatus("a");
    requests[0]!.resolve(status(10));
    await first;
    const stale = store.refreshStatus("a");
    pushUsage(store, "a", headerUsage);
    // The stale reply must not clobber the push or previously known context.
    requests[1]!.resolve(status(90));
    await stale;
    expect(store.statuses.get("a")?.headerUsage).toEqual(headerUsage);
    expect(store.statuses.get("a")?.context?.tokens).toBe(10);
  });

  // OAuth subscription quota for the same model, fetched before the
  // credential switched to an API key.
  const oauthQuota = {
    modelKey: "anthropic/claude-sonnet-4-6",
    provider: "anthropic",
    updatedAt: 1_757_590_500_000,
    hourly: { remainingPercent: 60, resetAt: 1_757_590_800_000, windowSeconds: 18_000 },
    weekly: { remainingPercent: 45, resetAt: 1_757_600_000_000, windowSeconds: 604_800 },
  } as const;

  it("keeps a fresh API-key header snapshot over a stale in-flight OAuth quota reply", async () => {
    const { store, requests } = setup();
    // The quota request starts while the session still authenticates with
    // OAuth; the credential switches to an API key mid-flight and the fresh
    // header snapshot is pushed before the OAuth reply settles.
    const oauthReply = store.refreshStatus("a", true);
    expect(store.modelUsageRefreshing.has("a")).toBe(true);
    pushUsage(store, "a", headerUsage);
    requests[0]!.resolve({ ...status(10), modelUsageRefresh: "ready", modelUsage: oauthQuota });
    await oauthReply;

    const merged = store.statuses.get("a");
    expect(merged?.headerUsage).toEqual(headerUsage);
    // The stale OAuth windows must not merge and hide the header snapshot.
    expect(merged?.modelUsage).toBeUndefined();
    expect(merged?.modelUsageRefresh).toBe("skipped");
    expect(displayModelUsage(merged)).toEqual(headerUsage);
    expect(store.modelUsageRefreshing.has("a")).toBe(false);
  });

  it("merges quota normally when the request started after the last header push", async () => {
    const { store, requests } = setup();
    // A leftover header snapshot predates the quota request (for example the
    // credential switched back to OAuth): the fresh OAuth quota is
    // authoritative and merges without suppression. The newer full snapshot
    // no longer carries header usage, so the pushed snapshot is retired.
    pushUsage(store, "a", headerUsage);
    const oauthReply = store.refreshStatus("a", true);
    requests[0]!.resolve({ ...status(10), modelUsageRefresh: "ready", modelUsage: oauthQuota });
    await oauthReply;

    const merged = store.statuses.get("a");
    expect(merged?.modelUsage).toEqual(oauthQuota);
    expect(merged?.headerUsage).toBeUndefined();
    expect(displayModelUsage(merged)).toEqual(oauthQuota);
  });

  it("re-enables quota merges once the pushed header snapshot is cleared", async () => {
    const { store, requests } = setup();
    pushUsage(store, "a", headerUsage);
    pushUsage(store, "a", null);
    const oauthReply = store.refreshStatus("a", true);
    requests[0]!.resolve({ ...status(10), modelUsageRefresh: "ready", modelUsage: oauthQuota });
    await oauthReply;

    const merged = store.statuses.get("a");
    expect(merged?.headerUsage).toBeUndefined();
    expect(merged?.modelUsage).toEqual(oauthQuota);
  });

  for (const invalidate of ["forget", "reset"] as const) {
    it(`${invalidate} drops pushed header usage and rejects late pushes`, () => {
      const { store, setReady } = setup();
      pushUsage(store, "a", headerUsage);
      expect(store.statuses.get("a")?.headerUsage).toEqual(headerUsage);
      if (invalidate === "forget") store.forget("a"); else store.reset();
      // The runtime is no longer ready after either lifecycle transition.
      setReady(false);
      expect(store.statuses.has("a")).toBe(false);
      // Late pushes after invalidation never resurrect the session.
      expect(pushUsage(store, "a", headerUsage)).toBe(true);
      expect(store.statuses.has("a")).toBe(false);
    });
  }
});
