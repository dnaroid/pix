import { describe, expect, it, vi } from "vitest";
import { createSupervisorHandover, createSupervisorSessionAction, createSupervisorTabAutoClose, handleSupervisorMenu, SUPERVISOR_MENU_UNAVAILABLE } from "./supervisor-session";
import { sessionIsSupervisor } from "../lib/session-tabs";
import { COMMAND_PALETTE_IDS, desktopCommandDefinition } from "../lib/desktop-commands";
import type { SupervisorOpenResponse } from "../../../acp/src/acp/supervisor-contract";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function fixture() {
  const client = { openSupervisor: vi.fn(async (): Promise<SupervisorOpenResponse> => ({ sessionId: "sup", created: true })) };
  let current: typeof client | null = client;
  let workspace = "/p";
  const calls: string[] = [];
  const action = createSupervisorSessionAction({
    client: () => current,
    workspace: () => workspace,
    refreshSessions: async () => { calls.push("refresh"); },
    loadSession: async (id) => { calls.push(`load:${id}`); },
    activateTab: (id) => { calls.push(`tab:${id}`); },
    replaceRetiredTab: async (old, id) => { calls.push(`replace:${old}:${id}`); return true; },
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

  it("runs a fresh open after an ordinary open and shows only the replacement", async () => {
    const { client, calls, action } = fixture();
    const gate = deferred<{ sessionId: string; created: boolean }>();
    client.openSupervisor.mockReturnValueOnce(gate.promise).mockResolvedValueOnce({ sessionId: "fresh", created: true, previousSessionId: "old" });
    const ordinary = action.open();
    await Promise.resolve();
    const fresh = action.open(true);
    expect(action.open(true)).toBe(fresh);
    expect(action.open()).toBe(fresh);
    gate.resolve({ sessionId: "old", created: false });
    await Promise.all([ordinary, fresh]);
    expect(client.openSupervisor.mock.calls).toEqual([["/p"], ["/p", true]]);
    expect(calls).toEqual(["refresh", "load:fresh", "tab:fresh", "replace:old:fresh"]);
  });

  it("drops a stale reply after a workspace switch and reports only current errors", async () => {
    const { client, calls, action, setWorkspace } = fixture();
    const gate = deferred<SupervisorOpenResponse>();
    client.openSupervisor.mockReturnValueOnce(gate.promise);
    const pending = action.open(true);
    await Promise.resolve();
    setWorkspace("/other");
    gate.resolve({ sessionId: "sup", created: true, previousSessionId: "old" });
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
    expect(COMMAND_PALETTE_IDS).toContain("session.supervisorFresh");
    expect(desktopCommandDefinition("session.supervisorFresh").label).toBe("New Project Supervisor Conversation");
  });

  it("app menu runs the palette command when available and otherwise explains instead of dropping the click", async () => {
    let available = false;
    const execute = vi.fn(async () => {});
    const notices: string[] = [];
    const commands = { enabled: () => available, execute };
    await handleSupervisorMenu(commands, (message) => notices.push(message));
    expect(execute).not.toHaveBeenCalled();
    expect(notices).toEqual([SUPERVISOR_MENU_UNAVAILABLE]);
    available = true;
    await handleSupervisorMenu(commands, (message) => notices.push(message));
    expect(execute).toHaveBeenCalledWith("session.supervisor");
    expect(notices).toHaveLength(1);
  });
});

describe("manual supervisor handover", () => {
  function handover(sessions: Array<{ sessionId: string; _meta?: Record<string, unknown> }>) {
    const client = { supervisorHandover: vi.fn(async (_cwd: string, _id: string, supervised: boolean) => ({ supervised })) };
    let current: typeof client | null = client;
    const errors: unknown[] = [];
    const refresh = vi.fn(async () => {});
    const action = createSupervisorHandover({
      client: () => current,
      workspace: () => "/p",
      sessions: () => sessions.map((session) => ({ cwd: "/p", ...session })),
      refreshSessions: refresh,
      reportError: (error) => errors.push(error),
    });
    return { client, action, errors, refresh, setClient: (next: typeof client | null) => { current = next; } };
  }
  const supervisor = { sessionId: "sup", _meta: { "pix.supervisor": true } };

  it("offers handover only for ordinary sessions while a supervisor exists", () => {
    const h = handover([supervisor, { sessionId: "w" }, { sessionId: "m", _meta: { "pix.supervisorManaged": "manual" } }]);
    expect(h.action.supervision("w")).toEqual({ mode: undefined, supervisorAvailable: true, enabled: true });
    expect(h.action.supervision("m")).toEqual({ mode: "manual", supervisorAvailable: true, enabled: true });
    expect(h.action.supervision("sup")).toBeUndefined();
    expect(h.action.supervision("missing")).toBeUndefined();
    const none = handover([{ sessionId: "w" }, { sessionId: "m", _meta: { "pix.supervisorManaged": "manual" } }]);
    expect(none.action.supervision("w")).toEqual({ mode: undefined, supervisorAvailable: false, enabled: true });
    expect(none.action.supervision("m")).toEqual({ mode: "manual", supervisorAvailable: false, enabled: true });
  });

  it("calls ACP once per pending change, refreshes, and drops stale results", async () => {
    const worker = { sessionId: "w", _meta: { "pix.supervisorManaged": "manual" } };
    const h = handover([supervisor, worker]);
    let release!: () => void;
    h.client.supervisorHandover.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ supervised: true }); }));
    const first = h.action.setSupervised("w", true);
    expect(h.action.supervision("w")?.enabled).toBe(false);
    await h.action.setSupervised("w", true);
    expect(h.client.supervisorHandover).toHaveBeenCalledOnce();
    release();
    await first;
    expect(h.refresh).toHaveBeenCalledOnce();
    h.client.supervisorHandover.mockRejectedValueOnce(new Error("no supervisor"));
    await h.action.setSupervised("w", true);
    expect(h.errors).toHaveLength(1);
    h.client.supervisorHandover.mockImplementationOnce(async () => { h.setClient(null); throw new Error("late"); });
    await h.action.setSupervised("w", false);
    expect(h.client.supervisorHandover).toHaveBeenLastCalledWith("/p", "w", false);
    expect(h.errors).toHaveLength(1);
  });
});

describe("supervisor close-tab auto close", () => {
  function autoClose(overrides: Partial<Parameters<typeof createSupervisorTabAutoClose>[0]> = {}) {
    const closed: string[] = [];
    const options = {
      workspace: () => "/p",
      isTabOpen: (id: string) => id === "w",
      isBusy: () => false,
      closeTab: async (id: string) => { closed.push(id); return true; },
      ...overrides,
    };
    return { action: createSupervisorTabAutoClose(options), closed };
  }

  it("closes the tab of an idle, open worker of the current workspace", async () => {
    const h = autoClose();
    await expect(h.action({ cwd: "/p", sessionId: "w" })).resolves.toEqual({ closed: true });
    expect(h.closed).toEqual(["w"]);
  });

  it("never closes for another workspace, an unopened tab or a busy session", async () => {
    const busy = autoClose({ isBusy: (id) => id === "w" });
    await expect(busy.action({ cwd: "/p", sessionId: "w" })).resolves.toEqual({ closed: false });
    const otherWorkspace = autoClose();
    await expect(otherWorkspace.action({ cwd: "/other", sessionId: "w" })).resolves.toEqual({ closed: false });
    const unopened = autoClose();
    await expect(unopened.action({ cwd: "/p", sessionId: "gone" })).resolves.toEqual({ closed: false });
    expect([...busy.closed, ...otherWorkspace.closed, ...unopened.closed]).toEqual([]);
  });

  it("reports no close when closing fails", async () => {
    const h = autoClose({ closeTab: async () => { throw new Error("busy mutation"); } });
    await expect(h.action({ cwd: "/p", sessionId: "w" })).resolves.toEqual({ closed: false });
  });
});
