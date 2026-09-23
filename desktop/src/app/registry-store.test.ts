import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import { REGISTRY_STATE_CHANNEL } from "../lib/registry";
import { createRegistryStore } from "./registry.svelte";

afterEach(() => vi.useRealTimers());

describe("registry background project sync", () => {
  it("does not reload the next workspace or unlock its action after a stale pull finishes", async () => {
    let finishPull!: () => void;
    const registryAction = vi.fn(() => new Promise<any>((resolve) => {
      finishPull = () => resolve({ version: 1, configured: true, branch: "main", items: [], checkedAt: "now" });
    }));
    const client = { registryAction } as unknown as AcpClient;
    let workspace = "/one";
    const loadWorkspaceSettings = vi.fn();
    const loadProjectTasks = vi.fn();
    const loadProjectDocuments = vi.fn();
    const setOperationRunning = vi.fn();
    const store = createRegistryStore({
      client: () => client,
      operationRunning: () => false,
      workspace: () => workspace,
      sessionWorkspace: () => workspace,
      setOperationRunning,
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
    expect(setOperationRunning).toHaveBeenCalledTimes(1);
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
    const setOperationRunning = vi.fn();
    const client = { registryAction } as unknown as AcpClient;
    const store = createRegistryStore({
      client: () => client,
      operationRunning: () => false,
      workspace: () => "/project",
      sessionWorkspace: () => "/project",
      setOperationRunning,
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
      action: "push-project",
      scope: "tasks",
    });
    expect(setOperationRunning).not.toHaveBeenCalled();
    expect(store.backgroundSyncState.phase).toBe("idle");
  });
});
