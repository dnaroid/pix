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
  it("shares the transaction status read with a concurrent panel refresh", async () => {
    const { store, snapshot } = fixture();
    await store.refresh();
    let finishStatus!: (value: GitSnapshot) => void;
    invoke.mockImplementationOnce(() => new Promise<GitSnapshot>((resolve) => { finishStatus = resolve; }));
    const generate = vi.fn(async () => "AI message");
    const transaction = store.stageGenerateCommitPush(generate);
    await vi.waitFor(() => expect(finishStatus).toBeTypeOf("function"));
    const panelRefresh = store.refresh();
    expect(invoke.mock.calls.filter(([command]) => command === "git_status")).toHaveLength(2);
    expect(invoke.mock.calls.some(([command]) => command === "git_stage")).toBe(false);
    finishStatus(snapshot);
    await panelRefresh;
    await expect(transaction).resolves.toBe(true);
    expect(generate).toHaveBeenCalledOnce();
    expect(store.error).toBeNull();
  });

  it("waits for an older panel read then starts a new pre-staging checkpoint", async () => {
    const { store, snapshot } = fixture();
    await store.refresh();
    let finishStatus!: (value: GitSnapshot) => void;
    invoke.mockImplementationOnce(() => new Promise<GitSnapshot>((resolve) => { finishStatus = resolve; }));
    const panelRefresh = store.refresh();
    // The old read captured a safe state, but incoming commits now block staging.
    invoke.mockImplementation(async (command: string) => command === "git_status" ? { ...snapshot, behind: 1 } : undefined);
    const generate = vi.fn(async () => "AI message");
    const transaction = store.stageGenerateCommitPush(generate);
    expect(invoke.mock.calls.filter(([command]) => command === "git_status")).toHaveLength(2);
    finishStatus(snapshot);
    await panelRefresh;
    await expect(transaction).resolves.toBe(false);
    expect(invoke.mock.calls.some(([command]) => command === "git_stage")).toBe(false);
    expect(generate).not.toHaveBeenCalled();
    expect(store.snapshot?.behind).toBe(1);
  });

  it("does not reuse a status read begun during AI generation for the commit checkpoint", async () => {
    const { store, snapshot } = fixture();
    await store.refresh();
    let finishGeneration!: (value: string) => void;
    const generate = vi.fn(() => new Promise<string>((resolve) => { finishGeneration = resolve; }));
    const transaction = store.stageGenerateCommitPush(generate);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    let finishStatus!: (value: GitSnapshot) => void;
    invoke.mockImplementationOnce(() => new Promise<GitSnapshot>((resolve) => { finishStatus = resolve; }));
    const panelRefresh = store.refresh();
    invoke.mockImplementation(async (command: string) => command === "git_status" ? { ...snapshot, head: "changed" } : undefined);
    finishGeneration("AI message");
    finishStatus(snapshot);
    await panelRefresh;
    await expect(transaction).resolves.toBe(false);
    expect(store.error).toMatch(/publication target changed/);
    expect(invoke.mock.calls.some(([command]) => command === "git_commit" || command === "git_push")).toBe(false);
  });

  it("does not let an old refresh clear or replace a new lifecycle's pending read", async () => {
    const { store, snapshot, setWorkspace } = fixture();
    let finishOld!: (value: GitSnapshot) => void;
    invoke.mockImplementationOnce(() => new Promise<GitSnapshot>((resolve) => { finishOld = resolve; }));
    const oldRefresh = store.refresh();
    setWorkspace("/two");
    setWorkspace("/one");
    let finishNew!: (value: GitSnapshot) => void;
    invoke.mockImplementationOnce(() => new Promise<GitSnapshot>((resolve) => { finishNew = resolve; }));
    const newRefresh = store.refresh();
    finishOld({ ...snapshot, head: "stale" });
    await oldRefresh;
    expect(store.snapshot).toBeUndefined();
    expect(store.loading).toBe(true);
    const joined = store.refresh();
    expect(invoke.mock.calls).toHaveLength(2);
    finishNew(snapshot);
    await Promise.all([newRefresh, joined]);
    expect(store.snapshot?.head).toBe("abc");
    expect(store.loading).toBe(false);
  });

  it("stages all, generates, commits and pushes under one lock", async () => {
    const { store } = fixture();
    await store.refresh();
    const generate = vi.fn(async () => {
      expect(store.actionId).toBe("stage-generate-commit-push");
      await expect(store.stage("other.ts")).resolves.toBe(false);
      await expect(store.commit("duplicate", true)).resolves.toBe(false);
      return "AI message";
    });
    await expect(store.stageGenerateCommitPush(generate)).resolves.toBe(true);
    const mutations = invoke.mock.calls.filter(([command]) => ["git_stage", "git_commit", "git_push"].includes(command));
    expect(mutations).toEqual([
      ["git_stage", { workspace: "/one", path: null }],
      ["git_commit", { workspace: "/one", message: "AI message" }],
      ["git_push", { workspace: "/one" }],
    ]);
    expect(generate).toHaveBeenCalledOnce();
    expect(store.notice).toMatch(/Committed and pushed/);
    expect(store.actionId).toBeNull();
  });

  it("runs from a cold store without opening or refreshing the Git panel first", async () => {
    const { store } = fixture();
    expect(store.snapshot).toBeUndefined();
    const generate = vi.fn(async () => "AI message");
    await expect(store.stageGenerateCommitPush(generate)).resolves.toBe(true);
    expect(invoke.mock.calls[0]).toEqual(["git_status", { workspace: "/one" }]);
    expect(invoke.mock.calls.filter(([command]) => ["git_stage", "git_commit", "git_push"].includes(command)).map(([command]) => command))
      .toEqual(["git_stage", "git_commit", "git_push"]);
    expect(generate).toHaveBeenCalledOnce();
  });

  it.each(["status", "behind", "conflict", "remote", "detached", "ambiguous"])("checks cold-store %s safety before staging", async (state) => {
    const { store, snapshot } = fixture();
    invoke.mockImplementation(async (command: string) => {
      if (command === "git_status") {
        if (state === "status") throw new Error("status unavailable");
        return {
          ...snapshot,
          behind: state === "behind" ? 1 : 0,
          detached: state === "detached",
          upstream: state === "ambiguous" ? undefined : snapshot.upstream,
          remotes: state === "remote" ? [] : state === "ambiguous" ? ["one", "two"] : snapshot.remotes,
          changes: snapshot.changes.map((change) => ({ ...change, conflicted: state === "conflict" })),
        };
      }
    });
    const generate = vi.fn();
    await expect(store.stageGenerateCommitPush(generate)).resolves.toBe(false);
    expect(store.error).toBeTruthy();
    expect(generate).not.toHaveBeenCalled();
    expect(invoke.mock.calls.some(([command]) => ["git_stage", "git_commit", "git_push"].includes(command))).toBe(false);
  });

  it.each(["stage", "generation", "empty", "diff", "commit", "push"])("stops combined workflow safely on %s failure", async (failure) => {
    const { store, snapshot } = fixture();
    await store.refresh();
    let diffs = 0;
    invoke.mockImplementation(async (command: string) => {
      if (command === "git_status") return snapshot;
      if (command === "git_stage" && failure === "stage") throw new Error("stage failed");
      if (command === "git_commit" && failure === "commit") throw new Error("commit failed");
      if (command === "git_push" && failure === "push") throw new Error("push failed");
      if (command === "git_diff") return { scope: "staged", content: failure === "diff" && ++diffs > 1 ? "+changed" : "+new", truncated: false };
    });
    const generate = vi.fn(async () => {
      if (failure === "generation") throw new Error("AI failed");
      return failure === "empty" ? " " : "message";
    });
    await expect(store.stageGenerateCommitPush(generate)).resolves.toBe(failure === "push");
    expect(store.error).toBeTruthy();
    expect(store.actionId).toBeNull();
    expect(invoke.mock.calls.some(([command]) => command === "git_push")).toBe(failure === "push");
    if (["stage", "generation", "empty", "diff"].includes(failure)) expect(invoke.mock.calls.some(([command]) => command === "git_commit")).toBe(false);
    if (failure === "stage") expect(generate).not.toHaveBeenCalled();
    if (failure === "push") expect(store.error).toMatch(/Retry Push/);
  });

  it("rejects stale AI after an A→B→A switch without releasing a new lock", async () => {
    const { store, setWorkspace } = fixture();
    await store.refresh();
    let finish!: (message: string) => void;
    const generate = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const pending = store.stageGenerateCommitPush(generate);
    await vi.waitFor(() => expect(generate).toHaveBeenCalled());
    setWorkspace("/two");
    setWorkspace("/one");
    expect(store.beginLlmAction("new")).toBe(true);
    finish("old message");
    await expect(pending).resolves.toBe(false);
    expect(store.llmActionId).toBe("new");
    expect(invoke.mock.calls.some(([command]) => command === "git_commit" || command === "git_push")).toBe(false);
  });

  it.each(["behind", "conflict", "remote"])("does not stage for unsafe %s state", async (state) => {
    const { store, snapshot } = fixture();
    invoke.mockImplementation(async (command: string) => command === "git_status" ? {
      ...snapshot,
      behind: state === "behind" ? 1 : 0,
      remotes: state === "remote" ? [] : snapshot.remotes,
      changes: snapshot.changes.map((change) => ({ ...change, conflicted: state === "conflict" })),
    } : undefined);
    await store.refresh();
    await expect(store.stageGenerateCommitPush(vi.fn())).resolves.toBe(false);
    expect(invoke.mock.calls.some(([command]) => command === "git_stage")).toBe(false);
  });

  it.each(["status", "branch", "head", "upstream", "behind", "conflict"])("aborts before commit when %s changes during generation", async (state) => {
    const { store, snapshot } = fixture();
    await store.refresh();
    let generated = false;
    invoke.mockImplementation(async (command: string) => {
      if (command === "git_status") {
        if (generated && state === "status") throw new Error("status unavailable");
        return generated ? {
          ...snapshot,
          branch: state === "branch" ? "other" : snapshot.branch,
          head: state === "head" ? "changed-head" : snapshot.head,
          upstream: state === "upstream" ? "origin/other" : snapshot.upstream,
          behind: state === "behind" ? 1 : snapshot.behind,
          changes: snapshot.changes.map((change) => ({ ...change, conflicted: state === "conflict" })),
        } : snapshot;
      }
      if (command === "git_diff") return { scope: "staged", content: "+new", truncated: false };
    });
    await expect(store.stageGenerateCommitPush(async () => { generated = true; return "message"; })).resolves.toBe(false);
    expect(store.error).toBeTruthy();
    expect(invoke.mock.calls.some(([command]) => command === "git_commit" || command === "git_push")).toBe(false);
  });

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
  it("fetches remotes before reporting current incoming commits", async () => {
    const { store, snapshot } = fixture();
    let fetched = false;
    invoke.mockImplementation(async (command: string) => {
      if (command === "git_fetch") {
        fetched = true;
        return undefined;
      }
      if (command === "git_status") return { ...snapshot, behind: fetched ? 2 : 0 };
      if (command === "git_diff") return { scope: "staged", content: "+new", truncated: false };
      if (command === "git_history" || command === "git_stash_list") return [];
    });

    await store.refreshRemoteStatus();

    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["git_status", "git_fetch", "git_status"]);
    expect(store.snapshot?.behind).toBe(2);
    expect(store.notice).toBeNull();
  });

  it("skips remote fetch when no Git remote is configured", async () => {
    const { store, snapshot } = fixture();
    snapshot.remotes.length = 0;

    await store.refreshRemoteStatus();

    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["git_status"]);
  });

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
