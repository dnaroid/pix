import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopWatchRestart } from "./desktop-watch-restart.svelte";

afterEach(() => vi.useRealTimers());

describe("Desktop watcher status", () => {
  it("restores Restart after cancelled confirmation and allows a confirmed retry", async () => {
    vi.useFakeTimers();
    let respond!: (requested: boolean) => void;
    const invoke = vi.fn((command: string) => command === "desktop_watch_status"
      ? Promise.resolve({ available: true, buildStatus: "building" })
      : new Promise<boolean>((resolve) => { respond = resolve; }));
    const watcher = createDesktopWatchRestart({ invoke: invoke as never });
    const stop = watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    const cancelled = watcher.restart();
    expect(watcher.restarting).toBe(true);
    await watcher.restart();
    expect(invoke.mock.calls.filter(([command]) => command === "desktop_watch_restart")).toHaveLength(1);
    respond(false);
    await cancelled;
    expect(watcher.restarting).toBe(false);
    expect(watcher.available).toBe(true);
    expect(watcher.buildStatus).toBe("building");
    const confirmed = watcher.restart();
    respond(true);
    await confirmed;
    expect(watcher.restarting).toBe(true);
    expect(invoke.mock.calls.filter(([command]) => command === "desktop_watch_restart")).toHaveLength(2);
    stop();
  });

  it("ignores cancelled confirmation from an old lifecycle during a new restart", async () => {
    vi.useFakeTimers();
    const responses: Array<(requested: boolean) => void> = [];
    const invoke = vi.fn((command: string) => command === "desktop_watch_status"
      ? Promise.resolve({ available: true, buildStatus: "idle" })
      : new Promise<boolean>((resolve) => { responses.push(resolve); }));
    const watcher = createDesktopWatchRestart({ invoke: invoke as never });
    const stopOld = watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    const oldRestart = watcher.restart();
    stopOld();
    const stopNew = watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(watcher.restarting).toBe(false);
    const newRestart = watcher.restart();
    responses[0]!(false);
    await oldRestart;
    expect(watcher.restarting).toBe(true);
    responses[1]!(false);
    await newRestart;
    expect(watcher.restarting).toBe(false);
    stopNew();
  });

  it("restores Restart after a command failure", async () => {
    vi.useFakeTimers();
    const invoke = vi.fn((command: string) => command === "desktop_watch_status"
      ? Promise.resolve({ available: true, buildStatus: "idle" })
      : Promise.reject(new Error("restart failed")));
    const watcher = createDesktopWatchRestart({ invoke: invoke as never });
    const stop = watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    await watcher.restart();
    expect(watcher.restarting).toBe(false);
    expect(watcher.available).toBe(true);
    stop();
  });

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

  it("does not resume polling after a restart error arrives after teardown", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const invoke = vi.fn((command: string) => {
      if (command === "desktop_watch_status") return Promise.resolve({ available: true, buildStatus: "idle" });
      return new Promise((_resolve, fail) => { reject = fail; });
    });
    const watcher = createDesktopWatchRestart({ invoke: invoke as never });
    const stop = watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    const restarting = watcher.restart();
    stop();
    reject(new Error("late restart failure"));
    await restarting;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["desktop_watch_status", "desktop_watch_restart"]);
  });

  it("allows a new lifecycle to poll without an abandoned response unlocking its active poll", async () => {
    vi.useFakeTimers();
    const completions: Array<(value: unknown) => void> = [];
    const invoke = vi.fn(() => new Promise((resolve) => { completions.push(resolve); }));
    const watcher = createDesktopWatchRestart({ invoke: invoke as never });
    const stopOld = watcher.start();
    stopOld();
    const stopNew = watcher.start();
    expect(invoke).toHaveBeenCalledTimes(2);
    completions[0]!({ available: true, buildStatus: "failed" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(watcher.buildStatus).toBe("idle");
    completions[1]!({ available: true, buildStatus: "building" });
    await vi.advanceTimersByTimeAsync(0);
    expect(watcher.buildStatus).toBe("building");
    // Calling an obsolete cleanup must not cancel the newer lifecycle.
    stopOld();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(invoke).toHaveBeenCalledTimes(3);
    stopNew();
    completions[2]!({ available: true, buildStatus: "idle" });
  });
});
