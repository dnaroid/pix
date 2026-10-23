import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGitWorkspaceStore } from "./git-workspace.svelte";
import type { GitSnapshot } from "../lib/git";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

function fixture() {
  let workspace = "/one";
  const snapshot: GitSnapshot = {
    branch: "main", head: "abc", upstream: "origin/main", detached: false,
    ahead: 0, behind: 0, remotes: ["origin"],
    branches: [{ name: "main", current: true, upstream: "origin/main" }],
    changes: [{ path: "a.ts", indexStatus: ".", worktreeStatus: "M", staged: false, unstaged: true, untracked: false, conflicted: false }],
  };
  const onSnapshotChange = vi.fn();
  invoke.mockResolvedValue(snapshot);
  const store = createGitWorkspaceStore({
    workspace: () => workspace, previewDirty: () => false, reloadProject: vi.fn(),
    activeWorkbenchTabId: () => null, activeConversationWorkbenchTabId: () => null,
    setActiveWorkbenchTabId: vi.fn(), nextWorkbenchAuxOrder: () => 1, onSnapshotChange,
  });
  const lean = { ...snapshot, remotes: [], branches: [] };
  return { store, snapshot, lean, onSnapshotChange, reset() { workspace = "/two"; store.reset(); } };
}

beforeEach(() => invoke.mockReset());

describe("Explorer Git status ownership", () => {
  it("bootstraps metadata once, preserves it on minimal polls and keeps equal snapshot identity", async () => {
    const { store, lean, onSnapshotChange } = fixture();
    await store.refreshExplorer();
    const previous = store.snapshot;
    expect(invoke).toHaveBeenLastCalledWith("git_status", { workspace: "/one", includeLineStats: false });
    invoke.mockResolvedValue(lean);
    await store.refreshExplorer();
    expect(invoke).toHaveBeenLastCalledWith("git_status", { workspace: "/one", includeLineStats: false, includeRepositoryDetails: false });
    expect(store.snapshot).toBe(previous);
    expect(onSnapshotChange).toHaveBeenCalledTimes(1);
    expect(store.snapshot?.remotes).toEqual(["origin"]);
    expect(store.snapshot?.branches).toEqual(previous?.branches);
  });

  it("publishes changed decorations without losing metadata", async () => {
    const { store, lean, onSnapshotChange } = fixture();
    await store.refreshExplorer();
    invoke.mockResolvedValue({ ...lean, changes: [] });
    await store.refreshExplorer();
    expect(store.snapshot?.changes).toEqual([]);
    expect(store.snapshot?.remotes).toEqual(["origin"]);
    expect(onSnapshotChange).toHaveBeenCalledTimes(2);
  });

  it.each(["branch", "upstream"] as const)("reloads metadata after an external %s switch", async (field) => {
    const { store, lean, snapshot } = fixture();
    await store.refreshExplorer();
    const switched = { ...lean, [field]: "other" };
    const enriched = { ...snapshot, [field]: "other", remotes: ["other-origin"] };
    invoke.mockResolvedValueOnce(switched).mockResolvedValueOnce(enriched);
    await store.refreshExplorer();
    expect(invoke).toHaveBeenLastCalledWith("git_status", { workspace: "/one", includeLineStats: false });
    expect(store.snapshot?.remotes).toEqual(["other-origin"]);
    expect(store.snapshot?.[field]).toBe("other");
  });

  it("ignores a stale metadata reload after workspace reset and bootstraps the new workspace", async () => {
    const f = fixture();
    await f.store.refreshExplorer();
    let finish!: (value: GitSnapshot) => void;
    invoke.mockResolvedValueOnce({ ...f.lean, branch: "other" })
      .mockImplementationOnce(() => new Promise<GitSnapshot>((resolve) => { finish = resolve; }));
    const refresh = f.store.refreshExplorer();
    // The metadata reload starts after the minimal response, without timers.
    await Promise.resolve();
    f.reset();
    finish({ ...f.snapshot, branch: "other" });
    await refresh;
    expect(f.store.snapshot).toBeUndefined();
    await f.store.refreshExplorer();
    expect(invoke).toHaveBeenLastCalledWith("git_status", { workspace: "/two", includeLineStats: false });
  });

  it("does not let a minimal pending poll satisfy concurrent full readers", async () => {
    const { store, lean } = fixture();
    await store.refreshExplorer();
    invoke.mockClear();
    let finish!: (value: GitSnapshot) => void;
    invoke.mockImplementationOnce(() => new Promise<GitSnapshot>((resolve) => { finish = resolve; }));
    const minimal = store.refreshExplorer();
    const full = store.refresh();
    const secondFull = store.refresh();
    finish(lean);
    await Promise.all([minimal, full, secondFull]);
    expect(invoke.mock.calls).toEqual([
      ["git_status", { workspace: "/one", includeLineStats: false, includeRepositoryDetails: false }],
      ["git_status", { workspace: "/one" }],
    ]);
  });

  it("full reads replace cached remote metadata even when status is unchanged", async () => {
    const { store, snapshot } = fixture();
    await store.refreshExplorer();
    invoke.mockResolvedValue({ ...snapshot, remotes: ["new-origin"] });
    await store.refresh();
    expect(invoke).toHaveBeenLastCalledWith("git_status", { workspace: "/one" });
    expect(store.snapshot?.remotes).toEqual(["new-origin"]);
  });
});
