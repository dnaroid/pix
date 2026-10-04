import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import { REGISTRY_STATE_CHANNEL } from "../lib/registry";
import { createRegistryStore } from "./registry.svelte";

afterEach(() => vi.useRealTimers());

describe("registry background project sync", () => {
  it("does not reload the next workspace after a stale pull finishes", async () => {
    let finishPull!: () => void;
    const registryAction = vi.fn(() => new Promise<any>((resolve) => {
      finishPull = () => resolve({ version: 1, configured: true, branch: "main", items: [], checkedAt: "now" });
    }));
    const client = { registryAction } as unknown as AcpClient;
    let workspace = "/one";
    const loadWorkspaceSettings = vi.fn();
    const loadProjectTasks = vi.fn();
    const loadProjectDocuments = vi.fn();
    const store = createRegistryStore({
      client: () => client,
      operationRunning: () => false,
      workspace: () => workspace,
      sessionWorkspace: () => workspace,
      setErrorMessage: vi.fn(),
      loadWorkspaceSettings,
      loadProjectTasks,
      loadProjectDocuments,
      reportError: vi.fn(),
    });

    const pending = store.runAction({ action: "pull-project", scope: "project" }, "pull-old");
    workspace = "/two";
    store.reset();
    finishPull();
    await pending;

    expect(loadWorkspaceSettings).not.toHaveBeenCalled();
    expect(loadProjectTasks).not.toHaveBeenCalled();
    expect(loadProjectDocuments).not.toHaveBeenCalled();
  });

  it("keeps Registry update busy state local to the Registry store", async () => {
    let finishUpdate!: () => void;
    const registryAction = vi.fn(() => new Promise<any>((resolve) => {
      finishUpdate = () => resolve({
        version: 1,
        configured: true,
        branch: "main",
        items: [],
        checkedAt: "now",
      });
    }));
    const client = { registryAction } as unknown as AcpClient;
    const store = createRegistryStore({
      client: () => client,
      operationRunning: () => false,
      workspace: () => "/project",
      sessionWorkspace: () => "/project",
      setErrorMessage: vi.fn(),
      loadProjectTasks: vi.fn(),
      loadProjectDocuments: vi.fn(),
      reportError: vi.fn(),
    });

    const pending = store.runAction(
      { action: "update", type: "skill", name: "pdf" },
      "skill:pdf:update",
    );

    expect(store.actionId).toBe("skill:pdf:update");
    expect(registryAction).toHaveBeenCalledWith("/project", {
      action: "update",
      type: "skill",
      name: "pdf",
    });

    finishUpdate();
    await pending;

    expect(store.actionId).toBeNull();
  });

  it("pushes a debounced project artifact without taking the foreground operation lock", async () => {
    vi.useFakeTimers();
    const registryAction = vi.fn(async () => ({
      version: 1 as const,
      configured: true,
      branch: "main",
      items: [],
      checkedAt: "now",
    }));
    const client = { registryAction } as unknown as AcpClient;
    const store = createRegistryStore({
      client: () => client,
      operationRunning: () => false,
      workspace: () => "/project",
      sessionWorkspace: () => "/project",
      setErrorMessage: vi.fn(),
      loadProjectTasks: vi.fn(),
      loadProjectDocuments: vi.fn(),
      reportError: vi.fn(),
    });
    store.handleSessionState({
      sessionId: "session-1",
      channel: REGISTRY_STATE_CHANNEL,
      data: {
        version: 1,
        configured: true,
        branch: "main",
        checkedAt: "2026-09-13T12:00:00Z",
        items: [],
      },
    });

    store.scheduleProjectSync("tasks");
    expect(store.backgroundSyncState.phase).toBe("pending");
    await vi.advanceTimersByTimeAsync(900);

    expect(registryAction).toHaveBeenCalledWith("/project", {
      action: "sync-project",
      scope: "tasks",
    });
    expect(store.backgroundSyncState.phase).toBe("idle");
  });

  it("reloads project documents when an external plans change is observed", () => {
    vi.useFakeTimers();
    const loadProjectTasks = vi.fn();
    const loadProjectDocuments = vi.fn();
    const store = createRegistryStore({
      client: () => null,
      operationRunning: () => false,
      workspace: () => "/project",
      sessionWorkspace: () => "/project",
      setErrorMessage: vi.fn(),
      loadProjectTasks,
      loadProjectDocuments,
      reportError: vi.fn(),
    });

    store.observeProjectChange("plans");

    expect(loadProjectDocuments).toHaveBeenCalledOnce();
    expect(loadProjectDocuments).toHaveBeenCalledWith("/project");
    expect(loadProjectTasks).not.toHaveBeenCalled();
    expect(store.backgroundSyncState).toMatchObject({
      phase: "pending",
      dirtyScopes: ["plans"],
    });
    store.reset();
  });

  it("reloads externally changed plans even while another registry sync is pending", () => {
    vi.useFakeTimers();
    const loadProjectDocuments = vi.fn();
    const store = createRegistryStore({
      client: () => null,
      operationRunning: () => false,
      workspace: () => "/project",
      sessionWorkspace: () => "/project",
      setErrorMessage: vi.fn(),
      loadProjectTasks: vi.fn(),
      loadProjectDocuments,
      reportError: vi.fn(),
    });
    store.scheduleProjectSync("tasks");

    store.observeProjectChange("plans");

    expect(loadProjectDocuments).toHaveBeenCalledWith("/project");
    expect(store.backgroundSyncState).toMatchObject({
      phase: "pending",
      dirtyScopes: ["tasks", "plans"],
    });
    store.reset();
  });
});

function syncFixture(registryAction: ReturnType<typeof vi.fn>) {
  const client = { registryAction } as unknown as AcpClient;
  let workspace = "/project";
  const reportError = vi.fn();
  const store = createRegistryStore({
    client: () => client,
    operationRunning: () => false,
    workspace: () => workspace,
    sessionWorkspace: () => workspace,
    setErrorMessage: vi.fn(),
    loadWorkspaceSettings: vi.fn(),
    loadProjectTasks: vi.fn(),
    loadProjectDocuments: vi.fn(),
    reportError,
  });
  const snapshot = { version: 1, configured: true, branch: "main", checkedAt: "now", items: [] };
  const publish = (data: unknown = snapshot) => store.handleSessionState({
    sessionId: "session", channel: REGISTRY_STATE_CHANNEL, data,
  });
  publish();
  return { store, snapshot, publish, reportError, switchWorkspace: () => { workspace = "/next"; store.reset(); publish(); } };
}

describe("manual bulk project resource sync", () => {
  it.each(["error", "projectIssue"])("serializes one workspace RPC and reports snapshot %s", async (field) => {
    let finish!: (value: unknown) => void;
    const registryAction = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const f = syncFixture(registryAction);
    const pending = f.store.runAction({ action: "push-project-resources" }, "push-project-resources");
    expect(f.store.actionId).toBe("push-project-resources");
    await f.store.runAction({ action: "push-project-resources" }, "duplicate");
    expect(registryAction).toHaveBeenCalledExactlyOnceWith("/project", { action: "push-project-resources" });
    finish({ ...f.snapshot, [field]: "push failed" });
    await pending;
    expect(f.reportError).toHaveBeenCalledWith(new Error("push failed"));
    expect(f.store.actionId).toBeNull();
    f.store.reset();
  });

  it("discards a bulk sync completion after switching projects", async () => {
    let finish!: (value: unknown) => void;
    const registryAction = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const f = syncFixture(registryAction);
    const pending = f.store.runAction({ action: "push-project-resources" }, "push-project-resources");
    f.switchWorkspace();
    finish({ ...f.snapshot, error: "old project failed" });
    await pending;
    expect(f.store.snapshot?.error).toBeUndefined();
    expect(f.reportError).not.toHaveBeenCalled();
    expect(f.store.actionId).toBeNull();
    f.store.reset();
  });

  it("rejects manual sync while automatic resource publication is in flight", async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    const registryAction = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const f = syncFixture(registryAction);
    f.publish({ ...f.snapshot, items: [{
      id: "skill:draft", type: "skill", name: "draft", status: "local-changes", statusLabel: "Local changes",
      icon: "!", local: true, remote: true, publicationScope: "project", actions: ["push"],
    }] });
    await vi.advanceTimersByTimeAsync(900);
    expect(f.store.resourceAutoPushState.phase).toBe("syncing");
    await f.store.runAction({ action: "push-project-resources" }, "push-project-resources");
    expect(registryAction).toHaveBeenCalledTimes(1);
    finish(f.snapshot);
    await vi.advanceTimersByTimeAsync(0);
    f.store.reset();
  });
});

describe("automatic project sync recovery", () => {
  it("coalesces dirty workspace state and Local-only project resources on snapshot ingestion", async () => {
    vi.useFakeTimers();
    const registryAction = vi.fn(async () => fixture.snapshot);
    const fixture = syncFixture(registryAction);
    const item = { id: "project:workspace", type: "project", artifact: "workspace", name: "workspace.jsonc",
      status: "local-changes", statusLabel: "LOCAL CHANGES", icon: "!", local: true, remote: true, actions: ["push", "pull"] };
    fixture.publish({ ...fixture.snapshot, items: [item,
      { ...item, id: "skill:draft", type: "skill", artifact: undefined, name: "draft", status: "local-only" },
      { ...item, id: "project:todo", artifact: "todo", status: "diverged" }] });
    await vi.advanceTimersByTimeAsync(899);
    expect(registryAction).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(registryAction).toHaveBeenCalledExactlyOnceWith("/project", { action: "sync-project", scope: "project" });
    fixture.store.reset();
  });

  it("retains snapshot errors and dirty scopes instead of reporting successful sync or poll retrying", async () => {
    vi.useFakeTimers();
    const registryAction = vi.fn(async () => ({ ...fixture.snapshot, error: "remote changed" }));
    const fixture = syncFixture(registryAction);
    fixture.store.scheduleProjectSync("tasks");
    await vi.advanceTimersByTimeAsync(900);
    expect(fixture.store.backgroundSyncState).toMatchObject({ phase: "error", error: "remote changed", dirtyScopes: ["tasks"] });
    fixture.store.observeProjectChange("plans");
    fixture.publish();
    await vi.advanceTimersByTimeAsync(3000);
    expect(registryAction).toHaveBeenCalledTimes(1);
    expect(fixture.store.backgroundSyncState.dirtyScopes).toEqual(["tasks", "plans"]);
    fixture.store.reset();
  });

  it("keeps an external workspace change observed during an in-flight tasks sync", async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    const registryAction = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockImplementation(async () => fixture.snapshot);
    const fixture = syncFixture(registryAction);
    fixture.store.scheduleProjectSync("tasks");
    await vi.advanceTimersByTimeAsync(900);
    fixture.store.observeProjectChange("workspace");
    finish(fixture.snapshot);
    await vi.advanceTimersByTimeAsync(900);
    expect(registryAction.mock.calls).toEqual([
      ["/project", { action: "sync-project", scope: "tasks" }],
      ["/project", { action: "sync-project", scope: "workspace" }],
    ]);
    fixture.store.reset();
  });

  it("ignores an old workspace's error completion after reset", async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    const registryAction = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockImplementation(async () => fixture.snapshot);
    const fixture = syncFixture(registryAction);
    fixture.store.scheduleProjectSync("tasks");
    await vi.advanceTimersByTimeAsync(900);
    fixture.switchWorkspace();
    fixture.store.scheduleProjectSync("workspace");
    finish({ ...fixture.snapshot, error: "old error" });
    await vi.advanceTimersByTimeAsync(900);
    expect(fixture.store.snapshot?.error).toBeUndefined();
    expect(fixture.store.backgroundSyncState.phase).toBe("idle");
    expect(registryAction.mock.calls[1]).toEqual(["/next", { action: "sync-project", scope: "workspace" }]);
    fixture.store.reset();
  });

  it("auto-pushes a project-scope skill with local changes without a manual Push", async () => {
    vi.useFakeTimers();
    const registryAction = vi.fn(async () => fixture.snapshot);
    const fixture = syncFixture(registryAction);
    const item = {
      id: "skill:pdf", type: "skill", name: "pdf", status: "local-changes", statusLabel: "LOCAL CHANGES",
      icon: "!", local: true, remote: true, publicationScope: "project", actions: ["push"],
    };
    fixture.publish({ ...fixture.snapshot, items: [item] });
    await vi.advanceTimersByTimeAsync(900);
    expect(registryAction).toHaveBeenCalledExactlyOnceWith("/project", { action: "push", type: "skill", name: "pdf" });
    expect(fixture.store.resourceAutoPushState.phase).toBe("idle");
    fixture.store.reset();
  });

  it("does not auto-push a global-scope skill with local changes", async () => {
    vi.useFakeTimers();
    const registryAction = vi.fn(async () => fixture.snapshot);
    const fixture = syncFixture(registryAction);
    const item = {
      id: "skill:pdf", type: "skill", name: "pdf", status: "local-changes", statusLabel: "LOCAL CHANGES",
      icon: "!", local: true, remote: true, publicationScope: "global", actions: ["push"],
    };
    fixture.publish({ ...fixture.snapshot, items: [item] });
    await vi.advanceTimersByTimeAsync(3000);
    expect(registryAction).not.toHaveBeenCalled();
    expect(fixture.store.resourceAutoPushState.phase).toBe("idle");
    fixture.store.reset();
  });
});
