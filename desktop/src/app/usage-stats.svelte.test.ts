import { describe, expect, it, vi } from "vitest";
import type { UsageSourceId, UsageSourceSnapshot, UsageStatsResponse } from "../../../acp/src/acp/usage-stats-contract";
import { createUsageStatsStore } from "./usage-stats.svelte";

type Call = {
  cwd: string;
  options: { sources?: readonly UsageSourceId[]; refresh?: boolean };
  resolve: (response: UsageStatsResponse) => void;
  reject: (error: unknown) => void;
};

function fakeClient() {
  const calls: Call[] = [];
  const client = {
    usageStats: vi.fn((cwd: string, options: Call["options"] = {}) => new Promise<UsageStatsResponse>((resolve, reject) => {
      calls.push({ cwd, options, resolve, reject });
    })),
  };
  return { client, calls };
}

function snap(source: UsageSourceId, fetchedAtMs = 1, status: UsageSourceSnapshot["status"] = "ready"): UsageSourceSnapshot {
  return { source, status, unit: "tokens", coverage: null, buckets: [], fetchedAtMs };
}

function setup() {
  const first = fakeClient();
  let client: ReturnType<typeof fakeClient>["client"] | null = first.client;
  let workspace = "/w/a";
  const errors: unknown[] = [];
  const store = createUsageStatsStore({
    client: () => client,
    workspace: () => workspace,
    reportError: (error) => { errors.push(error); },
  });
  return {
    store, calls: first.calls, errors,
    setClient: (next: typeof client) => { client = next; },
    setWorkspace: (next: string) => { workspace = next; },
  };
}

const flush = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

describe("usage stats store", () => {
  it("does not request while closed and fetches on open", async () => {
    const { store, calls } = setup();
    await store.refresh();
    store.handleChanged({ source: "pix-sessions" });
    await flush();
    expect(calls).toHaveLength(0);

    const opening = store.open();
    expect(store.busy).toBe(true);
    expect(calls[0]).toMatchObject({ cwd: "/w/a", options: {} });
    calls[0]!.resolve({ snapshots: [snap("pix-sessions")] });
    await opening;
    expect(store.busy).toBe(false);
    expect([...store.snapshots.keys()]).toEqual(["pix-sessions"]);
  });

  it("passes refresh through and lets a newer request for a source win", async () => {
    const { store, calls } = setup();
    const older = store.open();
    const newer = store.refresh();
    expect(calls[1]!.options).toEqual({ refresh: true });
    calls[1]!.resolve({ snapshots: [snap("pix-sessions", 2)] });
    await newer;
    calls[0]!.resolve({ snapshots: [snap("pix-sessions", 1)] });
    await older;
    expect(store.snapshot("pix-sessions")?.fetchedAtMs).toBe(2);
  });

  it("drops completions after a workspace switch and clears foreign data", async () => {
    const { store, calls, setWorkspace, errors } = setup();
    const first = store.open();
    calls[0]!.resolve({ snapshots: [snap("pix-sessions", 1)] });
    await first;

    const stale = store.refresh();
    setWorkspace("/w/b");
    const synced = store.sync();
    expect(store.snapshots.size).toBe(0);
    expect(calls[2]!.cwd).toBe("/w/b");
    calls[1]!.resolve({ snapshots: [snap("pix-sessions", 9)] });
    calls[1]!.reject(new Error("late"));
    await stale;
    calls[2]!.resolve({ snapshots: [snap("pix-sessions", 3)] });
    await synced;
    expect(store.snapshot("pix-sessions")?.fetchedAtMs).toBe(3);
    expect(errors).toEqual([]);
  });

  it("drops completions after an ACP reset and requests through the new client", async () => {
    const { store, calls, setClient } = setup();
    const stale = store.open();
    const replacement = fakeClient();
    setClient(replacement.client);
    const synced = store.sync();
    calls[0]!.resolve({ snapshots: [snap("pix-sessions", 1)] });
    await stale;
    expect(store.snapshots.size).toBe(0);
    replacement.calls[0]!.resolve({ snapshots: [snap("pix-sessions", 2)] });
    await synced;
    expect(store.snapshot("pix-sessions")?.fetchedAtMs).toBe(2);

    setClient(null);
    await store.sync();
    expect(store.snapshots.size).toBe(0);
    expect(store.busy).toBe(false);
  });

  it("close discards in-flight results but keeps cached data for reopen", async () => {
    const { store, calls, errors } = setup();
    const first = store.open();
    calls[0]!.resolve({ snapshots: [snap("pix-sessions", 1)] });
    await first;
    const pending = store.refresh();
    store.close();
    expect(store.busy).toBe(false);
    calls[1]!.reject(new Error("aborted"));
    await pending;
    expect(errors).toEqual([]);
    expect(store.snapshot("pix-sessions")?.fetchedAtMs).toBe(1);
  });

  it("coalesces change notifications into one targeted request", async () => {
    const { store, calls } = setup();
    const opening = store.open();
    calls[0]!.resolve({ snapshots: [] });
    await opening;

    store.handleChanged({ source: "pix-sessions" });
    store.handleChanged({ source: "pix-sessions" });
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.options).toEqual({ sources: ["pix-sessions"] });
  });

  it("ignores updates and successful in-flight results while all historical sections sleep", async () => {
    const { store, calls } = setup();
    const first = store.open();
    calls[0]!.resolve({ snapshots: [snap("pix-sessions", 1)] });
    await first;
    const interrupted = store.refresh();
    store.handleChanged({ source: "pix-sessions" });
    store.close();
    calls[1]!.resolve({ snapshots: [snap("pix-sessions", 2)] });
    await interrupted;
    store.handleChanged({ source: "pix-sessions" });
    await store.refresh();
    await flush();
    expect(calls).toHaveLength(2);
    expect(store.snapshot("pix-sessions")?.fetchedAtMs).toBe(1);
    const reopened = store.open();
    expect(calls).toHaveLength(3);
    calls[2]!.resolve({ snapshots: [snap("pix-sessions", 3)] });
    await reopened;
    expect(store.snapshot("pix-sessions")?.fetchedAtMs).toBe(3);
    store.dispose();
  });

  it("clears foreign cached data without fetching when the workspace changes while asleep", async () => {
    const { store, calls, setWorkspace } = setup();
    const first = store.open();
    calls[0]!.resolve({ snapshots: [snap("pix-sessions")] });
    await first;
    store.close();
    setWorkspace("/w/b");
    store.close();
    expect(store.snapshots.size).toBe(0);
    expect(calls).toHaveLength(1);
    store.dispose();
  });

  it("reports current request failures once and stops after dispose", async () => {
    const { store, calls, errors } = setup();
    const opening = store.open();
    const failure = new Error("boom");
    calls[0]!.reject(failure);
    await opening;
    expect(errors).toEqual([failure]);
    expect(store.busy).toBe(false);

    const pending = store.refresh();
    store.dispose();
    calls[1]!.resolve({ snapshots: [snap("pix-sessions")] });
    await pending;
    expect(store.snapshots.size).toBe(0);
    await store.open();
    await store.refresh();
    expect(calls).toHaveLength(2);
  });
});

describe("usage stats remount cache", () => {
  it("renders the last snapshots immediately in a remounted store for the same connection and project", async () => {
    const { client, calls } = fakeClient();
    const options = { client: () => client, workspace: () => "/w/cache", reportError: () => {} };
    const first = createUsageStatsStore(options);
    const opening = first.open();
    calls[0]!.resolve({ snapshots: [snap("pix-sessions", 7)] });
    await opening;
    first.dispose();
    const second = createUsageStatsStore(options);
    expect(second.snapshot("pix-sessions")?.fetchedAtMs).toBe(7);
    void second.open();
    expect(second.snapshot("pix-sessions")?.fetchedAtMs).toBe(7);
    expect(calls).toHaveLength(2);
    const other = createUsageStatsStore({ ...options, workspace: () => "/w/other" });
    expect(other.snapshots.size).toBe(0);
  });
});
