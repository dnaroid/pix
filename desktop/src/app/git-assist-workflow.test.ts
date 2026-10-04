import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGitWorkspaceStore } from "./git-workspace.svelte";
import { createGitAssist } from "./git-assist";
import { gitReviewResolutionPrompt, type GitDiff } from "../lib/git";
import type { GitCiSnapshot } from "../lib/git-ci";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const findings = "## Findings\n\n1. High — guard the stale completion in file.ts.";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  let workspace = "/one";
  let content = "+current changes";
  let ciFixModelRef: string | undefined;
  let ciFixModelResolver = async () => ciFixModelRef;
  let ciSnapshot: GitCiSnapshot = {
    provider: "github",
    availability: "ready",
    remoteName: "origin",
    host: "github.com",
    project: "example/repo",
    headSha: "head-1",
    localOnly: false,
    runs: [{
      id: "run-1",
      name: "Check",
      status: "failure",
      rawStatus: "failure",
      headSha: "head-1",
      branch: "main",
      url: "https://github.com/example/repo/actions/runs/1",
    }],
  };
  invoke.mockImplementation(async (command: string, payload: { scope: GitDiff["scope"]; path: string | null }) => {
    if (command === "git_diff") return { scope: payload.scope, path: payload.path ?? undefined, content, truncated: false };
  });
  const git = createGitWorkspaceStore({
    workspace: () => workspace, previewDirty: () => false, reloadProject: async () => {},
    activeWorkbenchTabId: () => null, activeConversationWorkbenchTabId: () => null,
    setActiveWorkbenchTabId: () => {}, nextWorkbenchAuxOrder: () => 1,
  });
  const client = {
    gitAssist: vi.fn(async (_cwd: string, _mode: string, _diff: string) => findings),
    newSession: vi.fn(async (_workspace: string) => ({ sessionId: "fix-session" })),
    closeSession: vi.fn(async (_session: string) => {}),
  };
  const runtime = { ensure: vi.fn(async (_client: unknown, _sessionId: string) => {}), isReady: vi.fn(() => true) };
  const prompts = { runPromptRequest: vi.fn(async () => {}) };
  const activate = vi.fn((_sessionId: string, _workspace: string, _prompt: string) => "message-1");
  const forget = vi.fn();
  const started = vi.fn();
  const refresh = vi.fn();
  const assist = createGitAssist({
    client: () => client as any, workspace: () => workspace,
    gitAssistantReady: () => true, operationRunning: () => false, statusReady: () => true,
    git, runtime: runtime as any, prompts: prompts as any,
    ciSnapshot: () => ciSnapshot,
    ciFixModelRef: () => ciFixModelResolver(),
    forgetRuntime: forget,
    activateResolutionSession: activate, onResolutionRunStarted: started, refreshSessions: refresh, reportError: vi.fn(),
  });
  function setReview() {
    git.setReview(findings, { scope: "all", content, truncated: false });
  }
  return {
    assist, git, client, runtime, prompts, activate, forget, started, refresh, setReview,
    changeContent(value: string) { content = value; },
    changeWorkspace(value: string) { workspace = value; git.reset(); },
    setCiFixModelRef(value: string | undefined) { ciFixModelRef = value; },
    setCiFixModelResolver(value: () => Promise<string | undefined>) { ciFixModelResolver = value; },
    setCiSnapshot(value: GitCiSnapshot) { ciSnapshot = value; },
    getCiSnapshot() { return ciSnapshot; },
  };
}

beforeEach(() => invoke.mockReset());

describe("Git assistant freshness", () => {
  it("combined action generates a message from staged changes without a conversation", async () => {
    const { assist, git, client } = fixture();
    const diff: GitDiff = { scope: "staged", content: "+staged", truncated: false };
    vi.spyOn(git, "stageGenerateCommitPush").mockImplementation(async (generate) => {
      expect(await generate(diff)).toBe(findings);
      return true;
    });
    await expect(assist.stageGenerateCommitPush()).resolves.toBe(true);
    expect(client.gitAssist).toHaveBeenCalledWith("/one", "commit-message", "+staged");
    expect(client.newSession).not.toHaveBeenCalled();
  });

  it("combined action rejects stale assistant output after a workspace round trip", async () => {
    const { assist, git, client, changeWorkspace } = fixture();
    const response = deferred<string>();
    client.gitAssist.mockReturnValueOnce(response.promise);
    vi.spyOn(git, "stageGenerateCommitPush").mockImplementation(async (generate) => {
      expect(await generate({ scope: "staged", content: "+staged", truncated: false })).toBeUndefined();
      return false;
    });
    const pending = assist.stageGenerateCommitPush();
    await vi.waitFor(() => expect(client.gitAssist).toHaveBeenCalled());
    changeWorkspace("/two");
    changeWorkspace("/one");
    response.resolve("obsolete");
    await expect(pending).resolves.toBe(false);
  });

  it("reviews a fresh diff rather than the cached editor snapshot", async () => {
    const { git, assist, client } = fixture();
    git.showDiff({ scope: "all", content: "+outdated editor", truncated: false });
    await assist.reviewDiff(undefined, "all");
    expect(client.gitAssist).toHaveBeenCalledWith("/one", "review", "+current changes");
    expect(git.reviewResult?.text).toBe(findings);
    expect(git.reviewResult?.stale).toBe(false);
  });
  it("keeps findings available after navigating to another file during review", async () => {
    const { git, assist, client } = fixture();
    const result = deferred<string>();
    client.gitAssist.mockReturnValueOnce(result.promise);
    const pending = assist.reviewDiff(undefined, "all");
    await vi.waitFor(() => expect(client.gitAssist).toHaveBeenCalledOnce());
    git.showDiff({ path: "other.ts", scope: "unstaged", content: "+other", truncated: false });
    result.resolve(findings);
    await pending;
    expect(git.diffReview).toBeUndefined();
    expect(git.reviewResult?.text).toBe(findings);
    git.showReview();
    expect(git.diffReview).toBe(findings);
  });
  it("marks findings stale if files changed while the model was reviewing", async () => {
    const { git, assist, client, changeContent } = fixture();
    const result = deferred<string>();
    client.gitAssist.mockReturnValueOnce(result.promise);
    const pending = assist.reviewDiff(undefined, "all");
    await vi.waitFor(() => expect(client.gitAssist).toHaveBeenCalledOnce());
    changeContent("+edited during review");
    result.resolve(findings);
    await pending;
    expect(git.reviewResult?.stale).toBe(true);
    await assist.resolveReviewInNewSession();
    expect(client.newSession).not.toHaveBeenCalled();
  });
  it("generates from the workspace without an active conversation session", async () => {
    const { git, assist, client } = fixture();
    const result = deferred<string>();
    client.gitAssist.mockReturnValueOnce(result.promise);
    const pending = assist.generateCommitMessage();
    await vi.waitFor(() => expect(client.gitAssist).toHaveBeenCalledOnce());
    expect(client.gitAssist).toHaveBeenCalledWith("/one", "commit-message", "+current changes");
    result.resolve("workspace message");
    await expect(pending).resolves.toBe("workspace message");
    expect(git.llmActionId).toBeNull();
  });
  it("rejects generated messages when the staged diff changed", async () => {
    const { git, assist, client, changeContent } = fixture();
    client.gitAssist.mockImplementationOnce(async () => {
      changeContent("+different staging");
      return "generated message";
    });
    await expect(assist.generateCommitMessage()).resolves.toBeUndefined();
    expect(git.error).toMatch(/Staged changes changed/);
  });
  it("old LLM completion cannot clear a new action after an A→B→A workspace switch", async () => {
    const { git, assist, client, changeWorkspace } = fixture();
    const result = deferred<string>();
    client.gitAssist.mockReturnValueOnce(result.promise);
    const pending = assist.generateCommitMessage();
    await vi.waitFor(() => expect(client.gitAssist).toHaveBeenCalledOnce());
    changeWorkspace("/two");
    changeWorkspace("/one");
    git.beginLlmAction("commit-message");
    result.resolve("obsolete");
    await expect(pending).resolves.toBeUndefined();
    expect(git.llmActionId).toBe("commit-message");
  });
});

describe("Git review → fix-session handoff", () => {
  it("starts a distinct session with verified findings and never commits or pushes", async () => {
    const f = fixture();
    f.setReview();
    const expected = gitReviewResolutionPrompt(f.git.reviewResult!.diff, findings);
    await f.assist.resolveReviewInNewSession();
    expect(f.client.newSession).toHaveBeenCalledWith("/one");
    expect(f.activate).toHaveBeenCalledWith("fix-session", "/one", expected);
    expect(f.prompts.runPromptRequest).toHaveBeenCalledWith(f.client, "fix-session", [{ type: "text", text: expected }], [], "message-1");
    expect(expected).toContain("Do not commit or push");
    expect(f.started).toHaveBeenCalledWith("fix-session");
    expect(f.git.reviewResult?.stale).toBe(true);
    expect(invoke.mock.calls.every(([command]) => command === "git_diff")).toBe(true);
  });
  it("rechecks the actual diff before allocating a session", async () => {
    const f = fixture();
    f.setReview();
    f.changeContent("+changed without a status refresh");
    await f.assist.resolveReviewInNewSession();
    expect(f.client.newSession).not.toHaveBeenCalled();
    expect(f.git.reviewResult?.stale).toBe(true);
    expect(f.git.resolveRunning).toBe(false);
  });
  it("closes an orphan session when the user changes workspace during creation", async () => {
    const f = fixture();
    f.setReview();
    const created = deferred<{ sessionId: string }>();
    f.client.newSession.mockReturnValueOnce(created.promise);
    const pending = f.assist.resolveReviewInNewSession();
    await vi.waitFor(() => expect(f.client.newSession).toHaveBeenCalledOnce());
    f.changeWorkspace("/two");
    created.resolve({ sessionId: "orphan" });
    await pending;
    expect(f.client.closeSession).toHaveBeenCalledWith("orphan");
    expect(f.forget).toHaveBeenCalledExactlyOnceWith("orphan");
    expect(f.activate).not.toHaveBeenCalled();
  });
  it("does not forget a reopened session when the orphan's close finishes later", async () => {
    const f = fixture();
    f.setReview();
    const ensuring = deferred<void>();
    const closing = deferred<void>();
    const owners = new Map<string, { runtime: string; activity: string }>();
    f.runtime.ensure.mockImplementationOnce(async (_client: unknown, sessionId: string) => {
      owners.set(sessionId, { runtime: "orphan", activity: "orphan" });
      await ensuring.promise;
    });
    f.forget.mockImplementation((sessionId: string) => { owners.delete(sessionId); });
    f.client.closeSession.mockReturnValueOnce(closing.promise);

    const pending = f.assist.resolveReviewInNewSession();
    await vi.waitFor(() => expect(f.runtime.ensure).toHaveBeenCalledOnce());
    f.changeWorkspace("/two");
    ensuring.resolve(undefined);
    await vi.waitFor(() => expect(f.client.closeSession).toHaveBeenCalledExactlyOnceWith("fix-session"));
    expect(f.forget).toHaveBeenCalledExactlyOnceWith("fix-session");
    expect(owners.has("fix-session")).toBe(false);

    // Reattach the same ID while the captured old client's close is still pending.
    const reopened = { runtime: "replacement", activity: "replacement" };
    owners.set("fix-session", reopened);
    closing.resolve(undefined);
    await pending;
    expect(owners.get("fix-session")).toBe(reopened);
    expect(f.forget).toHaveBeenCalledTimes(1);
    expect(f.activate).not.toHaveBeenCalled();
  });
});

describe("failed CI → Fix with AI handoff", () => {
  it("starts a new session with the normal default model when CI fix model is unset", async () => {
    const f = fixture();
    const snapshot = f.getCiSnapshot();
    expect(f.assist.canFixCi(snapshot)).toBe(true);

    await f.assist.fixCiInNewSession(snapshot);

    expect(f.client.newSession).toHaveBeenCalledWith("/one");
    const prompt = f.activate.mock.calls[0]?.[2] as string;
    expect(prompt).toContain("keep iterating until CI is green");
    expect(prompt).toContain("commit only the changes needed for the CI repair and push them");
    expect(prompt).toContain("Do not force-push or rewrite history");
    expect(prompt).toContain("Do not make CI green by disabling checks");
    expect(prompt).toContain("https://github.com/example/repo/actions/runs/1");
    expect(f.prompts.runPromptRequest).toHaveBeenCalledWith(f.client, "fix-session", [{ type: "text", text: prompt }], [], "message-1");
    expect(f.started).toHaveBeenCalledWith("fix-session");
  });

  it("applies the configured CI repair model and thinking level to the new session", async () => {
    const f = fixture();
    f.setCiFixModelRef("anthropic/claude-sonnet-4-5:high");

    await f.assist.fixCiInNewSession(f.getCiSnapshot());

    expect(f.client.newSession).toHaveBeenCalledWith("/one", {
      modelRef: "anthropic/claude-sonnet-4-5",
      thinkingLevel: "high",
    });
  });

  it("uses the configured model's own default thinking when no thinking suffix is set", async () => {
    const f = fixture();
    f.setCiFixModelRef("anthropic/claude-sonnet-4-5");

    await f.assist.fixCiInNewSession(f.getCiSnapshot());

    expect(f.client.newSession).toHaveBeenCalledWith("/one", {
      modelRef: "anthropic/claude-sonnet-4-5",
    });
  });

  it("does not allocate a session after the failing CI snapshot becomes stale while settings load", async () => {
    const f = fixture();
    const snapshot = f.getCiSnapshot();
    const model = deferred<string | undefined>();
    f.setCiFixModelResolver(() => model.promise);

    const pending = f.assist.fixCiInNewSession(snapshot);
    f.setCiSnapshot({
      ...snapshot,
      runs: snapshot.runs.map((run: GitCiSnapshot["runs"][number]) => ({ ...run, status: "success" as const, rawStatus: "success" })),
    });
    model.resolve(undefined);
    await pending;

    expect(f.client.newSession).not.toHaveBeenCalled();
    expect(f.git.resolveRunning).toBe(false);
  });

  it("closes an orphan CI-fix session if the CI result changes during creation", async () => {
    const f = fixture();
    const snapshot = f.getCiSnapshot();
    const created = deferred<{ sessionId: string }>();
    f.client.newSession.mockReturnValueOnce(created.promise);

    const pending = f.assist.fixCiInNewSession(snapshot);
    await vi.waitFor(() => expect(f.client.newSession).toHaveBeenCalledOnce());
    f.setCiSnapshot({
      ...snapshot,
      runs: snapshot.runs.map((run: GitCiSnapshot["runs"][number]) => ({ ...run, status: "success" as const, rawStatus: "success" })),
    });
    created.resolve({ sessionId: "ci-orphan" });
    await pending;

    expect(f.client.closeSession).toHaveBeenCalledWith("ci-orphan");
    expect(f.forget).toHaveBeenCalledWith("ci-orphan");
    expect(f.activate).not.toHaveBeenCalled();
  });
});
