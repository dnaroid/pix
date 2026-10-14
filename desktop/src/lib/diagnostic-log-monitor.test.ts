import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiagnosticLogMonitor, filterDiagnosticLogs, type DiagnosticLogEntry, type DiagnosticLogSnapshot } from "./diagnostic-log-monitor";

const snapshot: DiagnosticLogSnapshot = { entries: [], limited: false, skipped: 0 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { resolve, promise };
}
afterEach(() => vi.useRealTimers());

describe("diagnostic log monitoring", () => {
  it("does not read until started, prevents overlapping reads, and stops timers", async () => {
    vi.useFakeTimers();
    const pending = deferred<DiagnosticLogSnapshot>();
    const read = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(snapshot);
    const publish = vi.fn();
    const monitor = createDiagnosticLogMonitor(read, publish);
    expect(read).not.toHaveBeenCalled();
    monitor.start();
    monitor.start();
    await monitor.refresh();
    await vi.advanceTimersByTimeAsync(6000);
    expect(read).toHaveBeenCalledOnce();
    pending.resolve(snapshot);
    await vi.advanceTimersByTimeAsync(0);
    expect(publish.mock.lastCall?.[0]).toEqual({ snapshot, error: null, loading: false });
    await vi.advanceTimersByTimeAsync(2000);
    expect(read).toHaveBeenCalledTimes(2);
    monitor.stop();
    await vi.advanceTimersByTimeAsync(6000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores stopped results and resumes only after the old IPC finishes", async () => {
    vi.useFakeTimers();
    const old = deferred<DiagnosticLogSnapshot>();
    const read = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(snapshot);
    const publish = vi.fn();
    const monitor = createDiagnosticLogMonitor(read, publish);
    monitor.start();
    monitor.stop();
    expect(publish.mock.lastCall?.[0]).toEqual({ snapshot: null, error: null, loading: false });
    const count = publish.mock.calls.length;
    monitor.start();
    old.resolve({ ...snapshot, skipped: 99 });
    await vi.advanceTimersByTimeAsync(0);
    expect(publish.mock.calls.slice(count).some(([state]) => state.snapshot?.skipped === 99)).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
    expect(publish.mock.lastCall?.[0]).toMatchObject({ snapshot, loading: false });
    monitor.stop();
  });

  it("preserves last snapshot on failure, retries, and never publishes after disposal", async () => {
    vi.useFakeTimers();
    const pending = deferred<DiagnosticLogSnapshot>();
    const read = vi.fn().mockResolvedValueOnce(snapshot).mockRejectedValueOnce("disk unavailable").mockReturnValueOnce(pending.promise);
    const publish = vi.fn();
    const monitor = createDiagnosticLogMonitor(read, publish);
    monitor.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(publish.mock.lastCall?.[0]).toMatchObject({ snapshot, error: "disk unavailable", loading: false });
    await vi.advanceTimersByTimeAsync(2000);
    monitor.stop();
    const count = publish.mock.calls.length;
    pending.resolve(snapshot);
    await vi.advanceTimersByTimeAsync(5000);
    expect(publish).toHaveBeenCalledTimes(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("combines exact level/source/project filters with literal detail search", () => {
    const entries: DiagnosticLogEntry[] = [
      { id: "1", record: { v: 1, time: "now", level: "error", source: "acp", module: "requests", event: "failure", project: { name: "one", path: "/one" }, details: { diagnostic: "Connection closed" } } },
      { id: "2", record: { v: 1, time: "now", level: "warn", source: "desktop", module: "native", event: "failure", project: null } },
    ];
    expect(filterDiagnosticLogs(entries, { level: "error", source: "acp", project: "/one", query: " CLOSED " }).map(e => e.id)).toEqual(["1"]);
    expect(filterDiagnosticLogs(entries, { level: "", source: "", project: "/two", query: "" })).toEqual([]);
    expect(filterDiagnosticLogs(entries, { level: "", source: "", project: null, query: "" })).toHaveLength(2);
  });

  it("clears a paused snapshot and never restores a pre-clear in-flight read", async () => {
    vi.useFakeTimers();
    const old = deferred<DiagnosticLogSnapshot>();
    const before = { ...snapshot, skipped: 17 };
    const read = vi.fn().mockResolvedValueOnce(before).mockReturnValueOnce(old.promise).mockResolvedValue(snapshot);
    const publish = vi.fn();
    const monitor = createDiagnosticLogMonitor(read, publish);
    monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(publish.mock.lastCall?.[0].snapshot).toBe(before);
    await vi.advanceTimersByTimeAsync(2000);
    monitor.stop();
    monitor.discardSnapshot();
    expect(publish.mock.lastCall?.[0]).toEqual({ snapshot: null, error: null, loading: false });
    const count = publish.mock.calls.length;
    old.resolve(before);
    await vi.advanceTimersByTimeAsync(6000);
    expect(publish).toHaveBeenCalledTimes(count);
    expect(read).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(publish.mock.lastCall?.[0]).toMatchObject({ snapshot, loading: false });
    monitor.stop();
  });

  it("waits out a pre-clear read before resuming with a fresh snapshot", async () => {
    vi.useFakeTimers();
    const old = deferred<DiagnosticLogSnapshot>();
    const read = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(snapshot);
    const publish = vi.fn();
    const monitor = createDiagnosticLogMonitor(read, publish);
    monitor.start();
    monitor.stop();
    monitor.discardSnapshot();
    monitor.start();
    const count = publish.mock.calls.length;
    old.resolve({ ...snapshot, skipped: 99 });
    await vi.advanceTimersByTimeAsync(0);
    expect(publish.mock.calls.slice(count).some(([state]) => state.snapshot?.skipped === 99)).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
    expect(publish.mock.lastCall?.[0]).toMatchObject({ snapshot, loading: false });
    monitor.stop();
  });
});
