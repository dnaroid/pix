import { parse } from "jsonc-parser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWikiAutoCheckSettingsOwner } from "./wiki-auto-check-settings.svelte";
import type { WorkspaceConfigEdit } from "./workspace-config-persistence";

const first = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const mocks = vi.hoisted(() => ({
  read: vi.fn(), persist: vi.fn(), selection: vi.fn(),
}));
vi.mock("./workspace-config-persistence", () => ({
  readWorkspaceConfig: mocks.read,
  persistWorkspaceConfigEdit: mocks.persist,
}));
vi.mock("../lib/search-source-selection", () => ({ readSearchSourceSelection: mocks.selection }));

type Save = (workspace: string, edit: WorkspaceConfigEdit, label: string,
  report: (error: unknown, workspace: string) => void) => Promise<void>;
let files: Map<string, string>;
const apply: Save = async (workspace, edit, _label, report) => {
  try { files.set(workspace, edit(files.get(workspace))); }
  catch (error) { report(error, workspace); }
};
const document = (workspace: string) => {
  const content = files.get(workspace);
  return content === undefined ? undefined : { path: ".pi/workspace.jsonc", content };
};
const configured = (enabled: boolean, runId?: string, path = "wiki") => JSON.stringify({
  wiki: { path, autoCheck: enabled, ...(runId ? { autoCheckRunId: runId } : {}) },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture() {
  let workspace = "/project", generation = 0;
  const pause = vi.fn(), resume = vi.fn(), reportError = vi.fn();
  const owner = createWikiAutoCheckSettingsOwner({
    workspace: () => workspace, generation: () => generation, pause, resume, reportError,
  });
  return {
    ...owner,
    get enabled() { return owner.enabled; },
    get saving() { return owner.saving; },
    get error() { return owner.error; },
    pause, resume, reportError,
    readCurrent: (signal = new AbortController().signal) => owner.read(workspace, signal),
    select(value: string) { workspace = value; generation++; owner.reset(); },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  files = new Map();
  mocks.read.mockImplementation(async (workspace: string) => document(workspace));
  mocks.persist.mockImplementation(apply);
  mocks.selection.mockResolvedValue({ enabled: { knowledge: true }, error: undefined });
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(first);
});

describe("Wiki background settings ownership", () => {
  it("restores the disabled default without indexing-policy reads or writes", async () => {
    const item = fixture();
    expect(item.enabled).toBeUndefined();
    expect(await item.readCurrent()).toMatchObject({ enabled: false, wikiPath: "wiki", sourcesEnabled: false });
    expect(item.enabled).toBe(false);
    expect(mocks.selection).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(item.pause).not.toHaveBeenCalled();
  });

  it("restores an enabled pass and reads the actual Knowledge source policy", async () => {
    files.set("/project", configured(true, other, "design/wiki"));
    mocks.selection.mockResolvedValue({ enabled: { knowledge: false } });
    const item = fixture(), signal = new AbortController().signal;
    expect(await item.readCurrent(signal)).toEqual({ enabled: true, runId: other, wikiPath: "design/wiki", sourcesEnabled: false });
    expect(mocks.selection).toHaveBeenCalledExactlyOnceWith("/project", signal);
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(crypto.randomUUID).not.toHaveBeenCalled();
  });

  it("initializes an enabled configuration once and retains the same pass on later reads", async () => {
    files.set("/project", configured(true));
    const item = fixture();
    expect(await item.readCurrent()).toMatchObject({ enabled: true, runId: first });
    expect(await item.readCurrent()).toMatchObject({ enabled: true, runId: first });
    expect(mocks.persist).toHaveBeenCalledOnce();
    expect(crypto.randomUUID).toHaveBeenCalledOnce();
    expect(item.reportError).not.toHaveBeenCalled();
  });

  it("coalesces simultaneous initialization reads inside the owner", async () => {
    files.set("/project", configured(true));
    const entered = deferred<void>(), release = deferred<void>();
    mocks.persist.mockImplementation(async (...args: Parameters<Save>) => {
      entered.resolve(undefined);
      await release.promise;
      return apply(...args);
    });
    const item = fixture();
    const firstRead = item.readCurrent();
    await entered.promise;
    const secondRead = item.readCurrent();
    // Let the second initial read finish without relying on elapsed wall time.
    await mocks.read.mock.results.at(-1)!.value;
    expect(mocks.persist).toHaveBeenCalledOnce();
    release.resolve(undefined);
    const results = await Promise.all([firstRead, secondRead]);
    expect(results.map(value => value.runId)).toEqual([first, first]);
    expect(mocks.persist).toHaveBeenCalledOnce();
    expect(crypto.randomUUID).toHaveBeenCalledOnce();
  });

  it("does not re-enable a policy disabled before the initialization CAS edit", async () => {
    files.set("/project", configured(true));
    mocks.persist.mockImplementation(async (...args: Parameters<Save>) => {
      files.set("/project", configured(false));
      return apply(...args);
    });
    const item = fixture();
    expect(await item.readCurrent()).toMatchObject({ enabled: false });
    expect(parse(files.get("/project")!).wiki.autoCheck).toBe(false);
    expect(crypto.randomUUID).not.toHaveBeenCalled();
    expect(mocks.selection).not.toHaveBeenCalled();
    expect(item.reportError).not.toHaveBeenCalled();
  });

  it("accepts a concurrent pass identity without overwriting it or related source settings", async () => {
    files.set("/project", configured(true));
    const latest = JSON.stringify({ wiki: { path: "knowledge", autoCheck: true, autoCheckRunId: other }, search: { sources: { knowledge: true } } });
    mocks.persist.mockImplementation(async (...args: Parameters<Save>) => {
      files.set("/project", latest);
      return apply(...args);
    });
    const item = fixture();
    expect(await item.readCurrent()).toMatchObject({ enabled: true, runId: other, wikiPath: "knowledge" });
    expect(files.get("/project")).toBe(latest);
    expect(crypto.randomUUID).not.toHaveBeenCalled();
  });

  it("does not recreate a configuration removed before its identity was initialized", async () => {
    files.set("/project", configured(true));
    mocks.persist.mockImplementation(async (...args: Parameters<Save>) => {
      files.delete("/project");
      return apply(...args);
    });
    const item = fixture();
    expect(await item.readCurrent()).toMatchObject({ enabled: false });
    expect(files.has("/project")).toBe(false);
  });

  it("pauses immediately and preserves a concurrent source edit while committing the explicit choice", async () => {
    files.set("/project", configured(false, other));
    const entered = deferred<void>(), release = deferred<void>();
    mocks.persist.mockImplementation(async (...args: Parameters<Save>) => {
      entered.resolve(undefined);
      await release.promise;
      return apply(...args);
    });
    const item = fixture();
    const pending = item.setEnabled(true);
    expect(item.pause).toHaveBeenCalledOnce();
    expect(item.saving).toBe(true);
    expect(parse(files.get("/project")!).wiki.autoCheck).toBe(false);
    await entered.promise;
    files.set("/project", JSON.stringify({ wiki: { path: "design", autoCheck: false, autoCheckRunId: other }, search: { sources: { knowledge: true }, revision: "concurrent" } }));
    release.resolve(undefined);
    await pending;
    expect(parse(files.get("/project")!)).toEqual({
      wiki: { path: "design", autoCheck: true, autoCheckRunId: first },
      search: { sources: { knowledge: true }, revision: "concurrent" },
    });
    expect(item.saving).toBe(false);
    expect(item.resume).toHaveBeenCalledOnce();
  });

  it("retains the pass identity when the checkbox is turned off", async () => {
    files.set("/project", configured(true, other));
    const item = fixture();
    await item.setEnabled(false);
    expect(parse(files.get("/project")!).wiki).toMatchObject({ autoCheck: false, autoCheckRunId: other });
    expect(crypto.randomUUID).not.toHaveBeenCalled();
    expect(item.resume).toHaveBeenCalledOnce();
  });

  it("invalidates a stale read when the checkbox changes before that read returns", async () => {
    const loading = deferred<ReturnType<typeof document>>();
    mocks.read.mockReturnValueOnce(loading.promise);
    const item = fixture();
    const reading = item.readCurrent();
    const rejected = expect(reading).rejects.toMatchObject({ name: "AbortError" });
    await item.setEnabled(false);
    expect(item.enabled).toBeUndefined();
    await item.readCurrent();
    expect(item.enabled).toBe(false);
    loading.resolve({ path: ".pi/workspace.jsonc", content: configured(true) });
    await rejected;
    expect(item.enabled).toBe(false);
    expect(mocks.persist).toHaveBeenCalledOnce();
    expect(mocks.selection).not.toHaveBeenCalled();
    expect(parse(files.get("/project")!).wiki.autoCheck).toBe(false);
  });

  it("rejects cancelled reads before performing filesystem or source operations", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("Cancelled", "AbortError"));
    const item = fixture();
    await expect(item.readCurrent(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.selection).not.toHaveBeenCalled();
  });

  it("rejects an old policy read after a project round-trip without logging it twice", async () => {
    files.set("/project", configured(true, other));
    const started = deferred<void>(), selected = deferred<{ enabled: { knowledge: boolean } }>();
    mocks.selection.mockImplementation(() => { started.resolve(undefined); return selected.promise; });
    const item = fixture();
    const reading = item.readCurrent();
    const rejected = expect(reading).rejects.toMatchObject({ name: "AbortError" });
    await started.promise;
    expect(item.enabled).toBe(true);
    item.select("/other");
    item.select("/project");
    expect(item.enabled).toBeUndefined();
    selected.resolve({ enabled: { knowledge: true } });
    await rejected;
    expect(item.enabled).toBeUndefined();
    expect(item.reportError).not.toHaveBeenCalled();
    expect(item.resume).not.toHaveBeenCalled();
  });

  it("keeps an accepted old-project save targeted there without touching new UI or scheduler state", async () => {
    const entered = deferred<void>(), release = deferred<void>();
    mocks.persist.mockImplementation(async (...args: Parameters<Save>) => {
      entered.resolve(undefined);
      await release.promise;
      return apply(...args);
    });
    const item = fixture();
    const pending = item.setEnabled(true);
    await entered.promise;
    item.select("/other");
    item.select("/project");
    expect(item.saving).toBe(false);
    release.resolve(undefined);
    await pending;
    expect(parse(files.get("/project")!).wiki.autoCheck).toBe(true);
    expect(files.has("/other")).toBe(false);
    expect(item.resume).not.toHaveBeenCalled();
    expect(item.error).toBeUndefined();
  });

  it("does not let an earlier save clear a newer owner's saving state", async () => {
    const releases = [deferred<void>(), deferred<void>()];
    const entered = [deferred<void>(), deferred<void>()];
    let sequence = 0;
    mocks.persist.mockImplementation(async (...args: Parameters<Save>) => {
      const index = sequence++;
      entered[index]!.resolve(undefined);
      await releases[index]!.promise;
      return apply(...args);
    });
    const item = fixture();
    const previous = item.setEnabled(true);
    await entered[0]!.promise;
    item.select("/other");
    item.select("/project");
    const next = item.setEnabled(false);
    await entered[1]!.promise;
    releases[0]!.resolve(undefined);
    await previous;
    expect(item.saving).toBe(true);
    expect(item.resume).not.toHaveBeenCalled();
    releases[1]!.resolve(undefined);
    await next;
    expect(item.saving).toBe(false);
    expect(item.resume).toHaveBeenCalledOnce();
    expect(parse(files.get("/project")!).wiki.autoCheck).toBe(false);
  });

  it("keeps persistence failure inline without an optimistic enabled state", async () => {
    files.set("/project", configured(false));
    const failure = new Error("Workspace config changed repeatedly");
    mocks.persist.mockImplementation(async (workspace, _edit, _label, report) => { report(failure, workspace); });
    const item = fixture();
    await item.readCurrent();
    expect(item.enabled).toBe(false);
    await item.setEnabled(true);
    expect(item.enabled).toBe(false);
    expect(item.error).toBe(failure.message);
    expect(item.saving).toBe(false);
    expect(item.reportError).toHaveBeenCalledExactlyOnceWith(failure, "/project");
    expect(item.resume).toHaveBeenCalledOnce();
    expect((await item.readCurrent()).enabled).toBe(false);
  });

  it("throws initialization and source-policy errors to the scheduler without duplicate diagnostics", async () => {
    const item = fixture(), failure = new Error("Cannot persist pass identity");
    files.set("/project", configured(true));
    mocks.persist.mockImplementation(async (workspace, _edit, _label, report) => { report(failure, workspace); });
    await expect(item.readCurrent()).rejects.toBe(failure);
    files.set("/project", configured(true, other));
    mocks.selection.mockResolvedValue({ enabled: { knowledge: true }, error: "Invalid source policy" });
    await expect(item.readCurrent()).rejects.toThrow("Invalid source policy");
    expect(item.enabled).toBe(true);
    expect(item.reportError).not.toHaveBeenCalled();
    expect(item.error).toBeUndefined();
  });

  it("retains the parsed enabled choice through source/path errors and invalid JSON until a disabled read", async () => {
    files.set("/project", configured(true, other));
    mocks.selection.mockResolvedValue({ enabled: { knowledge: true }, error: "Source selection failed" });
    const item = fixture();
    await expect(item.readCurrent()).rejects.toThrow("Source selection failed");
    expect(item.enabled).toBe(true);
    files.set("/project", "{");
    await expect(item.readCurrent()).rejects.toThrow();
    expect(item.enabled).toBe(true);
    files.set("/project", configured(true, other, "../unsafe"));
    await expect(item.readCurrent()).rejects.toThrow();
    expect(item.enabled).toBe(true);
    files.delete("/project");
    await item.readCurrent();
    expect(item.enabled).toBe(false);
    item.reset();
    expect(item.enabled).toBeUndefined();
  });

  it("publishes a successful checkbox change only after rereading the saved flag", async () => {
    files.set("/project", configured(false));
    const item = fixture();
    await item.readCurrent();
    expect(item.enabled).toBe(false);
    await item.setEnabled(true);
    expect(item.enabled).toBe(false);
    await item.readCurrent();
    expect(item.enabled).toBe(true);
    item.select("/other");
    expect(item.enabled).toBeUndefined();
  });
});
