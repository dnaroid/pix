import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import { REGISTRY_STATE_CHANNEL, type RegistryItem, type RegistrySnapshot } from "../lib/registry";
import { createRegistryStore } from "./registry.svelte";

afterEach(() => vi.useRealTimers());

async function fixture() {
  vi.useFakeTimers();
  const item: RegistryItem = {
    id: "skill:pdf", type: "skill", name: "pdf", local: true, remote: true,
    status: "up-to-date", statusLabel: "Up to date", icon: "=",
    publicationScope: "project", actions: ["remove", "toggle-scope"],
  };
  const snapshot: RegistrySnapshot = {
    version: 1, configured: true, branch: "main", projectKey: "project", checkedAt: "now", items: [item],
  };
  let finish!: (value: RegistrySnapshot) => void;
  let fail!: (error: Error) => void;
  let finishAction!: (value: RegistrySnapshot) => void;
  const registryAction = vi.fn()
    .mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }))
    .mockImplementationOnce(() => new Promise((resolve) => { finishAction = resolve; }))
    .mockResolvedValue(snapshot);
  const client = { registryAction } as unknown as AcpClient;
  const reportError = vi.fn();
  let workspace = "/project";
  let busy = false;
  const store = createRegistryStore({
    client: () => client, workspace: () => workspace, operationRunning: () => busy,
    sessionWorkspace: () => workspace, setErrorMessage: vi.fn(),
    loadProjectTasks: vi.fn(), loadProjectDocuments: vi.fn(), reportError,
  });
  function publish(data = snapshot) {
    store.handleSessionState({ sessionId: "session", channel: REGISTRY_STATE_CHANNEL, data });
  }
  publish();
  store.scheduleProjectSync("tasks");
  await vi.advanceTimersByTimeAsync(900);
  expect(store.backgroundSyncState.phase).toBe("syncing");
  return { store, snapshot, item, registryAction, reportError, publish,
    finish: (value = snapshot) => finish(value), fail: () => fail(new Error("network failed")),
    finishAction: () => finishAction(snapshot),
    switchWorkspace: () => { workspace = "/next"; store.reset(); publish(); },
    setBusy: () => { busy = true; },
  };
}

describe("Registry foreground action waiting", () => {
  it("reserves one slot, runs once before the next background batch, then resumes sync", async () => {
    const f = await fixture();
    const pending = f.store.runAction({ action: "remove", type: "skill", name: "pdf" }, "remove");
    await f.store.runAction({ action: "remove", type: "skill", name: "pdf" }, "duplicate");
    f.store.scheduleProjectSync("plans");
    expect(f.store.actionId).toBe("remove");
    expect(f.store.activity).toContain("queued");
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.registryAction).toHaveBeenCalledTimes(1);
    f.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.registryAction).toHaveBeenNthCalledWith(2, "/project", { action: "remove", type: "skill", name: "pdf" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.registryAction).toHaveBeenCalledTimes(2);
    f.finishAction();
    await pending;
    await vi.advanceTimersByTimeAsync(0);
    expect(f.registryAction).toHaveBeenNthCalledWith(3, "/project", { action: "sync-project", scope: "plans" });
    expect(f.store.actionId).toBeNull();
    f.store.reset();
  });

  it("cancels and settles a queued action on reset without waiting for the old RPC", async () => {
    const f = await fixture();
    const pending = f.store.runAction({ action: "refresh" }, "refresh");
    f.switchWorkspace();
    await pending;
    expect(f.store.activity).toBeNull();
    expect(f.store.actionId).toBeNull();
    f.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.registryAction).toHaveBeenCalledTimes(1);
    f.store.reset();
  });

  it("releases the queued action when background sync fails", async () => {
    const f = await fixture();
    const pending = f.store.runAction({ action: "refresh" }, "refresh");
    f.fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.registryAction).toHaveBeenNthCalledWith(2, "/project", { action: "refresh" });
    expect(f.store.backgroundSyncState.phase).toBe("error");
    f.finishAction();
    await pending;
    expect(f.store.actionId).toBeNull();
    f.store.reset();
  });

  it.each(["missing", "unavailable", "scope", "registry", "busy"])("rejects stale queued intent: %s", async (change) => {
    const f = await fixture();
    const pending = f.store.runAction({ action: "toggle-scope", type: "skill", name: "pdf" }, "scope");
    let next = f.snapshot;
    if (change === "missing") next = { ...next, items: [] };
    if (change === "unavailable") next = { ...next, items: [{ ...f.item, actions: [] }] };
    if (change === "scope") next = { ...next, items: [{ ...f.item, publicationScope: "global" }] };
    if (change === "registry") next = { ...next, remote: "other-registry" };
    if (change === "busy") f.setBusy();
    f.finish(next);
    await pending;
    expect(f.registryAction).toHaveBeenCalledTimes(1);
    expect(f.reportError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("Review the resource") }));
    expect(f.store.actionId).toBeNull();
    f.store.reset();
  });

  it("does not release a waiting action when an unconfigured poll arrives during the RPC", async () => {
    const f = await fixture();
    const pending = f.store.runAction({ action: "refresh" }, "refresh");
    f.publish({ ...f.snapshot, configured: false });
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.store.backgroundSyncState.phase).toBe("syncing");
    expect(f.registryAction).toHaveBeenCalledTimes(1);
    f.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.registryAction).toHaveBeenCalledTimes(2);
    f.finishAction();
    await pending;
    f.store.reset();
  });
});
