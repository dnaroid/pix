export type GitDiffScope = "staged" | "unstaged" | "all";

export interface GitFileChange {
  readonly path: string;
  readonly originalPath?: string;
  readonly indexStatus: string;
  readonly worktreeStatus: string;
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly untracked: boolean;
  readonly conflicted: boolean;
}

export interface GitBranch {
  readonly name: string;
  readonly upstream?: string;
  readonly current: boolean;
}

export interface GitSnapshot {
  readonly branch: string;
  readonly detached: boolean;
  readonly head?: string;
  readonly upstream?: string;
  readonly ahead: number;
  readonly behind: number;
  readonly changes: GitFileChange[];
  readonly branches: GitBranch[];
  readonly remotes: string[];
}

export interface GitDiff {
  readonly path?: string;
  readonly scope: GitDiffScope;
  readonly content: string;
  readonly truncated: boolean;
}

export interface GitCommitDraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function gitCommitDraftStorageKey(workspace: string): string {
  return `pix.desktop.gitCommitMessage:${workspace}`;
}

export function loadGitCommitDraft(storage: GitCommitDraftStorage, workspace: string): string {
  if (!workspace) return "";
  try {
    return storage.getItem(gitCommitDraftStorageKey(workspace)) ?? "";
  } catch {
    return "";
  }
}

export function saveGitCommitDraft(storage: GitCommitDraftStorage, workspace: string, message: string): void {
  if (!workspace) return;
  try {
    const key = gitCommitDraftStorageKey(workspace);
    if (message) storage.setItem(key, message);
    else storage.removeItem(key);
  } catch {
    // Persistence is best-effort; source control remains usable without storage.
  }
}

export function stagedGitChanges(snapshot: GitSnapshot | undefined): GitFileChange[] {
  return (snapshot?.changes ?? []).filter((change) => change.staged);
}

export function unstagedGitChanges(snapshot: GitSnapshot | undefined): GitFileChange[] {
  return (snapshot?.changes ?? []).filter((change) => change.unstaged || change.untracked);
}

export function gitChangeCode(change: GitFileChange, scope: Exclude<GitDiffScope, "all">): string {
  if (change.conflicted) return "!";
  if (change.untracked) return "U";
  const status = scope === "staged" ? change.indexStatus : change.worktreeStatus;
  if (status === "R") return "R";
  if (status === "C") return "C";
  if (status === "A") return "A";
  if (status === "D") return "D";
  if (status === "T") return "T";
  return "M";
}

export function gitChangeLabel(change: GitFileChange, scope: Exclude<GitDiffScope, "all">): string {
  const code = gitChangeCode(change, scope);
  if (code === "!") return "Conflict";
  if (code === "U") return "Untracked";
  if (code === "A") return "Added";
  if (code === "D") return "Deleted";
  if (code === "R") return "Renamed";
  if (code === "C") return "Copied";
  if (code === "T") return "Type changed";
  return "Modified";
}

export function gitDiffForLlm(diff: GitDiff, maxChars = 120_000): string {
  if (diff.content.length <= maxChars) return diff.content;
  let boundary = maxChars;
  while (boundary > 0 && isLowSurrogate(diff.content.charCodeAt(boundary))) boundary -= 1;
  return `${diff.content.slice(0, boundary)}\n\n[Diff truncated before LLM review]`;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
