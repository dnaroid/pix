import { afterEach, describe, expect, it, vi } from "vitest";
import { RegistryBackgroundSyncCoordinator } from "./registry-background-sync";

afterEach(() => {
  vi.useRealTimers();
});

describe("RegistryBackgroundSyncCoordinator", () => {
  it("debounces repeated task writes into one tasks push", async () => {
    vi.useFakeTimers();
    const sync = vi.fn(async () => {});
    const coordinator = new RegistryBackgroundSyncCoordinator({
      canSync: () => true,
      sync,
      onChange: () => {},
      debounceMs: 100,
    });

    coordinator.mark("tasks");
    await vi.advanceTimersByTimeAsync(50);
    coordinator.mark("tasks");
    await vi.advanceTimersByTimeAsync(99);
    expect(sync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledWith("tasks");
    expect(coordinator.state.phase).toBe("idle");
  });

  it("coalesces different project artifacts into one project push", async () => {
    vi.useFakeTimers();
    const sync = vi.fn(async () => {});
    const coordinator = new RegistryBackgroundSyncCoordinator({
      canSync: () => true,
      sync,
      onChange: () => {},
      debounceMs: 100,
    });

    coordinator.mark("tasks");
    coordinator.mark("plans");
    await vi.advanceTimersByTimeAsync(100);
    expect(sync).toHaveBeenCalledWith("project");
  });

  it("runs another debounced push when state changes during an in-flight sync", async () => {
    vi.useFakeTimers();
    let resolveFirst!: () => void;
    const first = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const sync = vi.fn()
      .mockImplementationOnce(async () => first)
      .mockImplementationOnce(async () => {});
    const coordinator = new RegistryBackgroundSyncCoordinator({
      canSync: () => true,
      sync,
      onChange: () => {},
      debounceMs: 100,
    });

    coordinator.mark("tasks");
    await vi.advanceTimersByTimeAsync(100);
    expect(coordinator.state.phase).toBe("syncing");
    coordinator.mark("todo");
    resolveFirst();
    await Promise.resolve();
    await Promise.resolve();
    expect(coordinator.state.phase).toBe("pending");
    await vi.advanceTimersByTimeAsync(100);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync.mock.calls[1]?.[0]).toBe("todo");
  });

  it("keeps pending work while the session is busy and retries later", async () => {
    vi.useFakeTimers();
    let ready = false;
    const sync = vi.fn(async () => {});
    const coordinator = new RegistryBackgroundSyncCoordinator({
      canSync: () => ready,
      sync,
      onChange: () => {},
      debounceMs: 100,
      retryMs: 50,
    });

    coordinator.mark("tasks");
    await vi.advanceTimersByTimeAsync(100);
    expect(sync).not.toHaveBeenCalled();
    expect(coordinator.state.phase).toBe("pending");
    ready = true;
    await vi.advanceTimersByTimeAsync(50);
    expect(sync).toHaveBeenCalledWith("tasks");
  });

  it("surfaces terminal sync errors and retries retained dirty work after a new edit", async () => {
    vi.useFakeTimers();
    const sync = vi.fn()
      .mockRejectedValueOnce(new Error("remote changed"))
      .mockResolvedValueOnce(undefined);
    const coordinator = new RegistryBackgroundSyncCoordinator({
      canSync: () => true,
      sync,
      onChange: () => {},
      debounceMs: 100,
    });

    coordinator.mark("tasks");
    await vi.advanceTimersByTimeAsync(100);
    expect(coordinator.state).toMatchObject({ phase: "error", error: "remote changed" });
    coordinator.mark("todo");
    await vi.advanceTimersByTimeAsync(100);
    expect(sync.mock.calls[1]?.[0]).toBe("project");
    expect(coordinator.state.phase).toBe("idle");
  });
});
