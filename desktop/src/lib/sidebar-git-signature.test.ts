import { describe, expect, it } from "vitest";
import type { GitSnapshot } from "./git";
import { sidebarGitSignature } from "./sidebar-git-signature";

const snapshot: GitSnapshot = {
  branch: "main", head: "abc", upstream: "origin/main", detached: false,
  ahead: 0, behind: 0, remotes: ["origin"], branches: [],
  changes: [{ path: "a.ts", indexStatus: "M", worktreeStatus: ".", staged: true, unstaged: false, untracked: false, conflicted: false }],
};

describe("sidebar Git invalidation signature", () => {
  it("ignores object identity, file details and line counts", () => {
    const enriched = { ...snapshot, changes: [{ ...snapshot.changes[0]!, path: "b.ts", stagedAdditions: 10 }] };
    expect(sidebarGitSignature(enriched, null)).toBe(sidebarGitSignature(snapshot, null));
    expect(sidebarGitSignature(structuredClone(snapshot), null)).toBe(sidebarGitSignature(snapshot, null));
  });

  const changes: Partial<GitSnapshot>[] = [
    { changes: [] }, { changes: [{ ...snapshot.changes[0]!, conflicted: true }] },
    { branch: "other" }, { head: "new" }, { upstream: "origin/other" },
    { ahead: 1 }, { behind: 1 }, { detached: true },
  ];
  it.each(changes)("invalidates meaningful state changes: %j", (change) => {
    expect(sidebarGitSignature({ ...snapshot, ...change }, null)).not.toBe(sidebarGitSignature(snapshot, null));
  });

  it("invalidates error and repository availability transitions", () => {
    expect(sidebarGitSignature(snapshot, "failed")).not.toBe(sidebarGitSignature(snapshot, null));
    expect(sidebarGitSignature(undefined, null)).not.toBe(sidebarGitSignature(snapshot, null));
  });
});
