import { describe, expect, it } from "vitest";
import type { GitFileChange, GitSnapshot } from "./git";
import { sameGitSnapshot } from "./git-snapshot";

const snapshot: GitSnapshot = {
  branch: "main", head: "abc", upstream: "origin/main", detached: false,
  ahead: 0, behind: 0, remotes: ["origin"], branches: [{ name: "main", current: true }],
  changes: [{ path: "a.ts", indexStatus: ".", worktreeStatus: "M", staged: false, unstaged: true, untracked: false, conflicted: false }],
};

describe("Git snapshot equality", () => {
  it("compares data rather than object identity", () => {
    expect(sameGitSnapshot(snapshot, structuredClone(snapshot))).toBe(true);
    expect(sameGitSnapshot(undefined, snapshot)).toBe(false);
  });

  const updates: Partial<GitSnapshot>[] = [
    { branch: "other" }, { head: "new" }, { upstream: undefined }, { detached: true },
    { ahead: 1 }, { behind: 1 }, { remotes: [] }, { remotes: ["new"] },
    { branches: [] }, { branches: [{ name: "other", current: false }] },
    { branches: [{ name: "main", current: true, upstream: "origin/main" }] }, { changes: [] },
  ];
  it.each(updates)("detects changed repository state %j", (update) => {
    expect(sameGitSnapshot(snapshot, { ...snapshot, ...update })).toBe(false);
  });

  const fileUpdates: Partial<GitFileChange>[] = [
    { path: "b.ts" }, { originalPath: "old.ts" }, { indexStatus: "M" }, { worktreeStatus: "." },
    { staged: true }, { unstaged: false }, { untracked: true }, { conflicted: true },
    { stagedAdditions: 1 }, { stagedDeletions: 1 }, { unstagedAdditions: 1 }, { unstagedDeletions: 1 },
  ];
  it.each(fileUpdates)("detects changed file state %j", (update) => {
    expect(sameGitSnapshot(snapshot, { ...snapshot, changes: [{ ...snapshot.changes[0]!, ...update }] })).toBe(false);
  });
});
