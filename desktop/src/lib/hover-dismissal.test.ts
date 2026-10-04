import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHoverDismissal, HOVER_DISMISS_DELAY_MS } from "./hover-dismissal";

describe("hover dismissal grace period", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps the popup available during pointer travel and closes after departure", () => {
    const hover = createHoverDismissal();
    const dismiss = vi.fn();
    hover.schedule(() => false, dismiss);
    vi.advanceTimersByTime(HOVER_DISMISS_DELAY_MS - 1);
    expect(dismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(dismiss).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels on reentry without closing a later opening", () => {
    const hover = createHoverDismissal();
    const dismiss = vi.fn();
    hover.schedule(() => false, dismiss);
    vi.advanceTimersByTime(100);
    hover.cancel();
    vi.advanceTimersByTime(HOVER_DISMISS_DELAY_MS);
    expect(dismiss).not.toHaveBeenCalled();
    hover.schedule(() => false, dismiss);
    vi.advanceTimersByTime(HOVER_DISMISS_DELAY_MS);
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("rechecks pointer or focus ownership at expiry", () => {
    const hover = createHoverDismissal();
    const dismiss = vi.fn();
    let retained = false;
    hover.schedule(() => retained, dismiss);
    retained = true;
    vi.advanceTimersByTime(HOVER_DISMISS_DELAY_MS);
    expect(dismiss).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("replaces old departures rather than letting them close a sibling", () => {
    const hover = createHoverDismissal();
    const oldDismiss = vi.fn();
    const newDismiss = vi.fn();
    hover.schedule(() => false, oldDismiss);
    vi.advanceTimersByTime(100);
    hover.schedule(() => false, newDismiss);
    vi.advanceTimersByTime(100);
    expect(oldDismiss).not.toHaveBeenCalled();
    expect(newDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(newDismiss).toHaveBeenCalledOnce();
  });

  it("cancels delayed work for immediate dismissal", () => {
    const hover = createHoverDismissal();
    const dismiss = vi.fn();
    hover.schedule(() => false, dismiss);
    hover.cancel();
    dismiss();
    vi.advanceTimersByTime(HOVER_DISMISS_DELAY_MS);
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("releases timers on teardown and ignores later scheduling", () => {
    const hover = createHoverDismissal();
    const dismiss = vi.fn();
    hover.schedule(() => false, dismiss);
    hover.dispose();
    expect(vi.getTimerCount()).toBe(0);
    hover.schedule(() => false, dismiss);
    vi.advanceTimersByTime(HOVER_DISMISS_DELAY_MS);
    expect(dismiss).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
