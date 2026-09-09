import { describe, expect, it } from "vitest";
import {
  gitChangeCode,
  gitChangeLabel,
  gitChangeLineStats,
  gitCommitDraftStorageKey,
  gitDiffForLlm,
  gitReviewHasFindings,
  gitReviewResolutionPrompt,
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

  it("selects staged and working-tree line counts independently", () => {
    const change = {
      ...snapshot.changes[0]!,
      stagedAdditions: 4,
      stagedDeletions: 1,
      unstagedAdditions: 9,
      unstagedDeletions: 3,
    };
    expect(gitChangeLineStats(change, "staged")).toEqual({ additions: 4, deletions: 1 });
    expect(gitChangeLineStats(change, "unstaged")).toEqual({ additions: 9, deletions: 3 });
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

  it("shows resolve only for review output that contains actionable findings", () => {
    expect(gitReviewHasFindings(undefined)).toBe(false);
    expect(gitReviewHasFindings("No significant findings.")).toBe(false);
    expect(gitReviewHasFindings("### Review failed\n\nprovider timeout")).toBe(false);
    expect(gitReviewHasFindings("- P2: timeout does not cover runtime initialization")).toBe(true);
  });

  it("does not duplicate the reviewed diff into the fixing-session prompt", () => {
    const diff = {
      path: "src/main.ts",
      scope: "unstaged" as const,
      content: "diff --git a/src/main.ts b/src/main.ts\n+const ready = true;",
      truncated: false,
    };
    const prompt = gitReviewResolutionPrompt(diff, "- P2: verify the timeout boundary");
    expect(prompt).toContain("verify every finding against the current working tree");
    expect(prompt).toContain("Do not commit or push");
    expect(prompt).toContain("- P2: verify the timeout boundary");
    expect(prompt).toContain("original diff is intentionally not embedded");
    expect(prompt).toContain("Inspect the current Git working-tree changes for src/main.ts yourself");
    expect(prompt).not.toContain(diff.content);
  });

  it("keeps the fixing-session prompt compact even for a large reviewed diff", () => {
    const diff = {
      scope: "all" as const,
      content: `diff --git a/large.ts b/large.ts\n${"+changed line\n".repeat(2_000)}`,
      truncated: false,
    };
    const prompt = gitReviewResolutionPrompt(diff, "- P2: verify a large-change regression");

    expect(prompt).toContain("original diff is intentionally not embedded");
    expect(prompt).toContain("Inspect the current Git all current changes yourself before editing");
    expect(prompt).toContain("- P2: verify a large-change regression");
    expect(prompt).not.toContain("<reviewed-git-diff>");
    expect(prompt).not.toContain("+changed line\n+changed line");
  });
});
