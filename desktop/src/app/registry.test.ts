import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRegistryStore } from "./registry.svelte";
import type { RegistryItem } from "../lib/registry";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

function fixture() {
  let workspace = "/project";
  const loadProjectTasks = vi.fn(async () => {});
  const loadProjectDocuments = vi.fn(async () => {});
  const reportError = vi.fn();
  const store = createRegistryStore({
    client: () => null,
    operationRunning: () => false,
    workspace: () => workspace,
    sessionWorkspace: () => undefined,
    setErrorMessage: vi.fn(),
    loadProjectTasks,
    loadProjectDocuments,
    reportError,
  });
  return {
    store,
    loadProjectTasks,
    loadProjectDocuments,
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
    await vi.waitFor(() => expect(store.projectInitialized).toBe(true));
    await vi.waitFor(() => expect(store.projectPiSizeBytes).toBe(1536));
  });

  it("cleans only reclaimable .pi garbage and keeps project state initialized", async () => {
    const {
      store,
      loadProjectTasks,
      loadProjectDocuments,
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
    expect(store.projectInitialized).toBe(true);
    expect(store.projectPiSizeBytes).toBe(3584);
    expect(store.projectPiCleanupBytes).toBe(0);
    expect(store.projectPiCleanupAvailable).toBe(false);
  });

  it("runs TTL auto-clean without the foreground operation lock and refreshes current storage", async () => {
    const { store } = fixture();
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

describe("Registry resource diff", () => {
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  function diffFixture(registryDiffImpl?: (cwd: string, type: string, name: string) => Promise<unknown>) {
    let workspace = "/project";
    const registryDiff = vi.fn(registryDiffImpl ?? (async () => ({ files: [] })));
    const client = { registryDiff } as any;
    const store = createRegistryStore({
      client: () => client,
      operationRunning: () => false,
      workspace: () => workspace,
      sessionWorkspace: () => undefined,
      setErrorMessage: vi.fn(),
      loadProjectTasks: vi.fn(),
      loadProjectDocuments: vi.fn(),
      reportError: vi.fn(),
    });
    return {
      store,
      registryDiff,
      setWorkspace(value: string) {
        workspace = value;
        store.reset();
      },
    };
  }

  const agentItem = (overrides: Partial<RegistryItem> = {}): RegistryItem => ({
    id: `agent:${overrides.name ?? "researcher"}`,
    type: "agent",
    name: "researcher",
    status: "diverged",
    statusLabel: "DIVERGED",
    icon: "!",
    local: true,
    remote: true,
    actions: ["push", "pull"],
    ...overrides,
  });

  it("loads a two-sided diff on demand without running a mutating registry action", async () => {
    const files = [{ path: "agents/researcher.md", oldText: "old\n", newText: "new\n" }];
    const { store, registryDiff } = diffFixture(async () => ({ files }));

    store.openDiff(agentItem());

    expect(store.diff).toMatchObject({ phase: "loading", target: { type: "agent", name: "researcher" } });
    await vi.waitFor(() => expect(store.diff?.phase).toBe("ready"));
    expect(registryDiff).toHaveBeenCalledWith("/project", "agent", "researcher");
    expect(store.diff).toMatchObject({ phase: "ready", files });
    expect(store.actionId).toBeNull();
  });

  it("does not open a diff for one-sided or synced resources", () => {
    const { store, registryDiff } = diffFixture();

    store.openDiff(agentItem({ status: "up-to-date" }));
    store.openDiff(agentItem({ status: "local-only", remote: false }));
    store.openDiff(agentItem({ name: "todo", type: "project" }));

    expect(store.diff).toBeUndefined();
    expect(registryDiff).not.toHaveBeenCalled();
  });

  it("surfaces read errors instead of an empty diff", async () => {
    const { store } = diffFixture(async () => {
      throw new Error("registry data unavailable");
    });

    store.openDiff(agentItem());
    await vi.waitFor(() => expect(store.diff?.phase).toBe("error"));

    expect(store.diff).toMatchObject({
      phase: "error",
      target: { name: "researcher" },
      error: "registry data unavailable",
    });
  });

  it("replaces the view when another resource diff is opened before the first resolves", async () => {
    let finishFirst!: (value: { files: unknown[] }) => void;
    const { store, registryDiff } = diffFixture((_cwd: string, _type: string, name: string) => {
      if (name === "researcher") {
        return new Promise((resolve) => {
          finishFirst = resolve;
        });
      }
      return Promise.resolve({ files: [{ path: "skills/pdf/SKILL.md", oldText: null, newText: "new\n" }] });
    });

    store.openDiff(agentItem());
    store.openDiff(agentItem({ name: "pdf", type: "skill", status: "local-changes" }));
    await vi.waitFor(() => expect(store.diff?.phase).toBe("ready"));
    finishFirst({ files: [{ path: "agents/researcher.md", oldText: "old\n", newText: "older\n" }] });
    await settle();

    expect(store.diff).toMatchObject({
      phase: "ready",
      target: { type: "skill", name: "pdf" },
    });
    expect(registryDiff).toHaveBeenCalledTimes(2);
  });

  it("ignores a late response after the diff is closed", async () => {
    let finish!: (value: { files: unknown[] }) => void;
    const { store } = diffFixture(() => new Promise((resolve) => {
      finish = resolve;
    }));

    store.openDiff(agentItem());
    store.closeDiff();
    finish({ files: [{ path: "agents/researcher.md", oldText: null, newText: "late\n" }] });
    await settle();

    expect(store.diff).toBeUndefined();
  });

  it("drops the diff on workspace reset and ignores its late response", async () => {
    let finish!: (value: { files: unknown[] }) => void;
    const { store, setWorkspace } = diffFixture(() => new Promise((resolve) => {
      finish = resolve;
    }));

    store.openDiff(agentItem());
    setWorkspace("/other");
    finish({ files: [{ path: "agents/researcher.md", oldText: null, newText: "late\n" }] });
    await settle();

    expect(store.diff).toBeUndefined();
  });
});
