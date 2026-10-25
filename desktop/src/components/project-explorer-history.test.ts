import { describe, expect, it, vi } from "vitest";
import { createProjectExplorerHistory, type ProjectFileReceipt } from "./project-explorer-history.svelte";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const receipt = (token = "operation", extra: Partial<ProjectFileReceipt> = {}): ProjectFileReceipt => ({ token, entries: [], changes: [], warning: null, complete: true, ...extra });
const request = { type: "delete" as const, paths: ["file"] };

function fixture() {
  let workspace = "/first";
  const invoke = vi.fn(async (_command: string, _args: Record<string, unknown>) => receipt());
  const changed = vi.fn(async (_receipt: ProjectFileReceipt) => {});
  const release = vi.fn();
  const prepare = vi.fn(async (): Promise<() => void> => release);
  const warning = vi.fn();
  const forget = vi.fn();
  const history = createProjectExplorerHistory({ workspace: () => workspace, invoke, changed, prepare, warning, forget });
  return { history, invoke, changed, release, prepare, warning, forget, switchWorkspace: () => { workspace = "/second"; history.invalidate(); } };
}

describe("Files operation history", () => {
  it("moves tokens between undo/redo, drops redo only after a new successful change, and releases reservations", async () => {
    const f = fixture();
    await f.history.execute(request);
    expect(f.history.canUndo).toBe(true);
    await f.history.undo();
    expect(f.invoke).toHaveBeenLastCalledWith("replay_project_entries", { workspace: "/first", token: "operation", undo: true });
    expect(f.history.canUndo).toBe(false);
    expect(f.history.canRedo).toBe(true);
    f.invoke.mockRejectedValueOnce(new Error("occupied"));
    await expect(f.history.execute(request)).rejects.toThrow("occupied");
    expect(f.history.canRedo).toBe(true);
    await f.history.redo();
    await f.history.undo();
    await f.history.execute(request);
    expect(f.history.canRedo).toBe(false);
    expect(f.forget).toHaveBeenCalledWith(["operation"]);
    expect(f.release).toHaveBeenCalledTimes(6);
  });

  it("keeps partially replayed batches on the same stack for retry", async () => {
    const f = fixture();
    await f.history.execute(request);
    f.invoke.mockResolvedValueOnce(receipt("operation", { complete: false, warning: "one file is occupied" }));
    await f.history.undo();
    expect(f.history.canUndo).toBe(true);
    expect(f.history.canRedo).toBe(false);
    expect(f.warning).toHaveBeenCalledWith("one file is occupied");
    await f.history.undo();
    expect(f.history.canRedo).toBe(true);
  });

  it("allows independent forward operations but refuses replay while any is pending", async () => {
    const f = fixture();
    const first = deferred<ProjectFileReceipt>();
    const second = deferred<ProjectFileReceipt>();
    f.invoke.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const a = f.history.execute(request);
    const b = f.history.execute(request);
    expect(await f.history.undo()).toBeNull();
    second.resolve(receipt("second")); await b;
    expect(f.history.busy).toBe(true);
    first.resolve(receipt("first")); await a;
    expect(f.history.busy).toBe(false);
    await f.history.undo();
    expect(f.invoke).toHaveBeenLastCalledWith("replay_project_entries", expect.objectContaining({ token: "first" }));
  });

  it("forgets stale tokens without publishing changes or clearing a newer busy owner", async () => {
    const f = fixture();
    const old = deferred<ProjectFileReceipt>();
    const next = deferred<ProjectFileReceipt>();
    f.invoke.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => next.promise);
    const pending = f.history.execute(request);
    await Promise.resolve();
    f.switchWorkspace();
    const newer = f.history.execute(request);
    old.resolve(receipt("stale"));
    expect(await pending).toBeNull();
    expect(f.forget).toHaveBeenCalledWith(["stale"]);
    expect(f.changed).not.toHaveBeenCalled();
    expect(f.history.busy).toBe(true);
    next.resolve(receipt("new")); await newer;
    expect(f.history.canUndo).toBe(true);
    expect(f.release).toHaveBeenCalledTimes(2);
  });

  it("checks generation again after preparation and preserves history if refresh fails", async () => {
    const f = fixture();
    const preparation = deferred<() => void>();
    f.prepare.mockImplementationOnce(() => preparation.promise);
    const pending = f.history.execute(request);
    f.switchWorkspace(); preparation.resolve(f.release);
    expect(await pending).toBeNull();
    expect(f.invoke).not.toHaveBeenCalled();
    f.changed.mockRejectedValueOnce(new Error("refresh failed"));
    await expect(f.history.execute(request)).rejects.toThrow("refresh failed");
    expect(f.history.canUndo).toBe(true);
    expect(f.release).toHaveBeenCalledTimes(2);
  });

  it("caps live history at 100 and releases runtime tokens on teardown", async () => {
    const f = fixture();
    for (let i = 0; i < 102; i++) { f.invoke.mockResolvedValueOnce(receipt(String(i))); await f.history.execute(request); }
    expect(f.forget).toHaveBeenCalledWith(["0"]);
    expect(f.forget).toHaveBeenCalledWith(["1"]);
    f.history.invalidate();
    expect(f.forget.mock.calls.at(-1)?.[0]).toHaveLength(100);
    expect(f.history.canUndo).toBe(false);
  });
});
