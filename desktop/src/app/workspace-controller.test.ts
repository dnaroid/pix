import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceController } from "./workspace-controller";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

function options() {
  return {
    workspace: () => "",
    blocked: () => false,
    previewDirty: () => false,
    closeSessionSelector: vi.fn(),
    rememberProject: vi.fn(),
    loadDesktopPreferences: vi.fn(),
    closeWorkspaceSessions: vi.fn().mockResolvedValue(undefined),
    resetForWorkspace: vi.fn(),
    loadWorkspace: vi.fn().mockResolvedValue(undefined),
    setOperationRunning: vi.fn(),
    setErrorMessage: vi.fn(),
    reportError: vi.fn(),
  };
}

describe("native project window persistence", () => {
  beforeEach(() => {
    native.invoke.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal("window", { location: { href: "http://localhost/" } });
    vi.stubGlobal("localStorage", { setItem: vi.fn() });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("opens a native window with a stable restorable label and reports creation failure", async () => {
    const state = options();
    const error = new Error("creation failed");
    native.invoke.mockRejectedValue(error);
    createWorkspaceController(state).openInNewWindow("/project");
    expect(native.invoke).toHaveBeenCalledWith("desktop_open_project_window", {
      label: expect.stringMatching(/^project-[0-9]+-[a-z0-9]+$/), workspace: "/project",
    });
    await Promise.resolve();
    expect(state.reportError).toHaveBeenCalledWith(error);
  });

  it("does not create a window for a relative path", () => {
    createWorkspaceController(options()).openInNewWindow("relative");
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("waits for native workspace acknowledgement before exposing the project switch", async () => {
    const state = options();
    let acknowledge!: () => void;
    native.invoke.mockReturnValue(new Promise<void>((resolve) => { acknowledge = resolve; }));
    const switching = createWorkspaceController(state).select("/new");
    await Promise.resolve();
    expect(native.invoke).toHaveBeenCalledWith("desktop_window_workspace", { workspace: "/new" });
    expect(state.resetForWorkspace).not.toHaveBeenCalled();
    acknowledge();
    await switching;
    expect(state.resetForWorkspace).toHaveBeenCalledWith("/new");
  });

  it("keeps native workspace persistence when localStorage fails", async () => {
    const state = options();
    vi.stubGlobal("localStorage", { setItem: () => { throw new Error("unavailable"); } });
    await createWorkspaceController(state).select("/new");
    expect(native.invoke).toHaveBeenCalledWith("desktop_window_workspace", { workspace: "/new" });
    expect(state.loadWorkspace).toHaveBeenCalledWith("/new");
  });
});
