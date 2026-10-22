import { describe, expect, it, vi } from "vitest";
import { createToastStore, MAX_ACTIVE_TOASTS, MAX_NOTIFICATION_HISTORY } from "./toasts.svelte";

function fakeTimers() {
  let now = 0;
  let nextHandle = 1;
  const pending = new Map<number, { at: number; callback: () => void }>();
  return {
    api: {
      setTimeout: (callback: () => void, ms: number) => { const handle = nextHandle++; pending.set(handle, { at: now + ms, callback }); return handle; },
      clearTimeout: (handle: unknown) => { pending.delete(handle as number); },
      now: () => now,
    },
    advance(ms: number) {
      now += ms;
      for (const [handle, timer] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= now && pending.delete(handle)) timer.callback();
      }
    },
    get pendingCount() { return pending.size; },
  };
}

describe("toast store", () => {
  it("auto-dismisses success after its duration and marks it read", () => {
    const timers = fakeTimers();
    const store = createToastStore(timers.api);
    store.success({ message: "Pushed", source: "Git" });
    expect(store.active).toHaveLength(1);
    expect(store.unreadCount).toBe(1);
    timers.advance(4_999);
    expect(store.active).toHaveLength(1);
    timers.advance(1);
    expect(store.active).toHaveLength(0);
    expect(store.history[0]).toMatchObject({ message: "Pushed", source: "Git", read: true });
    expect(store.unreadCount).toBe(0);
  });

  it("keeps errors until dismissed and leaves expired warnings unread", () => {
    const timers = fakeTimers();
    const store = createToastStore(timers.api);
    const errorId = store.error("Push failed");
    store.warning("Slow remote");
    timers.advance(60_000);
    expect(store.active.map((toast) => toast.id)).toEqual([errorId]);
    expect(store.unreadCount).toBe(2);
    expect(store.unreadLevel).toBe("error");
    store.dismiss(errorId);
    expect(store.active).toHaveLength(0);
    expect(store.unreadLevel).toBe("warning");
    store.markAllRead();
    expect(store.unreadLevel).toBeNull();
  });

  it("pauses every countdown while hovered and resumes with the remaining time", () => {
    const timers = fakeTimers();
    const store = createToastStore(timers.api);
    store.info("One");
    timers.advance(3_000);
    store.pause();
    expect(timers.pendingCount).toBe(0);
    timers.advance(60_000);
    expect(store.active).toHaveLength(1);
    store.resume();
    timers.advance(1_999);
    expect(store.active).toHaveLength(1);
    timers.advance(1);
    expect(store.active).toHaveLength(0);
  });

  it("deduplicates keyed toasts, counts repeats and restarts the countdown", () => {
    const timers = fakeTimers();
    const store = createToastStore(timers.api);
    const first = store.success({ message: "Fetched", key: "git:fetch" });
    timers.advance(4_000);
    const second = store.success({ message: "Fetched again", key: "git:fetch" });
    expect(second).toBe(first);
    expect(store.active).toHaveLength(1);
    expect(store.active[0]).toMatchObject({ message: "Fetched again", count: 2 });
    expect(store.history).toHaveLength(1);
    timers.advance(4_000);
    expect(store.active).toHaveLength(1);
    timers.advance(1_000);
    expect(store.active).toHaveLength(0);
  });

  it("ignores blank messages and bounds active toasts and history", () => {
    const timers = fakeTimers();
    const store = createToastStore(timers.api);
    expect(store.info("   ")).toBe(0);
    for (let index = 0; index < MAX_NOTIFICATION_HISTORY + 5; index++) store.error(`E${index}`);
    expect(store.active).toHaveLength(MAX_ACTIVE_TOASTS);
    expect(store.history).toHaveLength(MAX_NOTIFICATION_HISTORY);
    expect(store.history[0]!.message).toBe(`E${MAX_NOTIFICATION_HISTORY + 4}`);
  });

  it("reports errors once unless the caller already logged them", () => {
    const store = createToastStore(fakeTimers().api);
    const report = vi.fn();
    const release = store.setReporter(report);
    store.error({ message: "Boom", source: "Git" });
    store.error({ message: "Logged elsewhere", log: false });
    store.warning("Not an error");
    expect(report).toHaveBeenCalledOnce();
    expect(String(report.mock.calls[0]![0])).toContain("Git: Boom");
    release();
    store.error("After release");
    expect(report).toHaveBeenCalledOnce();
  });

  it("runs actions, dismisses by default and surfaces action failures", async () => {
    const store = createToastStore(fakeTimers().api);
    const run = vi.fn(async () => { throw new Error("retry failed"); });
    const id = store.error({ message: "Push failed", actions: [{ label: "Retry", run }] });
    store.runAction(id, store.active[0]!.actions[0]!);
    expect(store.active.some((toast) => toast.id === id)).toBe(false);
    await vi.waitFor(() => expect(store.active.map((toast) => toast.message)).toEqual(["retry failed"]));
    expect(run).toHaveBeenCalledOnce();
  });

  it("clears history except visible toasts and disposes timers", () => {
    const timers = fakeTimers();
    const store = createToastStore(timers.api);
    store.success("Old");
    timers.advance(5_000);
    store.error("Visible");
    store.clearHistory();
    expect(store.history.map((entry) => entry.message)).toEqual(["Visible"]);
    store.info("Pending");
    store.dispose();
    expect(store.active).toHaveLength(0);
    expect(timers.pendingCount).toBe(0);
  });
});
