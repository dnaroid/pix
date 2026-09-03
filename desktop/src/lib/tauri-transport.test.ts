import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, listener: (event: { payload: unknown }) => void) => {
    tauri.listeners.set(event, listener);
    return () => tauri.listeners.delete(event);
  }),
}));

import { TauriAcpTransport } from "./tauri-transport";

describe("TauriAcpTransport", () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
    tauri.listeners.clear();
    tauri.invoke.mockImplementation(async (command: string) => command === "acp_start" ? 7 : undefined);
  });

  it("filters stale events and generation-guards sends and stops", async () => {
    const lines: string[] = [];
    const transport = new TauriAcpTransport();
    await transport.start({
      onLine: (line) => lines.push(line),
      onStderr: () => {},
      onExit: () => {},
    });

    tauri.listeners.get("acp://stdout")?.({ payload: { generation: 6, line: "stale" } });
    tauri.listeners.get("acp://stdout")?.({ payload: { generation: 7, line: "current" } });
    await transport.send("{}");
    await transport.stop();

    expect(lines).toEqual(["current"]);
    expect(tauri.invoke).toHaveBeenCalledWith("acp_send", { generation: 7, line: "{}" });
    expect(tauri.invoke).toHaveBeenCalledWith("acp_stop", { generation: 7 });
    await expect(transport.send("{}")).rejects.toThrow("not started");
  });
});
