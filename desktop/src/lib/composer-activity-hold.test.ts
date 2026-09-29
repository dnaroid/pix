import { afterEach, describe, expect, it, vi } from "vitest";
import { createComposerActivityHold } from "./composer-activity-hold";

afterEach(() => vi.useRealTimers());

describe("composer activity minimum display time", () => {
  it("shows immediately, holds for a second, and coalesces to the latest without debounce starvation", () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const hold = createComposerActivityHold(publish);
    hold.update({ action: "Reading code", moreCount: 0 });
    expect(publish).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    hold.update({ action: "Thinking", moreCount: 0 });
    vi.advanceTimersByTime(899);
    hold.update({ action: "Making changes", moreCount: 2 });
    expect(publish).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(publish).toHaveBeenLastCalledWith({ action: "Making changes", moreCount: 2 });
    expect(publish).toHaveBeenCalledTimes(2);
    hold.update({ action: "Making changes", moreCount: 1 });
    vi.advanceTimersByTime(999);
    expect(publish).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(publish).toHaveBeenLastCalledWith({ action: "Making changes", moreCount: 1 });
    hold.dispose();
  });

  it("does not republish or restart the hold if the latest status returns to the visible one", () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const hold = createComposerActivityHold(publish);
    const first = { action: "Thinking", moreCount: 0 };
    hold.update(first);
    vi.advanceTimersByTime(50);
    hold.update({ action: "Reading code", moreCount: 0 });
    hold.update(first);
    vi.advanceTimersByTime(950);
    expect(publish).toHaveBeenCalledTimes(1);
    hold.update({ action: "Working", moreCount: 0 });
    expect(publish).toHaveBeenCalledTimes(2);
    hold.dispose();
  });

  it("cancels pending updates on teardown and starts a fresh session immediately", () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const old = createComposerActivityHold(publish);
    old.update({ action: "Reading code", moreCount: 0 });
    old.update({ action: "Making changes", moreCount: 0 });
    old.dispose();
    old.update({ action: "Stale", moreCount: 0 });
    const fresh = createComposerActivityHold(publish);
    fresh.update({ action: "Thinking", moreCount: 0 });
    vi.advanceTimersByTime(2000);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith({ action: "Thinking", moreCount: 0 });
    expect(vi.getTimerCount()).toBe(0);
    fresh.dispose();
  });
});
