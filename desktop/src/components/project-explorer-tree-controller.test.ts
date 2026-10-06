import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectExplorerTreeController } from "./project-explorer-tree-controller.svelte";
import type { ProjectTreeEntry } from "../lib/project-tree";

const deferredTick = vi.hoisted(() => ({ wait: Promise.resolve() }));
vi.mock("svelte", async (importOriginal) => ({
  ...await importOriginal<typeof import("svelte")>(),
  tick: () => deferredTick.wait,
}));

function fixture(onListDirectory: (path: string) => Promise<ProjectTreeEntry[]> = async () => []) {
  let workspace = "/first";
  let release!: () => void;
  deferredTick.wait = new Promise<void>((resolve) => { release = resolve; });
  const focus = vi.fn();
  const scrollIntoView = vi.fn();
  const root = { querySelector: vi.fn(() => ({ focus, scrollIntoView })) };
  const onOpenFile = vi.fn();
  const controller = createProjectExplorerTreeController({
    workspace: () => workspace,
    refreshKey: () => 0,
    root: () => root as unknown as HTMLDivElement,
    onListDirectory,
    onOpenFile,
    onOpenExternal: vi.fn(),
    onHealthChange: vi.fn(),
    onLoadExpandedDirectories: async () => [],
    onPersistExpandedDirectories: async () => {},
    clearDrag: vi.fn(),
  });
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  return { controller, root, focus, scrollIntoView, onOpenFile, release, replaceWorkspace: () => { workspace = "/second"; } };
}

afterEach(() => vi.unstubAllGlobals());

describe("Project Explorer deferred focus", () => {
  it("does not focus a matching row in a replacement workspace after tick", async () => {
    const f = fixture();
    const pending = f.controller.focusPath("");
    f.replaceWorkspace();
    f.release();
    await pending;
    expect(f.root.querySelector).not.toHaveBeenCalled();
  });

  it("does not focus after teardown or after focus moves to another row", async () => {
    for (const teardown of [true, false]) {
      const f = fixture();
      const pending = f.controller.focusPath("");
      if (teardown) f.controller.dispose();
      else f.controller.state.focusedPath = "another";
      f.release();
      await pending;
      expect(f.root.querySelector).not.toHaveBeenCalled();
    }
  });

  it("still focuses a current row after rendering", async () => {
    const f = fixture();
    const pending = f.controller.focusPath("");
    expect(f.focus).not.toHaveBeenCalled();
    f.release();
    await pending;
    expect(f.focus).toHaveBeenCalledOnce();
  });
});

describe("Project Explorer reverse navigation", () => {
  const directory = (path: string): ProjectTreeEntry => ({ path, name: path.split("/").at(-1)!, kind: "directory" });
  const file = (path: string): ProjectTreeEntry => ({ ...directory(path), kind: "file" });

  it.each(["a/deep/file.ts", "a/deep"])("expands lazy parents, selects and scrolls to %s without opening it", async (path) => {
    const list = vi.fn(async (parent: string) => ({
      "": [directory("a"), directory("other")],
      a: [directory("a/deep")],
      "a/deep": [file("a/deep/file.ts")],
    }[parent] ?? []));
    const f = fixture(list);
    f.controller.state.rootExpanded = false;
    const pending = f.controller.revealPath(path);
    f.release();
    await pending;
    expect(f.controller.state.rootExpanded).toBe(true);
    expect(f.controller.state.expandedDirectories).toContain("a");
    expect(f.controller.state.expandedDirectories).toContain("a/deep");
    expect(f.controller.state.selectedPath).toBe(path);
    expect(f.controller.state.focusedPath).toBe(path);
    expect(f.focus).toHaveBeenCalledOnce();
    expect(f.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(f.onOpenFile).not.toHaveBeenCalled();
    expect(list.mock.calls.map(([parent]) => parent)).not.toContain("other");
    f.controller.dispose();
  });

  it("reveals a hidden .pi directory with a trailing separator", async () => {
    const path = ".pi/artifacts/usage-popup-mockups";
    const list = vi.fn(async (parent: string) => ({
      "": [directory(".pi")],
      ".pi": [directory(".pi/artifacts")],
      ".pi/artifacts": [directory(path)],
      [path]: [file(`${path}/mockup.svg`)],
    }[parent] ?? []));
    const f = fixture(list);
    const pending = f.controller.revealPath(`${path}/`);
    f.release();
    await pending;
    expect(f.controller.state.selectedPath).toBe(path);
    expect(f.controller.state.expandedDirectories).toEqual(expect.arrayContaining([
      ".pi", ".pi/artifacts", path,
    ]));
    expect(list.mock.calls.map(([parent]) => parent)).toEqual([
      "", ".pi", ".pi/artifacts", path,
    ]);
    expect(f.focus).toHaveBeenCalledOnce();
    expect(f.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(f.onOpenFile).not.toHaveBeenCalled();
    f.controller.dispose();
  });

  it.each(["workspace", "dispose", "newer-reveal", "focus"])("ignores delayed reveal after %s", async (change) => {
    let finish!: (entries: ProjectTreeEntry[]) => void;
    const wait = new Promise<ProjectTreeEntry[]>((resolve) => { finish = resolve; });
    const f = fixture(async () => wait);
    const pending = f.controller.revealPath("a/file.ts");
    f.release();
    await Promise.resolve();
    if (change === "workspace") f.replaceWorkspace();
    if (change === "dispose") f.controller.dispose();
    if (change === "focus") f.controller.state.focusedPath = "other";
    const newer = change === "newer-reveal" ? f.controller.revealPath("new.ts") : Promise.resolve();
    finish([directory("a"), file("new.ts")]);
    await Promise.all([pending, newer]);
    expect(f.controller.state.selectedPath).toBe(change === "newer-reveal" ? "new.ts" : null);
    expect(f.focus).toHaveBeenCalledTimes(change === "newer-reveal" ? 1 : 0);
    f.controller.dispose();
  });

  it("waits for an already pending directory listing", async () => {
    let finish!: (entries: ProjectTreeEntry[]) => void;
    const list = vi.fn(() => new Promise<ProjectTreeEntry[]>((resolve) => { finish = resolve; }));
    const f = fixture(list);
    const refresh = f.controller.refreshVisibleDirectories();
    const reveal = f.controller.revealPath("file.ts");
    f.release();
    await Promise.resolve();
    finish([file("file.ts")]);
    await Promise.all([refresh, reveal]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(f.controller.state.selectedPath).toBe("file.ts");
    f.controller.dispose();
  });

  it.each(["../escape", "/absolute", "missing"])("does not select invalid or missing target %s", async (path) => {
    const f = fixture();
    const pending = f.controller.revealPath(path);
    f.release();
    await pending;
    expect(f.controller.state.selectedPath).toBeNull();
    expect(f.focus).not.toHaveBeenCalled();
    f.controller.dispose();
  });
});
