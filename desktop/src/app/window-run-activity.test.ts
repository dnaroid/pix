import { describe, expect, it, vi } from "vitest";
import { createWindowRunActivitySync } from "./window-run-activity";

describe("window run activity synchronization", () => {
  it("serializes IPC and coalesces activity while a write is pending", async () => {
    let resolve!: () => void;
    const write = vi.fn().mockImplementationOnce(() => new Promise<void>((r) => { resolve = r; })).mockResolvedValue(undefined);
    const sync = createWindowRunActivitySync(write, vi.fn());
    sync.update(true);
    sync.update(false);
    sync.update(true);
    sync.update(false);
    expect(write.mock.calls).toEqual([[true]]);
    resolve();
    await vi.waitFor(() => expect(write.mock.calls).toEqual([[true], [false]]));
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
