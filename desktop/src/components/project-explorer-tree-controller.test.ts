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
  const onPersistExpandedDirectories = vi.fn(async (_workspace: string, _paths: readonly string[]) => {});
  const controller = createProjectExplorerTreeController({
    workspace: () => workspace,
    refreshKey: () => 0,
    root: () => root as unknown as HTMLDivElement,
    onListDirectory,
    onOpenFile,
    onOpenExternal: vi.fn(),
    onHealthChange: vi.fn(),
    onLoadExpandedDirectories: async () => [],
    onPersistExpandedDirectories,
    clearDrag: vi.fn(),
  });
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  return { controller, root, focus, scrollIntoView, onOpenFile, onPersistExpandedDirectories, release, replaceWorkspace: () => { workspace = "/second"; } };
}

afterEach(() => vi.unstubAllGlobals());

describe("Project Explorer external directory changes", () => {
  const directory = (path: string): ProjectTreeEntry => ({ path, name: path.split("/").at(-1)!, kind: "directory" });

  it("toggles selections, extends visible ranges, preserves focus, and remaps/prunes selected subtrees", async () => {
    const f = fixture(async () => [directory("b"), directory("c")]);
    const tree = f.controller;
    tree.state.entriesByDirectory = { "": [directory("a"), directory("b"), directory("c")], a: [directory("a/child")] };
    tree.state.expandedDirectories = ["a"];
    tree.state.focusedPath = "c";
    tree.selectEntry("a");
    tree.selectEntry("c", { metaKey: true });
    expect(tree.state.selectedPaths).toEqual(["a", "c"]);
    expect(tree.state.focusedPath).toBe("c");
    tree.selectEntry("a", { shiftKey: true });
    expect(tree.state.selectedPaths).toEqual(["a", "a/child", "b", "c"]);
    expect(tree.selectedEntries(directory("a"))).toEqual([directory("a"), directory("b"), directory("c")]);
    tree.selectEntry("b", { metaKey: true });
    expect(tree.state.selectedPaths).not.toContain("b");
    tree.remapPath("a", "renamed");
    expect(tree.state.selectedPaths).toContain("renamed/child");
    tree.removePath("renamed");
    expect(tree.state.selectedPaths).toEqual(["c"]);
    tree.selectAll();
    expect(tree.state.selectedPaths).not.toContain("");
    await tree.refreshDirectory("");
    expect(tree.state.selectedPaths).toEqual(["b", "c"]);
    expect(tree.isSelected("b")).toBe(true);
    expect(tree.isSelected("a")).toBe(false);
    tree.selectEntry("b", { metaKey: true });
    expect(tree.isSelected("b")).toBe(false);
    tree.dispose();
  });

  it("answers per-row selection and loading lookups from the current arrays", () => {
    const f = fixture();
    const tree = f.controller;
    const entries = Array.from({ length: 5_000 }, (_, index) => directory(`dir-${index}`));
    tree.state.entriesByDirectory = { "": entries };
    tree.selectAll();
    expect(tree.state.selectedPaths).toHaveLength(5_000);
    expect(entries.every((entry) => tree.isSelected(entry.path))).toBe(true);
    tree.state.loadingDirectories = ["dir-7"];
    expect(tree.isDirectoryLoading("dir-7")).toBe(true);
    expect(tree.isDirectoryLoading("dir-8")).toBe(false);
    tree.state.expandedDirectories = ["dir-3"];
    expect(tree.isDirectoryExpanded("dir-3")).toBe(true);
    tree.state.selectedPaths = [];
    expect(tree.isSelected("dir-0")).toBe(false);
    tree.dispose();
  });

  it("reloads a cached directory on expansion so externally created folders appear immediately", async () => {
    let entries: ProjectTreeEntry[] = [];
    const list = vi.fn(async () => entries);
    const f = fixture(list);
    await f.controller.refreshDirectory("a");
    entries = [directory("a/new-folder")];
    f.controller.toggleDirectory("a");
    await Promise.resolve();
    expect(list).toHaveBeenCalledTimes(2);
    expect(f.controller.state.entriesByDirectory.a).toEqual(entries);
    f.controller.dispose();
  });

  it("keeps equal cached listings and loading state untouched during background polls", async () => {
    let finish!: (entries: ProjectTreeEntry[]) => void;
    const f = fixture(() => new Promise<ProjectTreeEntry[]>((resolve) => { finish = resolve; }));
    f.controller.state.entriesByDirectory = { "": [directory("a")] };
    const previous = f.controller.state.entriesByDirectory;
    const loading = f.controller.state.loadingDirectories;
    const pending = f.controller.refreshVisibleDirectories();
    expect(f.controller.state.loadingDirectories).toBe(loading);
    const coalesced = f.controller.refreshVisibleDirectories();
    finish([directory("a")]);
    await Promise.all([pending, coalesced]);
    expect(f.controller.state.entriesByDirectory).toBe(previous);
    expect(f.controller.state.entriesByDirectory[""]).toBe(previous[""]);
    expect(f.controller.state.loadingDirectories).toBe(loading);
    f.controller.dispose();
  });

  it("still shows loading for an initial uncached listing and explicit reload", async () => {
    let finish!: (entries: ProjectTreeEntry[]) => void;
    const f = fixture(() => new Promise<ProjectTreeEntry[]>((resolve) => { finish = resolve; }));
    const pending = f.controller.refreshVisibleDirectories();
    expect(f.controller.rootLoading).toBe(true);
    finish([]);
    await pending;
    expect(f.controller.rootLoading).toBe(false);
    const explicit = f.controller.refreshDirectory("");
    expect(f.controller.rootLoading).toBe(true);
    finish([]);
    await explicit;
    expect(f.controller.rootLoading).toBe(false);
    f.controller.dispose();
  });

  it("updates changed listings while retaining unchanged entry identities", async () => {
    const f = fixture(async () => [directory("a"), directory("new")]);
    f.controller.state.entriesByDirectory = { "": [directory("a"), directory("removed")] };
    const unchanged = f.controller.state.entriesByDirectory[""]![0];
    f.controller.state.expandedDirectories = ["removed"];
    await f.controller.refreshVisibleDirectories();
    expect(f.controller.state.entriesByDirectory[""]![0]).toBe(unchanged);
    expect(f.controller.state.entriesByDirectory[""]!.map((entry) => entry.path)).toEqual(["a", "new"]);
    expect(f.controller.state.expandedDirectories).not.toContain("removed");
    f.controller.dispose();
  });

  it("does not let an older quiet poll overwrite a forced reload or clear its spinner", async () => {
    const completions: ((entries: ProjectTreeEntry[]) => void)[] = [];
    const f = fixture(() => new Promise((resolve) => { completions.push(resolve); }));
    f.controller.state.entriesByDirectory = { "": [directory("old")] };
    const previous = f.controller.state.entriesByDirectory;
    const quiet = f.controller.refreshVisibleDirectories();
    const explicit = f.controller.refreshDirectory("");
    expect(f.controller.rootLoading).toBe(true);
    completions[0]!([directory("stale")]);
    await quiet;
    expect(f.controller.state.entriesByDirectory).toBe(previous);
    expect(f.controller.rootLoading).toBe(true);
    completions[1]!([directory("fresh")]);
    await explicit;
    expect(f.controller.state.entriesByDirectory[""]).toEqual([directory("fresh")]);
    expect(f.controller.rootLoading).toBe(false);
    f.controller.dispose();
  });

  it("retains a background error until success, then clears it without replacing equal entries", async () => {
    const list = vi.fn<() => Promise<ProjectTreeEntry[]>>().mockRejectedValueOnce(new Error("offline"));
    const f = fixture(list);
    f.controller.state.entriesByDirectory = { "": [directory("a")] };
    const previous = f.controller.state.entriesByDirectory;
    await f.controller.refreshVisibleDirectories();
    expect(f.controller.rootError).toBe("offline");
    let finish!: (entries: ProjectTreeEntry[]) => void;
    list.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const retry = f.controller.refreshVisibleDirectories();
    expect(f.controller.rootError).toBe("offline");
    expect(f.controller.rootLoading).toBe(false);
    finish([directory("a")]);
    await retry;
    expect(f.controller.rootError).toBeUndefined();
    expect(f.controller.state.entriesByDirectory).toBe(previous);
    f.controller.dispose();
  });

  it.each(["workspace", "dispose"])("ignores a slow background listing after %s change", async (change) => {
    let finish!: (entries: ProjectTreeEntry[]) => void;
    const f = fixture(() => new Promise<ProjectTreeEntry[]>((resolve) => { finish = resolve; }));
    f.controller.state.entriesByDirectory = { "": [directory("a")] };
    const previous = f.controller.state.entriesByDirectory;
    const pending = f.controller.refreshVisibleDirectories();
    if (change === "workspace") f.replaceWorkspace();
    else f.controller.dispose();
    finish([directory("wrong-workspace")]);
    await pending;
    expect(f.controller.state.entriesByDirectory).toBe(previous);
    f.controller.dispose();
  });

  it("reloads cached root children when reopening a collapsed workspace root", async () => {
    let rootEntries = [directory("a")];
    let childEntries: ProjectTreeEntry[] = [];
    const list = vi.fn(async (path: string) => path ? childEntries : rootEntries);
    const f = fixture(list);
    await f.controller.refreshDirectory("");
    await f.controller.refreshDirectory("a");
    f.controller.state.expandedDirectories = ["a"];
    f.controller.toggleDirectory("");
    rootEntries = [directory("a"), directory("new-root-folder")];
    childEntries = [directory("a/new-child-folder")];
    list.mockClear();
    f.controller.toggleDirectory("");
    await Promise.resolve();
    expect(list.mock.calls.map(([path]) => path)).toEqual([""]);
    expect(f.controller.state.entriesByDirectory[""]).toEqual(rootEntries);
    expect(f.controller.state.expandedDirectories).toEqual([]);
    f.controller.toggleDirectory("a");
    await Promise.resolve();
    expect(f.controller.state.entriesByDirectory.a).toEqual(childEntries);
    f.controller.dispose();
  });

  it("polls only root and visible expanded directories and preserves navigation state", async () => {
    const list = vi.fn(async (path: string) => path
      ? [directory(`${path}/new-folder`)]
      : [directory("a"), directory("closed")]);
    const f = fixture(list);
    f.controller.state.entriesByDirectory = {
      "": [directory("a"), directory("closed")],
      a: [],
      closed: [directory("closed/deep")],
    };
    f.controller.state.expandedDirectories = ["a", "closed/deep"];
    f.controller.state.selectedPath = "a";
    f.controller.state.focusedPath = "a";
    await f.controller.refreshVisibleDirectories();
    expect(list.mock.calls.map(([path]) => path)).toEqual(["", "a"]);
    expect(f.controller.rows.map((row) => row.entry.path)).toContain("a/new-folder");
    expect(f.controller.state.selectedPath).toBe("a");
    expect(f.controller.state.focusedPath).toBe("a");
    expect(f.controller.state.expandedDirectories).toEqual(["a", "closed/deep"]);
    f.controller.dispose();
  });

  it("refreshes only the reopened branch, keeping cached rows and coalescing a slow read", async () => {
    const completions = new Map<string, (entries: ProjectTreeEntry[]) => void>();
    const list = vi.fn((path: string) => new Promise<ProjectTreeEntry[]>((resolve) => { completions.set(path, resolve); }));
    const f = fixture(list);
    const cached = [directory("a/deep")];
    f.controller.state.entriesByDirectory = {
      "": [directory("a"), directory("other")],
      a: cached,
      "a/deep": [],
      other: [],
    };
    f.controller.state.expandedDirectories = ["a/deep", "other"];
    f.controller.toggleDirectory("a");
    expect(list.mock.calls.map(([path]) => path)).toEqual(["a", "a/deep"]);
    expect(f.controller.state.entriesByDirectory.a).toEqual(cached);
    f.controller.toggleDirectory("a");
    f.controller.toggleDirectory("a");
    expect(list).toHaveBeenCalledTimes(2);
    f.controller.dispose();
    for (const [path, finish] of completions) finish([directory(`${path}/new-folder`)]);
    await Promise.resolve();
    expect(f.controller.state.entriesByDirectory["a/deep"]).toEqual([]);
  });
});

describe("Project Explorer collapse state", () => {
  it("clears all descendant preferences but preserves siblings, selection and cached entries", async () => {
    const f = fixture();
    f.controller.state.expandedDirectories = ["a", "a/deep", "a/deep/nested", "ab", "ab/deep", "other"];
    const cached: ProjectTreeEntry[] = [{ path: "a/deep", name: "deep", kind: "directory" }];
    f.controller.state.entriesByDirectory.a = cached;
    f.controller.state.selectedPath = "a/deep/file.ts";
    f.controller.toggleDirectory("a");
    expect(f.controller.state.expandedDirectories).toEqual(["ab", "ab/deep", "other"]);
    expect(f.controller.state.selectedPath).toBe("a/deep/file.ts");
    expect(f.controller.state.entriesByDirectory.a).toEqual(cached);
    f.controller.toggleDirectory("a");
    expect(f.controller.state.expandedDirectories).toEqual(["ab", "ab/deep", "other", "a"]);
    f.controller.toggleDirectory("a");
    f.controller.dispose();
    await vi.waitFor(() => expect(f.onPersistExpandedDirectories).toHaveBeenCalledWith("/first", ["ab", "ab/deep", "other"]));
  });

  it("clears and persists all descendant preferences when collapsing the workspace root", async () => {
    const f = fixture();
    f.controller.state.expandedDirectories = ["a", "a/deep", "other"];
    f.controller.state.selectedPath = "a/deep/file.ts";
    f.controller.toggleDirectory("");
    expect(f.controller.state.rootExpanded).toBe(false);
    expect(f.controller.state.expandedDirectories).toEqual([]);
    expect(f.controller.state.focusedPath).toBe("");
    expect(f.controller.state.selectedPath).toBe("a/deep/file.ts");
    f.controller.toggleDirectory("");
    expect(f.controller.state.rootExpanded).toBe(true);
    expect(f.controller.state.expandedDirectories).toEqual([]);
    f.controller.dispose();
    await vi.waitFor(() => expect(f.onPersistExpandedDirectories).toHaveBeenCalledWith("/first", []));
  });
});

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
