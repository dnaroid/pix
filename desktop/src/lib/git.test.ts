import { describe, expect, it } from "vitest";
import {
  gitChangeCode,
  gitChangeLabel,
  gitCommitDraftStorageKey,
  gitDiffForLlm,
  loadGitCommitDraft,
  saveGitCommitDraft,
  stagedGitChanges,
  unstagedGitChanges,
  type GitSnapshot,
} from "./git";

const snapshot: GitSnapshot = {
  branch: "main",
  detached: false,
  ahead: 1,
  behind: 0,
  branches: [],
  remotes: [],
  changes: [
    { path: "both.ts", indexStatus: "M", worktreeStatus: "M", staged: true, unstaged: true, untracked: false, conflicted: false },
    { path: "new.ts", indexStatus: "?", worktreeStatus: "?", staged: false, unstaged: true, untracked: true, conflicted: false },
    { path: "conflict.ts", indexStatus: "U", worktreeStatus: "U", staged: true, unstaged: true, untracked: false, conflicted: true },
  ],
};

describe("Git source-control helpers", () => {
  it("keeps partially staged files in both source-control sections", () => {
    expect(stagedGitChanges(snapshot).map((change) => change.path)).toEqual(["both.ts", "conflict.ts"]);
    expect(unstagedGitChanges(snapshot).map((change) => change.path)).toEqual(["both.ts", "new.ts", "conflict.ts"]);
  });

  it("maps compact status labels and bounds LLM diff input", () => {
    expect(gitChangeCode(snapshot.changes[1]!, "unstaged")).toBe("U");
    expect(gitChangeLabel(snapshot.changes[2]!, "staged")).toBe("Conflict");
    expect(gitDiffForLlm({ scope: "all", content: "x".repeat(200), truncated: false }, 50)).toContain("Diff truncated before LLM review");
  });

  it("scopes persisted commit-message drafts to the workspace", () => {
    expect(gitCommitDraftStorageKey("/projects/alpha")).toBe("pix.desktop.gitCommitMessage:/projects/alpha");
    expect(gitCommitDraftStorageKey("/projects/alpha")).not.toBe(gitCommitDraftStorageKey("/projects/beta"));

    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => { values.delete(key); },
    };
    saveGitCommitDraft(storage, "/projects/alpha", "feat: remember draft");
    saveGitCommitDraft(storage, "/projects/beta", "fix: another project");
    expect(loadGitCommitDraft(storage, "/projects/alpha")).toBe("feat: remember draft");
    expect(loadGitCommitDraft(storage, "/projects/beta")).toBe("fix: another project");

    saveGitCommitDraft(storage, "/projects/alpha", "");
    expect(loadGitCommitDraft(storage, "/projects/alpha")).toBe("");
    expect(loadGitCommitDraft(storage, "/projects/beta")).toBe("fix: another project");
  });
});
