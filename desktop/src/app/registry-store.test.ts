import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import { REGISTRY_STATE_CHANNEL } from "../lib/registry";
import { createRegistryStore } from "./registry.svelte";

afterEach(() => vi.useRealTimers());

describe("registry background project sync", () => {
  it("pushes a debounced project artifact without taking the foreground operation lock", async () => {
    vi.useFakeTimers();
    const registryAction = vi.fn(async () => {});
    const setOperationRunning = vi.fn();
    const client = { registryAction } as unknown as AcpClient;
    const store = createRegistryStore({
      client: () => client,
      activeSessionId: () => "session-1",
      sessionRuntimeReady: () => true,
      operationRunning: () => false,
      promptRunning: () => false,
      sessionHistoryLoading: () => false,
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

    expect(registryAction).toHaveBeenCalledWith("session-1", {
      action: "push-project",
      scope: "tasks",
    });
    expect(setOperationRunning).not.toHaveBeenCalled();
    expect(store.backgroundSyncState.phase).toBe("idle");
  });
});
