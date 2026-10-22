import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenRouterUsageStore, resetOpenRouterUsageCacheForTests, type OpenRouterUsage } from "./openrouter-usage.svelte";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const usage: OpenRouterUsage = { balance: 91.36, totalCredits: 594.65, usageDaily: 0.01, usageWeekly: 0.5, usageMonthly: 1.7 };
let items: Map<string, string>;

beforeEach(() => {
  vi.useFakeTimers();
  resetOpenRouterUsageCacheForTests();
  items = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => { items.set(k, v); },
    removeItem: (k: string) => { items.delete(k); },
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("OpenRouter usage store", () => {
  it("loads, persists and restores the snapshot in a fresh app session", async () => {
    const fetch = vi.fn().mockResolvedValue(usage);
    const store = createOpenRouterUsageStore({ reportError: vi.fn(), fetch });
    expect(store.usage).toBeUndefined();
    await store.resume();
    expect(store.usage).toEqual(usage);
    store.dispose();
    resetOpenRouterUsageCacheForTests();
    const restarted = createOpenRouterUsageStore({ reportError: vi.fn(), fetch: () => new Promise(() => {}) });
    expect(restarted.usage).toEqual(usage);
    restarted.dispose();
  });

  it("hides the row when no key is configured and keeps cached data on failure", async () => {
    const reportError = vi.fn();
    const fetch = vi.fn().mockResolvedValueOnce(usage).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(null);
    const store = createOpenRouterUsageStore({ reportError, fetch });
    await store.resume();
    await store.refresh();
    expect(store.error).toBe(true);
    expect(store.usage).toEqual(usage);
    expect(reportError).toHaveBeenCalledTimes(1);
    await store.refresh();
    expect(store.usage).toBeUndefined();
    expect(items.size).toBe(0);
    store.dispose();
  });

  it("polls only while open and drops late results after pause", async () => {
    let resolve!: (value: OpenRouterUsage) => void;
    const fetch = vi.fn().mockImplementation(() => new Promise<OpenRouterUsage>((r) => { resolve = r; }));
    const store = createOpenRouterUsageStore({ reportError: vi.fn(), fetch });
    const loading = store.resume();
    store.pause();
    resolve(usage);
    await loading;
    expect(store.usage).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    store.dispose();
  });
});
