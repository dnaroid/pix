import { describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import { createBackgroundForkController } from "./background-fork";

function setup() {
  const client = {} as AcpClient;
  let currentClient: AcpClient | null = client;
  let owned = true;
  let ready = false;
  const history = { primeBackground: vi.fn().mockResolvedValue(true) };
  const runtime = {
    ensure: vi.fn(async () => { ready = true; }),
    captureOwnership: () => () => owned,
    isReady: () => ready,
  };
  const catalog = { ensureProvisional: vi.fn(), refresh: vi.fn() };
  const tabs = { show: vi.fn() };
  const reportError = vi.fn();
  const controller = createBackgroundForkController({
    client: () => currentClient, workspace: () => "/project", reportError,
    sessions: { history, runtime, catalog, tabs } as unknown as Parameters<typeof createBackgroundForkController>[0]["sessions"],
  });
  return { controller, client, history, runtime, catalog, tabs, reportError,
    disconnect: () => { currentClient = null; }, close: () => { owned = false; ready = false; } };
}

const notification = { sourceSessionId: "source", sessionId: "child", cwd: "/project" };

describe("background fork adoption", () => {
  it("primes history before exposing/loading a background tab, without a selection API", async () => {
    const f = setup();
    await f.controller.handleReady(notification);
    expect(f.history.primeBackground).toHaveBeenCalledWith(f.client, "child", "/project");
    expect(f.tabs.show).toHaveBeenCalledWith("child");
    expect(f.history.primeBackground.mock.invocationCallOrder[0]).toBeLessThan(f.tabs.show.mock.invocationCallOrder[0]!);
    expect(f.tabs.show.mock.invocationCallOrder[0]).toBeLessThan(f.runtime.ensure.mock.invocationCallOrder[0]!);
    expect(f.catalog.ensureProvisional).toHaveBeenCalledWith("child", "/project");
    expect(f.runtime.ensure).toHaveBeenCalledOnce();
    expect(f.reportError).not.toHaveBeenCalled();
  });

  it.each(["disconnect", "invalidated"])("does not expose a stale child after %s during history load", async (reason) => {
    const f = setup();
    f.history.primeBackground.mockImplementation(async () => {
      if (reason === "disconnect") f.disconnect();
      return reason !== "invalidated";
    });
    await f.controller.handleReady(notification);
    expect(f.tabs.show).not.toHaveBeenCalled();
    expect(f.runtime.ensure).not.toHaveBeenCalled();
  });

  it("does not finish adoption after a tab was closed during runtime loading", async () => {
    const f = setup();
    f.runtime.ensure.mockImplementation(async () => { f.close(); });
    await f.controller.handleReady(notification);
    expect(f.catalog.refresh).not.toHaveBeenCalled();
    expect(f.reportError).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent notifications and ignores other workspaces", async () => {
    const f = setup();
    await Promise.all([f.controller.handleReady(notification), f.controller.handleReady(notification)]);
    await f.controller.handleReady({ ...notification, cwd: "/other" });
    expect(f.runtime.ensure).toHaveBeenCalledOnce();
  });

  it("reports history failure without starting a partial-history prompt", async () => {
    const f = setup();
    const error = new Error("history unavailable");
    f.history.primeBackground.mockRejectedValue(error);
    await f.controller.handleReady(notification);
    expect(f.reportError).toHaveBeenCalledWith(error);
    expect(f.runtime.ensure).not.toHaveBeenCalled();
  });
});
