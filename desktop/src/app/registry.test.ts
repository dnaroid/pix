import { beforeEach, describe, expect, it, vi } from "vitest";
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

describe("Registry project initialization", () => {
  it("checks .pi locally without requiring a ready ACP session", async () => {
    const { store } = fixture();
    invoke.mockResolvedValueOnce(false);

    await store.refreshProjectInitialization();

    expect(invoke).toHaveBeenCalledWith("project_pi_initialized", { workspace: "/project" });
    expect(store.projectInitialized).toBe(false);
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
      return undefined;
    });

    await store.refreshProjectInitialization();
    expect(store.projectInitialized).toBe(false);
    await expect(store.initializeProject()).resolves.toBe(true);

    expect(loadProjectTasks).toHaveBeenCalledWith("/project");
    expect(loadProjectDocuments).toHaveBeenCalledWith("/project");
    expect(setOperationRunning.mock.calls).toEqual([[true], [false]]);
    await vi.waitFor(() => expect(store.projectInitialized).toBe(true));
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
