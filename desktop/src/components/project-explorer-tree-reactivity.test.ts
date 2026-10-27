import { compileModule } from "svelte/compiler";
import ts from "typescript";
import { expect, it, vi } from "vitest";
// @ts-expect-error Execute client runes: SSR effects are inert.
import * as client from "svelte/internal/client";
import source from "./project-explorer-tree-controller.svelte.ts?raw";
import * as projectFiles from "../lib/project-files";
import * as keyboardNavigation from "../lib/keyboard-navigation";
import * as projectTree from "../lib/project-tree";
import * as projectTreeSelection from "../lib/project-tree-selection";
import type { createProjectExplorerTreeController } from "./project-explorer-tree-controller.svelte";
import type { ProjectTreeEntry } from "../lib/project-tree";

const rootEntries: ProjectTreeEntry[] = [{ path: "a", name: "a", kind: "directory" }];
const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
const compiled = compileModule(javascript, { filename: "project-explorer-tree-controller.svelte.js", generate: "client" }).js.code;
const commonjs = ts.transpileModule(compiled, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS } }).outputText;

function fixture() {
  const exports: { createProjectExplorerTreeController?: typeof createProjectExplorerTreeController } = {};
  const dependencies: Record<string, unknown> = {
    "svelte/internal/client": client,
    svelte: { untrack: client.untrack, tick: async () => client.flush() },
    "../lib/project-files": projectFiles,
    "../lib/keyboard-navigation": keyboardNavigation,
    "../lib/project-tree": projectTree,
    "../lib/project-tree-selection": projectTreeSelection,
  };
  new Function("require", "exports", commonjs)((name: string) => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  }, exports);
  const onListDirectory = vi.fn(async (_path: string) => structuredClone(rootEntries));
  const render = vi.fn();
  let controller!: ReturnType<typeof createProjectExplorerTreeController>;
  const stop = client.effect_root(() => {
    controller = exports.createProjectExplorerTreeController!({
      workspace: () => "/one", refreshKey: () => 0, root: () => null, onListDirectory,
      onOpenFile: vi.fn(), onOpenExternal: vi.fn(), onHealthChange: vi.fn(),
      onLoadExpandedDirectories: async () => [], onPersistExpandedDirectories: vi.fn(), clearDrag: vi.fn(),
    });
    client.render_effect(() => render(controller.rows, controller.tabbablePath, controller.rootLoading, controller.rootError));
  });
  return { controller, onListDirectory, render, stop: () => { controller.dispose(); stop(); } };
}

async function settle(): Promise<void> {
  client.flush();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  client.flush();
}

it("does not invalidate real Svelte tree rendering on equal background polls", async () => {
  const f = fixture();
  try {
    await settle();
    f.render.mockClear();
    f.onListDirectory.mockClear();
    const previous = f.controller.state.entriesByDirectory;
    for (let i = 0; i < 3; i++) {
      let finish!: (entries: ProjectTreeEntry[]) => void;
      f.onListDirectory.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      const refresh = f.controller.refreshVisibleDirectories();
      client.flush();
      expect(f.controller.rootLoading).toBe(false);
      expect(f.render).not.toHaveBeenCalled();
      finish(structuredClone(rootEntries));
      await refresh;
      await settle();
      expect(f.controller.state.entriesByDirectory).toBe(previous);
      expect(f.render).not.toHaveBeenCalled();
    }
    expect(f.onListDirectory).toHaveBeenCalledTimes(3);
    f.onListDirectory.mockResolvedValueOnce([...rootEntries, { path: "new", name: "new", kind: "file" }]);
    await f.controller.refreshVisibleDirectories();
    await settle();
    expect(f.render).toHaveBeenCalledTimes(1);
    expect(f.controller.rows.map((row) => row.entry.path)).toEqual(["", "a", "new"]);
  } finally { f.stop(); }
});
