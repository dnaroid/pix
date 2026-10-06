import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeQuotaRefreshStatus, RuntimeStatus } from "../lib/acp-client";
import { createSessionRuntimeStatus } from "./session-runtime-status.svelte";

const quota = {
  provider: "anthropic", modelKey: "pi-claude-code-provider/sonnet", updatedAt: Date.now(),
  hourly: { remainingPercent: 80, resetAt: Date.now() + 60_000, windowSeconds: 18_000 },
} as const;

function setup() {
  let ready = true;
  const runtimeStatus = vi.fn(async (): Promise<RuntimeStatus> => ({ sessionId: "a", modelUsageRefresh: "failed" }));
  const claudeQuotaRefresh = vi.fn(async (): Promise<ClaudeQuotaRefreshStatus> => ({ sessionId: "a", launched: true, refresh: "failed" }));
  const client = { runtimeStatus, claudeQuotaRefresh };
  const store = createSessionRuntimeStatus({
    client: () => client as unknown as NonNullable<ReturnType<Parameters<typeof createSessionRuntimeStatus>[0]["client"]>>,
    isReady: () => ready,
  });
  return { store, runtimeStatus, claudeQuotaRefresh, setReady: (value: boolean) => { ready = value; } };
}

describe("bounded startup quota retries", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("recovers failed first lookup within seconds without launching the CLI", async () => {
    const { store, runtimeStatus, claudeQuotaRefresh } = setup();
    await store.refreshStatus("a", true);
    runtimeStatus.mockResolvedValue({ sessionId: "a", modelUsageRefresh: "ready", modelUsage: quota });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(runtimeStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runtimeStatus).toHaveBeenCalledTimes(2);
    expect(store.statuses.get("a")?.modelUsage).toEqual(quota);
    expect(claudeQuotaRefresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("also retries a rejected runtime-status transport request", async () => {
    const { store, runtimeStatus } = setup();
    runtimeStatus.mockRejectedValueOnce(new Error("transport timeout"));
    await store.refreshStatus("a", true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runtimeStatus).toHaveBeenCalledTimes(2);
    store.reset();
  });

  it("bounds retries to three delays, then returns to ordinary polling", async () => {
    const { store, runtimeStatus } = setup();
    await store.refreshStatus("a", true);
    for (const delay of [5_000, 15_000, 30_000]) await vi.advanceTimersByTimeAsync(delay);
    expect(runtimeStatus).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(runtimeStatus).toHaveBeenCalledTimes(4);
    // A later periodic failure does not rearm the spent startup budget.
    await store.refreshStatus("a", true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries failed quota reread after the one startup login nudge", async () => {
    const { store, runtimeStatus, claudeQuotaRefresh } = setup();
    runtimeStatus.mockResolvedValueOnce({ sessionId: "a", modelUsageRefresh: "unavailable", modelUsageCredentialPending: true });
    await store.refreshStatus("a", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(claudeQuotaRefresh).toHaveBeenCalledTimes(1);
    runtimeStatus.mockResolvedValue({ sessionId: "a", modelUsageRefresh: "ready", modelUsage: quota });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.statuses.get("a")?.modelUsage).toEqual(quota);
    expect(claudeQuotaRefresh).toHaveBeenCalledTimes(1);
  });

  for (const outcome of ["ready", "unavailable", "skipped"] as const) {
    it(`does not retry ${outcome} or later failures after authoritative ${outcome}`, async () => {
      const { store, runtimeStatus } = setup();
      runtimeStatus.mockResolvedValueOnce({ sessionId: "a", modelUsageRefresh: outcome });
      await store.refreshStatus("a", true);
      expect(vi.getTimerCount()).toBe(0);
      if (outcome !== "skipped") {
        await store.refreshStatus("a", true);
        expect(vi.getTimerCount()).toBe(0);
      }
    });
  }

  for (const invalidate of ["forget", "reset", "header", "not-ready"] as const) {
    it(`cancels pending recovery on ${invalidate}`, async () => {
      const { store, runtimeStatus, setReady } = setup();
      await store.refreshStatus("a", true);
      if (invalidate === "forget") store.forget("a");
      if (invalidate === "reset") store.reset();
      if (invalidate === "not-ready") setReady(false);
      if (invalidate === "header") store.handleSessionState({ sessionId: "a", channel: "model-usage", data: { ...quota, source: "headers" } });
      await vi.advanceTimersByTimeAsync(50_000);
      expect(runtimeStatus).toHaveBeenCalledTimes(1);
      store.reset();
    });
  }

  it("a newer quota check cancels the timer, while context-only updates do not", async () => {
    const { store, runtimeStatus } = setup();
    await store.refreshStatus("a", true);
    runtimeStatus.mockResolvedValueOnce({ sessionId: "a", modelUsageRefresh: "skipped" });
    await store.refreshStatus("a");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runtimeStatus).toHaveBeenCalledTimes(3);
    runtimeStatus.mockResolvedValueOnce({ sessionId: "a", modelUsageRefresh: "ready", modelUsage: quota });
    await store.refreshStatus("a", true);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(runtimeStatus).toHaveBeenCalledTimes(4);
  });

  it("does not schedule recovery from a superseded rejected request", async () => {
    const { store, runtimeStatus } = setup();
    let reject!: (reason: Error) => void;
    runtimeStatus.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const old = store.refreshStatus("a", true);
    runtimeStatus.mockResolvedValueOnce({ sessionId: "a", modelUsageRefresh: "ready", modelUsage: quota });
    await store.refreshStatus("a", true);
    reject(new Error("old timeout"));
    await old;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not recover a rejected request predating pushed header telemetry", async () => {
    const { store, runtimeStatus } = setup();
    let reject!: (reason: Error) => void;
    runtimeStatus.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const old = store.refreshStatus("a", true);
    store.handleSessionState({ sessionId: "a", channel: "model-usage", data: { ...quota, source: "headers" } });
    reject(new Error("pre-auth-switch timeout"));
    await old;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rearms the spent retry budget only for a new runtime owner", async () => {
    const { store, runtimeStatus } = setup();
    await store.refreshStatus("a", true);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(runtimeStatus).toHaveBeenCalledTimes(4);
    store.forget("a");
    await store.refreshStatus("a", true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runtimeStatus).toHaveBeenCalledTimes(6);
    store.reset();
  });
});
