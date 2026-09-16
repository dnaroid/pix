import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpClientHandlers } from "../lib/acp-client-types";

interface ClientDouble {
  handlers: AcpClientHandlers;
  dispose: ReturnType<typeof vi.fn>;
}

const rpc = vi.hoisted(() => ({ start: vi.fn(), clients: [] as ClientDouble[] }));
vi.mock("../lib/tauri-transport", () => ({ TauriAcpTransport: class {} }));
vi.mock("../lib/acp-client", () => ({
  AcpClient: class {
    dispose = vi.fn(async () => {});
    constructor(_transport: unknown, readonly handlers: AcpClientHandlers) { rpc.clients.push(this); }
    start() { return rpc.start(); }
  },
}));

import { createConnectionStore } from "./connection.svelte";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const options = {
    workspace: () => "/workspace",
    onSessionUpdate: vi.fn(),
    onSessionState: vi.fn(),
    onQueueState: vi.fn(),
    onQueueConsumed: vi.fn(),
    onElicitation: vi.fn(async () => ({ action: "cancel" as const })),
    onDisconnect: vi.fn(),
    openWorkspaceSession: vi.fn(async () => {}),
    setErrorMessage: vi.fn(),
    reportError: vi.fn(),
  };
  return { options, store: createConnectionStore(options) };
}

describe("Desktop connection ownership", () => {
  beforeEach(() => {
    rpc.clients.length = 0;
    rpc.start.mockReset().mockResolvedValue({});
  });

  it("shares initialization and does not replace an already-ready client", async () => {
    const initialization = deferred<object>();
    rpc.start.mockReturnValue(initialization.promise);
    const { store, options } = fixture();
    const first = store.connect();
    expect(store.connect()).toBe(first);
    initialization.resolve({});
    await first;
    await store.connect();
    expect(rpc.clients).toHaveLength(1);
    expect(options.openWorkspaceSession).toHaveBeenCalledOnce();
    await store.dispose();
  });

  it("does not resurrect a client when disposed during reconnect teardown", async () => {
    const { store } = fixture();
    await store.connect();
    const release = deferred<void>();
    rpc.clients[0]!.dispose.mockReturnValue(release.promise);
    const reconnect = store.reconnect();
    expect(store.status).toBe("starting");
    const shutdown = store.dispose();
    release.resolve();
    await Promise.all([reconnect, shutdown]);
    expect(store.status).toBe("stopped");
    expect(store.client).toBeNull();
    expect(rpc.clients).toHaveLength(1);
    await Promise.all([store.connect(), store.reconnect()]);
    expect(rpc.clients).toHaveLength(1);
  });

  it("ignores late initialization from a replaced client", async () => {
    const initialization = deferred<object>();
    rpc.start.mockReturnValueOnce(initialization.promise).mockResolvedValue({});
    const { store, options } = fixture();
    const first = store.connect();
    const reconnect = store.reconnect();
    expect(store.reconnect()).toBe(reconnect);
    await reconnect;
    const replacement = store.client;
    initialization.resolve({ agentCapabilities: { promptCapabilities: { image: true } } });
    await first;
    expect(store.client).toBe(replacement);
    expect(store.imagePromptSupported).toBe(false);
    expect(options.openWorkspaceSession).toHaveBeenCalledOnce();
    expect(options.reportError).not.toHaveBeenCalled();
    await store.dispose();
  });

  it("suppresses initialization errors and notifications after disposal", async () => {
    const initialization = deferred<object>();
    rpc.start.mockReturnValue(initialization.promise);
    const { store, options } = fixture();
    const connected = store.connect();
    const old = rpc.clients[0]!;
    const shutdown = store.dispose();
    old.handlers.onDiagnostic?.("late diagnostic");
    initialization.reject(new Error("late failure"));
    await Promise.all([connected, shutdown]);
    expect(store.status).toBe("stopped");
    expect(store.diagnostics).toEqual([]);
    expect(options.reportError).not.toHaveBeenCalled();
    expect(options.openWorkspaceSession).not.toHaveBeenCalled();
  });

  it("disposes a failed client before a retry", async () => {
    rpc.start.mockRejectedValueOnce(new Error("cannot initialize")).mockResolvedValue({});
    const { store, options } = fixture();
    await store.connect();
    expect(store.status).toBe("error");
    expect(options.reportError).toHaveBeenCalledOnce();
    await store.connect();
    expect(rpc.clients[0]!.dispose).toHaveBeenCalledOnce();
    expect(rpc.clients).toHaveLength(2);
    expect(store.status).toBe("ready");
    await store.dispose();
  });

  it("invalidates the exited client's callbacks before resetting session state", async () => {
    const { store, options } = fixture();
    await store.connect();
    const old = rpc.clients[0]!;
    old.handlers.onExit?.({ generation: 1, code: 1, success: false, requested: false, error: null });
    old.handlers.onSessionUpdate({
      sessionId: "old", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late" } },
    });
    expect(store.client).toBeNull();
    expect(store.status).toBe("error");
    expect(options.onDisconnect).toHaveBeenCalledOnce();
    expect(options.onSessionUpdate).not.toHaveBeenCalled();
    expect(old.dispose).toHaveBeenCalledOnce();
    await store.dispose();
  });
});
