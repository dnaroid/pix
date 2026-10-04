import { describe, expect, it } from "vitest";
import { gitReviewHasFindings, type GitSnapshot } from "./git";
import { gitPushBlockedReason, gitStageGenerateCommitPushBlockedReason, gitReviewStatus, gitUpdateBlockedReason, gitUpdateNotice, sameGitDiff } from "./git-workflow";

const snapshot: GitSnapshot = { branch: "main", detached: false, head: "abc", upstream: "origin/main", ahead: 1, behind: 0, changes: [], branches: [], remotes: ["origin"] };

describe("Git workflow decisions", () => {
  it("allows the self-refreshing combined command before the panel loads status, but preserves known safety guards", () => {
    expect(gitStageGenerateCommitPushBlockedReason(undefined)).toBeNull();
    expect(gitStageGenerateCommitPushBlockedReason(snapshot)).toBeNull();
    expect(gitPushBlockedReason(undefined)).toMatch(/not available/);
    for (const unsafe of [
      { ...snapshot, detached: true },
      { ...snapshot, behind: 1 },
      { ...snapshot, remotes: [] },
      { ...snapshot, upstream: undefined, remotes: ["one", "two"] },
      { ...snapshot, changes: [{ path: "a", indexStatus: "U", worktreeStatus: "U", staged: false, unstaged: true, untracked: false, conflicted: true }] },
    ]) expect(gitStageGenerateCommitPushBlockedReason(unsafe)).toBeTruthy();
  });
  it("allows publishing with origin or a single remote, but never guesses among other remotes", () => {
    expect(gitPushBlockedReason(snapshot)).toBeNull();
    expect(gitPushBlockedReason({ ...snapshot, upstream: undefined })).toBeNull();
    expect(gitPushBlockedReason({ ...snapshot, upstream: undefined, remotes: ["company"] })).toBeNull();
    expect(gitPushBlockedReason({ ...snapshot, upstream: undefined, remotes: ["one", "two"] })).toMatch(/upstream/);
  });
  it("explains detached HEAD, incoming commits and missing remotes", () => {
    expect(gitPushBlockedReason({ ...snapshot, detached: true })).toMatch(/branch/);
    expect(gitPushBlockedReason({ ...snapshot, behind: 1 })).toMatch(/Update the project/);
    expect(gitPushBlockedReason({ ...snapshot, remotes: [] })).toMatch(/remote/);
    expect(gitPushBlockedReason(undefined)).toMatch(/not available/);
  });
  it("gates one-click Update on a tracked branch without conflicts, but not on local changes", () => {
    const change = { path: "a.ts", indexStatus: ".", worktreeStatus: "M", staged: false, unstaged: true, untracked: false, conflicted: false };
    expect(gitUpdateBlockedReason(snapshot)).toBeNull();
    expect(gitUpdateBlockedReason({ ...snapshot, changes: [change] })).toBeNull();
    expect(gitUpdateBlockedReason({ ...snapshot, changes: [{ ...change, conflicted: true }] })).toMatch(/conflicts/);
    expect(gitUpdateBlockedReason({ ...snapshot, upstream: undefined })).toMatch(/upstream/);
    expect(gitUpdateBlockedReason({ ...snapshot, detached: true })).toMatch(/branch/);
    expect(gitUpdateBlockedReason(undefined)).toMatch(/not available/);
  });
  it("describes the Update outcome, including restored local changes", () => {
    expect(gitUpdateNotice({ incoming: 0, stashed: false })).toBe("Already up to date.");
    expect(gitUpdateNotice({ incoming: 1, stashed: false })).toBe("Updated: 1 incoming commit.");
    expect(gitUpdateNotice({ incoming: 3, stashed: true })).toBe("Updated: 3 incoming commits. Local changes were restored.");
  });
  it("compares content, scope, target and truncation, not only file names", () => {
    const diff = { scope: "staged" as const, content: "+first", truncated: false };
    expect(sameGitDiff(diff, { ...diff })).toBe(true);
    expect(sameGitDiff(diff, { ...diff, content: "+other" })).toBe(false);
    expect(sameGitDiff(diff, { ...diff, scope: "all" })).toBe(false);
    expect(sameGitDiff(diff, { ...diff, path: "file.ts" })).toBe(false);
    expect(sameGitDiff(diff, { ...diff, truncated: true })).toBe(false);
    expect(sameGitDiff(undefined, undefined)).toBe(false);
  });
  it("does not present failed or empty reviews as actionable findings", () => {
    expect(gitReviewStatus("### Review failed\nNetwork unavailable")).toBe("failed");
    expect(gitReviewStatus("No diff to review.")).toBe("empty");
    expect(gitReviewHasFindings("No diff to review.")).toBe(false);
    expect(gitReviewHasFindings("### Review failed\nNetwork unavailable")).toBe(false);
    expect(gitReviewHasFindings("No significant findings.")).toBe(false);
  });
});
