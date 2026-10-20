import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "jsonc-parser";
import { usageCollapsedSections, usageProviderOrder } from "../lib/usage-panel-sections";
import { clearUsagePanelSectionsCache, createUsagePanelSections } from "./usage-panel-sections.svelte";

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

beforeEach(() => { native.invoke.mockReset(); clearUsagePanelSectionsCache(); });

describe("usage panel disclosure persistence", () => {
  it("restores provider order before ready and does not rewrite unchanged order", async () => {
    const { store, files } = setup({ "/a": '{"usagePanel":{"providerOrder":["zhipu","openai","future"]}}' });
    await store.setProviderOrder(["anthropic"]);
    const loading = store.load("/a");
    expect(store.ready).toBe(false);
    expect(store.providerOrder).toEqual([]);
    await loading;
    expect(store.ready).toBe(true);
    expect(store.providerOrder).toEqual(["zhipu", "openai", "future"]);
    await store.setProviderOrder(["zhipu", "openai", "future", "zhipu"]);
    expect(native.invoke.mock.calls.some(([command]) => command === "write_project_workspace_config_if_unchanged")).toBe(false);
    store.dispose();
    await store.setProviderOrder(["anthropic"]);
    expect(usageProviderOrder(files.get("/a"))).toEqual(["zhipu", "openai", "future"]);
  });

  it("serializes order changes with toggles and waits for accepted writes on reopen", async () => {
    const { store, files, errors } = setup({ "/a": '// keep\n{"color":"#112233"}' });
    await store.load("/a");
    const implementation = native.invoke.getMockImplementation()!;
    const started = deferred<void>();
    const release = deferred<void>();
    let firstWrite = true;
    native.invoke.mockImplementation(async (command: string, args: Record<string, string>) => {
      if (command === "write_project_workspace_config_if_unchanged" && firstWrite) {
        firstWrite = false;
        started.resolve(undefined);
        await release.promise;
      }
      return implementation(command, args);
    });
    const mutable = ["openai", "anthropic"];
    const writes = [store.setProviderOrder(mutable), store.setOpen("daily", false), store.setProviderOrder(["zhipu", "openai"])];
    mutable.reverse();
    await started.promise;
    store.dispose();
    const reopened = createUsagePanelSections(errors);
    const callsBeforeReopen = native.invoke.mock.calls.length;
    const restoring = reopened.load("/a");
    expect(native.invoke.mock.calls).toHaveLength(callsBeforeReopen);
    // The remounted panel renders the last known state at once while disk restoration waits for writes.
    expect(reopened.ready).toBe(true);
    expect(reopened.providerOrder).toEqual(["zhipu", "openai"]);
    expect(reopened.isOpen("daily")).toBe(false);
    release.resolve(undefined);
    await Promise.all([...writes, restoring]);
    expect(reopened.providerOrder).toEqual(["zhipu", "openai"]);
    expect(reopened.isOpen("daily")).toBe(false);
    expect(files.get("/a")).toContain("// keep");
    expect(parse(files.get("/a")!)).toMatchObject({ color: "#112233" });
    expect(errors).not.toHaveBeenCalled();
    reopened.dispose();
  });

  it("merges provider order across write conflicts without overwriting concurrent toggles", async () => {
    const { store, files } = setup({ "/a": '{"usagePanel":{"providerOrder":["openai"]}}' });
    await store.load("/a");
    const implementation = native.invoke.getMockImplementation()!;
    let conflict = true;
    native.invoke.mockImplementation((command: string, args: Record<string, string>) => {
      if (command === "write_project_workspace_config_if_unchanged" && conflict) {
        conflict = false;
        files.set("/a", '{"color":"#112233","usagePanel":{"collapsedSections":["cache"],"providerOrder":["anthropic"]}}');
      }
      return implementation(command, args);
    });
    await store.setProviderOrder(["zhipu", "openai"]);
    await store.setOpen("daily", false);
    expect(usageProviderOrder(files.get("/a"))).toEqual(["zhipu", "openai"]);
    expect(usageCollapsedSections(files.get("/a"))).toEqual(["cache", "daily"]);
    expect(parse(files.get("/a")!)).toMatchObject({ color: "#112233" });
  });

  it("keeps pending order writes in their original project after switching workspace", async () => {
    const { store, files } = setup({ "/a": "{}", "/b": '{"usagePanel":{"providerOrder":["anthropic"]}}' });
    await store.load("/a");
    const saving = store.setProviderOrder(["zhipu", "openai"]);
    await store.load("/b");
    await saving;
    expect(store.providerOrder).toEqual(["anthropic"]);
    expect(usageProviderOrder(files.get("/a"))).toEqual(["zhipu", "openai"]);
    expect(usageProviderOrder(files.get("/b"))).toEqual(["anthropic"]);
  });

  it("keeps sections asleep until restoration finishes and never saves programmatic restoration", async () => {
    const { store, files } = setup({ "/a": '{"usagePanel":{"collapsedSections":["daily","provider-limits"]}}' });
    expect(store.ready).toBe(false);
    expect(store.isOpen("overview")).toBe(false);
    const loading = store.load("/a");
    expect(store.ready).toBe(false);
    expect(store.isOpen("daily")).toBe(false);
    await loading;
    expect(store.ready).toBe(true);
    expect(store.isOpen("overview")).toBe(true);
    expect(store.isOpen("daily")).toBe(false);
    expect(store.isOpen("provider-limits")).toBe(false);
    expect(native.invoke.mock.calls.some(([command]) => command === "write_project_workspace_config_if_unchanged")).toBe(false);
    await store.setOpen("overview", false);
    await store.load("/a");
    expect(store.ready).toBe(true);
    expect(store.isOpen("overview")).toBe(false);
    expect(usageCollapsedSections(files.get("/a"))).toContain("overview");
    store.dispose();
  });

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
      return { content: '{"usagePanel":{"collapsedSections":["activity"],"providerOrder":["openai"]}}' };
    });
    const first = store.load("/a");
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("read_project_file", expect.objectContaining({ workspace: "/a" })));
    await store.load("/b");
    late.resolve({ content: '{"usagePanel":{"collapsedSections":["daily"],"providerOrder":["zhipu"]}}' });
    await first;
    expect(store.isOpen("activity")).toBe(false);
    expect(store.isOpen("daily")).toBe(true);
    expect(store.providerOrder).toEqual(["openai"]);
    const loading = store.load("/a");
    const pendingState = store.isOpen("daily");
    store.dispose();
    await loading;
    expect(store.isOpen("daily")).toBe(pendingState);
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
    expect(parse(files.get("/a")!)).toMatchObject({ color: "#112233" });
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
