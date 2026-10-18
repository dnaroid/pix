import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "jsonc-parser";
import { workCollapsedSections, workspaceConfigWithWorkSection } from "../lib/work-panel-sections";
import { createWorkPanelSections } from "./work-panel-sections.svelte";
import { createUsagePanelSections } from "./usage-panel-sections.svelte";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function setup(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const errors = vi.fn();
  native.invoke.mockImplementation(async (command: string, args: Record<string, string | null>) => {
    const workspace = args.workspace!;
    if (command === "project_file_exists") return files.has(workspace);
    if (command === "read_project_file") return { content: files.get(workspace) };
    if (command === "write_project_workspace_config_if_unchanged") {
      if ((files.get(workspace) ?? null) !== args.expectedContent) return { written: false, document: { content: files.get(workspace) } };
      files.set(workspace, args.content!);
      return { written: true, document: { content: args.content } };
    }
    throw new Error(`Unexpected command ${command}`);
  });
  return { files, errors, store: createWorkPanelSections(errors) };
}

beforeEach(() => { native.invoke.mockReset(); });

describe("Work panel section config", () => {
  it("edits only workPanel.collapsedSections, preserving comments, siblings and unknown ids", () => {
    const source = '// keep\n{"color":"#112233","workPanel":{"collapsedSections":["future"]}}';
    const closed = workspaceConfigWithWorkSection(source, "plans", false);
    expect(closed).toContain("// keep");
    expect(workCollapsedSections(closed)).toEqual(["future", "plans"]);
    expect((parse(closed) as Record<string, unknown>).color).toBe("#112233");
    expect(workCollapsedSections(workspaceConfigWithWorkSection(closed, "plans", true))).toEqual(["future"]);
    expect(workCollapsedSections(undefined)).toEqual([]);
  });

  it("rejects malformed config instead of overwriting it", () => {
    expect(() => workCollapsedSections("{")).toThrow("malformed");
    expect(() => workCollapsedSections('{"workPanel":[]}')).toThrow("workPanel");
    expect(() => workCollapsedSections('{"workPanel":{"collapsedSections":[1]}}')).toThrow("collapsedSections");
  });
});

describe("Work panel accordion persistence", () => {
  it("defaults both open, restores per workspace and persists toggles", async () => {
    const { store, files } = setup({ "/b": '{"workPanel":{"collapsedSections":["tasks"]}}' });
    const loading = store.load("/a");
    expect(store.ready).toBe(false);
    await loading;
    expect(store.ready).toBe(true);
    expect(store.isOpen("plans")).toBe(true);
    expect(store.isOpen("tasks")).toBe(true);
    await store.toggle("plans");
    expect(store.isOpen("plans")).toBe(false);
    expect(workCollapsedSections(files.get("/a"))).toEqual(["plans"]);
    await store.load("/b");
    expect(store.isOpen("plans")).toBe(true);
    expect(store.isOpen("tasks")).toBe(false);
    const reopened = setup(Object.fromEntries(files)).store;
    await reopened.load("/a");
    expect(reopened.isOpen("plans")).toBe(false);
  });

  it("keeps user input made during a slow restore and ignores stale workspace loads", async () => {
    const { store, files } = setup({ "/a": '{"workPanel":{"collapsedSections":["plans"]}}', "/b": "{}" });
    const implementation = native.invoke.getMockImplementation()!;
    const gate = deferred<void>();
    native.invoke.mockImplementation(async (command: string, args: Record<string, string>) => {
      if (command === "read_project_file" && args.workspace === "/a") await gate.promise;
      return implementation(command, args);
    });
    const loading = store.load("/a");
    const write = store.setOpen("tasks", false);
    gate.resolve();
    await Promise.all([loading, write]);
    expect(store.isOpen("plans")).toBe(false);
    expect(store.isOpen("tasks")).toBe(false);
    expect(workCollapsedSections(files.get("/a"))).toEqual(["plans", "tasks"]);

    const slow = deferred<void>();
    native.invoke.mockImplementation(async (command: string, args: Record<string, string>) => {
      if (command === "read_project_file" && args.workspace === "/b") await slow.promise;
      return implementation(command, args);
    });
    const stale = store.load("/b");
    await store.load("");
    slow.resolve();
    await stale;
    expect(store.ready).toBe(true);
    expect(store.isOpen("tasks")).toBe(true);
  });

  it("reports malformed config, keeps defaults and does not write after dispose", async () => {
    const { store, files, errors } = setup({ "/a": "{" });
    await store.load("/a");
    expect(errors).toHaveBeenCalledTimes(1);
    expect(store.ready).toBe(true);
    expect(store.isOpen("plans")).toBe(true);
    store.dispose();
    await store.setOpen("plans", false);
    expect(files.get("/a")).toBe("{");
  });

  it("serializes writes with the usage panel through the shared workspace queue", async () => {
    const { store, files } = setup({ "/a": '{"color":"#112233"}' });
    const usage = createUsagePanelSections(vi.fn());
    await Promise.all([store.load("/a"), usage.load("/a")]);
    await Promise.all([store.setOpen("tasks", false), usage.setOpen("overview", false), store.setOpen("plans", false)]);
    const parsed = parse(files.get("/a")!) as { color: string; workPanel: { collapsedSections: string[] }; usagePanel: { collapsedSections: string[] } };
    expect(parsed.color).toBe("#112233");
    expect(parsed.workPanel.collapsedSections).toEqual(["tasks", "plans"]);
    expect(parsed.usagePanel.collapsedSections).toEqual(["overview"]);
  });
});
