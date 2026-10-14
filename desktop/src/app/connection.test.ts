import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpClientHandlers } from "../lib/acp-client-types";

interface ClientDouble {
  handlers: AcpClientHandlers;
  dispose: ReturnType<typeof vi.fn>;
}

const rpc = vi.hoisted(() => ({ start: vi.fn(), clients: [] as ClientDouble[] }));
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
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
    workspace: vi.fn(() => "/workspace"),
    onSessionUpdate: vi.fn(),
    onSessionCatalogChanged: vi.fn(),
    onSessionState: vi.fn(),
    onQueueState: vi.fn(),
    onQueueConsumed: vi.fn(),
    onElicitation: vi.fn(async () => ({ action: "cancel" as const })),
    onDisconnect: vi.fn(),
    openWorkspaceSession: vi.fn(async () => {}),
    setErrorMessage: vi.fn(),
    reportError: vi.fn(),
    recordDiagnostic: vi.fn(),
  };
  return { options, store: createConnectionStore(options) };
}

describe("Desktop connection ownership", () => {
  beforeEach(() => {
    rpc.clients.length = 0;
    rpc.start.mockReset().mockResolvedValue({});
    native.invoke.mockReset().mockResolvedValue("/workspace/.pi/artifacts/acp-crash-test/stderr.log");
  });

  it("ignores native catalog notifications from old clients and other workspaces", async () => {
    const { store, options } = fixture();
    await store.connect();
    rpc.clients[0]!.handlers.onSessionCatalogChanged?.("/elsewhere");
    expect(options.onSessionCatalogChanged).not.toHaveBeenCalled();
    rpc.clients[0]!.handlers.onSessionCatalogChanged?.("/workspace");
    expect(options.onSessionCatalogChanged).toHaveBeenCalledExactlyOnceWith("/workspace");
    await store.reconnect();
    rpc.clients[0]!.handlers.onSessionCatalogChanged?.("/workspace");
    expect(options.onSessionCatalogChanged).toHaveBeenCalledTimes(1);
    rpc.clients[1]!.handlers.onSessionCatalogChanged?.("/workspace");
    expect(options.onSessionCatalogChanged).toHaveBeenCalledTimes(2);
    await store.dispose();
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
    expect(options.recordDiagnostic.mock.calls.map(([event]) => event)).toEqual(["acp:connecting", "acp:ready"]);
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
    expect(options.recordDiagnostic).toHaveBeenCalledWith("acp:connect-failed");
    expect(native.invoke).toHaveBeenCalledWith("save_acp_crash_log", {
      workspace: "/workspace", content: expect.stringContaining("cannot initialize"),
    });
    await store.connect();
    expect(rpc.clients[0]!.dispose).toHaveBeenCalledOnce();
    expect(rpc.clients).toHaveLength(2);
    expect(store.status).toBe("ready");
    expect(options.recordDiagnostic).toHaveBeenCalledWith("acp:reconnecting");
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

  it("uses the native stderr snapshot even when the final stderr event is late", async () => {
    const { store, options } = fixture();
    await store.connect();
    const old = rpc.clients[0]!;
    old.handlers.onDiagnostic?.("old partial line");
    old.handlers.onExit?.({ generation: 1, code: 1, success: false, requested: false, error: null,
      stderr: "[pix-acp] fatal: startup failed\n    at main.js:42\n" });
    old.handlers.onDiagnostic?.("late diagnostic");
    await Promise.resolve();
    expect(options.setErrorMessage).toHaveBeenLastCalledWith(expect.stringContaining("fatal: startup failed"));
    expect(options.setErrorMessage).toHaveBeenLastCalledWith(expect.stringContaining("Log: /workspace/.pi/artifacts/"));
    expect(native.invoke).toHaveBeenCalledWith("save_acp_crash_log", {
      workspace: "/workspace", content: expect.stringContaining("at main.js:42"),
    });
    expect(store.diagnostics).toEqual(["old partial line"]);
    await store.dispose();
  });

  it("persists the original crash but does not overwrite a reconnected banner", async () => {
    const saved = deferred<string>();
    native.invoke.mockReturnValue(saved.promise);
    const { store, options } = fixture();
    await store.connect();
    rpc.clients[0]!.handlers.onDiagnostic?.("first generation stderr");
    rpc.clients[0]!.handlers.onExit?.({ generation: 1, code: 1, success: false, requested: false, error: null });
    await store.reconnect();
    options.setErrorMessage.mockClear();
    saved.resolve("/workspace/.pi/artifacts/old/stderr.log");
    await Promise.resolve();
    expect(store.status).toBe("ready");
    expect(store.diagnostics).toEqual([]);
    expect(options.setErrorMessage).not.toHaveBeenCalled();
    await store.dispose();
  });

  it("reports saving failures without masking stderr, and ignores stale failures after disposal", async () => {
    native.invoke.mockRejectedValueOnce(new Error("read-only filesystem"));
    const { store, options } = fixture();
    await store.connect();
    rpc.clients[0]!.handlers.onExit?.({ generation: 1, code: 1, success: false, requested: false, error: null, stderr: "fatal: boom" });
    await Promise.resolve();
    expect(options.setErrorMessage).toHaveBeenLastCalledWith(expect.stringContaining("fatal: boom · Could not save crash log: Error: read-only filesystem"));
    await store.reconnect();
    const saved = deferred<string>();
    native.invoke.mockReturnValue(saved.promise);
    rpc.clients[1]!.handlers.onExit?.({ generation: 2, code: 1, success: false, requested: false, error: null });
    await store.dispose();
    options.setErrorMessage.mockClear();
    saved.reject(new Error("late failure"));
    await Promise.resolve();
    expect(options.setErrorMessage).not.toHaveBeenCalled();
  });

  it("does not create crash receipts for requested stops", async () => {
    const { store } = fixture();
    await store.connect();
    rpc.clients[0]!.handlers.onExit?.({ generation: 1, code: 0, success: true, requested: true, error: null });
    expect(native.invoke).not.toHaveBeenCalled();
    await store.dispose();
  });

  it("saves to the failing project without updating a newly selected project's banner", async () => {
    const saved = deferred<string>();
    native.invoke.mockReturnValue(saved.promise);
    const { store, options } = fixture();
    await store.connect();
    rpc.clients[0]!.handlers.onExit?.({ generation: 1, code: 1, success: false, requested: false, error: null });
    expect(native.invoke).toHaveBeenCalledWith("save_acp_crash_log", expect.objectContaining({ workspace: "/workspace" }));
    options.workspace.mockReturnValue("/other-project");
    options.setErrorMessage.mockClear();
    saved.resolve("/workspace/.pi/artifacts/old/stderr.log");
    await Promise.resolve();
    expect(options.setErrorMessage).not.toHaveBeenCalled();
    await store.dispose();
  });
});
