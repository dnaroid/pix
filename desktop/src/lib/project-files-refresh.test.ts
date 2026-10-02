import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectFilesRefresh } from "./project-files-refresh";

afterEach(() => vi.useRealTimers());

function setup(refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined), focused = true) {
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), {
    hidden: false,
    hasFocus: () => focused,
  });
  const controller = createProjectFilesRefresh(refresh, { window, document });
  return {
    refresh, controller, window, document,
    focus(value: boolean) {
      focused = value;
      window.dispatchEvent(new Event(value ? "focus" : "blur"));
    },
    hide(value: boolean) {
      document.hidden = value;
      document.dispatchEvent(new Event("visibilitychange"));
    },
  };
}

describe("Project Explorer directory polling", () => {
  it("leaves initial loading to the tree and polls every five seconds", async () => {
    vi.useFakeTimers();
    const test = setup();
    expect(test.refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(test.refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(test.refresh).toHaveBeenCalledTimes(2);
    test.controller.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(test.refresh).toHaveBeenCalledTimes(2);
  });

  it("does no background work and refreshes immediately on return", async () => {
    vi.useFakeTimers();
    const test = setup(undefined, false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(test.refresh).not.toHaveBeenCalled();
    test.focus(true);
    await Promise.resolve();
    expect(test.refresh).toHaveBeenCalledTimes(1);
    test.focus(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(test.refresh).toHaveBeenCalledTimes(1);
    test.focus(true);
    await Promise.resolve();
    expect(test.refresh).toHaveBeenCalledTimes(2);
    test.controller.dispose();
  });

  it("pauses hidden windows and coalesces visibility/focus notifications", async () => {
    vi.useFakeTimers();
    const test = setup();
    test.hide(true);
    test.window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(test.refresh).not.toHaveBeenCalled();
    test.hide(false);
    test.window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    expect(test.refresh).toHaveBeenCalledTimes(1);
    test.controller.dispose();
  });

  it("serializes reads and coalesces activity triggers during a slow read", async () => {
    vi.useFakeTimers();
    let resolve!: () => void;
    const refresh = vi.fn<() => Promise<void>>()
      .mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }))
      .mockResolvedValue(undefined);
    const test = setup(refresh);
    await vi.advanceTimersByTimeAsync(5_000);
    test.focus(false);
    test.focus(true);
    test.focus(false);
    test.focus(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(2);
    test.controller.dispose();
  });

  it("does not restart after blur or disposal during in-flight work", async () => {
    vi.useFakeTimers();
    let resolve!: () => void;
    const refresh = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const test = setup(refresh);
    const removeWindow = vi.spyOn(test.window, "removeEventListener");
    const removeDocument = vi.spyOn(test.document, "removeEventListener");
    await vi.advanceTimersByTimeAsync(5_000);
    test.focus(false);
    resolve();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    test.focus(true);
    expect(refresh).toHaveBeenCalledTimes(2);
    test.focus(false);
    test.focus(true);
    test.controller.dispose();
    resolve();
    test.focus(false);
    test.focus(true);
    test.hide(true);
    test.hide(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(removeWindow).toHaveBeenCalledTimes(2);
    expect(removeDocument).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries failed directory listings", async () => {
    vi.useFakeTimers();
    const test = setup(vi.fn().mockRejectedValue(new Error("Listing failed")));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(test.refresh).toHaveBeenCalledTimes(2);
    test.controller.dispose();
  });
});
