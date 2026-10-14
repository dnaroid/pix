import { compileModule } from "svelte/compiler";
import ts from "typescript";
import { expect, it, vi } from "vitest";
// @ts-expect-error Execute the compiled client runes, not SSR's inert effects.
import * as client from "svelte/internal/client";
import source from "./workspace-search-index-owner.svelte.ts?raw";
import * as controller from "./search-index-controller";
import type { AcpClient } from "./acp-client";
import type { createWorkspaceSearchIndexOwner } from "./workspace-search-index-owner.svelte";

it("keeps one sync/controller across spread-prop updates; replaces only changed workspace/client identities", () => {
  const owners: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
  const create = vi.fn((..._args: unknown[]) => {
    const owner = { dispose: vi.fn() };
    owners.push(owner);
    return owner;
  });
  const stops: Array<ReturnType<typeof vi.fn>> = [];
  const sync = vi.fn(() => { const stop = vi.fn(); stops.push(stop); return stop; });
  const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
  const compiled = compileModule(javascript, { filename: "owner.svelte.js", generate: "client" }).js.code;
  const commonjs = ts.transpileModule(compiled, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports: { createWorkspaceSearchIndexOwner?: typeof createWorkspaceSearchIndexOwner } = {};
  const dependencies: Record<string, unknown> = {
    "svelte/internal/client": client, svelte: { untrack: client.untrack },
    "./search-index-controller": controller,
    "./workspace-search-index-controller": { createWorkspaceSearchIndexController: create },
    "./search-index-sync": { startSearchIndexSync: sync },
    "./settings-search-catalog": { SETTINGS_SEARCH_CATALOG: [] },
  };
  new Function("require", "exports", commonjs)((name: string) => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  }, exports);
  vi.stubGlobal("window", {});
  const connection = {} as AcpClient;
  const props = client.state({ workspace: "/one", connection, tab: "tasks", revision: 0 });
  const stop = client.effect_root(() => {
    exports.createWorkspaceSearchIndexOwner!({ workspace: () => client.get(props).workspace, client: () => client.get(props).connection });
  });
  try {
    client.flush();
    expect(create).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
    for (const tab of ["files", "search", "settings", "files"]) {
      client.set(props, { ...client.get(props), tab, revision: client.get(props).revision + 1 });
      client.flush();
    }
    expect(create).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(owners[0]!.dispose).not.toHaveBeenCalled();
    expect(stops[0]).not.toHaveBeenCalled();
    client.set(props, { ...client.get(props), workspace: "/two" });
    client.flush();
    expect(create).toHaveBeenCalledTimes(2);
    expect(stops[0]).toHaveBeenCalledTimes(1);
    expect(owners[0]!.dispose).toHaveBeenCalledTimes(1);
    client.set(props, { ...client.get(props), connection: {} });
    client.flush();
    expect(create).toHaveBeenCalledTimes(3);
    expect(sync).toHaveBeenCalledTimes(3);
    expect(create.mock.calls[0]).toHaveLength(3);
    expect(create.mock.calls[2]).toHaveLength(3);
  } finally { stop(); vi.unstubAllGlobals(); }
  expect(owners[2]!.dispose).toHaveBeenCalledTimes(1);
  expect(stops[2]).toHaveBeenCalledTimes(1);
  vi.stubGlobal("window", {});
  const remount = client.effect_root(() => {
    exports.createWorkspaceSearchIndexOwner!({ workspace: () => "/one", client: () => connection });
  });
  try {
    client.flush();
    expect(create).toHaveBeenCalledTimes(4);
    expect(create.mock.calls[3]).toHaveLength(3);
  } finally { remount(); vi.unstubAllGlobals(); }
});
