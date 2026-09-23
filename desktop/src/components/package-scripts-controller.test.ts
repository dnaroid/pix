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

  it("runs saved launch commands in the project shell", async () => {
    const { controller } = fixture();
    tauri.invoke.mockImplementation((command: string) => {
      if (command === "project_file_exists") return Promise.resolve(true);
      if (command === "read_project_file") return Promise.resolve({ content: '{"launchCommands":[{"id":"dev","name":"Dev","command":"npm run dev"}]}' });
      if (command === "package_scripts" || command === "package_terminal_list") return Promise.resolve([]);
      if (command === "package_terminal_start_shell") return Promise.resolve(terminal);
      return Promise.resolve(undefined);
    });
    controller.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await controller.runLaunchCommand("dev");
    expect(tauri.invoke).toHaveBeenCalledWith("package_terminal_start_shell", expect.objectContaining({ workspace: "/one" }));
    expect(tauri.invoke).toHaveBeenCalledWith("package_terminal_write", expect.objectContaining({ terminalId: terminal.id, data: "npm run dev\r" }));
  });

  it("rebases concurrent launch saves after a compare-and-swap conflict", async () => {
    const { controller } = fixture();
    let content = '{"launchCommands":[]}';
    let firstWrite = true;
    tauri.invoke.mockImplementation(async (command: string, args: any) => {
      if (command === "project_file_exists") return true;
      if (command === "read_project_file") return { content };
      if (command === "write_project_workspace_config_if_unchanged") {
        if (firstWrite) {
          firstWrite = false;
          content = '{"launchCommands":[{"id":"other","name":"Other","command":"echo other"}]}';
          return { written: false, document: { content } };
        }
        if (args.expectedContent !== content) return { written: false, document: { content } };
        content = args.content;
        return { written: true, document: { content } };
      }
      return undefined;
    });
    const one = controller.saveLaunchCommand({ id: "one", name: "One", command: "echo one" });
    const two = controller.saveLaunchCommand({ id: "two", name: "Two", command: "echo two" });
    expect(await one).toBe(true);
    expect(await two).toBe(true);
    expect(controller.launchCommands.map((item) => item.id)).toEqual(["other", "one", "two"]);
  });

  it("clears saved commands and refuses malformed field overwrite", async () => {
    const { controller } = fixture();
    let content = '{"launchCommands":[{"id":"a","name":"A","command":"echo a"}]}';
    tauri.invoke.mockImplementation(async (command: string, args: any) => {
      if (command === "project_file_exists") return true;
      if (command === "read_project_file") return { content };
      if (command === "write_project_workspace_config_if_unchanged") { content = args.content; return { written: true, document: { content } }; }
      return undefined;
    });
    expect(await controller.deleteLaunchCommand("a")).toBe(true);
    expect(controller.launchCommands).toEqual([]);
    content = '{"launchCommands":false}';
    expect(await controller.saveLaunchCommand({ id: "b", name: "B", command: "echo b" })).toBe(false);
    expect(controller.error).toContain("invalid launchCommands");
  });

  it("does not let a delayed workspace load replace a newly saved command", async () => {
    const { controller } = fixture();
    const oldRead = deferred<{ content: string }>();
    let reads = 0;
    tauri.invoke.mockImplementation((command: string, args: { content?: string }) => {
      if (command === "package_scripts") return Promise.resolve({ exists: false, scripts: [] });
      if (command === "package_terminal_list") return Promise.resolve([]);
      if (command === "project_file_exists") return Promise.resolve(true);
      if (command === "read_project_file") return ++reads === 1 ? oldRead.promise : Promise.resolve({ content: '{"launchCommands":[]}' });
      if (command === "write_project_workspace_config_if_unchanged") return Promise.resolve({ written: true, document: { content: args.content } });
      return Promise.resolve(undefined);
    });
    controller.refresh();
    await vi.waitFor(() => expect(reads).toBe(1));
    expect(await controller.saveLaunchCommand({ id: "new", name: "New", command: "echo new" })).toBe(true);
    oldRead.resolve({ content: '{"launchCommands":[]}' });
    await vi.waitFor(() => expect(controller.loading).toBe(false));
    expect(controller.launchCommands.map((item) => item.id)).toEqual(["new"]);
  });

  it("does not apply a saved command to a different workspace after a delayed write", async () => {
    const { controller, setWorkspace } = fixture();
    const write = deferred<{ written: boolean; document: { content: string } }>();
    tauri.invoke.mockImplementation((command: string) => {
      if (command === "project_file_exists") return Promise.resolve(false);
      if (command === "write_project_workspace_config_if_unchanged") return write.promise;
      return Promise.resolve(undefined);
    });
    const saving = controller.saveLaunchCommand({ id: "old", name: "Old", command: "echo old" });
    await vi.waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("write_project_workspace_config_if_unchanged", expect.objectContaining({ workspace: "/one" })));
    setWorkspace("/two");
    write.resolve({ written: true, document: { content: '{"launchCommands":[{"id":"old","name":"Old","command":"echo old"}]}' } });
    expect(await saving).toBe(false);
    expect(controller.launchCommands).toEqual([]);
  });

  it("keeps running terminals visible when saved commands are malformed", async () => {
    const { controller } = fixture();
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === "package_scripts") return { exists: false, scripts: [] };
      if (command === "package_terminal_list") return [terminal];
      if (command === "project_file_exists") return true;
      if (command === "read_project_file") return { content: '{"launchCommands":false}' };
      return undefined;
    });
    controller.refresh();
    await vi.waitFor(() => expect(controller.loading).toBe(false));
    expect(controller.terminals.map((item) => item.id)).toEqual([terminal.id]);
    expect(controller.error).toContain("invalid launchCommands");
  });

  it("restarts deleted launch commands as neutral shells rather than rerunning them", async () => {
    const { controller } = fixture();
    let content = '{"launchCommands":[{"id":"dev","name":"Dev","command":"npm run dev"}]}';
    let starts = 0;
    tauri.invoke.mockImplementation(async (command: string, args: { content?: string }) => {
      if (command === "package_scripts") return { exists: false, scripts: [] };
      if (command === "package_terminal_list") return [];
      if (command === "project_file_exists") return true;
      if (command === "read_project_file") return { content };
      if (command === "write_project_workspace_config_if_unchanged") {
        content = args.content!;
        return { written: true, document: { content } };
      }
      if (command === "package_terminal_start_shell") return { ...terminal, id: `shell-${++starts}` };
      return undefined;
    });
    controller.refresh();
    await vi.waitFor(() => expect(controller.launchCommands).toHaveLength(1));
    await controller.runLaunchCommand("dev");
    const first = controller.terminals[0]!;
    expect(await controller.deleteLaunchCommand("dev")).toBe(true);
    await controller.restartTerminal(first);
    expect(starts).toBe(2);
    expect(tauri.invoke.mock.calls.filter(([command]) => command === "package_terminal_write")).toHaveLength(1);
  });
});
