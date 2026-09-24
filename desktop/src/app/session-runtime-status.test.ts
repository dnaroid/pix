import { describe, expect, it } from "vitest";
import type { RuntimeStatus, SessionUsageStatus } from "../lib/acp-client";
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
});
