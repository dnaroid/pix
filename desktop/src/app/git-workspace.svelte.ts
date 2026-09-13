import { invoke } from "@tauri-apps/api/core";
import type { GitDiff, GitDiffScope, GitSnapshot } from "../lib/git";
import type { WorkbenchTabId } from "../lib/workbench-tabs";

type GitWorkspaceStoreOptions = {
  workspace: () => string;
  previewDirty: () => boolean;
  reloadProject: (workspace: string) => Promise<void>;
  activeWorkbenchTabId: () => WorkbenchTabId | null;
  activeConversationWorkbenchTabId: () => WorkbenchTabId | null;
  setActiveWorkbenchTabId: (id: WorkbenchTabId | null) => void;
  nextWorkbenchAuxOrder: () => number;
};

export function createGitWorkspaceStore(options: GitWorkspaceStoreOptions) {
  let snapshot = $state<GitSnapshot | undefined>(undefined);
  let statusBranch = $state<string | undefined>(undefined);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let actionId = $state<string | null>(null);
  let llmActionId = $state<string | null>(null);
  let resolveRunning = $state(false);
  let diffPreview = $state<GitDiff | null>(null);
  let diffReview = $state<string | undefined>(undefined);
  let workbenchAnchorId = $state<WorkbenchTabId | null>(null);
  let workbenchOpenedOrder = $state(0);
  let loadGeneration = 0;
  let statusBranchGeneration = 0;

  function reset(): void {
    loadGeneration += 1;
    statusBranchGeneration += 1;
    snapshot = undefined;
    statusBranch = undefined;
    loading = false;
    error = null;
    actionId = null;
    llmActionId = null;
    resolveRunning = false;
    closeDiff();
  }

  async function refresh(): Promise<void> {
    const workspace = options.workspace();
    if (!workspace) return;
    const generation = ++loadGeneration;
    loading = true;
    error = null;
    try {
      const next = await invoke<GitSnapshot>("git_status", { workspace });
      if (generation !== loadGeneration || options.workspace() !== workspace) return;
      snapshot = next;
      statusBranchGeneration += 1;
      statusBranch = next.detached || next.branch === "HEAD" ? undefined : next.branch;
    } catch (reason) {
      if (generation !== loadGeneration || options.workspace() !== workspace) return;
      snapshot = undefined;
      error = reason instanceof Error ? reason.message : String(reason);
    } finally {
      if (generation === loadGeneration && options.workspace() === workspace) loading = false;
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
    mutationOptions: { reloadProject?: boolean } = {},
  ): Promise<boolean> {
    const workspace = options.workspace();
    if (!workspace || actionId !== null) return false;
    if (
      mutationOptions.reloadProject
      && options.previewDirty()
      && !window.confirm("Discard unsaved Preview changes and reload the project?")
    ) return false;
    actionId = nextActionId;
    error = null;
    try {
      await invoke(command, { workspace, ...payload });
      if (options.workspace() !== workspace) return false;
      if (mutationOptions.reloadProject) {
        closeDiff();
        await options.reloadProject(workspace);
      }
      await refresh();
      return options.workspace() === workspace;
    } catch (reason) {
      if (options.workspace() === workspace) error = reason instanceof Error ? reason.message : String(reason);
      return false;
    } finally {
      if (options.workspace() === workspace && actionId === nextActionId) actionId = null;
    }
  }

  function stage(path?: string): void {
    void runMutation(path ? `stage:${path}` : "stage:all", "git_stage", { path: path ?? null });
  }

  function unstage(path?: string): void {
    void runMutation(path ? `unstage:${path}` : "unstage:all", "git_unstage", { path: path ?? null });
  }

  async function commit(message: string): Promise<boolean> {
    return runMutation("commit", "git_commit", { message });
  }

  function push(): void {
    void runMutation("push", "git_push");
  }

  function switchBranch(branch: string): void {
    void runMutation(`switch:${branch}`, "git_switch_branch", { branch }, { reloadProject: true });
  }

  function createBranch(branch: string): void {
    void runMutation(`create:${branch}`, "git_create_branch", { branch }, { reloadProject: true });
  }

  async function requestDiff(path: string | undefined, scope: GitDiffScope): Promise<GitDiff | undefined> {
    const workspace = options.workspace();
    if (!workspace) return undefined;
    try {
      const diff = await invoke<GitDiff>("git_diff", {
        workspace,
        path: path ?? null,
        scope,
      });
      return options.workspace() === workspace ? diff : undefined;
    } catch (reason) {
      if (options.workspace() === workspace) error = reason instanceof Error ? reason.message : String(reason);
      return undefined;
    }
  }

  async function openDiff(path: string | undefined, scope: GitDiffScope): Promise<void> {
    if (actionId !== null) return;
    const nextActionId = `diff:${scope}:${path ?? "all"}`;
    actionId = nextActionId;
    error = null;
    try {
      const diff = await requestDiff(path, scope);
      if (!diff) return;
      showDiff(diff);
    } finally {
      if (actionId === nextActionId) actionId = null;
    }
  }

  function showDiff(diff: GitDiff): void {
    if (!diffPreview) {
      workbenchAnchorId = options.activeWorkbenchTabId() ?? options.activeConversationWorkbenchTabId();
      workbenchOpenedOrder = options.nextWorkbenchAuxOrder();
    }
    diffPreview = diff;
    diffReview = undefined;
    options.setActiveWorkbenchTabId("git-diff");
  }

  function closeDiff(): void {
    diffPreview = null;
    diffReview = undefined;
    workbenchAnchorId = null;
    workbenchOpenedOrder = 0;
  }

  function retargetAnchor(sourceId: WorkbenchTabId, targetId: WorkbenchTabId | null): void {
    if (workbenchAnchorId === sourceId) workbenchAnchorId = targetId;
  }

  function beginLlmAction(id: string): boolean {
    if (llmActionId !== null) return false;
    llmActionId = id;
    error = null;
    return true;
  }

  function finishLlmAction(id: string): void {
    if (llmActionId === id) llmActionId = null;
  }

  function setError(message: string | null): void {
    error = message;
  }

  function setReview(review: string | undefined): void {
    diffReview = review;
  }

  function setResolveRunning(running: boolean): void {
    resolveRunning = running;
  }

  return {
    get snapshot() { return snapshot; },
    get statusBranch() { return statusBranch; },
    get loading() { return loading; },
    get error() { return error; },
    get actionId() { return actionId; },
    get llmActionId() { return llmActionId; },
    get resolveRunning() { return resolveRunning; },
    get diffPreview() { return diffPreview; },
    get diffReview() { return diffReview; },
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
    setResolveRunning,
  };
}
