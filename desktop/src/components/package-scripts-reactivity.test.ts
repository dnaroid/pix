import { compileModule } from "svelte/compiler";
import ts from "typescript";
import { expect, it, vi } from "vitest";
// @ts-expect-error Execute client runes: SSR effects are inert.
import * as client from "svelte/internal/client";
import source from "./package-scripts-controller.svelte.ts?raw";
import * as terminalInput from "../lib/terminal-input";
import * as projectColors from "../lib/project-colors";
import * as launchCommands from "../lib/project-launch-commands";
import * as packageScripts from "../lib/package-scripts";
import type { createPackageScriptsController } from "./package-scripts-controller.svelte";
import { launchCommandMenu } from "../lib/launch-command-menu";

function fixture() {
  const listeners = new Map<string, (event: { payload: unknown }) => void>();
  const unlisten = vi.fn();
  const invoke = vi.fn(async (command: string, _args?: unknown): Promise<unknown> => {
    if (command === "package_scripts") return { exists: false, scripts: [] };
    if (command === "package_terminal_list") return [];
    if (command === "project_file_exists") return false;
    return undefined;
  });
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
  return { controller, invoke, update, listeners, unlisten, stop: () => { disposeController(); stop(); } };
}

async function settle() {
  client.flush();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  client.flush();
}

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
    f.invoke.mockImplementation((command: string) => command === "package_terminal_start"
      ? new Promise((resolve) => { resolveStart = resolve; }) : Promise.resolve(undefined));
    const opening = f.controller.runScript({ name: "test", command: "npm test" });
    for (let i = 0; i < 5; i++) {
      f.update();
      await settle();
      expect(f.controller.loading).toBe(false);
      expect(f.controller.startingScript).toBe("test");
    }
    resolveStart({ id: "pty", kind: "script", script: "test", command: "npm test", status: "running", outputBase64: "", startedAtMs: 1 });
    await opening;
    expect(f.controller.terminals.map((terminal) => terminal.id)).toEqual(["pty"]);
    expect(f.invoke.mock.calls.map(([command]) => command)).toEqual(["package_terminal_start"]);
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
