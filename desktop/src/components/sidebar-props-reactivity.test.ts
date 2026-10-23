import { compile } from "svelte/compiler";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
// @ts-expect-error Execute client prop spreading/effects, not inert SSR runes.
import * as client from "svelte/internal/client";
import explorerSource from "./ProjectExplorer.svelte?raw";
import sidebarSource from "./WorkspaceSidebar.svelte?raw";
import { createProjectGitRefresh } from "../lib/project-git-refresh";

/** Compile the production prop declarations and I/O effects without the DOM tree.
 * Unrelated controllers/rendering are excluded, not copies of the effects under test.
 */
function compileEffects<Api extends object = Record<string, never>>(
  source: string,
  names: string[],
  effect: (statement: string) => boolean,
  harness: Record<string, unknown>,
  setup: string,
  exports = "",
) {
  const script = source.slice(source.indexOf(">") + 1, source.indexOf("</script>"));
  const ast = ts.createSourceFile("component.ts", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statements = ast.statements.filter((statement) => {
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.some((declaration) =>
        declaration.initializer?.getText(ast) === "$props()"
        || (ts.isIdentifier(declaration.name) && names.includes(declaration.name.text)));
    }
    return ts.isExpressionStatement(statement) && statement.getText(ast).startsWith("$effect(")
      && effect(statement.getText(ast));
  }).map((statement) => statement.getText(ast));
  expect(statements.length).toBeGreaterThan(names.length);
  const javascript = ts.transpileModule(`
    import { untrack } from "svelte";
    import { createProjectGitRefresh } from "../lib/project-git-refresh";
    import { harness } from "test-harness";
    ${setup}
    ${statements.join("\n")}
    ${exports}
  `, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
  const compiled = compile(`<script>${javascript}</script>`, { filename: "PropEffects.svelte", generate: "client", dev: false }).js.code;
  const commonjs = ts.transpileModule(compiled, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const output: { default?: (anchor: unknown, props: object) => Api } = {};
  const dependencies: Record<string, unknown> = {
    "svelte/internal/client": client,
    "svelte/internal/disclose-version": {},
    "svelte/internal/flags/legacy": {},
    svelte: { untrack: client.untrack },
    "../lib/project-git-refresh": { createProjectGitRefresh },
    "test-harness": { harness },
  };
  new Function("require", "exports", commonjs)((name: string) => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  }, output);
  return output.default!;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    client.flush();
    await Promise.resolve();
  }
}

function explorerFixture() {
  const input = client.state({ workspace: "/one", refreshKey: 0, gitLoading: false });
  const gates: (() => void)[] = [];
  const refresh = vi.fn(() => {
    update({ gitLoading: true });
    return new Promise<void>((resolve) => { gates.push(resolve); }).finally(() => update({ gitLoading: false }));
  });
  const invoke = vi.fn(async () => []);
  const component = compileEffects<{ dispose(): void; setQuery(query: string): void }>(explorerSource,
    ["gitRefresh", "refreshTarget", "effectWorkspace", "searchQuery", "searchGeneration", "searchError", "searchResults", "searchLoading"],
    (statement) => statement.includes("gitRefresh.request()") || statement.includes("const generation = ++searchGeneration"),
    { invoke }, "const { invoke } = harness;",
    `export function setQuery(query) { searchQuery = query; }
     export function dispose() { gitRefresh.dispose(); searchGeneration++; }
     function errorMessage(error) { return String(error); }`,
  );
  let api!: ReturnType<typeof component>;
  const stop = client.effect_root(() => {
    // Same coarse derived object/spread getter as DesktopSidebar. Forward its
    // getters again, as WorkspaceSidebar does when creating ProjectExplorer.
    const props = client.derived(() => ({ ...client.get(input), onGitStatusRefresh: refresh }));
    const spread = client.spread_props(() => client.get(props));
    api = component(null, {
      get workspace() { return spread.workspace; },
      get refreshKey() { return spread.refreshKey; },
      get onGitStatusRefresh() { return spread.onGitStatusRefresh; },
    });
  });
  function update(patch: Partial<{ workspace: string; refreshKey: number; gitLoading: boolean }>) {
    client.set(input, { ...client.get(input), ...patch });
  }
  return { refresh, gates, invoke, api, update, stop: () => { api.dispose(); stop(); } };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("does not feed Git loading prop changes back into refreshes or bypass the 5s timer", async () => {
  vi.useFakeTimers();
  const f = explorerFixture();
  try {
    await settle();
    expect(f.refresh).toHaveBeenCalledTimes(1);
    f.gates.shift()!();
    await settle();
    expect(f.refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_999);
    await settle();
    expect(f.refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(f.refresh).toHaveBeenCalledTimes(2);
    f.gates.shift()!();
    await settle();
    expect(f.refresh).toHaveBeenCalledTimes(2);
  } finally { f.stop(); }
  await vi.advanceTimersByTimeAsync(30_000);
  expect(f.refresh).toHaveBeenCalledTimes(2);
});

it("queues real lifecycle changes during a read and stops after teardown", async () => {
  vi.useFakeTimers();
  const f = explorerFixture();
  try {
    await settle();
    f.update({ workspace: "/two" });
    await settle();
    f.update({ refreshKey: 1 });
    await settle();
    expect(f.refresh).toHaveBeenCalledTimes(1);
    f.gates.shift()!();
    await settle();
    expect(f.refresh).toHaveBeenCalledTimes(2);
    f.gates.shift()!();
    await settle();
    expect(f.refresh).toHaveBeenCalledTimes(2);
    f.update({ refreshKey: 2 });
    await settle();
    expect(f.refresh).toHaveBeenCalledTimes(3);
  } finally { f.stop(); }
  f.gates.shift()!();
  await settle();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(f.refresh).toHaveBeenCalledTimes(3);
});

it("does not postpone the search debounce when unrelated sidebar props change", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  const f = explorerFixture();
  try {
    await settle();
    f.api.setQuery("needle");
    await settle();
    await vi.advanceTimersByTimeAsync(100);
    f.update({ gitLoading: false });
    await settle();
    await vi.advanceTimersByTimeAsync(80);
    await settle();
    expect(f.invoke).toHaveBeenCalledExactlyOnceWith("search_project_files", { workspace: "/one", query: "needle" });
    f.api.setQuery("new query");
    await settle();
    f.update({ gitLoading: true });
    await settle();
    await vi.advanceTimersByTimeAsync(180);
    expect(f.invoke).toHaveBeenLastCalledWith("search_project_files", { workspace: "/one", query: "new query" });
  } finally { f.stop(); }
  f.gates.shift()!();
  await settle();
});

it("does not reload Registry/Work state or restart task observation on Git loading toggles", async () => {
  const invalidateFast = vi.fn();
  const selectTasks = vi.fn();
  const selectPlans = vi.fn();
  const load = vi.fn();
  const unsubscribe = vi.fn();
  const observe = vi.fn(() => unsubscribe);
  const registry = {};
  const initial = { workspace: "/one", registrySnapshot: registry, gitLoading: false, onObserveTasks: observe };
  const input = client.state(initial);
  const component = compileEffects<{ setEditorOpen(value: boolean): void }>(sidebarSource,
    ["effectWorkspace", "effectRegistrySnapshot", "observeTasks", "activeTab", "editorOpen"],
    (statement) => ["tasksView.selectWorkspace", "onObserveTasks", "workSections.load", "plansView.selectWorkspace", "effectRegistrySnapshot;", "registrySnapshot;"].some((part) => statement.includes(part)),
    { tasksView: { selectWorkspace: selectTasks }, plansView: { selectWorkspace: selectPlans }, workSections: { load },
      indicatorService: { invalidateFast }, layoutController: { collapsed: false } },
    "const { tasksView, plansView, workSections, indicatorService, layoutController } = harness;",
    "export function setEditorOpen(value) { editorOpen = value; }",
  );
  let api!: ReturnType<typeof component>;
  const stop = client.effect_root(() => {
    const props = client.derived(() => ({ ...client.get(input) }));
    api = component(null, client.spread_props(() => client.get(props)));
  });
  function update(patch: Partial<typeof initial>) { client.set(input, { ...client.get(input), ...patch }); }
  try {
    await settle();
    expect(invalidateFast).toHaveBeenCalledTimes(1);
    for (const gitLoading of [true, false, true, false]) { update({ gitLoading }); await settle(); }
    expect(invalidateFast).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledExactlyOnceWith("/one");
    expect(selectTasks).toHaveBeenCalledExactlyOnceWith("/one");
    expect(selectPlans).toHaveBeenCalledExactlyOnceWith("/one");
    expect(observe).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();
    update({ workspace: "/two" });
    await settle();
    expect(load).toHaveBeenLastCalledWith("/two");
    expect(selectTasks).toHaveBeenLastCalledWith("/two");
    expect(selectPlans).toHaveBeenLastCalledWith("/two");
    expect(observe).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    update({ registrySnapshot: {} });
    await settle();
    expect(invalidateFast).toHaveBeenCalledTimes(2);
    api.setEditorOpen(true);
    await settle();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
    update({ gitLoading: true });
    await settle();
    expect(observe).toHaveBeenCalledTimes(2);
    api.setEditorOpen(false);
    await settle();
    expect(observe).toHaveBeenCalledTimes(3);
    update({ workspace: "" });
    await settle();
    expect(unsubscribe).toHaveBeenCalledTimes(3);
    expect(observe).toHaveBeenCalledTimes(3);
    update({ workspace: "/three" });
    await settle();
    expect(observe).toHaveBeenCalledTimes(4);
  } finally { stop(); }
  expect(unsubscribe).toHaveBeenCalledTimes(4);
});
