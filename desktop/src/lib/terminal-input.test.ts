import { describe, expect, it, vi } from "vitest";
import { createTerminalInputWriter } from "./terminal-input";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}

describe("PTY input ordering", () => {
  it("waits for each acknowledgement before sending the next chunk or keystroke", async () => {
    const entered = deferred();
    const release = deferred();
    const send = vi.fn(async (_id: string, _data: string) => {});
    send.mockImplementationOnce(() => { entered.resolve(); return release.promise; });
    const writer = createTerminalInputWriter(send);
    const paste = "a".repeat(40_000);
    const first = writer.write("one", paste);
    const second = writer.write("one", "\r");
    await entered.promise;
    expect(send).toHaveBeenCalledTimes(1);
    release.resolve();
    await Promise.all([first, second]);
    expect(send.mock.calls.map((call) => call[1]).join("")).toBe(`${paste}\r`);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it("does not block another terminal behind a slow PTY", async () => {
    const entered = deferred();
    const release = deferred();
    const send = vi.fn(async (id: string, _data: string) => {
      if (id === "slow") { entered.resolve(); await release.promise; }
    });
    const writer = createTerminalInputWriter(send);
    const slow = writer.write("slow", "one");
    await entered.promise;
    await writer.write("fast", "two");
    expect(send).toHaveBeenCalledWith("fast", "two");
    release.resolve();
    await slow;
  });

  it("keeps surrogate pairs intact at IPC chunk boundaries", async () => {
    const chunks: string[] = [];
    const writer = createTerminalInputWriter(async (_id, chunk) => { chunks.push(chunk); });
    const input = `${"x".repeat(16_383)}😀${"🙂".repeat(20_000)}\r`;
    await writer.write("one", input);
    const encoder = new TextEncoder();
    const decoded = chunks.map((chunk) => new TextDecoder().decode(encoder.encode(chunk))).join("");
    expect(decoded).toBe(input);
    for (const chunk of chunks) expect(encoder.encode(chunk).length).toBeLessThanOrEqual(64 * 1024);
  });

  it("rejects a failed paste without stranding subsequent writes", async () => {
    const send = vi.fn(async (_id: string, _data: string) => {});
    send.mockRejectedValueOnce(new Error("PTY closed"));
    const writer = createTerminalInputWriter(send);
    const failed = writer.write("one", "a".repeat(40_000));
    const next = writer.write("one", "next");
    await expect(failed).rejects.toThrow("PTY closed");
    await next;
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith("one", "next");
  });
});
