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
  readonly stagedAdditions?: number;
  readonly stagedDeletions?: number;
  readonly unstagedAdditions?: number;
  readonly unstagedDeletions?: number;
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

export function gitChangeLineStats(
  change: GitFileChange,
  scope: Exclude<GitDiffScope, "all">,
): { additions?: number; deletions?: number } {
  return scope === "staged"
    ? { additions: change.stagedAdditions, deletions: change.stagedDeletions }
    : { additions: change.unstagedAdditions, deletions: change.unstagedDeletions };
}

export function gitDiffForLlm(diff: GitDiff, maxChars = 120_000): string {
  if (diff.content.length <= maxChars) return diff.content;
  let boundary = maxChars;
  while (boundary > 0 && isLowSurrogate(diff.content.charCodeAt(boundary))) boundary -= 1;
  return `${diff.content.slice(0, boundary)}\n\n[Diff truncated before LLM review]`;
}

export function gitReviewHasFindings(review: string | undefined): boolean {
  const normalized = review?.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith("### review failed")) return false;

  const noFindingsPatterns = [
    /\bno significant findings\b/u,
    /\bno significant issues\b/u,
    /\bno actionable findings\b/u,
    /\bno actionable issues\b/u,
    /\bno issues found\b/u,
    /\bno problems found\b/u,
    /\bnothing significant to report\b/u,
  ];
  return !noFindingsPatterns.some((pattern) => pattern.test(normalized));
}

export function gitReviewResolutionPrompt(diff: GitDiff, review: string): string {
  const scope = diff.scope === "staged" ? "staged changes" : diff.scope === "unstaged" ? "working-tree changes" : "all current changes";
  const target = diff.path ? `file ${diff.path}` : scope;
  const inspectionTarget = diff.path ? `${scope} for ${diff.path}` : scope;
  return [
    `Resolve the confirmed issues from the Git code review for ${target}.`,
    "",
    "Before editing, verify every finding against the current working tree. The review may be stale or wrong; do not blindly apply a suggestion that no longer applies.",
    "Fix the findings that are still valid, preserve unrelated user changes, add or update focused tests where appropriate, and run the relevant checks.",
    "Do not commit or push unless the user explicitly asks you to do so.",
    "",
    "<review-findings>",
    neutralizeClosingTag(review.trim(), "review-findings"),
    "</review-findings>",
    "",
    "The original diff is intentionally not embedded in this prompt.",
    `Inspect the current Git ${inspectionTarget} yourself before editing and use the review findings only as hypotheses to verify.`,
  ].join("\n");
}

function neutralizeClosingTag(value: string, tag: string): string {
  return value.replaceAll(`</${tag}>`, `</ ${tag}>`);
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
