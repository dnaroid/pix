import { describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "@agentclientprotocol/sdk";
import type { AcpClient } from "../lib/acp-client";
import { createSessionRename } from "./session-rename.svelte";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const prompt = vi.fn().mockResolvedValue({ stopReason: "end_turn" });
  let client: AcpClient | null = { prompt } as unknown as AcpClient;
  let workspace = "/project";
  let open = true;
  let busy = false;
  let ready = true;
  let sessions: SessionInfo[] = [{ sessionId: "target", cwd: workspace, title: "Old title" }];
  const ensureRuntime = vi.fn().mockResolvedValue(undefined);
  const refreshSessions = vi.fn().mockResolvedValue(undefined);
  const reportError = vi.fn();
  const rename = createSessionRename({
    client: () => client, workspace: () => workspace, sessions: () => sessions,
    isOpen: () => open, isBusy: () => busy, runtimeReady: () => ready,
    ensureRuntime, refreshSessions, reportError,
  });
  return {
    rename, prompt, ensureRuntime, refreshSessions, reportError,
    disconnect: () => { client = null; }, switchProject: () => { workspace = "/other"; },
    close: () => { open = false; }, startRun: () => { busy = true; },
    failLoad: () => { ready = false; }, setSessions: (value: SessionInfo[]) => { sessions = value; },
  };
}

describe("session tab rename", () => {
  it("prefills the clicked tab and saves its trimmed name through the local built-in", async () => {
    const f = fixture();
    f.rename.open("target");
    expect(f.rename.request).toMatchObject({ sessionId: "target", title: "Old title" });
    await f.rename.submit('  New "name" / hello  ');
    expect(f.prompt).toHaveBeenCalledExactlyOnceWith("target", [{ type: "text", text: '/name New "name" / hello' }]);
    expect(f.refreshSessions).toHaveBeenCalledOnce();
    expect(f.rename.request).toBeNull();
  });

  it("rejects drafts, viewers and running or closed sessions", () => {
    const f = fixture();
    expect(f.rename.canRename("draft")).toBe(false);
    f.startRun();
    expect(f.rename.canRename("target")).toBe(false);
    const viewer = fixture();
    viewer.setSessions([{ sessionId: "target", cwd: "/project", _meta: { "pix.subagent": { runDir: "/run", agentId: "agent" } } }]);
    expect(viewer.rename.canRename("target")).toBe(false);
    const closed = fixture();
    closed.close();
    expect(closed.rename.canRename("target")).toBe(false);
  });

  it("does not submit blank or multiline names or duplicate saves", async () => {
    const f = fixture();
    f.rename.open("target");
    await f.rename.submit("   ");
    await f.rename.submit("first\nsecond");
    expect(f.prompt).not.toHaveBeenCalled();
    const load = deferred();
    f.ensureRuntime.mockReturnValue(load.promise);
    const save = f.rename.submit("valid");
    await f.rename.submit("duplicate");
    load.resolve();
    await save;
    expect(f.prompt).toHaveBeenCalledOnce();
  });

  it.each(["cancel", "disconnect", "switchProject", "close", "startRun"] as const)(
    "does not write after %s during preparation", async (change) => {
      const f = fixture();
      const load = deferred();
      f.ensureRuntime.mockReturnValue(load.promise);
      f.rename.open("target");
      const save = f.rename.submit("new");
      if (change === "cancel") f.rename.cancel();
      else f[change]();
      f.rename.reconcile();
      load.resolve();
      await save;
      expect(f.prompt).not.toHaveBeenCalled();
      expect(f.rename.request).toBeNull();
    },
  );

  it("does not let an old completion close a replacement dialog", async () => {
    const f = fixture();
    const response = deferred();
    f.prompt.mockReturnValueOnce(response.promise);
    f.rename.open("target");
    const save = f.rename.submit("new");
    await vi.waitFor(() => expect(f.prompt).toHaveBeenCalledOnce());
    f.rename.cancel();
    f.rename.open("target");
    const replacement = f.rename.request;
    response.resolve();
    await save;
    expect(f.rename.request).toBe(replacement);
    expect(f.refreshSessions).not.toHaveBeenCalled();
  });

  it.each(["load", "prompt"])("reports %s failure and keeps the dialog retryable", async (failure) => {
    const f = fixture();
    if (failure === "load") f.failLoad();
    else f.prompt.mockRejectedValueOnce(new Error("Rename failed"));
    f.rename.open("target");
    await f.rename.submit("new");
    expect(f.reportError).toHaveBeenCalledOnce();
    expect(f.rename.request).not.toBeNull();
    expect(f.rename.saving).toBe(false);
    expect(f.refreshSessions).not.toHaveBeenCalled();
  });
});
