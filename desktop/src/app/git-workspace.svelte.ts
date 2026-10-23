import { invoke } from "@tauri-apps/api/core";
import { confirmDesktopAction } from "../lib/confirm-action";
import type { GitDiff, GitDiffScope, GitSnapshot } from "../lib/git";
import { sameGitSnapshot } from "../lib/git-snapshot";
import { sameGitDiff, gitPushBlockedReason, gitStageGenerateCommitPushBlockedReason, gitUpdateNotice, type GitUpdateResult, type GitRepositoryAction, type GitRepositoryDetails, type GitHistoryEntry, type GitCommitDiff, type GitStashEntry, type GitReviewResult } from "../lib/git-workflow";
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
  /** One-shot success results are shown as toasts, not inline panel state. */
  notify?: (message: string) => void;
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
  let details = $state<GitRepositoryDetails | null>(null);
  let detailsLoading = $state(false);
  let detailsGeneration = 0;
  let generation = 0;
  let diffSelectionVersion = 0;
  let workbenchAnchorId = $state<WorkbenchTabId | null>(null);
  let workbenchOpenedOrder = $state(0);
  let loadGeneration = 0;
  let pendingRefresh: Promise<void> | null = null;
  let pendingRefreshIncludesLineStats = true;
  // Last successful remote-ref update per workspace (fetch/pull/update/push).
  const remoteCheckedAt = new Map<string, number>();
  const REMOTE_REF_COMMANDS = new Set(["git_fetch", "git_pull", "git_update", "git_push"]);

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
    details = null;
    detailsLoading = false;
    closeDiff();
  }

  function refresh(includeLineStats = true): Promise<void> {
    if (pendingRefresh) {
      if (!includeLineStats || pendingRefreshIncludesLineStats) return pendingRefresh;
      // A panel/safety checkpoint must not settle for an Explorer-only read.
      const workspace = options.workspace();
      const requestGeneration = generation;
      return pendingRefresh.then(() => {
        if (generation !== requestGeneration || options.workspace() !== workspace) return;
        return refresh();
      });
    }
    const workspace = options.workspace();
    if (!workspace) return Promise.resolve();
    pendingRefreshIncludesLineStats = includeLineStats;
    const request = loadStatus(workspace, includeLineStats).finally(() => {
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

  async function loadStatus(workspace: string, includeLineStats: boolean): Promise<void> {
    const requestGeneration = ++loadGeneration;
    // Bootstrap repository metadata once. Explorer subsequently needs only
    // porcelain status; panel reads and mutation checkpoints always read all.
    const previous = snapshot;
    const includeRepositoryDetails = includeLineStats || !previous;
    loading = true;
    error = null;
    try {
      let next = await invoke<GitSnapshot>("git_status", {
        workspace,
        ...(!includeLineStats ? { includeLineStats: false } : {}),
        ...(!includeRepositoryDetails ? { includeRepositoryDetails: false } : {}),
      });
      if (requestGeneration !== loadGeneration || options.workspace() !== workspace) return;
      if (!includeRepositoryDetails && previous) {
        if (next.branch !== previous.branch || next.upstream !== previous.upstream) {
          // External branch/upstream switches need fresh branch/remote metadata.
          next = await invoke<GitSnapshot>("git_status", { workspace, includeLineStats: false });
          if (requestGeneration !== loadGeneration || options.workspace() !== workspace) return;
        } else next = { ...next, branches: previous.branches, remotes: previous.remotes };
      }
      if (!sameGitSnapshot(snapshot, next)) {
        snapshot = next;
        options.onSnapshotChange?.(next);
      }
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
  async function refreshRemoteStatus(refreshOptions: { maxAgeMs?: number } = {}): Promise<void> {
    const workspace = options.workspace();
    await refresh();
    const current = snapshot;
    if (!current?.remotes.length) return;
    // Opening the panel must not pay a network round-trip every time; an
    // explicit refresh (no maxAgeMs) always checks the remotes.
    const last = remoteCheckedAt.get(workspace);
    if (refreshOptions.maxAgeMs !== undefined && last !== undefined && Date.now() - last < refreshOptions.maxAgeMs) return;
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
      && !await confirmDesktopAction("Discard unsaved Preview changes and reload the project?")
    ) return false;
    if (!current() || actionId !== null || llmActionId !== null || resolveRunning) return false;
    actionId = nextActionId;
    error = null;
    try {
      const result = await invoke<unknown>(command, { workspace, ...payload });
      if (REMOTE_REF_COMMANDS.has(command)) remoteCheckedAt.set(workspace, Date.now());
      if (!current()) return false;
      if (command !== "git_fetch" && command !== "git_push" && command !== "git_save_identity") invalidateReview();
      if (mutationOptions.reloadProject) {
        closeDiff();
        await options.reloadProject(workspace);
      }
      await refreshFresh();
      if (!current()) return false;
      const success = typeof mutationOptions.success === "function"
        ? mutationOptions.success(result)
        : mutationOptions.success;
      if (success) options.notify?.(success);
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

  function stageGenerateCommitPush(generate: (diff: GitDiff) => Promise<string | undefined>, pushAfterCommit = true): Promise<boolean> {
    return commitTransaction("", pushAfterCommit, generate);
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
    const preparationAction = pushAfterCommit ? "stage-generate-commit-push" : "stage-generate-commit";
    actionId = generate ? preparationAction : "commit";
    error = null;
    try {
      if (generate) {
        // One mutation lock spans staging, AI and commit, including awaited gaps.
        await refreshFresh();
        if (!current()) return false;
        if (loading || error || !snapshot) throw new Error(error ?? "A fresh Git status is required before staging.");
        const blocked = pushAfterCommit ? gitPushBlockedReason(snapshot) : null;
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
        const pushBlocked = pushAfterCommit ? gitPushBlockedReason(snapshot) : null;
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
      if (current()) options.notify?.(pushAfterCommit ? "Committed and pushed successfully." : "Commit created locally.");
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
    const selectionVersion = ++diffSelectionVersion;
    const nextActionId = `diff:${scope}:${path ?? "all"}`;
    const requestGeneration = generation;
    actionId = nextActionId;
    error = null;
    try {
      const diff = await requestDiff(path, scope);
      if (!diff || selectionVersion !== diffSelectionVersion || generation !== requestGeneration) return;
      showDiff(diff);
    } finally {
      if (generation === requestGeneration && actionId === nextActionId) actionId = null;
    }
  }

  /** Open an exact, immutable commit patch without refreshing or altering HEAD. */
  async function openCommitDiff(hash: string, isCurrent: () => boolean = () => true): Promise<boolean> {
    const workspace = options.workspace();
    if (!workspace) throw new Error("Open a Git project to view this commit.");
    const requestGeneration = generation;
    const selectionVersion = ++diffSelectionVersion;
    const current = () => isCurrent() && generation === requestGeneration
      && options.workspace() === workspace && diffSelectionVersion === selectionVersion;
    try {
      const result = await invoke<GitCommitDiff>("git_commit_diff", { workspace, hash });
      if (!current()) return false;
      showDiff({
        scope: "all", content: result.content, truncated: result.truncated, commit: result.commit,
      });
      return true;
    } catch (reason) {
      if (!current()) return false;
      throw new Error(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function showDiff(diff: GitDiff): void {
    // A manually selected working-tree/review diff supersedes any still
    // pending historical commit request from search or the Git Log.
    diffSelectionVersion++;
    if (!diffPreview) {
      workbenchAnchorId = options.activeWorkbenchTabId() ?? options.activeConversationWorkbenchTabId();
      workbenchOpenedOrder = options.nextWorkbenchAuxOrder();
    }
    diffPreview = diff;
    options.setActiveWorkbenchTabId("git-diff");
  }

  function closeDiff(): void {
    diffSelectionVersion += 1;
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

  async function repositoryAction(action: GitRepositoryAction, target?: string): Promise<boolean> {
    if ((action === "discard" || action === "stash-apply") && !target) return Promise.resolve(false);
    const requestWorkspace = options.workspace(), requestGeneration = generation;
    if (action === "discard" && !await confirmDesktopAction(
      `Discard unstaged changes in ${target}?\n\nStaged changes are kept. This cannot be undone.`,
      { title: "Discard changes?", okLabel: "Discard" },
    )) return false;
    if (options.workspace() !== requestWorkspace || generation !== requestGeneration) return false;
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
    get details() { return details; },
    get detailsLoading() { return detailsLoading; },
    get generation() { return generation; },
    get workbenchAnchorId() { return workbenchAnchorId; },
    get workbenchOpenedOrder() { return workbenchOpenedOrder; },
    reset,
    refresh,
    refreshExplorer: () => refresh(false),
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
    openCommitDiff,
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
    saveIdentity: (name: string, email: string) => runMutation("save-identity", "git_save_identity", { name, email }, { success: "Commit author saved for this repository." }),
    setResolveRunning,
  };
}
