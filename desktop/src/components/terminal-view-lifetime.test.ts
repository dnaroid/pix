import { describe, expect, it, vi } from "vitest";
import { createTerminalViewLifetime } from "./terminal-view-lifetime";

function controlledFrames() {
  const callbacks = new Map<number, FrameRequestCallback>();
  const cancelled: number[] = [];
  let nextId = 0;
  return {
    callbacks,
    cancelled,
    request: (callback: FrameRequestCallback) => {
      const id = ++nextId;
      callbacks.set(id, callback);
      return id;
    },
    cancel: (id: number) => { cancelled.push(id); callbacks.delete(id); },
    fire: (id: number) => {
      const callback = callbacks.get(id);
      callbacks.delete(id);
      callback?.(0);
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settlePromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("terminal view lifetime", () => {
  it("cancels the initial xterm frame and coalesced ResizeObserver fit on unmount, even if cancelled callbacks arrive", () => {
    const frames = controlledFrames();
    const lifetime = createTerminalViewLifetime(frames.request, frames.cancel);
    const initial = vi.fn();
    const fit = vi.fn();
    lifetime.scheduleInitial(initial);
    lifetime.scheduleFit(fit);
    lifetime.scheduleFit(fit);
    expect([...frames.callbacks.keys()]).toEqual([1, 2]);
    const staleInitial = frames.callbacks.get(1)!;
    const staleFit = frames.callbacks.get(2)!;
    lifetime.dispose();
    expect(frames.cancelled).toEqual([1, 2]);
    expect(frames.callbacks.size).toBe(0);
    staleInitial(0);
    staleFit(0);
    lifetime.scheduleInitial(initial);
    lifetime.scheduleFit(fit);
    expect(initial).not.toHaveBeenCalled();
    expect(fit).not.toHaveBeenCalled();
    expect(frames.callbacks.size).toBe(0);
  });

  it("runs initial and fitted frames normally and allows later resize fits", () => {
    const frames = controlledFrames();
    const lifetime = createTerminalViewLifetime(frames.request, frames.cancel);
    const initial = vi.fn();
    const fit = vi.fn();
    lifetime.scheduleInitial(initial);
    lifetime.scheduleFit(fit);
    frames.fire(1);
    frames.fire(2);
    lifetime.scheduleFit(fit);
    frames.fire(3);
    expect(initial).toHaveBeenCalledOnce();
    expect(fit).toHaveBeenCalledTimes(2);
    lifetime.dispose();
    expect(frames.cancelled).toEqual([]);
  });

  it("removes live listeners and timers, and ignores a timer already queued when the view unmounts", () => {
    const frames = controlledFrames();
    const timers = new Map<number, () => void>();
    const cleared: number[] = [];
    let nextTimer = 0;
    const lifetime = createTerminalViewLifetime(
      frames.request, frames.cancel,
      (callback) => { const id = ++nextTimer; timers.set(id, callback); return id; },
      (id) => { cleared.push(id); timers.delete(id); },
    );
    const target = new EventTarget();
    const add = vi.spyOn(target, "addEventListener");
    const remove = vi.spyOn(target, "removeEventListener");
    const listener = vi.fn();
    const timer = vi.fn();
    lifetime.listen(target, "change", listener);
    const staleListener = add.mock.calls[0]![1] as EventListener;
    target.dispatchEvent(new Event("change"));
    lifetime.setTimeout(timer, 8);
    const staleTimer = timers.get(1)!;
    lifetime.dispose();
    target.dispatchEvent(new Event("change"));
    staleListener(new Event("change"));
    staleTimer();
    lifetime.setTimeout(timer, 8);
    lifetime.listen(target, "change", listener);
    expect(listener).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(timer).not.toHaveBeenCalled();
    expect(cleared).toEqual([1]);
    expect(timers.size).toBe(0);
  });

  it.each(["success", "failure"] as const)("never invokes an xterm link callback after unmount (%s)", async (outcome) => {
    const pending = deferred<readonly string[]>();
    const callback = vi.fn();
    const frames = controlledFrames();
    const lifetime = createTerminalViewLifetime(frames.request, frames.cancel);
    lifetime.resolveLinks(() => pending.promise, callback);
    await settlePromises();
    lifetime.dispose();
    if (outcome === "success") pending.resolve(["link"]);
    else pending.reject(new Error("lookup failed"));
    await settlePromises();
    expect(callback).not.toHaveBeenCalled();
  });

  it("does not even begin a queued link lookup after unmount", async () => {
    const frames = controlledFrames();
    const lifetime = createTerminalViewLifetime(frames.request, frames.cancel);
    const resolve = vi.fn(() => ["link"]);
    const callback = vi.fn();
    lifetime.resolveLinks(resolve, callback);
    lifetime.dispose();
    await settlePromises();
    expect(resolve).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  it("reports live link successes, failures, and synchronous resolver errors", async () => {
    const frames = controlledFrames();
    const lifetime = createTerminalViewLifetime(frames.request, frames.cancel);
    const callback = vi.fn();
    lifetime.resolveLinks(() => ["link"], callback);
    lifetime.resolveLinks(() => Promise.reject(new Error("failed")), callback);
    lifetime.resolveLinks(() => { throw new Error("failed synchronously"); }, callback);
    await settlePromises();
    expect(callback.mock.calls).toEqual([[ ["link"] ], [undefined], [undefined]]);
    lifetime.dispose();
  });
});
