import { compile } from "svelte/compiler";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
// @ts-expect-error Exercise client effect tracking rather than inert SSR runes.
import * as client from "svelte/internal/client";
import source from "./ProjectWikiSearch.svelte?raw";
import { SearchDialogController, emptySearchDialogState } from "../lib/search-dialog-controller";
import { queryProjectWiki } from "../lib/project-wiki-search";
import { SEARCH_SOURCE_SELECTION_CHANGED } from "../lib/search-source-selection";
import type { SearchDialogState } from "../lib/search-dialog-controller";
import type { queryNativeRepository } from "../lib/native-repository-search";
import type { NativeSearchHit, NativeSearchResponse } from "../../../external/pi-tools-suite/src/project-search/native-contract";

interface Api {
  submit(query: string): Promise<void>;
  open(index: number): void;
  snapshot(): { query: string; view: SearchDialogState };
}

function fixture() {
  vi.stubGlobal("window", new EventTarget());
  const hit: NativeSearchHit = { kind: "knowledge", id: "wiki/page.md", path: "wiki/page.md", title: "Page", snippet: "rules", score: 1, startLine: 1, endLine: 2 };
  const response: NativeSearchResponse = { hits: [hit], notices: [], status: { backend: "native", generation: 1, complete: true, stale: false } };
  const repository = vi.fn<typeof queryNativeRepository>(async () => response);
  const selection = vi.fn(async () => ({ enabled: { settings: false, sessions: false, tasks: false, commits: false, code: false, knowledge: true } }));
  const script = source.slice(source.indexOf(">") + 1, source.indexOf("</script>"));
  const javascript = ts.transpileModule(`${script}
    export async function submit(value: string) { query = value; await requests?.submit(query, ["knowledge"]); }
    export function snapshot() { return { query, view }; }
    export function open(index: number) { const hit = view.result.results[index]; if (hit?.kind === "knowledge") openResult(hit); }
  `, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
  const compiled = compile(`<script>${javascript}</script>`, { filename: "WikiSearchEffects.svelte", generate: "client", dev: false }).js.code;
  const commonjs = ts.transpileModule(compiled, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const output: { default?: (anchor: unknown, props: object) => Api } = {};
  const dependencies: Record<string, unknown> = {
    "svelte/internal/client": client,
    "svelte/internal/disclose-version": {},
    "svelte/internal/flags/legacy": {},
    svelte: { untrack: client.untrack },
    "@tauri-apps/api/core": { invoke: vi.fn() },
    "../lib/diagnostic-logging": { createDiagnosticLogger: () => ({ report: vi.fn() }) },
    "../lib/native-repository-search": { queryNativeRepository: repository },
    "../lib/project-wiki-search": { queryProjectWiki },
    "../lib/search-dialog-controller": { SearchDialogController, emptySearchDialogState },
    "../lib/search-source-selection": { readSearchSourceSelection: selection, SEARCH_SOURCE_SELECTION_CHANGED },
    "../lib/search-source-deadline": { pendingSearchNotice: (source: string) => source },
  };
  new Function("require", "exports", commonjs)((name: string) => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  }, output);
  const input = client.state({ workspace: "/project", path: "wiki", revision: 0, activePath: null as string | null });
  const opened = vi.fn((path: string) => client.set(input, { ...client.get(input), activePath: path, revision: client.get(input).revision + 1 }));
  let api!: Api;
  const stop = client.effect_root(() => {
    // Parent spreads/derived configs can change identity on background refresh,
    // while the primitive Wiki target stays exactly the same.
    const props = client.derived(() => ({ ...client.get(input) }));
    const spread = client.spread_props(() => client.get(props));
    api = output.default!(null, {
      get workspace() { return spread.workspace; },
      get path() { return spread.path; },
      get activePath() { return spread.activePath; },
      onOpenFile: opened,
    });
  });
  const update = (patch: Partial<{ workspace: string; path: string; revision: number }>) => {
    client.set(input, { ...client.get(input), ...patch });
  };
  return { api, stop, update, repository, hit, response, opened };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) { client.flush(); await Promise.resolve(); }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

afterEach(() => vi.unstubAllGlobals());

it("opens consecutive result ranges without clearing or re-running the search", async () => {
  const f = fixture();
  const second = { ...f.hit, id: "wiki/second.md", path: "wiki/second.md", startLine: 31, endLine: 38 };
  f.response.hits.push(second);
  try {
    await settle();
    await f.api.submit("rules");
    await settle();
    for (const [index, hit] of [f.hit, second, f.hit].entries()) {
      f.api.open(index === 1 ? 1 : 0);
      await settle();
      expect(f.opened).toHaveBeenLastCalledWith(hit.path, { startLine: hit.startLine, endLine: hit.endLine });
      expect(f.api.snapshot().query).toBe("rules");
      expect(f.api.snapshot().view.result.results).toEqual([f.hit, second]);
    }
    expect(f.repository).toHaveBeenCalledOnce();
  } finally { f.stop(); }
});

it("keeps a submitted query and results through unchanged parent target refreshes", async () => {
  const f = fixture();
  try {
    await settle();
    await f.api.submit("rules");
    await settle();
    expect(f.api.snapshot().view.result.results).toEqual([f.hit]);
    f.update({ revision: 1 });
    await settle();
    expect(f.api.snapshot().query).toBe("rules");
    expect(f.api.snapshot().view.result.results).toEqual([f.hit]);
    expect(f.repository).toHaveBeenCalledOnce();
  } finally { f.stop(); }
});

it("keeps an in-flight search owned through an unchanged target refresh", async () => {
  const f = fixture();
  const reply = deferred<NativeSearchResponse>();
  f.repository.mockReturnValueOnce(reply.promise);
  try {
    await settle();
    const pending = f.api.submit("rules");
    await settle();
    expect(f.repository).toHaveBeenCalledOnce();
    const signal = f.repository.mock.calls[0]![3];
    f.update({ revision: 1 });
    await settle();
    expect(signal.aborted).toBe(false);
    expect(f.api.snapshot().view.busy).toBe(true);
    reply.resolve(f.response);
    await pending;
    await settle();
    expect(f.api.snapshot().view.result.results).toEqual([f.hit]);
  } finally { f.stop(); }
});

it.each([{ workspace: "/other" }, { path: "other-wiki" }])("clears and cancels on a real target change: %j", async target => {
  const f = fixture();
  const reply = deferred<NativeSearchResponse>();
  f.repository.mockReturnValueOnce(reply.promise);
  try {
    await settle();
    const pending = f.api.submit("rules");
    await settle();
    const signal = f.repository.mock.calls[0]![3];
    f.update(target);
    await settle();
    expect(signal.aborted).toBe(true);
    expect(f.api.snapshot()).toEqual({ query: "", view: emptySearchDialogState() });
    reply.resolve(f.response);
    await pending;
    await settle();
    expect(f.api.snapshot().view.result.results).toEqual([]);
  } finally { f.stop(); }
});

it("still invalidates on policy changes and releases listeners on teardown", async () => {
  const f = fixture();
  const remove = vi.spyOn(window, "removeEventListener");
  try {
    await settle();
    await f.api.submit("rules");
    window.dispatchEvent(new CustomEvent(SEARCH_SOURCE_SELECTION_CHANGED, { detail: { workspace: "/other" } }));
    expect(f.api.snapshot().view.result.results).toEqual([f.hit]);
    window.dispatchEvent(new CustomEvent(SEARCH_SOURCE_SELECTION_CHANGED, { detail: { workspace: "/project" } }));
    expect(f.api.snapshot().view.result.results).toEqual([]);
    await f.api.submit("rules");
    window.dispatchEvent(new Event("pix-semantic-config-changed"));
    expect(f.api.snapshot().view.result.results).toEqual([]);
  } finally { f.stop(); }
  expect(remove).toHaveBeenCalledWith(SEARCH_SOURCE_SELECTION_CHANGED, expect.any(Function));
  expect(remove).toHaveBeenCalledWith("pix-semantic-config-changed", expect.any(Function));
});
