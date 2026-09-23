import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRegistryStore } from "./registry.svelte";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

function fixture() {
  let workspace = "/project";
  const loadProjectTasks = vi.fn(async () => {});
  const loadProjectDocuments = vi.fn(async () => {});
  const setOperationRunning = vi.fn();
  const reportError = vi.fn();
  const store = createRegistryStore({
    client: () => null,
    operationRunning: () => false,
    workspace: () => workspace,
    sessionWorkspace: () => undefined,
    setOperationRunning,
    setErrorMessage: vi.fn(),
    loadProjectTasks,
    loadProjectDocuments,
    reportError,
  });
  return {
    store,
    loadProjectTasks,
    loadProjectDocuments,
    setOperationRunning,
    reportError,
    setWorkspace(value: string) {
      workspace = value;
      store.reset();
    },
  };
}

beforeEach(() => invoke.mockReset());
afterEach(() => vi.useRealTimers());

describe("Registry project initialization", () => {
  it("checks .pi locally without requiring a ready ACP session", async () => {
    const { store } = fixture();
    invoke.mockImplementation(async (command: string) => {
      if (command === "project_pi_initialized") return false;
      if (command === "project_pi_storage") {
        return { totalBytes: null, cleanupBytes: 0, cleanupAvailable: false };
      }
      return undefined;
    });

    await store.refreshProjectInitialization();

    expect(invoke).toHaveBeenCalledWith("project_pi_initialized", { workspace: "/project" });
    expect(invoke).toHaveBeenCalledWith("project_pi_storage", { workspace: "/project" });
    expect(store.projectInitialized).toBe(false);
    expect(store.projectPiSizeBytes).toBeNull();
    expect(store.projectPiCleanupBytes).toBe(0);
    expect(store.projectPiCleanupAvailable).toBe(false);
  });

  it("keeps the initialization result when .pi size inspection fails", async () => {
    const { store, reportError } = fixture();
    invoke.mockImplementation(async (command: string) => {
      if (command === "project_pi_initialized") return true;
      if (command === "project_pi_storage") throw new Error("permission denied");
      return undefined;
    });

    await store.refreshProjectInitialization();

    expect(store.projectInitialized).toBe(true);
    expect(store.projectPiSizeBytes).toBeUndefined();
    expect(store.projectPiStorageLoading).toBe(false);
    expect(store.projectPiStorageError).toBe("Storage meter unavailable");
    expect(reportError).not.toHaveBeenCalled();
  });

  it("bounds a stalled .pi storage inspection instead of remaining in loading forever", async () => {
    vi.useFakeTimers();
    const { store } = fixture();
    let stalled = true;
    invoke.mockImplementation(async (command: string) => {
      if (command === "project_pi_initialized") return true;
      if (command === "project_pi_storage") {
        return stalled
          ? new Promise(() => {})
          : { totalBytes: 2048, cleanupBytes: 128, cleanupAvailable: true };
      }
      return undefined;
    });

    const pending = store.refreshProjectInitialization();
    expect(store.projectPiStorageLoading).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;

    expect(store.projectInitialized).toBe(true);
    expect(store.projectPiStorageLoading).toBe(false);
    expect(store.projectPiStorageError).toBe("Storage meter timed out");

    stalled = false;
    await store.refreshProjectInitialization();
    expect(store.projectPiStorageError).toBeNull();
    expect(store.projectPiSizeBytes).toBe(2048);
    expect(store.projectPiCleanupBytes).toBe(128);
    expect(store.projectPiCleanupAvailable).toBe(true);
  });

  it("creates the local project skeleton and reloads project state", async () => {
    const {
      store,
      loadProjectTasks,
      loadProjectDocuments,
      setOperationRunning,
    } = fixture();
    let initialized = false;
    invoke.mockImplementation(async (command: string) => {
      if (command === "initialize_project_pi") {
        initialized = true;
        return undefined;
      }
      if (command === "project_pi_initialized") return initialized;
      if (command === "project_pi_storage") {
        return {
          totalBytes: initialized ? 1536 : null,
          cleanupBytes: 0,
          cleanupAvailable: false,
        };
      }
      return undefined;
    });

    await store.refreshProjectInitialization();
    expect(store.projectInitialized).toBe(false);
    await expect(store.initializeProject()).resolves.toBe(true);

    expect(loadProjectTasks).toHaveBeenCalledWith("/project");
    expect(loadProjectDocuments).toHaveBeenCalledWith("/project");
    expect(setOperationRunning.mock.calls).toEqual([[true], [false]]);
    await vi.waitFor(() => expect(store.projectInitialized).toBe(true));
    await vi.waitFor(() => expect(store.projectPiSizeBytes).toBe(1536));
  });

  it("cleans only reclaimable .pi garbage and keeps project state initialized", async () => {
    const {
      store,
      loadProjectTasks,
      loadProjectDocuments,
      setOperationRunning,
    } = fixture();
    let cleanupBytes = 512;
    let totalBytes = 4096;
    invoke.mockImplementation(async (command: string) => {
      if (command === "project_pi_initialized") return true;
      if (command === "project_pi_storage") {
        return { totalBytes, cleanupBytes, cleanupAvailable: cleanupBytes > 0 };
      }
      if (command === "clean_project_pi") {
        totalBytes -= cleanupBytes;
        const removed = cleanupBytes;
        cleanupBytes = 0;
        return removed;
      }
      return undefined;
    });

    await store.refreshProjectInitialization();
    expect(store.projectPiSizeBytes).toBe(4096);
    expect(store.projectPiCleanupBytes).toBe(512);
    expect(store.projectPiCleanupAvailable).toBe(true);
    expect(store.projectPiStorageError).toBeNull();
    expect(store.projectPiStorageLoading).toBe(false);

    await expect(store.cleanProject()).resolves.toBe(true);

    expect(invoke).toHaveBeenCalledWith("clean_project_pi", { workspace: "/project" });
    expect(loadProjectTasks).not.toHaveBeenCalled();
    expect(loadProjectDocuments).not.toHaveBeenCalled();
    expect(setOperationRunning.mock.calls).toEqual([[true], [false]]);
    expect(store.projectInitialized).toBe(true);
    expect(store.projectPiSizeBytes).toBe(3584);
    expect(store.projectPiCleanupBytes).toBe(0);
    expect(store.projectPiCleanupAvailable).toBe(false);
  });

  it("runs TTL auto-clean without the foreground operation lock and refreshes current storage", async () => {
    const { store, setOperationRunning } = fixture();
    let totalBytes = 4096;
    let cleanupBytes = 512;
    invoke.mockImplementation(async (command: string) => {
      if (command === "auto_clean_project_pi") {
        totalBytes -= 256;
        cleanupBytes -= 256;
        return 256;
      }
      if (command === "project_pi_initialized") return true;
      if (command === "project_pi_storage") {
        return {
          totalBytes,
          cleanupBytes,
          cleanupAvailable: cleanupBytes > 0,
        };
      }
      return undefined;
    });

    await store.autoCleanProject("/project");

    expect(invoke).toHaveBeenCalledWith("auto_clean_project_pi", { workspace: "/project" });
    expect(setOperationRunning).not.toHaveBeenCalled();
    expect(store.projectPiSizeBytes).toBe(3840);
    expect(store.projectPiCleanupBytes).toBe(256);
    expect(store.projectPiCleanupAvailable).toBe(true);
  });

  it("does not refresh another workspace after stale background auto-clean completes", async () => {
    const { store, setWorkspace } = fixture();
    let finish!: () => void;
    invoke.mockImplementation((command: string) => {
      if (command === "auto_clean_project_pi") {
        return new Promise<number>((resolve) => {
          finish = () => resolve(0);
        });
      }
      return Promise.resolve(undefined);
    });

    const pending = store.autoCleanProject("/project");
    setWorkspace("/other");
    finish();
    await pending;

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("auto_clean_project_pi", { workspace: "/project" });
    expect(store.projectPiSizeBytes).toBeUndefined();
  });

  it("ignores an initialization completion after the workspace lifecycle changes", async () => {
    const { store, setWorkspace, loadProjectTasks } = fixture();
    let finish!: () => void;
    invoke.mockImplementationOnce(
      () => new Promise<void>((resolve) => { finish = resolve; }),
    );

    const pending = store.initializeProject();
    setWorkspace("/other");
    finish();

    await expect(pending).resolves.toBe(false);
    expect(store.projectInitialized).toBeUndefined();
    expect(loadProjectTasks).not.toHaveBeenCalled();
  });
});

describe("Registry workspace actions", () => {
  it("refreshes through the workspace without requiring a conversation session", async () => {
    const snapshot = { version: 1 as const, configured: true, branch: "main", items: [], checkedAt: "now" };
    const registryAction = vi.fn(async () => snapshot);
    const client = { registryAction } as any;
    const store = createRegistryStore({
      client: () => client,
      operationRunning: () => false,
      workspace: () => "/project",
      sessionWorkspace: () => undefined,
      setOperationRunning: vi.fn(),
      setErrorMessage: vi.fn(),
      loadProjectTasks: vi.fn(),
      loadProjectDocuments: vi.fn(),
      reportError: vi.fn(),
    });

    await store.runAction({ action: "refresh" }, "refresh");

    expect(registryAction).toHaveBeenCalledWith("/project", { action: "refresh" });
    expect(store.snapshot).toEqual(snapshot);
  });
});
