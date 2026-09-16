import { describe, expect, it, vi } from "vitest";
import { AcpJsonRpcConnection } from "./acp-json-rpc";
import type { AcpTransportHandlers } from "./acp-client-types";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function fixture() {
  let incoming!: AcpTransportHandlers;
  const transport = {
    start: async (handlers: AcpTransportHandlers) => { incoming = handlers; },
    stop: vi.fn(async () => {}),
    send: vi.fn(async (_line: string) => {}),
  };
  const handlers = {
    onNotification: vi.fn(),
    onRequest: vi.fn(async (_method: string, _params: unknown): Promise<unknown> => null),
    onDiagnostic: vi.fn(), onExit: vi.fn(),
  };
  return { rpc: new AcpJsonRpcConnection(transport, handlers), transport, handlers, get incoming() { return incoming; } };
}

describe("ACP RPC shutdown", () => {
  it("makes repeated dispose calls wait for the same transport shutdown", async () => {
    const { rpc, transport } = fixture();
    const entered = deferred<void>();
    const release = deferred<void>();
    transport.stop.mockImplementation(() => { entered.resolve(); return release.promise; });
    await rpc.start();
    const first = rpc.dispose();
    const second = rpc.dispose();
    expect(second).toBe(first);
    let finished = false;
    void second.then(() => { finished = true; });
    await entered.promise;
    expect(finished).toBe(false);
    release.resolve();
    await Promise.all([first, second]);
    expect(transport.stop).toHaveBeenCalledOnce();
  });

  it("suppresses late notifications and an in-flight server-request response", async () => {
    const test = fixture();
    const response = deferred<unknown>();
    test.handlers.onRequest.mockReturnValue(response.promise);
    await test.rpc.start();
    test.incoming.onLine(JSON.stringify({ jsonrpc: "2.0", id: "question", method: "question", params: {} }));
    await test.rpc.dispose();
    response.resolve({ action: "cancel" });
    test.incoming.onLine(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {} }));
    test.incoming.onStderr("late");
    // Drain the response continuation without relying on wall-clock sleeps.
    await response.promise;
    await Promise.resolve();
    expect(test.transport.send).not.toHaveBeenCalled();
    expect(test.handlers.onNotification).not.toHaveBeenCalled();
    expect(test.handlers.onDiagnostic).not.toHaveBeenCalled();
  });

  it("rejects pending and new requests immediately on disposal", async () => {
    const { rpc } = fixture();
    await rpc.start();
    const pending = rpc.request("session/prompt", {}, null);
    const rejected = expect(pending).rejects.toThrow("disposed");
    await rpc.dispose();
    await rejected;
    await expect(rpc.request("session/list", {})).rejects.toThrow("disposed");
  });
});
