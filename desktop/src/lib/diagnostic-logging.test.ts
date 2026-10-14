import { describe, expect, it, vi } from "vitest";
import { createDiagnosticLogger } from "./diagnostic-logging";

describe("frontend diagnostic logging", () => {
  it("ignores browser-only ResizeObserver loop notices, not actual JavaScript errors", async () => {
    const target = new EventTarget() as Window;
    const send = vi.fn().mockResolvedValue(undefined);
    const logger = createDiagnosticLogger(() => ({ workspace: "/project" }), send);
    const stop = logger.start(target);
    try {
      for (const message of [
        "ResizeObserver loop completed with undelivered notifications.",
        "ResizeObserver loop limit exceeded",
      ]) {
        const event = new Event("error");
        Object.assign(event, { message });
        target.dispatchEvent(event);
      }
      await Promise.resolve();
      expect(send).not.toHaveBeenCalled();
      const actual = new Event("error");
      Object.assign(actual, {
        message: "ResizeObserver loop completed with undelivered notifications.",
        error: new Error("A real observer exception"),
      });
      target.dispatchEvent(actual);
      await Promise.resolve();
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0]?.[1]).toMatchObject({
        event: "frontend:uncaught",
        diagnostic: expect.stringContaining("A real observer exception"),
      });
    } finally {
      stop();
    }
  });
  it("records allowlisted payload-free lifecycle events with a context snapshot", async () => {
    let workspace = "/projects/first";
    const send = vi.fn().mockResolvedValue(undefined);
    const logger = createDiagnosticLogger(() => ({ workspace, sessionId: "s1" }), send);
    logger.record("acp:ready");
    workspace = "/projects/second";
    await Promise.resolve();
    expect(send).toHaveBeenCalledExactlyOnceWith("log_desktop_event", {
      event: "acp:ready", workspace: "/projects/first", sessionId: "s1",
    });
    const target = new EventTarget() as Window;
    const stop = logger.start(target);
    stop();
    logger.record("updater:available");
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("snapshots the project before IPC, bounds concurrency and swallows logging failures", async () => {
    let workspace = "/projects/first";
    const send = vi.fn().mockRejectedValue(new Error("offline"));
    const logger = createDiagnosticLogger(() => ({ workspace, sessionId: "session" }), send);
    for (let index = 0; index < 30; index++) logger.report(new Error("test"));
    workspace = "/projects/second";
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(send).toHaveBeenCalledTimes(16);
    expect(send.mock.calls[0]?.[1]).toMatchObject({ workspace: "/projects/first", sessionId: "session" });
    logger.report("after failure");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(send).toHaveBeenCalledTimes(17);
  });
  it("removes global listeners and stops submissions on teardown", async () => {
    const target = new EventTarget() as Window;
    const send = vi.fn().mockResolvedValue(undefined);
    const logger = createDiagnosticLogger(() => ({ workspace: "" }), send);
    const stop = logger.start(target);
    const error = new Event("error");
    Object.assign(error, { message: "failure" });
    target.dispatchEvent(error);
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    stop();
    target.dispatchEvent(error);
    logger.report("late");
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("does not revive stale queued diagnostics when restarted", async () => {
    const target = new EventTarget() as Window;
    const send = vi.fn().mockResolvedValue(undefined);
    const logger = createDiagnosticLogger(() => ({ workspace: "" }), send);
    const stop = logger.start(target);
    logger.report("stale");
    stop();
    const stopNew = logger.start(target);
    stop(); // A stale cleanup cannot dispose the new lifetime.
    logger.report("current");
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[1]).toMatchObject({ diagnostic: "current" });
    stopNew();
  });
  it("never turns context or error conversion failures into UI errors", () => {
    const send = vi.fn();
    const logger = createDiagnosticLogger(() => { throw new Error("gone"); }, send);
    expect(() => logger.report("test")).not.toThrow();
    const other = createDiagnosticLogger(() => ({ workspace: "" }), send);
    expect(() => other.report({ toString() { throw new Error("bad value"); } })).not.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
