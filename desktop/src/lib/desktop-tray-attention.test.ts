import { afterEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { createDesktopTrayAttention, TRAY_ATTENTION_RETRY_MAX_MS, TRAY_ATTENTION_RETRY_MS } from "./desktop-tray-attention";

afterEach(() => {
  if (typeof window !== "undefined") clearMocks();
  vi.unstubAllGlobals();
});

function harness() {
  const visible = new Set<string | null>();
  const publish = vi.fn(async (_attention: boolean): Promise<void> => undefined);
  const attention = createDesktopTrayAttention({ isSessionVisible: (id) => visible.has(id), publish });
  return { attention, publish, visible };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("desktop tray unseen attention", () => {
  it("retains background tabs and acknowledges only visible conversations", async () => {
    const { attention, publish, visible } = harness();
    visible.add("current");
    attention.mark("current");
    expect(publish).not.toHaveBeenCalled();
    attention.mark("other");
    attention.mark("third");
    await settle();
    expect(publish.mock.calls).toEqual([[true]]);
    visible.add("other");
    attention.acknowledgeVisible();
    await settle();
    expect(publish.mock.calls).toEqual([[true]]);
    visible.add("third");
    attention.acknowledgeVisible();
    await settle();
    expect(publish.mock.calls).toEqual([[true], [false]]);
  });

  it("clears only the requested session and resets window-level questions", async () => {
    const { attention, publish } = harness();
    attention.mark("a");
    attention.mark(null);
    await settle();
    attention.clearSession("a");
    await settle();
    expect(publish.mock.calls).toEqual([[true]]);
    attention.reset();
    await settle();
    expect(publish.mock.calls).toEqual([[true], [false]]);
  });

  it("serializes transport so a late true is followed by the latest false", async () => {
    const { attention, publish, visible } = harness();
    let release!: () => void;
    publish.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    attention.mark("a");
    visible.add("a");
    attention.acknowledgeVisible();
    expect(publish.mock.calls).toEqual([[true]]);
    release();
    await settle();
    expect(publish.mock.calls).toEqual([[true], [false]]);
  });

  it("coalesces rapid changes without publishing a stale intermediate snapshot", async () => {
    const { attention, publish, visible } = harness();
    let release!: () => void;
    publish.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    attention.mark("a");
    visible.add("a");
    attention.acknowledgeVisible();
    attention.mark("b");
    release();
    await settle();
    expect(publish.mock.calls).toEqual([[true]]);
    attention.dispose();
    await settle();
    expect(publish.mock.calls).toEqual([[true], [false]]);
  });

  it("retries failures on subsequent updates without blocking or polling", async () => {
    const { attention, publish } = harness();
    publish.mockRejectedValueOnce(new Error("host unavailable"));
    attention.mark("a");
    await settle();
    attention.acknowledgeVisible();
    await settle();
    expect(publish.mock.calls).toEqual([[true], [true]]);
    attention.clearSession("a");
    await settle();
    expect(publish.mock.calls).toEqual([[true], [true], [false]]);
  });

  it("publishes the initial empty snapshot and cleans up focus/visibility listeners", async () => {
    const { attention, publish, visible } = harness();
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    vi.stubGlobal("window", windowTarget);
    vi.stubGlobal("document", documentTarget);
    const removeWindow = vi.spyOn(windowTarget, "removeEventListener");
    const removeDocument = vi.spyOn(documentTarget, "removeEventListener");
    const stop = attention.start();
    await settle();
    expect(publish.mock.calls).toEqual([[false]]);
    attention.mark("a");
    await settle();
    visible.add("a");
    windowTarget.dispatchEvent(new Event("focus"));
    await settle();
    expect(publish.mock.calls).toEqual([[false], [true], [false]]);
    attention.mark("b");
    await settle();
    visible.add("b");
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(publish.mock.calls).toEqual([[false], [true], [false], [true], [false]]);
    stop();
    stop();
    expect(removeWindow).toHaveBeenCalledWith("focus", expect.any(Function));
    expect(removeDocument).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    const count = publish.mock.calls.length;
    attention.mark("c");
    attention.start()();
    attention.reset();
    await settle();
    expect(publish).toHaveBeenCalledTimes(count);
  });

  it("clears a late in-flight update during teardown and ignores later events", async () => {
    const { attention, publish } = harness();
    let release!: () => void;
    publish.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    attention.mark("a");
    attention.dispose();
    attention.mark("b");
    release();
    await settle();
    expect(publish.mock.calls).toEqual([[true], [false]]);
  });

  it("retries a failed publish with backoff and logs once per failure streak", async () => {
    vi.useFakeTimers();
    try {
      const publish = vi.fn(async (_attention: boolean): Promise<void> => undefined);
      const reportWarning = vi.fn();
      const attention = createDesktopTrayAttention({ isSessionVisible: () => false, publish, reportWarning });
      publish.mockRejectedValueOnce(new Error("ipc down")).mockRejectedValueOnce(new Error("ipc down"));
      attention.mark("a");
      await settle();
      expect(publish).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(TRAY_ATTENTION_RETRY_MS);
      expect(publish).toHaveBeenCalledTimes(2);
      expect(reportWarning).toHaveBeenCalledOnce();
      expect(reportWarning).toHaveBeenCalledWith("tray:publish", expect.any(Error));
      await vi.advanceTimersByTimeAsync(TRAY_ATTENTION_RETRY_MS * 2);
      expect(publish.mock.calls).toEqual([[true], [true], [true]]);
      expect(vi.getTimerCount()).toBe(0);
      publish.mockRejectedValueOnce(new Error("again"));
      attention.clearSession("a");
      await settle();
      expect(reportWarning).toHaveBeenCalledTimes(2); // new streak after success
      attention.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry after teardown", async () => {
    vi.useFakeTimers();
    try {
      const publish = vi.fn(async (_attention: boolean): Promise<void> => { throw new Error("down"); });
      const attention = createDesktopTrayAttention({ isSessionVisible: () => false, publish });
      attention.mark("a");
      attention.dispose();
      await vi.advanceTimersByTimeAsync(TRAY_ATTENTION_RETRY_MAX_MS * 2);
      expect(publish).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the window-owned native command without notification permission or routing data", async () => {
    vi.stubGlobal("window", { crypto: globalThis.crypto, isTauri: true });
    vi.stubGlobal("isTauri", true);
    const host = vi.fn((_command: string, _args: unknown) => undefined);
    mockIPC((command, args) => host(command, args));
    const attention = createDesktopTrayAttention({ isSessionVisible: () => false });
    attention.mark("session-a");
    await settle();
    expect(host).toHaveBeenCalledWith("desktop_set_tray_attention", { attention: true });
    attention.dispose();
    await settle();
    expect(host).toHaveBeenCalledWith("desktop_set_tray_attention", { attention: false });
  });
});
