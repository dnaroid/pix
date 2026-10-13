import { afterEach, describe, expect, it, vi } from "vitest";
import { monitorSearchIndexes, type SearchIndexSnapshot } from "./search-index-monitor";
import type { SearchIndexActivity, SearchIndexStatus, SemanticConsent } from "./search-index-status";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { resolve, promise };
}
const stores: SearchIndexStatus = { stores: [] };
const consent: SemanticConsent = { configured: true, keyAvailable: true, provider: "ollama", model: "m", vectorSize: 3 };
const active: SearchIndexActivity = { indexingSources: { settings: false, tasks: true, sessions: false } };
afterEach(() => vi.useRealTimers());

describe("read-only index monitor", () => {
  it("retries an initial freshness transport failure without previous rows or selection", async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const freshness = { tasks: { state: "untracked" as const, coverage: "unknown" as const, detail: "No recorded pass" } };
    const readFreshness = vi.fn().mockRejectedValueOnce(new Error("starting")).mockResolvedValue(freshness);
    const monitor = monitorSearchIndexes({ readStores: async () => stores, readConsent: async () => consent,
      readFreshness, onChange });
    await vi.advanceTimersByTimeAsync(1000);
    expect(readFreshness).toHaveBeenCalledTimes(2);
    expect(onChange.mock.lastCall?.[0]).toMatchObject({ stores, freshness });
    monitor.dispose();
  });
  it("retries startup failures with bounded backoff and returns to idle polling after recovery", async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const readStores = vi.fn().mockRejectedValueOnce("starting").mockRejectedValueOnce("busy").mockResolvedValue(stores);
    const monitor = monitorSearchIndexes({ readStores, readConsent: async () => consent, onChange });
    await vi.advanceTimersByTimeAsync(999);
    expect(readStores).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(readStores).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(onChange.mock.lastCall?.[0]).toMatchObject({ stores, error: "" });
    await vi.advanceTimersByTimeAsync(29999);
    expect(readStores).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(readStores).toHaveBeenCalledTimes(4);
    monitor.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps timestamped last-read counts during transient failures, then replaces them after recovery", async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const replacement = { stores: [{ id: "tasks" as const, state: "absent" as const, counts: {} }] };
    const readStores = vi.fn().mockResolvedValueOnce(stores).mockRejectedValueOnce("locked").mockResolvedValue(replacement);
    const monitor = monitorSearchIndexes({ readStores, readConsent: async () => consent, onChange });
    await vi.advanceTimersByTimeAsync(0);
    const checkedAt = onChange.mock.lastCall?.[0].storesCheckedAt;
    await monitor.refresh();
    expect(onChange.mock.lastCall?.[0]).toMatchObject({ stores, storesCheckedAt: checkedAt });
    expect(onChange.mock.lastCall?.[0].error).toContain("locked");
    await vi.advanceTimersByTimeAsync(1000);
    expect(onChange.mock.lastCall?.[0]).toMatchObject({ stores: replacement, error: "" });
    expect(onChange.mock.lastCall?.[0].storesCheckedAt).toBeGreaterThan(checkedAt);
    monitor.dispose();
  });
  it("bounds failure details and handles unstructured rejections", async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const readStores = vi.fn().mockRejectedValueOnce(`Native\n${"x".repeat(400)}`).mockRejectedValueOnce(null);
    const monitor = monitorSearchIndexes({ readStores, readConsent: async () => consent, onChange });
    await vi.advanceTimersByTimeAsync(0);
    const error = onChange.mock.lastCall?.[0].error;
    expect(error).toBe(`Could not read index status. ${`Native ${"x".repeat(400)}`.slice(0, 240)}. Retrying automatically.`);
    await monitor.refresh();
    expect(onChange.mock.lastCall?.[0].error).toBe("Could not read index status. Retrying automatically.");
    monitor.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("preserves native string rejections and clears them after recovery", async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const readStores = vi.fn().mockRejectedValueOnce("Selected workspace is unavailable").mockResolvedValue(stores);
    const monitor = monitorSearchIndexes({ readStores, readConsent: async () => consent, onChange });
    await vi.advanceTimersByTimeAsync(0);
    expect(onChange.mock.lastCall?.[0]).toMatchObject({ stores: null,
      error: "Could not read index status. Selected workspace is unavailable. Retrying automatically." });
    await monitor.refresh();
    expect(onChange.mock.lastCall?.[0]).toMatchObject({ stores, error: "" });
    monitor.dispose();
  });
  it("forces manual freshness checks and degrades failed observations without losing historical coverage", async () => {
    vi.useFakeTimers();
    const freshness = { tasks: { state: "current", coverage: "complete", detail: "checked" } };
    const readFreshness = vi.fn().mockResolvedValue(freshness);
    const onChange = vi.fn();
    const monitor = monitorSearchIndexes({ readStores: async () => stores, readConsent: async () => consent, readFreshness, onChange });
    await vi.advanceTimersByTimeAsync(0);
    expect(readFreshness.mock.lastCall?.[1]).toBe(true);
    await vi.advanceTimersByTimeAsync(30000);
    expect(readFreshness.mock.lastCall?.[1]).toBe(false);
    expect(onChange.mock.lastCall?.[0].freshness).toEqual(freshness);
    readFreshness.mockRejectedValue(new Error("check unavailable"));
    await monitor.refresh();
    expect(readFreshness.mock.lastCall?.[1]).toBe(true);
    expect(onChange.mock.lastCall?.[0]).toMatchObject({ stores, freshness: { tasks: { state: "unchecked", coverage: "complete", runState: undefined } } });
    monitor.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps healthy readers polling when one transport hangs, without duplicating that transport", async () => {
    vi.useFakeTimers();
    const late = deferred<SearchIndexActivity>();
    const readActivity = vi.fn((_signal: AbortSignal) => late.promise);
    const readStores = vi.fn().mockResolvedValue(stores);
    const onChange = vi.fn();
    const monitor = monitorSearchIndexes({ readStores, readConsent: async () => consent, readActivity,
      isIndexing: () => true, readTimeoutMs: 100, activeIntervalMs: 10, onChange });
    await vi.advanceTimersByTimeAsync(100);
    expect(onChange.mock.lastCall?.[0]).toMatchObject({ stores, consent, reading: false,
      activity: null, activityError: "Search activity could not be read. Search diagnostic read timed out. Retrying automatically." });
    expect(readActivity.mock.calls[0]![0].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(30);
    expect(readStores).toHaveBeenCalledTimes(4);
    expect(readActivity).toHaveBeenCalledTimes(1);
    late.resolve(active);
    await vi.advanceTimersByTimeAsync(0);
    expect(onChange.mock.lastCall?.[0].activity).toBeNull();
    monitor.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("isolates synchronous reader failures and still settles the refresh", async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const monitor = monitorSearchIndexes({ readStores: () => { throw new Error("native transport unavailable"); },
      readConsent: async () => consent, onChange });
    await vi.advanceTimersByTimeAsync(0);
    expect(onChange.mock.lastCall?.[0]).toMatchObject({ stores: null, consent, reading: false,
      error: "Could not read index status. native transport unavailable. Retrying automatically." });
    monitor.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("polls quietly every 30 seconds while idle and never overlaps timer reads", async () => {
    vi.useFakeTimers();
    const late = deferred<SearchIndexStatus>();
    const snapshots: SearchIndexSnapshot[] = [];
    const readStores = vi.fn().mockResolvedValueOnce(stores).mockReturnValueOnce(late.promise).mockResolvedValue(stores);
    const monitor = monitorSearchIndexes({ readStores, readConsent: async () => consent, onChange: value => snapshots.push(value) });
    await vi.advanceTimersByTimeAsync(29999);
    expect(readStores).toHaveBeenCalledTimes(1);
    const before = snapshots.length;
    await vi.advanceTimersByTimeAsync(1);
    expect(readStores).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(90000);
    expect(readStores).toHaveBeenCalledTimes(2);
    expect(snapshots.slice(before).every(value => !value.reading)).toBe(true);
    late.resolve(stores);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30000);
    expect(readStores).toHaveBeenCalledTimes(3);
    monitor.dispose();
  });
  it("uses fast quiet checks only while an individual source is active", async () => {
    vi.useFakeTimers();
    let manual = true;
    const readStores = vi.fn().mockResolvedValue(stores);
    const readActivity = vi.fn().mockResolvedValue({ indexing: true });
    const monitor = monitorSearchIndexes({ readStores, readConsent: async () => consent, readActivity,
      isIndexing: () => manual, onChange: () => {} });
    await vi.advanceTimersByTimeAsync(1500);
    expect(readStores).toHaveBeenCalledTimes(2);
    manual = false;
    await vi.advanceTimersByTimeAsync(1500);
    expect(readStores).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(29999);
    expect(readStores).toHaveBeenCalledTimes(3);
    readActivity.mockResolvedValue(active);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(readStores).toHaveBeenCalledTimes(5);
    monitor.dispose();
  });
  it("publishes independent reads without blanking prior results on refresh", async () => {
    vi.useFakeTimers();
    const activity = deferred<SearchIndexActivity>();
    const snapshots: SearchIndexSnapshot[] = [];
    const readStores = vi.fn().mockResolvedValue(stores);
    const monitor = monitorSearchIndexes({ readStores, readConsent: async () => consent,
      readActivity: () => activity.promise, onChange: s => snapshots.push(s) });
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots.at(-1)).toMatchObject({ stores, consent, reading: true, activity: null });
    activity.resolve(active);
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots.at(-1)).toMatchObject({ activity: active, reading: false });
    const before = snapshots.length;
    await monitor.refresh();
    expect(snapshots[before]).toMatchObject({ stores, consent, activity: active, reading: true });
    monitor.dispose();
    await vi.advanceTimersByTimeAsync(10000);
    expect(readStores).toHaveBeenCalledTimes(2);
  });
  it("ignores old completions and cancels polling after teardown", async () => {
    vi.useFakeTimers();
    const stale = deferred<SearchIndexStatus>();
    const onChange = vi.fn();
    const readStores = vi.fn().mockReturnValueOnce(stale.promise).mockResolvedValue(stores);
    const monitor = monitorSearchIndexes({ readStores, readConsent: async () => consent, onChange });
    const signal = readStores.mock.calls[0]![0] as AbortSignal;
    const refreshed = monitor.refresh();
    expect(signal.aborted).toBe(true);
    expect(readStores).toHaveBeenCalledTimes(1);
    stale.resolve({ stores: [{ id: "code", state: "error", counts: {} }] });
    await refreshed;
    expect(readStores).toHaveBeenCalledTimes(2);
    expect(onChange.mock.lastCall?.[0]).toMatchObject({ stores, error: "" });
    const calls = onChange.mock.calls.length;
    monitor.dispose();
    await vi.advanceTimersByTimeAsync(10000);
    expect(onChange).toHaveBeenCalledTimes(calls);
  });
  it("clears activity after disconnect, without losing successful native counts", async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const readActivity = vi.fn().mockResolvedValueOnce(active).mockRejectedValue(new Error("disconnected"));
    const monitor = monitorSearchIndexes({ readStores: async () => stores, readConsent: async () => consent, readActivity, onChange });
    await vi.advanceTimersByTimeAsync(0);
    await monitor.refresh();
    expect(onChange.mock.lastCall?.[0]).toMatchObject({ stores, consent, activity: null, reading: false });
    monitor.dispose();
  });
  it("reports independent diagnostic errors and clears them after recovery", async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const readConsent = vi.fn().mockRejectedValueOnce(new Error("config unavailable")).mockResolvedValue(consent);
    const readActivity = vi.fn().mockRejectedValueOnce(new Error("RPC unavailable")).mockResolvedValue(active);
    const monitor = monitorSearchIndexes({ readStores: async () => stores, readConsent, readActivity, onChange });
    await vi.advanceTimersByTimeAsync(0);
    expect(onChange.mock.lastCall?.[0]).toMatchObject({ stores, consent: null, activity: null,
      consentError: "Semantic settings could not be read", activityError: "Search activity could not be read. RPC unavailable. Retrying automatically." });
    await monitor.refresh();
    expect(onChange.mock.lastCall?.[0]).toMatchObject({ stores, consent, activity: active, consentError: "", activityError: "" });
    monitor.dispose();
  });
});
