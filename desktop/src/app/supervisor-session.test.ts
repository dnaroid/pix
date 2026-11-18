import { describe, expect, it, vi } from "vitest";
import { createSupervisorSessionAction } from "./supervisor-session";
import { sessionIsSupervisor } from "../lib/session-tabs";
import { COMMAND_PALETTE_IDS, desktopCommandDefinition } from "../lib/desktop-commands";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function fixture() {
  const client = { openSupervisor: vi.fn(async () => ({ sessionId: "sup", created: true })) };
  let current: typeof client | null = client;
  let workspace = "/p";
  const calls: string[] = [];
  const action = createSupervisorSessionAction({
    client: () => current,
    workspace: () => workspace,
    refreshSessions: async () => { calls.push("refresh"); },
    loadSession: async (id) => { calls.push(`load:${id}`); },
    activateTab: (id) => { calls.push(`tab:${id}`); },
    reportError: (error) => { calls.push(`error:${(error as Error).message}`); },
  });
  return {
    client, calls, action,
    setClient: (next: typeof client | null) => { current = next; },
    setWorkspace: (next: string) => { workspace = next; },
  };
}

describe("project supervisor session action", () => {
  it("opens the ACP-owned session, refreshes the catalog, then shows its tab", async () => {
    const { client, calls, action } = fixture();
    await action.open();
    expect(client.openSupervisor).toHaveBeenCalledWith("/p");
    expect(calls).toEqual(["refresh", "load:sup", "tab:sup"]);
  });

  it("joins repeated clicks into one request", async () => {
    const { client, action } = fixture();
    const gate = deferred<{ sessionId: string; created: boolean }>();
    client.openSupervisor.mockReturnValueOnce(gate.promise);
    const first = action.open();
    const second = action.open();
    gate.resolve({ sessionId: "sup", created: false });
    await Promise.all([first, second]);
    expect(client.openSupervisor).toHaveBeenCalledTimes(1);
  });

  it("drops a stale reply after a workspace switch and reports only current errors", async () => {
    const { client, calls, action, setWorkspace } = fixture();
    const gate = deferred<{ sessionId: string; created: boolean }>();
    client.openSupervisor.mockReturnValueOnce(gate.promise);
    const pending = action.open();
    setWorkspace("/other");
    gate.resolve({ sessionId: "sup", created: true });
    await pending;
    expect(calls).toEqual([]);

    setWorkspace("/p");
    client.openSupervisor.mockRejectedValueOnce(new Error("requires Pix Desktop"));
    await action.open();
    expect(calls).toEqual(["error:requires Pix Desktop"]);
  });

  it("does nothing without a connection", async () => {
    const { client, calls, action, setClient } = fixture();
    setClient(null);
    await action.open();
    expect(client.openSupervisor).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("recognizes the supervisor marker and exposes a palette command", () => {
    expect(sessionIsSupervisor({ sessionId: "a", cwd: "/p", _meta: { "pix.supervisor": true } })).toBe(true);
    expect(sessionIsSupervisor({ sessionId: "b", cwd: "/p" })).toBe(false);
    expect(COMMAND_PALETTE_IDS).toContain("session.supervisor");
    expect(desktopCommandDefinition("session.supervisor").label).toBe("Open Project Supervisor");
  });
});
