import { afterEach, describe, expect, it, vi } from "vitest";
import { startCompletionSpacedPoll } from "./completion-spaced-poll";

afterEach(() => {
  vi.useRealTimers();
});

describe("completion-spaced poll", () => {
  it("waits for the current task to finish before starting the next delay", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const task = vi.fn(() => new Promise<void>((resolve) => {
      finish = resolve;
    }));
    const stop = startCompletionSpacedPoll({
      delayMs: 30_000,
      shouldRun: () => true,
      task,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(task).toHaveBeenCalledTimes(1);

    finish();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(task).toHaveBeenCalledTimes(2);
    stop();
  });

  it("does not reschedule after disposal while a task is finishing", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const task = vi.fn(() => new Promise<void>((resolve) => {
      finish = resolve;
    }));
    const stop = startCompletionSpacedPoll({
      delayMs: 30_000,
      shouldRun: () => true,
      task,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(task).toHaveBeenCalledTimes(1);
    stop();
    finish();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(task).toHaveBeenCalledTimes(1);
  });
});
