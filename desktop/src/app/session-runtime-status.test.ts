import { describe, expect, it } from "vitest";
import type { RuntimeStatus } from "../lib/acp-client";
import { createSessionRuntimeStatus } from "./session-runtime-status.svelte";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function status(tokens: number, dcpStats?: string): RuntimeStatus {
  return { sessionId: "a", context: { tokens, contextWindow: 100, percent: tokens }, modelUsageRefresh: "skipped", ...(dcpStats ? { dcpStats } : {}) };
}

function setup() {
  const requests: ReturnType<typeof deferred<RuntimeStatus>>[] = [];
  const stats: ReturnType<typeof deferred<{ dcpStats: string }>>[] = [];
  const client = {
    runtimeStatus() { const request = deferred<RuntimeStatus>(); requests.push(request); return request.promise; },
    dcpStats() { const request = deferred<{ dcpStats: string }>(); stats.push(request); return request.promise; },
  };
  const store = createSessionRuntimeStatus({
    client: () => client as unknown as NonNullable<ReturnType<Parameters<typeof createSessionRuntimeStatus>[0]["client"]>>,
    isReady: () => true,
  });
  return { store, requests, stats };
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
  }

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
});
