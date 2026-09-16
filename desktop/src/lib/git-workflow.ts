import type { GitDiff, GitSnapshot } from "./git";

export type GitRepositoryAction = "fetch" | "pull" | "stash-save" | "stash-apply" | "discard";
export interface GitHistoryEntry { hash: string; shortHash: string; subject: string; author: string; date: string }
export interface GitStashEntry { reference: string; subject: string }
export interface GitRepositoryDetails { history: GitHistoryEntry[]; stashes: GitStashEntry[] }
export interface GitReviewResult { diff: GitDiff; text: string; stale: boolean }

/** Shared panel state keeps secondary operations out of the sidebar's prop list. */
export interface GitPanelWorkflow {
  review: GitReviewResult | null;
  resolveRunning: boolean;
  canResolve: boolean;
  notice: string | null;
  details: GitRepositoryDetails | null;
  detailsLoading: boolean;
  onShowReview: () => void;
  onResolve: () => void;
  onLoadDetails: () => void;
  onRepositoryAction: (action: GitRepositoryAction, target?: string) => Promise<boolean>;
}

export function sameGitDiff(a: GitDiff | null | undefined, b: GitDiff | null | undefined): boolean {
  return Boolean(a && b && a.path === b.path && a.scope === b.scope
    && a.content === b.content && a.truncated === b.truncated);
}

export function gitPushBlockedReason(snapshot: GitSnapshot | undefined): string | null {
  if (!snapshot) return "Git status is not available";
  if (snapshot.detached || snapshot.branch === "HEAD") return "Create or switch to a branch before pushing";
  if (!snapshot.remotes.length) return "No remote configured. Add a remote before pushing";
  if (!snapshot.upstream && snapshot.remotes.length > 1 && !snapshot.remotes.includes("origin")) {
    return "Configure an upstream to choose the remote";
  }
  if (snapshot.behind > 0) return "Pull incoming commits before pushing";
  return null;
}

export function gitReviewStatus(review: string | undefined): "none" | "failed" | "empty" | "complete" {
  if (!review?.trim()) return "none";
  if (review.trim().toLowerCase().startsWith("### review failed")) return "failed";
  if (review.trim() === "No diff to review.") return "empty";
  return "complete";
}
