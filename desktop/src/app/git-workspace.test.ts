import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitWorkspaceStore } from "./git-workspace.svelte";
import type { GitSnapshot } from "../lib/git";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

function fixture() {
  let workspace = "/one";
  const snapshot: GitSnapshot = {
    branch: "main", detached: false, head: "abc", upstream: "origin/main", ahead: 0, behind: 0, remotes: ["origin"], branches: [],
    changes: [{ path: "file.ts", indexStatus: "M", worktreeStatus: ".", staged: true, unstaged: false, untracked: false, conflicted: false }],
  };
  invoke.mockImplementation(async (command: string) => {
    if (command === "git_status") return snapshot;
    if (command === "git_diff") return { scope: "staged", content: "+new", truncated: false };
    if (command === "git_history" || command === "git_stash_list") return [];
  });
  const store = createGitWorkspaceStore({
    workspace: () => workspace, previewDirty: () => false, reloadProject: vi.fn(async () => {}),
    activeWorkbenchTabId: () => null, activeConversationWorkbenchTabId: () => null,
    setActiveWorkbenchTabId: vi.fn(), nextWorkbenchAuxOrder: () => 1,
  });
  return { store, snapshot, setWorkspace(value: string) { workspace = value; store.reset(); } };
}

beforeEach(() => { invoke.mockReset(); vi.stubGlobal("window", { confirm: vi.fn(() => true) }); });
afterEach(() => vi.unstubAllGlobals());

describe("Git commit transaction and lifecycle", () => {
  it("detects an uninitialized workspace and initializes it explicitly", async () => {
    const { store, snapshot } = fixture();
    let initialized = false;
    invoke.mockImplementation(async (command: string) => {
      if (command === "git_status") {
        if (!initialized) throw new Error("fatal: not a git repository");
        return snapshot;
      }
      if (command === "git_repository_state") return { initialized: false };
      if (command === "git_initialize") {
        initialized = true;
        return undefined;
      }
    });

    await store.refresh();
    expect(store.snapshot).toBeUndefined();
    expect(store.uninitialized).toBe(true);
    expect(store.error).toBeNull();

    await expect(store.initialize()).resolves.toBe(true);
    expect(store.uninitialized).toBe(false);
    expect(store.snapshot).toEqual(snapshot);
    expect(store.notice).toMatch(/initialized on main/i);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "git_status",
      "git_repository_state",
      "git_initialize",
      "git_status",
    ]);
  });

  it("does not offer nested initialization when the workspace belongs to a parent repository", async () => {
    const { store } = fixture();
    invoke.mockImplementation(async (command: string) => {
      if (command === "git_status") throw new Error("Git repository root is /parent");
      if (command === "git_repository_state") return { initialized: false, repositoryRoot: "/parent" };
    });

    await store.refresh();
    expect(store.uninitialized).toBe(false);
    expect(store.error).toContain("Git repository root is /parent");
  });

  it("commits then pushes under one lock, never implicitly staging", async () => {
    const { store } = fixture();
    await store.refresh();
    await expect(store.commit("message", true)).resolves.toBe(true);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["git_status", "git_commit", "git_push", "git_status"]);
    expect(store.notice).toMatch(/Committed and pushed/);
    expect(store.actionId).toBeNull();
  });
  it("does not push when commit fails", async () => {
    const { store } = fixture();
    await store.refresh();
    invoke.mockRejectedValueOnce(new Error("hook rejected"));
    await expect(store.commit("message", true)).resolves.toBe(false);
    expect(invoke.mock.calls.some(([command]) => command === "git_push")).toBe(false);
    expect(store.error).toMatch(/hook rejected/);
  });
  it("reports local commit success when push fails, allowing the draft to clear", async () => {
    const { store, snapshot } = fixture();
    await store.refresh();
    invoke.mockImplementation(async (command: string) => {
      if (command === "git_push") throw new Error("offline");
      if (command === "git_status") return { ...snapshot, ahead: 1, changes: [] };
    });
    await expect(store.commit("message", true)).resolves.toBe(true);
    expect(store.error).toMatch(/Commit created, but push failed.*Retry Push/);
    expect(store.snapshot?.ahead).toBe(1);
    expect(store.actionId).toBeNull();
  });
  it("rejects duplicate submissions and does not push after leaving a workspace", async () => {
    const { store, setWorkspace } = fixture();
    await store.refresh();
    let finish!: () => void;
    invoke.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const pending = store.commit("first", true);
    await expect(store.commit("second", true)).resolves.toBe(false);
    setWorkspace("/two");
    finish();
    await expect(pending).resolves.toBe(true);
    expect(invoke.mock.calls.filter(([command]) => command === "git_commit")).toHaveLength(1);
    expect(invoke.mock.calls.some(([command]) => command === "git_push")).toBe(false);
    expect(store.error).toBeNull();
  });
  it("an old completion cannot unlock another operation after an A→B→A switch", async () => {
    const { store, setWorkspace } = fixture();
    await store.refresh();
    let finish!: () => void;
    invoke.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const pending = store.stage();
    setWorkspace("/two");
    setWorkspace("/one");
    store.beginLlmAction("review:all");
    finish();
    await expect(pending).resolves.toBe(false);
    expect(store.llmActionId).toBe("review:all");
  });
  it("blocks staging/committing during review and blocks push when remote state is unsafe", async () => {
    const { store, snapshot } = fixture();
    await store.refresh();
    store.beginLlmAction("review:all");
    await expect(store.stage()).resolves.toBe(false);
    await expect(store.commit("message")).resolves.toBe(false);
    store.finishLlmAction("review:all");
    snapshot.remotes.length = 0;
    await store.refresh();
    await expect(store.commit("message", true)).resolves.toBe(false);
    expect(store.error).toMatch(/remote/);
    await expect(store.commit("message")).resolves.toBe(true);
  });
});

describe("Git review checkpoints and secondary operations", () => {
  it("retains a review when inspecting another file or closing the editor", async () => {
    const { store } = fixture();
    const reviewed = { scope: "staged" as const, content: "+new", truncated: false };
    store.showDiff(reviewed);
    store.setReview("finding", reviewed);
    store.showDiff({ ...reviewed, path: "other.ts" });
    expect(store.diffReview).toBeUndefined();
    expect(store.reviewResult?.text).toBe("finding");
    store.closeDiff();
    store.showReview();
    expect(store.diffReview).toBe("finding");
    await store.stage();
    expect(store.reviewResult?.stale).toBe(true);
  });
  it("checks diff content on refresh, even when filenames/counts did not change", async () => {
    const { store } = fixture();
    store.setReview("finding", { scope: "staged", content: "+old", truncated: false });
    await store.refresh();
    expect(store.reviewResult?.stale).toBe(true);
  });
  it("requires confirmation for discard and does not send a canceled mutation", async () => {
    const { store } = fixture();
    vi.mocked(window.confirm).mockReturnValue(false);
    await expect(store.repositoryAction("discard", "file.ts")).resolves.toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    await expect(store.repositoryAction("discard")).resolves.toBe(false);
  });
  it("ignores stale repository-details results after a workspace switch", async () => {
    const { store, setWorkspace } = fixture();
    let finish!: (value: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = store.loadDetails();
    setWorkspace("/two");
    finish([{ hash: "old" }]);
    await pending;
    expect(store.details).toBeNull();
    expect(store.detailsLoading).toBe(false);
  });
});
