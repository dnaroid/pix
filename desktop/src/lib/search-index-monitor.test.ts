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
    await monitor.refresh();
    expect(signal.aborted).toBe(true);
    const calls = onChange.mock.calls.length;
    stale.resolve({ stores: [{ id: "code", state: "error", counts: {} }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(onChange).toHaveBeenCalledTimes(calls);
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
      consentError: "Semantic settings could not be read", activityError: "Search activity could not be read" });
    await monitor.refresh();
    expect(onChange.mock.lastCall?.[0]).toMatchObject({ stores, consent, activity: active, consentError: "", activityError: "" });
    monitor.dispose();
  });
});
