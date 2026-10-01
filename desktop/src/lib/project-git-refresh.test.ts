import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectGitRefresh } from "./project-git-refresh";

afterEach(() => vi.useRealTimers());

describe("Project Explorer local Git refresh", () => {
  it("polls after completion and stops on disposal", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const controller = createProjectGitRefresh(refresh);
    await controller.request();
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    controller.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    await controller.request();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("coalesces refresh/focus/mutation triggers while a request is in flight", async () => {
    vi.useFakeTimers();
    let resolve!: () => void;
    const refresh = vi.fn().mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }))
      .mockResolvedValue(undefined);
    const controller = createProjectGitRefresh(refresh);
    const first = controller.request();
    await controller.request();
    await controller.request();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    resolve();
    await first;
    expect(refresh).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it("does not restart from a stale completion after teardown", async () => {
    vi.useFakeTimers();
    let resolve!: () => void;
    const refresh = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const controller = createProjectGitRefresh(refresh);
    const request = controller.request();
    await controller.request();
    controller.dispose();
    resolve();
    await request;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("retries failed/non-repository reads without failing file browsing", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockRejectedValue(new Error("Not a Git repository"));
    const controller = createProjectGitRefresh(refresh);
    await controller.request();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    controller.dispose();
  });
});
