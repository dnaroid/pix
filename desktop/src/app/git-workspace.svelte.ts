import { invoke } from "@tauri-apps/api/core";
import type { GitDiff, GitDiffScope, GitSnapshot } from "../lib/git";
import { sameGitDiff, gitPushBlockedReason, gitStageGenerateCommitPushBlockedReason, gitUpdateNotice, type GitUpdateResult, type GitRepositoryAction, type GitRepositoryDetails, type GitHistoryEntry, type GitStashEntry, type GitReviewResult } from "../lib/git-workflow";
import type { WorkbenchTabId } from "../lib/workbench-tabs";

type GitWorkspaceStoreOptions = {
  workspace: () => string;
  onSnapshotChange?: (snapshot: GitSnapshot | undefined) => void;
  previewDirty: () => boolean;
  reloadProject: (workspace: string) => Promise<void>;
  activeWorkbenchTabId: () => WorkbenchTabId | null;
  activeConversationWorkbenchTabId: () => WorkbenchTabId | null;
  setActiveWorkbenchTabId: (id: WorkbenchTabId | null) => void;
  nextWorkbenchAuxOrder: () => number;
};

type GitRepositoryState = {
  initialized: boolean;
  repositoryRoot?: string;
};

export function createGitWorkspaceStore(options: GitWorkspaceStoreOptions) {
  let snapshot = $state<GitSnapshot | undefined>(undefined);
  let uninitialized = $state(false);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let actionId = $state<string | null>(null);
  let llmActionId = $state<string | null>(null);
  let resolveRunning = $state(false);
  let diffPreview = $state<GitDiff | null>(null);
  let reviewResult = $state<GitReviewResult | null>(null);
  let notice = $state<string | null>(null);
  let details = $state<GitRepositoryDetails | null>(null);
  let detailsLoading = $state(false);
  let detailsGeneration = 0;
  let generation = 0;
  let workbenchAnchorId = $state<WorkbenchTabId | null>(null);
  let workbenchOpenedOrder = $state(0);
  let loadGeneration = 0;
  let pendingRefresh: Promise<void> | null = null;

  function reset(): void {
    generation += 1;
    detailsGeneration += 1;
    loadGeneration += 1;
    pendingRefresh = null;
    snapshot = undefined;
    options.onSnapshotChange?.(undefined);
    uninitialized = false;
    loading = false;
    error = null;
    actionId = null;
    llmActionId = null;
    resolveRunning = false;
    reviewResult = null;
    notice = null;
    details = null;
    detailsLoading = false;
    closeDiff();
  }

  function refresh(): Promise<void> {
    if (pendingRefresh) return pendingRefresh;
    const workspace = options.workspace();
    if (!workspace) return Promise.resolve();
    const request = loadStatus(workspace).finally(() => {
      if (pendingRefresh === request) pendingRefresh = null;
    });
    pendingRefresh = request;
    return request;
  }

  // A mutation checkpoint must not reuse a read started before that checkpoint.
  // Panel/background readers can share the new read without superseding it.
  async function refreshFresh(): Promise<void> {
    const workspace = options.workspace();
    const requestGeneration = generation;
    await pendingRefresh;
    if (generation !== requestGeneration || options.workspace() !== workspace) return;
    await refresh();
  }

  async function loadStatus(workspace: string): Promise<void> {
    const requestGeneration = ++loadGeneration;
    loading = true;
    error = null;
    try {
      const next = await invoke<GitSnapshot>("git_status", { workspace });
      if (requestGeneration !== loadGeneration || options.workspace() !== workspace) return;
      snapshot = next;
      options.onSnapshotChange?.(next);
      uninitialized = false;
      const review = reviewResult;
      if (review && !review.stale && llmActionId === null) {
        const current = await requestDiff(review.diff.path, review.diff.scope);
        if (requestGeneration === loadGeneration && reviewResult === review && (!current || !sameGitDiff(current, review.diff))) {
          reviewResult = { ...review, stale: true };
        }
      }
    } catch (reason) {
      if (requestGeneration !== loadGeneration || options.workspace() !== workspace) return;
      const detail = reason instanceof Error ? reason.message : String(reason);
      const repositoryState = await invoke<GitRepositoryState>("git_repository_state", { workspace }).catch(() => undefined);
      if (requestGeneration !== loadGeneration || options.workspace() !== workspace) return;
      snapshot = undefined;
      options.onSnapshotChange?.(undefined);
      uninitialized = repositoryState?.initialized === false && !repositoryState.repositoryRoot;
      error = uninitialized ? null : detail;
    } finally {
      if (requestGeneration === loadGeneration && options.workspace() === workspace) loading = false;
    }
  }

  /**
   * Refresh local status, then update remote refs so ahead/behind reflects the
   * current upstream state. This never pulls or changes working-tree files.
   */
  async function refreshRemoteStatus(): Promise<void> {
    await refresh();
    const current = snapshot;
    if (!current?.remotes.length) return;
    await runMutation("fetch", "git_fetch");
  }

  async function runMutation(
    nextActionId: string,
    command: string,
    payload: Record<string, unknown> = {},
    mutationOptions: { reloadProject?: boolean; success?: string | ((result: unknown) => string) } = {},
  ): Promise<boolean> {
    const workspace = options.workspace();
    const requestGeneration = generation;
    const current = () => options.workspace() === workspace && generation === requestGeneration;
    if (!workspace || actionId !== null || llmActionId !== null || resolveRunning) return false;
    if (
      mutationOptions.reloadProject
      && options.previewDirty()
      && !window.confirm("Discard unsaved Preview changes and reload the project?")
    ) return false;
    actionId = nextActionId;
    error = null;
    notice = null;
    try {
      const result = await invoke<unknown>(command, { workspace, ...payload });
      if (!current()) return false;
      if (command !== "git_fetch" && command !== "git_push") invalidateReview();
      if (mutationOptions.reloadProject) {
        closeDiff();
        await options.reloadProject(workspace);
      }
      await refreshFresh();
      if (!current()) return false;
      notice = typeof mutationOptions.success === "function"
        ? mutationOptions.success(result)
        : mutationOptions.success ?? null;
      if (details) void loadDetails();
      return true;
    } catch (reason) {
      if (current()) {
        const detail = reason instanceof Error ? reason.message : String(reason);
        // Failed pull/stash apply can still have changed refs or produced conflicts.
        invalidateReview();
        await refreshFresh();
        if (current()) error = detail;
      }
      return false;
    } finally {
      if (current() && actionId === nextActionId) actionId = null;
    }
  }

  function stage(path?: string): Promise<boolean> {
    return runMutation(path ? `stage:${path}` : "stage:all", "git_stage", { path: path ?? null });
  }

  function unstage(path?: string): void {
    void runMutation(path ? `unstage:${path}` : "unstage:all", "git_unstage", { path: path ?? null });
  }

  async function commit(message: string, pushAfterCommit = false): Promise<boolean> {
    return commitTransaction(message, pushAfterCommit);
  }

  function stageGenerateCommitPush(generate: (diff: GitDiff) => Promise<string | undefined>): Promise<boolean> {
    return commitTransaction("", true, generate);
  }

  async function commitTransaction(message: string, pushAfterCommit: boolean, generate?: (diff: GitDiff) => Promise<string | undefined>): Promise<boolean> {
    const workspace = options.workspace();
    const requestGeneration = generation;
    const current = () => options.workspace() === workspace && generation === requestGeneration;
    if (!workspace || (!generate && !message.trim()) || actionId || llmActionId || resolveRunning) return false;
    if (snapshot?.changes.some((change) => change.conflicted)) {
      error = "Resolve merge conflicts before committing";
      return false;
    }
    const pushBlocked = generate ? gitStageGenerateCommitPushBlockedReason(snapshot) : gitPushBlockedReason(snapshot);
    if (pushAfterCommit && pushBlocked) {
      error = pushBlocked;
      return false;
    }
    let committed = false;
    actionId = generate ? "stage-generate-commit-push" : "commit";
    error = null;
    notice = null;
    try {
      if (generate) {
        // One mutation lock spans staging, AI and commit, including awaited gaps.
        await refreshFresh();
        if (!current()) return false;
        if (loading || error || !snapshot) throw new Error(error ?? "A fresh Git status is required before staging.");
        const blocked = gitPushBlockedReason(snapshot);
        if (blocked || snapshot.changes.some((change) => change.conflicted)) {
          throw new Error(blocked ?? "Resolve merge conflicts before committing");
        }
        const preparedSnapshot = snapshot;
        await invoke("git_stage", { workspace, path: null });
        if (!current()) return false;
        invalidateReview();
        const diff = await requestDiff(undefined, "staged");
        if (!current()) return false;
        if (!diff?.content.trim()) throw new Error("There are no staged changes to describe.");
        const generated = await generate(diff);
        if (!current()) return false;
        if (!generated?.trim()) throw new Error("Commit message generation did not produce a message. Nothing was committed.");
        await refreshFresh();
        if (!current()) return false;
        if (loading || error || !snapshot) throw new Error(error ?? "A fresh Git status is required before committing.");
        if (snapshot.branch !== preparedSnapshot.branch || snapshot.head !== preparedSnapshot.head || snapshot.upstream !== preparedSnapshot.upstream
          || snapshot.remotes.join("\n") !== preparedSnapshot.remotes.join("\n")) {
          throw new Error("Git branch or publication target changed during generation. Nothing was committed; try again.");
        }
        const pushBlocked = gitPushBlockedReason(snapshot);
        if (pushBlocked || snapshot.changes.some((change) => change.conflicted)) {
          throw new Error(pushBlocked ?? "Resolve merge conflicts before committing");
        }
        const finalDiff = await requestDiff(undefined, "staged");
        if (!current()) return false;
        if (!finalDiff || !sameGitDiff(diff, finalDiff)) throw new Error("Staged changes changed during generation. Nothing was committed; try again.");
        message = generated;
        actionId = "commit";
      }
      await invoke("git_commit", { workspace, message });
      committed = true;
      if (!current()) return true;
      invalidateReview();
      if (pushAfterCommit) {
        actionId = "push";
        await invoke("git_push", { workspace });
      }
      if (current()) notice = pushAfterCommit ? "Committed and pushed successfully." : "Commit created locally. Ready to push.";
    } catch (reason) {
      if (current()) {
        const detail = reason instanceof Error ? reason.message : String(reason);
        error = committed ? `Commit created, but push failed. Retry Push; do not commit again. ${detail}` : detail;
      }
    } finally {
      if (current()) {
        const mutationError = error;
        await refreshFresh();
        if (current()) {
          if (mutationError) error = mutationError;
          actionId = null;
          if (details) void loadDetails();
        }
      }
    }
    // A failed push must not leave a message that invites a duplicate commit.
    return committed;
  }

  function push(): void {
    void runMutation("push", "git_push", {}, { success: "Branch pushed successfully." });
  }

  function initialize(): Promise<boolean> {
    return runMutation("init", "git_initialize", {}, { success: "Git repository initialized on main." });
  }

  function switchBranch(branch: string): void {
    void runMutation(`switch:${branch}`, "git_switch_branch", { branch }, { reloadProject: true });
  }

  function createBranch(branch: string): void {
    void runMutation(`create:${branch}`, "git_create_branch", { branch }, { reloadProject: true });
  }

  async function requestDiff(path: string | undefined, scope: GitDiffScope): Promise<GitDiff | undefined> {
    const workspace = options.workspace();
    const requestGeneration = generation;
    if (!workspace) return undefined;
    try {
      const diff = await invoke<GitDiff>("git_diff", {
        workspace,
        path: path ?? null,
        scope,
      });
      return options.workspace() === workspace && generation === requestGeneration ? diff : undefined;
    } catch (reason) {
      if (options.workspace() === workspace && generation === requestGeneration) error = reason instanceof Error ? reason.message : String(reason);
      return undefined;
    }
  }

  async function openDiff(path: string | undefined, scope: GitDiffScope): Promise<void> {
    if (actionId !== null) return;
    const nextActionId = `diff:${scope}:${path ?? "all"}`;
    const requestGeneration = generation;
    actionId = nextActionId;
    error = null;
    try {
      const diff = await requestDiff(path, scope);
      if (!diff) return;
      showDiff(diff);
    } finally {
      if (generation === requestGeneration && actionId === nextActionId) actionId = null;
    }
  }

  function showDiff(diff: GitDiff): void {
    if (!diffPreview) {
      workbenchAnchorId = options.activeWorkbenchTabId() ?? options.activeConversationWorkbenchTabId();
      workbenchOpenedOrder = options.nextWorkbenchAuxOrder();
    }
    diffPreview = diff;
    options.setActiveWorkbenchTabId("git-diff");
  }

  function closeDiff(): void {
    diffPreview = null;
    workbenchAnchorId = null;
    workbenchOpenedOrder = 0;
  }

  function retargetAnchor(sourceId: WorkbenchTabId, targetId: WorkbenchTabId | null): void {
    if (workbenchAnchorId === sourceId) workbenchAnchorId = targetId;
  }

  function beginLlmAction(id: string): boolean {
    if (llmActionId !== null || actionId !== null || resolveRunning) return false;
    llmActionId = id;
    error = null;
    return true;
  }

  function finishLlmAction(id: string, requestGeneration = generation): void {
    if (generation === requestGeneration && llmActionId === id) llmActionId = null;
  }

  function setError(message: string | null): void {
    error = message;
  }

  function setReview(review: string | undefined, diff = diffPreview): void {
    reviewResult = review && diff ? { diff, text: review, stale: false } : null;
  }

  function invalidateReview(): void {
    if (reviewResult) reviewResult = { ...reviewResult, stale: true };
  }

  function showReview(): void {
    if (reviewResult) showDiff(reviewResult.diff);
  }

  async function loadDetails(): Promise<void> {
    const workspace = options.workspace();
    const requestGeneration = generation;
    const request = ++detailsGeneration;
    if (!workspace) return;
    const current = () => workspace === options.workspace() && requestGeneration === generation && request === detailsGeneration;
    detailsLoading = true;
    try {
      const [history, stashes] = await Promise.all([
        invoke<GitHistoryEntry[]>("git_history", { workspace }),
        invoke<GitStashEntry[]>("git_stash_list", { workspace }),
      ]);
      if (current()) details = { history, stashes };
    } catch (reason) {
      if (current()) error = reason instanceof Error ? reason.message : String(reason);
    } finally {
      if (current()) detailsLoading = false;
    }
  }

  function repositoryAction(action: GitRepositoryAction, target?: string): Promise<boolean> {
    if ((action === "discard" || action === "stash-apply") && !target) return Promise.resolve(false);
    if (action === "discard" && !window.confirm(`Discard unstaged changes in ${target}?\n\nStaged changes are kept. This cannot be undone.`)) return Promise.resolve(false);
    const commands = {
      update: "git_update", fetch: "git_fetch", pull: "git_pull", "stash-save": "git_stash_save",
      "stash-apply": "git_stash_apply", discard: "git_discard_file",
    } as const;
    const success = {
      update: (result: unknown) => gitUpdateNotice(result as GitUpdateResult),
      fetch: "Remotes fetched.", pull: "Branch updated (fast-forward only).",
      "stash-save": "Changes saved to stash, including untracked files.",
      "stash-apply": "Stash restored. The saved stash is kept.", discard: "Unstaged changes discarded. Staged changes are kept.",
    } as const;
    return runMutation(action, commands[action], action === "discard" ? { path: target } : action === "stash-apply" ? { reference: target } : {}, {
      reloadProject: action !== "fetch", success: success[action],
    });
  }

  function setResolveRunning(running: boolean): void {
    resolveRunning = running;
  }

  return {
    get snapshot() { return snapshot; },
    get uninitialized() { return uninitialized; },
    get loading() { return loading; },
    get error() { return error; },
    get actionId() { return actionId; },
    get llmActionId() { return llmActionId; },
    get resolveRunning() { return resolveRunning; },
    get diffPreview() { return diffPreview; },
    get diffReview() { return sameGitDiff(reviewResult?.diff, diffPreview) ? reviewResult?.text : undefined; },
    get reviewResult() { return reviewResult; },
    get notice() { return notice; },
    get details() { return details; },
    get detailsLoading() { return detailsLoading; },
    get generation() { return generation; },
    get workbenchAnchorId() { return workbenchAnchorId; },
    get workbenchOpenedOrder() { return workbenchOpenedOrder; },
    reset,
    refresh,
    refreshRemoteStatus,
    runMutation,
    stage,
    unstage,
    commit,
    stageGenerateCommitPush,
    push,
    initialize,
    switchBranch,
    createBranch,
    requestDiff,
    openDiff,
    showDiff,
    closeDiff,
    retargetAnchor,
    beginLlmAction,
    finishLlmAction,
    setError,
    setReview,
    invalidateReview,
    showReview,
    loadDetails,
    repositoryAction,
    setResolveRunning,
  };
}
