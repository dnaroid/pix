import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPackageScriptsController } from "./package-scripts-controller.svelte";
import type { PackageTerminalSnapshot, PackageTerminalView } from "../lib/package-scripts";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

const terminal: PackageTerminalSnapshot = {
  id: "old-pty", kind: "shell", script: "shell", command: "sh", status: "running", outputBase64: "", startedAtMs: 1,
};

function fixture() {
  let workspace = "/one";
  const view = { write: vi.fn(), focus: vi.fn(), dimensions: () => ({ cols: 80, rows: 24 }) };
  const controller = createPackageScriptsController({ workspace: () => workspace, terminalView: () => view });
  return { controller, view, setWorkspace: (value: string) => { workspace = value; } };
}

describe("package terminal operation ownership", () => {
  beforeEach(() => { tauri.invoke.mockReset().mockResolvedValue(undefined); });

  it("reaps a late-started PTY instead of inserting it into a different workspace", async () => {
    const { controller, view, setWorkspace } = fixture();
    const started = deferred<PackageTerminalSnapshot>();
    tauri.invoke.mockImplementation((command: string) => command === "package_terminal_start" ? started.promise : Promise.resolve());
    const running = controller.runScript({ name: "test", command: "npm test" });
    setWorkspace("/two");
    started.resolve(terminal);
    await running;
    expect(controller.terminals).toEqual([]);
    expect(view.focus).not.toHaveBeenCalled();
    expect(tauri.invoke).toHaveBeenCalledWith("package_terminal_stop", { windowLabel: "main", terminalId: terminal.id });
    expect(tauri.invoke).toHaveBeenCalledWith("package_terminal_forget", { windowLabel: "main", terminalId: terminal.id });
  });

  it("does not redirect a requested shell command across a workspace change", async () => {
    const { controller, setWorkspace } = fixture();
    const opening = controller.openShellTerminal("npm test");
    setWorkspace("/two");
    await opening;
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("reserves a shell launch before its initial async wait", async () => {
    const { controller } = fixture();
    tauri.invoke.mockResolvedValue(terminal);
    const opening = controller.openShellTerminal();
    expect(controller.startingScript).toBe("__shell__");
    await controller.runScript({ name: "test", command: "npm test" });
    await opening;
    expect(tauri.invoke.mock.calls.map(([command]) => command)).toEqual(["package_terminal_start_shell"]);
    expect(controller.startingScript).toBeNull();
  });

  it("does not restart an old shell in a newly selected workspace", async () => {
    const { controller, setWorkspace } = fixture();
    const stop = deferred<void>();
    tauri.invoke.mockImplementation((command: string) => command === "package_terminal_stop" ? stop.promise : Promise.resolve());
    const restarting = controller.restartTerminal({ ...terminal, output: "" } satisfies PackageTerminalView);
    setWorkspace("/two");
    stop.resolve();
    await restarting;
    expect(tauri.invoke.mock.calls.map(([command]) => command)).toEqual(["package_terminal_stop", "package_terminal_forget"]);
  });

  it("invalidates in-flight starts on panel teardown", async () => {
    const { controller } = fixture();
    const dispose = controller.start();
    const started = deferred<PackageTerminalSnapshot>();
    tauri.invoke.mockImplementation((command: string) => command === "package_terminal_start" ? started.promise : Promise.resolve());
    const running = controller.runScript({ name: "test", command: "npm test" });
    dispose();
    started.resolve(terminal);
    await running;
    expect(controller.terminals).toEqual([]);
    expect(tauri.invoke).toHaveBeenCalledWith("package_terminal_stop", { windowLabel: "main", terminalId: terminal.id });
  });
});
