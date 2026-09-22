import { describe, expect, it, vi } from "vitest";

import { createAnimationFrameCoalescer } from "./animation-frame-coalescer";

describe("createAnimationFrameCoalescer", () => {
  it("runs at most once per frame and can schedule the following frame", () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextHandle = 1;
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle;
    });
    const callback = vi.fn();
    const scheduler = createAnimationFrameCoalescer(callback, requestFrame, vi.fn());

    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();
    expect(requestFrame).toHaveBeenCalledTimes(1);

    callbacks.get(1)?.(10);
    expect(callback).toHaveBeenCalledOnce();

    scheduler.schedule();
    expect(requestFrame).toHaveBeenCalledTimes(2);
  });

  it("cancels teardown-owned work and allows a later schedule", () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextHandle = 1;
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle;
    });
    const cancelFrame = vi.fn((handle: number) => callbacks.delete(handle));
    const callback = vi.fn();
    const scheduler = createAnimationFrameCoalescer(callback, requestFrame, cancelFrame);

    scheduler.schedule();
    scheduler.cancel();
    expect(cancelFrame).toHaveBeenCalledWith(1);
    expect(callback).not.toHaveBeenCalled();

    scheduler.schedule();
    expect(requestFrame).toHaveBeenCalledTimes(2);
    callbacks.get(2)?.(20);
    expect(callback).toHaveBeenCalledOnce();
  });
});
