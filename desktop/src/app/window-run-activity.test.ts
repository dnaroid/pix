import { describe, expect, it, vi } from "vitest";
import { createWindowRunActivitySync, hasRestartBlockingRun } from "./window-run-activity";

describe("restart-blocking runs", () => {
  const running = new Set(["a", "b"]);
  const questions = new Map([["a", { kind: "question" }], ["b", { kind: "question" }]]);
  it("excludes pending questions in active and background sessions", () => {
    expect(hasRestartBlockingRun(running, questions, null, "a", false)).toBe(false);
  });
  it("still protects another running session, forms, and draft materialization", () => {
    expect(hasRestartBlockingRun(running, new Map([["a", { kind: "question" }]]), null, "a", false)).toBe(true);
    expect(hasRestartBlockingRun(new Set(["a"]), new Map([["a", { kind: "form" }]]), null, "a", false)).toBe(true);
    expect(hasRestartBlockingRun(running, questions, null, "a", true)).toBe(true);
  });
  it("associates unscoped questions only with the active session", () => {
    expect(hasRestartBlockingRun(new Set(["a"]), new Map(), { kind: "question" }, "a", false)).toBe(false);
    expect(hasRestartBlockingRun(running, new Map(), { kind: "question" }, "a", false)).toBe(true);
  });
  it("protects the run again as soon as the question is answered", () => {
    expect(hasRestartBlockingRun(new Set(["a"]), new Map(), null, "a", false)).toBe(true);
    expect(hasRestartBlockingRun(new Set(), new Map(), null, null, false)).toBe(false);
  });
});

describe("window run activity synchronization", () => {
  it("serializes IPC and coalesces activity while a write is pending", async () => {
    let resolve!: () => void;
    const write = vi.fn().mockImplementationOnce(() => new Promise<void>((r) => { resolve = r; })).mockResolvedValue(undefined);
    const sync = createWindowRunActivitySync(write, vi.fn());
    sync.update(true);
    sync.update(false);
    sync.update(true);
    sync.update(true, false);
    expect(write.mock.calls).toEqual([[true, true]]);
    resolve();
    await vi.waitFor(() => expect(write.mock.calls).toEqual([[true, true], [true, false]]));
  });
  it("does not send retained writes or report late errors after disposal", async () => {
    let reject!: (error: Error) => void;
    const write = vi.fn(() => new Promise<void>((_, r) => { reject = r; }));
    const report = vi.fn();
    const sync = createWindowRunActivitySync(write, report);
    sync.update(true);
    sync.update(false);
    sync.dispose();
    reject(new Error("window destroyed"));
    await Promise.resolve();
    sync.update(true);
    expect(write).toHaveBeenCalledOnce();
    expect(report).not.toHaveBeenCalled();
  });
});
