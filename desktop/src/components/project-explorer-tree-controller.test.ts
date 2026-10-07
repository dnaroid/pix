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
