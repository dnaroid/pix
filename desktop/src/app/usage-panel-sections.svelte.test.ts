import { beforeEach, describe, expect, it, vi } from "vitest";
import { usageCollapsedSections } from "../lib/usage-panel-sections";
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
  return { files, errors, store: createUsagePanelSections(errors) };
}

beforeEach(() => { native.invoke.mockReset(); });

describe("usage panel disclosure persistence", () => {
  it("restores sections and persists rapid toggles in order, including across a reopen", async () => {
    const { store, files, errors } = setup({ "/a": '{"usagePanel":{"collapsedSections":["daily"]}}' });
    await store.load("/a");
    expect(store.isOpen("daily")).toBe(false);
    const writes = [store.setOpen("activity", false), store.setOpen("daily", true), store.setOpen("activity", true), store.setOpen("cache", false)];
    store.dispose();
    const reopened = createUsagePanelSections(errors);
    await reopened.load("/a");
    await Promise.all(writes);
    expect(usageCollapsedSections(files.get("/a"))).toEqual(["cache"]);
    expect(reopened.isOpen("daily")).toBe(true);
    expect(reopened.isOpen("cache")).toBe(false);
    expect(errors).not.toHaveBeenCalled();
    reopened.dispose();
  });

  it("ignores stale loads after project switch or disposal", async () => {
    const { store } = setup();
    const late = deferred<{ content: string }>();
    native.invoke.mockImplementation(async (command: string, args: { workspace: string }) => {
      if (command === "project_file_exists") return true;
      if (args.workspace === "/a") return late.promise;
      return { content: '{"usagePanel":{"collapsedSections":["activity"]}}' };
    });
    const first = store.load("/a");
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("read_project_file", expect.objectContaining({ workspace: "/a" })));
    await store.load("/b");
    late.resolve({ content: '{"usagePanel":{"collapsedSections":["daily"]}}' });
    await first;
    expect(store.isOpen("activity")).toBe(false);
    expect(store.isOpen("daily")).toBe(true);
    const loading = store.load("/a");
    store.dispose();
    await loading;
    expect(store.isOpen("daily")).toBe(true);
  });

  it("does not let slow restoration undo input and keeps writes in their original project", async () => {
    const { store, files } = setup({ "/a": "{}", "/b": "{}" });
    const implementation = native.invoke.getMockImplementation()!;
    const late = deferred<{ content: string }>();
    let firstRead = true;
    native.invoke.mockImplementation((command: string, args: Record<string, string>) => {
      if (command === "read_project_file" && firstRead) { firstRead = false; return late.promise; }
      return implementation(command, args);
    });
    const restoring = store.load("/a");
    await vi.waitFor(() => expect(firstRead).toBe(false));
    await store.setOpen("daily", false);
    late.resolve({ content: "{}" });
    await restoring;
    expect(store.isOpen("daily")).toBe(false);
    const writing = store.setOpen("activity", false);
    await store.load("/b");
    await writing;
    expect(usageCollapsedSections(files.get("/a"))).toEqual(["daily", "activity"]);
    expect(files.get("/b")).toBe("{}");
    expect(store.isOpen("daily")).toBe(true);
  });

  it("retries conflicting writes without dropping sibling settings or other toggles", async () => {
    const { store, files } = setup({ "/a": "{}" });
    const implementation = native.invoke.getMockImplementation()!;
    let conflict = true;
    native.invoke.mockImplementation((command: string, args: Record<string, string>) => {
      if (command === "write_project_workspace_config_if_unchanged" && conflict) {
        conflict = false;
        files.set("/a", '{"color":"#112233","usagePanel":{"collapsedSections":["activity"]}}');
      }
      return implementation(command, args);
    });
    await store.load("/a");
    await store.setOpen("daily", false);
    expect(usageCollapsedSections(files.get("/a"))).toEqual(["activity", "daily"]);
    expect(files.get("/a")).toContain('"color":"#112233"');
  });

  it("reports invalid config without overwriting it or blocking disclosure use", async () => {
    const { store, files, errors } = setup({ "/a": "{" });
    await store.load("/a");
    expect(errors).toHaveBeenCalledTimes(1);
    await store.setOpen("activity", false);
    expect(store.isOpen("activity")).toBe(false);
    expect(files.get("/a")).toBe("{");
    expect(errors).toHaveBeenCalledTimes(2);
  });
});
