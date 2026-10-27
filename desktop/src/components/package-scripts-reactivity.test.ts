import { compileModule } from "svelte/compiler";
import ts from "typescript";
import { expect, it, vi } from "vitest";
// @ts-expect-error Execute client runes: SSR effects are inert.
import * as client from "svelte/internal/client";
import source from "./package-scripts-controller.svelte.ts?raw";
import * as terminalInput from "../lib/terminal-input";
import * as projectColors from "../lib/project-colors";
import * as launchCommands from "../lib/project-launch-commands";
import * as commandHistory from "../lib/project-command-history";
import * as packageScripts from "../lib/package-scripts";
import type { createPackageScriptsController } from "./package-scripts-controller.svelte";
import { launchCommandMenu } from "../lib/launch-command-menu";

function fixture(files = new Map<string, string>()) {
  const listeners = new Map<string, (event: { payload: unknown }) => void>();
  const unlisten = vi.fn();
  const defaultInvoke = async (command: string, rawArgs?: unknown): Promise<unknown> => {
    const args = rawArgs as { workspace: string; expectedContent?: string | null; content?: string };
    if (command === "package_scripts") return { exists: false, scripts: [] };
    if (command === "package_terminal_list") return [];
    if (command === "project_file_exists") return files.has(args.workspace);
    if (command === "read_project_file") return { content: files.get(args.workspace) };
    if (command === "write_project_workspace_config_if_unchanged") {
      const written = (files.get(args.workspace) ?? null) === args.expectedContent;
      if (written) files.set(args.workspace, args.content!);
      return { written, document: files.has(args.workspace) ? { content: files.get(args.workspace) } : null };
    }
    return undefined;
  };
  const invoke = vi.fn(defaultInvoke);
  const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
  const compiled = compileModule(javascript, { filename: "package-scripts-controller.svelte.js", generate: "client" }).js.code;
  const commonjs = ts.transpileModule(compiled, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports: { createPackageScriptsController?: typeof createPackageScriptsController } = {};
  const dependencies: Record<string, unknown> = {
    "svelte/internal/client": client,
    svelte: { tick: async () => client.flush() },
    "@tauri-apps/api/core": { invoke },
    "@tauri-apps/api/window": { getCurrentWindow: () => ({ label: "main" }) },
    "@tauri-apps/api/event": { listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
      listeners.set(event, handler);
      return unlisten;
    } },
    "../lib/terminal-input": terminalInput,
    "../lib/project-colors": projectColors,
    "../lib/project-launch-commands": launchCommands,
    "../lib/project-command-history": commandHistory,
    "../lib/package-scripts": packageScripts,
  };
  new Function("require", "exports", commonjs)((name: string) => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  }, exports);
  // Mimic DesktopSidebar's spread props: polling replaces the object, not workspace.
  const props = client.state({ workspace: "/one", revision: 0 });
  let controller!: ReturnType<typeof createPackageScriptsController>;
  let disposeController!: () => void;
  const stop = client.effect_root(() => {
    controller = exports.createPackageScriptsController!({ workspace: () => client.get(props).workspace, terminalView: () => null });
    disposeController = controller.start();
  });
  const update = (workspace = client.get(props).workspace) => {
    client.set(props, { workspace, revision: client.get(props).revision + 1 });
    client.flush();
  };
  return { controller, invoke, defaultInvoke, files, update, listeners, unlisten, stop: () => { disposeController(); stop(); } };
}

async function settle() {
  client.flush();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  client.flush();
}

it("restores persisted history in a new controller and retains it when editing commands", async () => {
  const files = new Map([["/one", '// settings\n{"recentCommandRuns":{"launch:dev":123},"color":"#abc"}']]);
  const first = fixture(files);
  try {
    await settle();
    first.invoke.mockImplementation((command, args) => command === "package_terminal_start"
      ? Promise.resolve({ id: "pty", kind: "script", script: "test", command: "npm test", status: "running", outputBase64: "", startedAtMs: 1 })
      : first.defaultInvoke(command, args));
    await first.controller.runScript({ name: "test", command: "npm test" });
    expect(first.controller.recentCommandRuns["package:test"]).toBeGreaterThan(123);
    await first.controller.saveLaunchCommand({ id: "dev", name: "Dev", command: "npm run dev" });
    expect(files.get("/one")).toContain("// settings");
  } finally { first.stop(); }
  const restored = fixture(files);
  try {
    await settle();
    expect(restored.controller.recentCommandRuns).toEqual(commandHistory.commandHistoryFromWorkspaceConfig(files.get("/one")));
    expect(restored.controller.recentCommandRuns["launch:dev"]).toBe(123);
    expect(restored.controller.recentCommandRuns["package:test"]).toBeGreaterThan(123);
    expect(restored.controller.launchCommands[0]?.id).toBe("dev");
  } finally { restored.stop(); }
});

it("finishes a successful launch's pending save in its original project after a switch", async () => {
  const f = fixture();
  let finishSave!: () => void;
  try {
    await settle();
    f.invoke.mockImplementation((command, args) => {
      if (command === "package_terminal_start") return Promise.resolve({ id: "pty", kind: "script", script: "test", status: "running", outputBase64: "", startedAtMs: 1 });
      if (command === "write_project_workspace_config_if_unchanged") return new Promise((resolve) => {
        finishSave = () => { resolve(f.defaultInvoke(command, args)); };
      });
      return f.defaultInvoke(command, args);
    });
    const running = f.controller.runScript({ name: "test", command: "npm test" });
    await settle();
    expect(finishSave).toBeTypeOf("function");
    f.update("/two");
    await settle();
    finishSave();
    await running;
    expect(f.controller.recentCommandRuns).toEqual({});
    expect(f.files.has("/two")).toBe(false);
    expect(commandHistory.commandHistoryFromWorkspaceConfig(f.files.get("/one"))["package:test"]).toBeGreaterThan(0);
  } finally { f.stop(); }
});

it.each([false, true])("persists a saved command after successful input, reused shell=%s", async (reuse) => {
  const f = fixture(new Map([["/one", '{"launchCommands":[{"id":"dev","name":"Dev","command":"npm run dev"}]}']]));
  const terminal = { id: "pty", kind: "shell", launchCommandId: "dev", script: "shell", command: "sh", status: "running", outputBase64: "", startedAtMs: 1 };
  f.invoke.mockImplementation((command, args) => {
    if (command === "package_terminal_list") return Promise.resolve(reuse ? [terminal] : []);
    if (command === "package_terminal_start_shell") return Promise.resolve(terminal);
    if (command === "package_terminal_activity") return Promise.resolve([{ id: "pty", busy: false }]);
    return f.defaultInvoke(command, args);
  });
  try {
    await settle();
    await f.controller.runLaunchCommand("dev");
    expect(commandHistory.commandHistoryFromWorkspaceConfig(f.files.get("/one"))["launch:dev"]).toBeGreaterThan(0);
    expect(f.invoke).toHaveBeenCalledWith("package_terminal_write", expect.objectContaining({ terminalId: "pty" }));
  } finally { f.stop(); }
});

it("does not persist history when writing the launch command to its shell fails", async () => {
  const original = '{"launchCommands":[{"id":"dev","name":"Dev","command":"npm run dev"}]}';
  const f = fixture(new Map([["/one", original]]));
  f.invoke.mockImplementation((command, args) => {
    if (command === "package_terminal_start_shell") return Promise.resolve({ id: "pty", kind: "shell", script: "shell", status: "running", outputBase64: "", startedAtMs: 1 });
    if (command === "package_terminal_write") return Promise.reject(new Error("write failed"));
    return f.defaultInvoke(command, args);
  });
  try {
    await settle();
    await f.controller.runLaunchCommand("dev");
    expect(f.controller.error).toBe("write failed");
    expect(f.controller.recentCommandRuns).toEqual({});
    expect(f.files.get("/one")).toBe(original);
    expect(f.invoke.mock.calls.some(([command]) => command === "write_project_workspace_config_if_unchanged")).toBe(false);
  } finally { f.stop(); }
});

it("keeps Run/Stop current and buffers output without a mounted terminal, then releases its owner", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let busy = true;
  f.invoke.mockImplementation(async (command: string) => {
    if (command === "package_scripts") return { exists: false, scripts: [] };
    if (command === "package_terminal_list") return [{ id: "pty", kind: "shell", launchCommandId: "dev", script: "shell", command: "sh", status: "running", outputBase64: "", startedAtMs: 1 }];
    if (command === "project_file_exists") return true;
    if (command === "read_project_file") return { content: '{"launchCommands":[{"id":"dev","name":"Dev","command":"npm run dev"}]}' };
    if (command === "package_terminal_activity") return [{ id: "pty", busy }];
    return undefined;
  });
  try {
    await settle();
    expect(launchCommandMenu(f.controller).groups[0]?.actions[0]?.label).toBe("Stop Dev");
    f.listeners.get(packageScripts.PACKAGE_TERMINAL_OUTPUT_EVENT)?.({ payload: { terminalId: "pty", dataBase64: btoa("ready\n") } });
    expect(f.controller.activeTerminal?.output).toBe("ready\n");
    busy = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(launchCommandMenu(f.controller).groups[0]?.actions[0]?.label).toBe("Run Dev");
    busy = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(launchCommandMenu(f.controller).groups[0]?.actions[0]?.label).toBe("Stop Dev");
    f.listeners.get(packageScripts.PACKAGE_TERMINAL_EXIT_EVENT)?.({ payload: { terminalId: "pty", status: "exited", exitCode: 0 } });
    expect(launchCommandMenu(f.controller).groups[0]?.actions[0]?.label).toBe("Run Dev");
  } finally {
    f.stop();
    expect(f.unlisten).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  }
});

it("does not reload or cancel an in-flight launch on unrelated sidebar polling updates", async () => {
  const f = fixture();
  try {
    await settle();
    expect(f.controller.loading).toBe(false);
    f.invoke.mockClear();
    let resolveStart!: (value: unknown) => void;
    f.invoke.mockImplementation((command: string, args?: unknown) => command === "package_terminal_start"
      ? new Promise((resolve) => { resolveStart = resolve; }) : f.defaultInvoke(command, args));
    const opening = f.controller.runScript({ name: "test", command: "npm test" });
    for (let i = 0; i < 5; i++) {
      f.update();
      await settle();
      expect(f.controller.loading).toBe(false);
      expect(f.controller.startingScript).toBe("test");
    }
    resolveStart({ id: "pty", kind: "script", script: "test", command: "npm test", status: "running", outputBase64: "", startedAtMs: 1 });
    await opening;
    const runTime = f.controller.recentCommandRuns["package:test"];
    expect(runTime).toBeGreaterThan(0);
    expect(f.controller.terminals.map((terminal) => terminal.id)).toEqual(["pty"]);
    expect(f.invoke.mock.calls.map(([command]) => command)).toEqual([
      "package_terminal_start", "project_file_exists", "write_project_workspace_config_if_unchanged",
    ]);
    f.update("/two");
    await settle();
    expect(f.controller.recentCommandRuns).toEqual({});
    f.update("/one");
    await settle();
    expect(f.controller.recentCommandRuns["package:test"]).toBe(runTime);
  } finally { f.stop(); }
});

it("does not rank failed starts or late starts from a previous workspace", async () => {
  const f = fixture();
  try {
    await settle();
    f.invoke.mockImplementation(async (command: string) => {
      if (command === "package_terminal_start") throw new Error("start failed");
      return undefined;
    });
    await f.controller.runScript({ name: "failed", command: "false" });
    expect(f.controller.recentCommandRuns).toEqual({});
    let resolveStart!: (value: unknown) => void;
    f.invoke.mockImplementation((command: string) => command === "package_terminal_start"
      ? new Promise((resolve) => { resolveStart = resolve; }) : Promise.resolve(undefined));
    const opening = f.controller.runScript({ name: "late", command: "late" });
    f.update("/two");
    await settle();
    resolveStart({ id: "late", kind: "script", script: "late", status: "running", outputBase64: "", startedAtMs: 1 });
    await opening;
    expect(f.controller.recentCommandRuns).toEqual({});
    f.update("/one");
    await settle();
    expect(f.controller.recentCommandRuns).toEqual({});
    expect(f.invoke.mock.calls.some(([command]) => command === "write_project_workspace_config_if_unchanged")).toBe(false);
  } finally { f.stop(); }
});

it("still reloads on workspace change or explicit refresh and rejects the old load's late completion", async () => {
  const f = fixture();
  let resolveOld!: (value: unknown) => void;
  f.invoke.mockImplementation((command: string, ...rest: unknown[]) => {
    const args = rest[0] as { workspace: string };
    if (command === "package_scripts") return args.workspace === "/one"
      ? new Promise((resolve) => { resolveOld = resolve; })
      : Promise.resolve({ exists: false, packageName: "new", scripts: [] });
    if (command === "package_terminal_list") return Promise.resolve([]);
    return Promise.resolve(false);
  });
  try {
    await settle();
    f.update();
    await settle();
    expect(f.invoke.mock.calls.filter(([command]) => command === "package_scripts")).toHaveLength(1);
    f.update("/two");
    await settle();
    expect(f.controller.snapshot?.packageName).toBe("new");
    resolveOld({ exists: true, packageName: "old", scripts: [] });
    await settle();
    expect(f.controller.snapshot?.packageName).toBe("new");
    expect(f.controller.loading).toBe(false);
    expect(f.invoke.mock.calls.filter(([command]) => command === "package_scripts")).toHaveLength(2);
    f.controller.refresh();
    await settle();
    expect(f.invoke.mock.calls.filter(([command]) => command === "package_scripts")).toHaveLength(3);
  } finally { f.stop(); }
});
