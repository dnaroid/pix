import { invoke } from "@tauri-apps/api/core";
import type { GitDiff, GitDiffScope, GitSnapshot } from "../lib/git";
import { sameGitDiff, gitPushBlockedReason, type GitRepositoryAction, type GitRepositoryDetails, type GitHistoryEntry, type GitStashEntry, type GitReviewResult } from "../lib/git-workflow";
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
  let statusBranch = $state<string | undefined>(undefined);
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
  let statusBranchGeneration = 0;

  function reset(): void {
    generation += 1;
    detailsGeneration += 1;
    loadGeneration += 1;
    statusBranchGeneration += 1;
    snapshot = undefined;
    options.onSnapshotChange?.(undefined);
    uninitialized = false;
    statusBranch = undefined;
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

  async function refresh(): Promise<void> {
    const workspace = options.workspace();
    if (!workspace) return;
    const requestGeneration = ++loadGeneration;
    loading = true;
    error = null;
    try {
      const next = await invoke<GitSnapshot>("git_status", { workspace });
      if (requestGeneration !== loadGeneration || options.workspace() !== workspace) return;
      snapshot = next;
      options.onSnapshotChange?.(next);
      uninitialized = false;
      statusBranchGeneration += 1;
      statusBranch = next.detached || next.branch === "HEAD" ? undefined : next.branch;
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

  async function refreshStatusBranch(): Promise<void> {
    const workspace = options.workspace();
    if (!workspace) {
      statusBranchGeneration += 1;
      statusBranch = undefined;
      return;
    }
    const generation = ++statusBranchGeneration;
    try {
      const branch = await invoke<string | null>("git_current_branch", { workspace });
      if (generation !== statusBranchGeneration || options.workspace() !== workspace) return;
      statusBranch = branch?.trim() || undefined;
    } catch {
      if (generation !== statusBranchGeneration || options.workspace() !== workspace) return;
      statusBranch = undefined;
    }
  }

  async function runMutation(
    nextActionId: string,
    command: string,
    payload: Record<string, unknown> = {},
    mutationOptions: { reloadProject?: boolean; success?: string } = {},
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
      await invoke(command, { workspace, ...payload });
      if (!current()) return false;
      if (command !== "git_fetch" && command !== "git_push") invalidateReview();
      if (mutationOptions.reloadProject) {
        closeDiff();
        await options.reloadProject(workspace);
      }
      await refresh();
      if (!current()) return false;
      notice = mutationOptions.success ?? null;
      if (details) void loadDetails();
      return true;
    } catch (reason) {
      if (current()) {
        const detail = reason instanceof Error ? reason.message : String(reason);
        // Failed pull/stash apply can still have changed refs or produced conflicts.
        invalidateReview();
        await refresh();
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
    const workspace = options.workspace();
    const requestGeneration = generation;
    const current = () => options.workspace() === workspace && generation === requestGeneration;
    if (!workspace || !message.trim() || actionId || llmActionId || resolveRunning) return false;
    if (snapshot?.changes.some((change) => change.conflicted)) {
      error = "Resolve merge conflicts before committing";
      return false;
    }
    if (pushAfterCommit && gitPushBlockedReason(snapshot)) {
      error = gitPushBlockedReason(snapshot);
      return false;
    }
    let committed = false;
    actionId = "commit";
    error = null;
    notice = null;
    try {
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
        await refresh();
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
      fetch: "git_fetch", pull: "git_pull", "stash-save": "git_stash_save",
      "stash-apply": "git_stash_apply", discard: "git_discard_file",
    } as const;
    const success = {
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
    get statusBranch() { return statusBranch; },
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
    refreshStatusBranch,
    runMutation,
    stage,
    unstage,
    commit,
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
