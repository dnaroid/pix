import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopWatchRestart } from "./desktop-watch-restart.svelte";

afterEach(() => vi.useRealTimers());

describe("Desktop watcher status", () => {
  it("polls queued, building, failed and ready state without hiding a ready artifact", async () => {
    vi.useFakeTimers();
    const invoke = vi.fn()
      .mockResolvedValueOnce({ available: true, buildStatus: "queued" })
      .mockResolvedValueOnce({ available: true, buildStatus: "building" })
      .mockResolvedValueOnce({ available: true, buildStatus: "failed" })
      .mockResolvedValueOnce({ available: true, buildStatus: "idle" });
    const watcher = createDesktopWatchRestart({ invoke });
    const stop = watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(watcher.buildStatus).toBe("queued");
    for (const status of ["building", "failed", "idle"]) {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(watcher.buildStatus).toBe(status);
      expect(watcher.available).toBe(true);
    }
    expect(invoke).toHaveBeenCalledWith("desktop_watch_status");
    stop();
  });

  it("does not overlap polls or apply a late completion after teardown", async () => {
    vi.useFakeTimers();
    let resolve!: (value: unknown) => void;
    const invoke = vi.fn(() => new Promise((done) => { resolve = done; }));
    const watcher = createDesktopWatchRestart({ invoke: invoke as never });
    const stop = watcher.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(invoke).toHaveBeenCalledTimes(1);
    stop();
    resolve({ available: true, buildStatus: "failed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(watcher.available).toBe(false);
    expect(watcher.buildStatus).toBe("idle");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("hides status when no watcher state is available", async () => {
    vi.useFakeTimers();
    const watcher = createDesktopWatchRestart({ invoke: vi.fn().mockRejectedValue(new Error("no state")) });
    const stop = watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(watcher.available).toBe(false);
    expect(watcher.buildStatus).toBe("idle");
    stop();
  });
});
