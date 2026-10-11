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

function fixture() {
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
    "@tauri-apps/api/event": { listen: async () => () => {} },
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
  return { controller, invoke, update, stop: () => { disposeController(); stop(); } };
}

async function settle() {
  client.flush();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  client.flush();
}

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
