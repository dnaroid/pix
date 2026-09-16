import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "project-one" }) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));

import { TauriAcpTransport } from "./tauri-transport";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function handlers() {
  return { onLine: vi.fn(), onStderr: vi.fn(), onExit: vi.fn() };
}

describe("TauriAcpTransport", () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
    tauri.listen.mockReset();
    tauri.listeners.clear();
    tauri.listen.mockImplementation(async (event: string, listener: (event: { payload: unknown }) => void) => {
      tauri.listeners.set(event, listener);
      return () => { tauri.listeners.delete(event); };
    });
    tauri.invoke.mockImplementation(async (command: string) => command === "acp_start" ? 7 : undefined);
  });

  it("filters stale events and generation-guards sends and stops", async () => {
    const lines: string[] = [];
    const exits: unknown[] = [];
    const transport = new TauriAcpTransport();
    await transport.start({
      onLine: (line) => lines.push(line),
      onStderr: () => {},
      onExit: (exit) => exits.push(exit),
    });

    tauri.listeners.get("acp://stdout")?.({ payload: { windowLabel: "project-one", generation: 6, lines: ["stale"] } });
    tauri.listeners.get("acp://stdout")?.({ payload: { windowLabel: "project-two", generation: 7, lines: ["other-window"] } });
    tauri.listeners.get("acp://stdout")?.({ payload: { windowLabel: "project-one", generation: 7, lines: ["current", "next"] } });
    tauri.listeners.get("acp://exit")?.({
      payload: {
        windowLabel: "project-two",
        generation: 7,
        code: 0,
        success: true,
        requested: true,
        error: null,
      },
    });
    await transport.send("{}");
    await transport.stop();

    expect(lines).toEqual(["current", "next"]);
    expect(exits).toEqual([]);
    expect(tauri.invoke).toHaveBeenCalledWith("acp_start", { windowLabel: "project-one" });
    expect(tauri.invoke).toHaveBeenCalledWith("acp_send", { windowLabel: "project-one", generation: 7, line: "{}" });
    expect(tauri.invoke).toHaveBeenCalledWith("acp_stop", { windowLabel: "project-one", generation: 7 });
    await expect(transport.send("{}")).rejects.toThrow("not started");
  });

  it("shares concurrent starts instead of registering duplicate listeners", async () => {
    const transport = new TauriAcpTransport();
    const first = transport.start(handlers());
    expect(transport.start(handlers())).toBe(first);
    await first;
    expect(tauri.listen).toHaveBeenCalledTimes(3);
    expect(tauri.invoke).toHaveBeenCalledTimes(1);
    await transport.stop();
  });

  it("does not start a child when stopped during listener registration", async () => {
    const registered = deferred<void>();
    const registrations = Array.from({ length: 3 }, () => deferred<() => void>());
    const unlisteners = registrations.map(() => vi.fn());
    tauri.listen.mockImplementation(() => {
      const index = tauri.listen.mock.calls.length - 1;
      if (index === 2) registered.resolve();
      return registrations[index]!.promise;
    });
    const transport = new TauriAcpTransport();
    const started = transport.start(handlers());
    const rejected = expect(started).rejects.toThrow("cancelled");
    await registered.promise;
    const stopped = transport.stop();
    registrations.forEach((registration, index) => registration.resolve(unlisteners[index]!));
    await Promise.all([rejected, stopped]);
    expect(tauri.invoke).not.toHaveBeenCalled();
    for (const unlisten of unlisteners) expect(unlisten).toHaveBeenCalledOnce();
  });

  it("reaps a child whose start completes after stop without delivering its events", async () => {
    const generation = deferred<number>();
    const starting = deferred<void>();
    tauri.invoke.mockImplementation((command: string) => {
      if (command === "acp_start") {
        starting.resolve();
        return generation.promise;
      }
      return Promise.resolve();
    });
    const callbacks = handlers();
    const transport = new TauriAcpTransport();
    const started = transport.start(callbacks);
    const rejected = expect(started).rejects.toThrow("cancelled");
    await starting.promise;
    const lateListener = tauri.listeners.get("acp://stdout")!;
    lateListener({ payload: { windowLabel: "project-one", generation: 9, lines: ["early"] } });
    const stopped = transport.stop();
    lateListener({ payload: { windowLabel: "project-one", generation: 9, lines: ["late"] } });
    generation.resolve(9);
    await Promise.all([rejected, stopped]);
    expect(callbacks.onLine).not.toHaveBeenCalled();
    expect(tauri.listeners.size).toBe(0);
    expect(tauri.invoke).toHaveBeenCalledWith("acp_stop", { windowLabel: "project-one", generation: 9 });
    await expect(transport.send("{}")).rejects.toThrow("not started");
  });

  it("cleans up successful and late subscriptions when one registration fails", async () => {
    const late = deferred<() => void>();
    const stdoutUnlisten = vi.fn();
    const exitUnlisten = vi.fn();
    tauri.listen.mockImplementation((event: string) => {
      if (event === "acp://stdout") return Promise.resolve(stdoutUnlisten);
      if (event === "acp://stderr") return Promise.reject(new Error("subscription failed"));
      return late.promise;
    });
    const transport = new TauriAcpTransport();
    await expect(transport.start(handlers())).rejects.toThrow("subscription failed");
    expect(stdoutUnlisten).toHaveBeenCalledOnce();
    late.resolve(exitUnlisten);
    await late.promise;
    expect(exitUnlisten).toHaveBeenCalledOnce();
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("replays only its generation's early events in order", async () => {
    const generation = deferred<number>();
    const starting = deferred<void>();
    tauri.invoke.mockImplementation((command: string) => {
      if (command !== "acp_start") return Promise.resolve();
      starting.resolve();
      return generation.promise;
    });
    const callbacks = handlers();
    const transport = new TauriAcpTransport();
    const started = transport.start(callbacks);
    await starting.promise;
    const listener = tauri.listeners.get("acp://stdout")!;
    listener({ payload: { windowLabel: "project-one", generation: 6, lines: ["old"] } });
    listener({ payload: { windowLabel: "project-one", generation: 7, lines: ["one", "two"] } });
    generation.resolve(7);
    await started;
    expect(callbacks.onLine.mock.calls).toEqual([["one"], ["two"]]);
    await transport.stop();
  });

  it("waits for an in-flight stop before starting a replacement", async () => {
    const stopGate = deferred<void>();
    const transport = new TauriAcpTransport();
    await transport.start(handlers());
    tauri.invoke.mockImplementation((command: string) => command === "acp_stop" ? stopGate.promise : Promise.resolve(8));
    const stopped = transport.stop();
    expect(transport.stop()).toBe(stopped);
    const replacement = transport.start(handlers());
    await Promise.resolve();
    expect(tauri.invoke.mock.calls.filter(([command]) => command === "acp_start")).toHaveLength(1);
    stopGate.resolve();
    await Promise.all([stopped, replacement]);
    expect(tauri.invoke.mock.calls.filter(([command]) => command === "acp_start")).toHaveLength(2);
    await transport.stop();
  });
});
