import { describe, expect, it, vi } from "vitest";
import type { ListSessionsResponse } from "@agentclientprotocol/sdk";
import type { AcpClient } from "../lib/acp-client";
import { createSessionCatalog } from "./session-catalog.svelte";
import type { createSessionTabsState } from "./session-tabs-state.svelte";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function result(sessionId: string): ListSessionsResponse {
  return { sessions: [{ sessionId, cwd: "/workspace", updatedAt: "2026-10-08T00:00:00.000Z", title: sessionId }] };
}

function fixture(listSessions: () => Promise<ListSessionsResponse>) {
  let workspace = "/workspace";
  const client = { listSessions: vi.fn(listSessions) } as unknown as AcpClient;
  let selectedClient: AcpClient | null = client;
  const mergeRestored = vi.fn();
  let savedTabs: string[] | null = null;
  const reportError = vi.fn();
  const catalog = createSessionCatalog({
    client: () => selectedClient, workspace: () => workspace,
    tabs: { mergeRestored, sessionTabsForProject: () => savedTabs } as unknown as ReturnType<typeof createSessionTabsState>,
    reportError,
  });
  return {
    catalog, client, mergeRestored, reportError,
    setWorkspace: (next: string) => { workspace = next; },
    setClient: (next: AcpClient | null) => { selectedClient = next; },
    setSavedTabs: (ids: string[]) => { savedTabs = ids; },
  };
}

describe("native session catalog updates", () => {
  it("reconciles missing saved tabs before applying a partial startup catalog", async () => {
    const discovery = deferred<ListSessionsResponse>();
    const f = fixture(vi.fn()
      .mockResolvedValueOnce(result("cached"))
      .mockImplementationOnce(() => discovery.promise));
    f.setSavedTabs(["restored"]);
    const listing = f.catalog.listNow();
    await vi.waitFor(() => expect(f.client.listSessions).toHaveBeenCalledTimes(2));
    expect(f.client.listSessions).toHaveBeenLastCalledWith("/workspace", { waitForDiscovery: true });
    expect(f.mergeRestored).not.toHaveBeenCalled();
    discovery.resolve(result("restored"));
    expect((await listing)?.sessions.map(s => s.sessionId)).toEqual(["restored"]);
    expect(f.mergeRestored).toHaveBeenCalledTimes(1);
    expect(f.mergeRestored).toHaveBeenCalledWith("/workspace", null, ["restored"]);
  });

  it.each(["listNow", "refresh"] as const)("keeps the saved snapshot untouched when %s reconciliation fails", async method => {
    const failure = new Error("discovery failed");
    const f = fixture(vi.fn().mockResolvedValueOnce(result("cached")).mockRejectedValueOnce(failure));
    f.setSavedTabs(["restored"]);
    await f.catalog[method]();
    expect(f.mergeRestored).not.toHaveBeenCalled();
    expect(f.reportError).toHaveBeenCalledWith(failure);
  });

  it("keeps startup fast when every saved tab is already in the map", async () => {
    const f = fixture(async () => result("saved"));
    f.setSavedTabs(["saved"]);
    await f.catalog.listNow();
    expect(f.client.listSessions).toHaveBeenCalledExactlyOnceWith("/workspace");
    expect(f.mergeRestored).toHaveBeenCalledWith("/workspace", null, ["saved"]);
  });

  it("allows pruning only after authoritative discovery confirms a saved tab is gone", async () => {
    const f = fixture(vi.fn().mockResolvedValue({ sessions: [] }));
    f.setSavedTabs(["deleted"]);
    await f.catalog.listNow();
    expect(f.client.listSessions).toHaveBeenCalledTimes(2);
    expect(f.mergeRestored).toHaveBeenCalledExactlyOnceWith("/workspace", null, []);
  });

  it("ignores reconciliation completing after a workspace switch", async () => {
    const discovery = deferred<ListSessionsResponse>();
    const f = fixture(vi.fn().mockResolvedValueOnce(result("cached")).mockReturnValueOnce(discovery.promise));
    f.setSavedTabs(["restored"]);
    const listing = f.catalog.listNow();
    await vi.waitFor(() => expect(f.client.listSessions).toHaveBeenCalledTimes(2));
    f.setWorkspace("/other");
    f.catalog.invalidate();
    discovery.resolve(result("restored"));
    expect(await listing).toBeNull();
    expect(f.mergeRestored).not.toHaveBeenCalled();
  });

  it("delays a native discovery notification until the first list settles", async () => {
    const initial = deferred<ListSessionsResponse>();
    const f = fixture(vi.fn()
      .mockImplementationOnce(() => initial.promise)
      .mockResolvedValueOnce(result("discovered")));
    const first = f.catalog.listNow();
    f.catalog.nativeCatalogChanged("/workspace");
    expect(f.client.listSessions).toHaveBeenCalledTimes(1);
    initial.resolve(result("saved"));
    expect((await first)?.sessions.map(s => s.sessionId)).toEqual(["saved"]);
    await vi.waitFor(() => expect(f.catalog.sessions.map(s => s.sessionId)).toEqual(["discovered"]));
    expect(f.client.listSessions).toHaveBeenCalledTimes(2);
    expect(f.reportError).not.toHaveBeenCalled();
  });

  it("joins a refresh requested while the startup list is pending instead of discarding startup", async () => {
    const initial = deferred<ListSessionsResponse>();
    const f = fixture(vi.fn()
      .mockImplementationOnce(() => initial.promise)
      .mockResolvedValueOnce(result("later")));
    const listing = f.catalog.listNow();
    const refreshing = f.catalog.refresh();
    expect(f.client.listSessions).toHaveBeenCalledTimes(1);
    initial.resolve(result("saved"));
    expect((await listing)?.sessions.map(s => s.sessionId)).toEqual(["saved"]);
    await refreshing;
    expect(f.catalog.sessions.map(s => s.sessionId)).toEqual(["saved"]);
    expect(f.mergeRestored).toHaveBeenCalledTimes(1);
    await f.catalog.refresh();
    expect(f.client.listSessions).toHaveBeenCalledTimes(2);
    expect(f.catalog.sessions.map(s => s.sessionId)).toEqual(["later"]);
  });

  it("reruns a refresh when a discovery update arrives during an older request", async () => {
    const stale = deferred<ListSessionsResponse>();
    const f = fixture(vi.fn()
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce(result("fresh")));
    const first = f.catalog.refresh();
    f.catalog.nativeCatalogChanged("/workspace");
    expect(f.client.listSessions).toHaveBeenCalledTimes(1);
    stale.resolve(result("stale"));
    await first;
    await vi.waitFor(() => expect(f.catalog.sessions.map(s => s.sessionId)).toEqual(["fresh"]));
    expect(f.client.listSessions).toHaveBeenCalledTimes(2);
  });

  it("ignores notifications for old workspace or replaced ACP connection", async () => {
    const stale = deferred<ListSessionsResponse>();
    const f = fixture(() => stale.promise);
    const first = f.catalog.listNow();
    f.catalog.nativeCatalogChanged("/workspace");
    f.setWorkspace("/other");
    f.catalog.invalidate();
    f.catalog.nativeCatalogChanged("/workspace");
    stale.resolve(result("stale"));
    expect(await first).toBeNull();
    await Promise.resolve();
    expect(f.client.listSessions).toHaveBeenCalledTimes(1);
    expect(f.mergeRestored).not.toHaveBeenCalled();
    f.setClient(null);
    f.catalog.nativeCatalogChanged("/other");
    expect(f.client.listSessions).toHaveBeenCalledTimes(1);
  });
});
