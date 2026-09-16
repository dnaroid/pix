import { afterEach, describe, expect, it, vi } from "vitest";
import { gitReviewResolutionPrompt, type GitDiff } from "../lib/git";
import { createGitAssist } from "./git-assist";

const diff: GitDiff = {
  scope: "all",
  content: "diff --git a/file.ts b/file.ts\n+fixed",
  truncated: false,
};
const review = "## Review Findings\n\n1. Medium — fix the confirmed issue.";

function createCopyFixture(gitOverrides: Record<string, unknown> = {}) {
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const git = {
    diffPreview: diff,
    diffReview: review,
    reviewResult: { diff, text: review, stale: false },
    resolveRunning: false,
    llmActionId: null,
    ...gitOverrides,
  };
  const assist = createGitAssist({
    client: () => null,
    activeSessionId: () => null,
    workspace: () => "/workspace",
    activeSessionRuntimeReady: () => false,
    operationRunning: () => false,
    statusReady: () => true,
    git: git as any,
    runtime: {} as any,
    prompts: {} as any,
    forgetRuntime: () => undefined,
    activateResolutionSession: () => "message",
    onResolutionRunStarted: () => undefined,
    refreshSessions: () => undefined,
    reportError: () => undefined,
  });
  return { assist, writeText };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Git review resolution prompt copy", () => {
  it("copies the exact resolution prompt when the review is stable", async () => {
    const { assist, writeText } = createCopyFixture();

    await expect(assist.copyReviewResolutionPrompt()).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(gitReviewResolutionPrompt(diff, review));
  });

  it.each([
    ["review refresh", { llmActionId: "review:all" }],
    ["resolution startup", { resolveRunning: true }],
    ["changed diff", { reviewResult: { diff, text: review, stale: true } }],
  ])("does not copy stale review content during %s", async (_label, gitOverrides) => {
    const { assist, writeText } = createCopyFixture(gitOverrides);

    await expect(assist.copyReviewResolutionPrompt()).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });
});
