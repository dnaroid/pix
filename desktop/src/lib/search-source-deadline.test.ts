import { afterEach, describe, expect, it, vi } from "vitest";
import { runSearchSource, SEARCH_SOURCE_TIMEOUT_MS } from "./search-source-deadline";

afterEach(() => vi.useRealTimers());

describe("progressive source ownership", () => {
  it("ends initial waiting without cancelling work, then releases its listener on late completion", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    let finish!: () => void;
    const operation = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const slow = vi.fn(), complete = vi.fn();
    const initial = runSearchSource(controller.signal, operation, slow, complete);
    await vi.advanceTimersByTimeAsync(SEARCH_SOURCE_TIMEOUT_MS);
    expect(await initial).toBe("pending");
    expect(controller.signal.aborted).toBe(false);
    expect(operation).toHaveBeenCalledWith(controller.signal);
    expect(slow).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(complete).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores completion after cancellation, including after initial waiting ended", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let finish!: () => void;
    const complete = vi.fn();
    const initial = runSearchSource(controller.signal, () => new Promise<void>(resolve => { finish = resolve; }), vi.fn(), complete);
    await vi.advanceTimersByTimeAsync(SEARCH_SOURCE_TIMEOUT_MS);
    expect(await initial).toBe("pending");
    controller.abort();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(complete).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a late rejection exactly once without an unhandled rejection", async () => {
    vi.useFakeTimers();
    const controller = new AbortController(), complete = vi.fn();
    let fail!: (error: Error) => void;
    const initial = runSearchSource(controller.signal, () => new Promise<void>((_, reject) => { fail = reject; }), vi.fn(), complete);
    await vi.advanceTimersByTimeAsync(SEARCH_SOURCE_TIMEOUT_MS);
    expect(await initial).toBe("pending");
    const error = new Error("late failure");
    fail(error);
    await vi.advanceTimersByTimeAsync(0);
    expect(complete).toHaveBeenCalledExactlyOnceWith(error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels before starting a queued operation", async () => {
    const controller = new AbortController(), operation = vi.fn(), complete = vi.fn();
    const initial = runSearchSource(controller.signal, operation, vi.fn(), complete);
    controller.abort();
    expect(await initial).toBe("cancelled");
    expect(operation).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
});
