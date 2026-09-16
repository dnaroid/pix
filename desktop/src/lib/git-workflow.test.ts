import { describe, expect, it } from "vitest";
import { gitReviewHasFindings, type GitSnapshot } from "./git";
import { gitPushBlockedReason, gitReviewStatus, sameGitDiff } from "./git-workflow";

const snapshot: GitSnapshot = { branch: "main", detached: false, head: "abc", upstream: "origin/main", ahead: 1, behind: 0, changes: [], branches: [], remotes: ["origin"] };

describe("Git workflow decisions", () => {
  it("allows publishing with origin or a single remote, but never guesses among other remotes", () => {
    expect(gitPushBlockedReason(snapshot)).toBeNull();
    expect(gitPushBlockedReason({ ...snapshot, upstream: undefined })).toBeNull();
    expect(gitPushBlockedReason({ ...snapshot, upstream: undefined, remotes: ["company"] })).toBeNull();
    expect(gitPushBlockedReason({ ...snapshot, upstream: undefined, remotes: ["one", "two"] })).toMatch(/upstream/);
  });
  it("explains detached HEAD, incoming commits and missing remotes", () => {
    expect(gitPushBlockedReason({ ...snapshot, detached: true })).toMatch(/branch/);
    expect(gitPushBlockedReason({ ...snapshot, behind: 1 })).toMatch(/Pull/);
    expect(gitPushBlockedReason({ ...snapshot, remotes: [] })).toMatch(/remote/);
    expect(gitPushBlockedReason(undefined)).toMatch(/not available/);
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
