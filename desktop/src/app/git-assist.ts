import type { AcpClient } from "../lib/acp-client";
import {
  gitDiffForLlm,
  gitReviewHasFindings,
  gitReviewResolutionPrompt,
  type GitDiffScope,
} from "../lib/git";
import type { createGitWorkspaceStore } from "./git-workspace.svelte";
import type { createSessionRuntimeStore } from "./session-runtime.svelte";
import type { createPromptRuntime } from "./prompt-runtime.svelte";

type GitWorkspaceStore = ReturnType<typeof createGitWorkspaceStore>;
type SessionRuntimeStore = ReturnType<typeof createSessionRuntimeStore>;
type PromptRuntime = ReturnType<typeof createPromptRuntime>;

type GitAssistOptions = {
  client: () => AcpClient | null;
  activeSessionId: () => string | null;
  workspace: () => string;
  activeSessionRuntimeReady: () => boolean;
  operationRunning: () => boolean;
  statusReady: () => boolean;
  git: GitWorkspaceStore;
  runtime: SessionRuntimeStore;
  prompts: PromptRuntime;
  forgetRuntime: (sessionId: string) => void;
  activateResolutionSession: (sessionId: string, workspace: string, prompt: string) => string;
  onResolutionRunStarted: (sessionId: string) => void;
  refreshSessions: () => void | Promise<void>;
  reportError: (error: unknown) => void;
};

export function createGitAssist(options: GitAssistOptions) {
  async function reviewDiff(path: string | undefined, scope: GitDiffScope): Promise<void> {
    const requestClient = options.client();
    const sessionId = options.activeSessionId();
    const requestWorkspace = options.workspace();
    if (
      !requestClient
      || !sessionId
      || !requestWorkspace
      || !options.activeSessionRuntimeReady()
      || options.git.llmActionId !== null
    ) return;
    const actionId = `review:${path ? `${scope}:${path}` : "all"}`;
    if (!options.git.beginLlmAction(actionId)) return;
    try {
      const current = options.git.diffPreview;
      const diff = current && current.path === path && current.scope === scope
        ? current
        : await options.git.requestDiff(path, scope);
      if (
        !diff
        || requestClient !== options.client()
        || requestWorkspace !== options.workspace()
        || sessionId !== options.activeSessionId()
      ) return;
      options.git.showDiff(diff);
      if (!diff.content.trim()) {
        options.git.setReview("No diff to review.");
        return;
      }
      const review = await requestClient.gitAssist(sessionId, "review", gitDiffForLlm(diff));
      if (
        requestClient !== options.client()
        || requestWorkspace !== options.workspace()
        || sessionId !== options.activeSessionId()
      ) return;
      if (options.git.diffPreview?.path !== diff.path || options.git.diffPreview?.scope !== diff.scope) return;
      options.git.setReview(review);
    } catch (error) {
      if (
        requestClient === options.client()
        && requestWorkspace === options.workspace()
        && sessionId === options.activeSessionId()
      ) {
        const detail = error instanceof Error ? error.message : String(error);
        if (options.git.diffPreview?.path === path && options.git.diffPreview?.scope === scope) {
          options.git.setReview(`### Review failed\n\n${detail}`);
        }
      }
    } finally {
      options.git.finishLlmAction(actionId);
    }
  }

  async function generateCommitMessage(): Promise<string | undefined> {
    const requestClient = options.client();
    const sessionId = options.activeSessionId();
    const requestWorkspace = options.workspace();
    if (
      !requestClient
      || !sessionId
      || !requestWorkspace
      || !options.activeSessionRuntimeReady()
      || options.git.llmActionId !== null
    ) return undefined;
    const actionId = "commit-message";
    if (!options.git.beginLlmAction(actionId)) return undefined;
    try {
      const diff = await options.git.requestDiff(undefined, "staged");
      if (
        !diff
        || requestClient !== options.client()
        || requestWorkspace !== options.workspace()
        || sessionId !== options.activeSessionId()
      ) return undefined;
      if (!diff.content.trim()) {
        options.git.setError("There are no staged changes to describe.");
        return undefined;
      }
      return await requestClient.gitAssist(sessionId, "commit-message", gitDiffForLlm(diff));
    } catch (error) {
      if (
        requestClient === options.client()
        && requestWorkspace === options.workspace()
        && sessionId === options.activeSessionId()
      ) options.git.setError(error instanceof Error ? error.message : String(error));
      return undefined;
    } finally {
      options.git.finishLlmAction(actionId);
    }
  }

  async function resolveReviewInNewSession(): Promise<void> {
    const requestClient = options.client();
    const requestWorkspace = options.workspace();
    const diff = options.git.diffPreview;
    const review = options.git.diffReview;
    if (
      !requestClient
      || !requestWorkspace
      || !diff
      || !gitReviewHasFindings(review)
      || !review
      || options.git.resolveRunning
      || options.operationRunning()
      || !options.statusReady()
    ) return;

    const prompt = gitReviewResolutionPrompt(diff, review);
    options.git.setResolveRunning(true);
    options.git.setError(null);
    let createdSessionId: string | undefined;
    try {
      const created = await requestClient.newSession(requestWorkspace);
      createdSessionId = created.sessionId;
      if (requestClient !== options.client() || requestWorkspace !== options.workspace()) {
        await requestClient.closeSession(created.sessionId).catch(() => undefined);
        return;
      }

      await options.runtime.ensure(requestClient, created.sessionId, requestWorkspace);
      if (requestClient !== options.client() || requestWorkspace !== options.workspace()) {
        await requestClient.closeSession(created.sessionId).catch(() => undefined);
        options.forgetRuntime(created.sessionId);
        return;
      }
      if (!options.runtime.isReady(created.sessionId)) {
        await requestClient.closeSession(created.sessionId).catch(() => undefined);
        options.forgetRuntime(created.sessionId);
        options.git.setError("Could not start a new session for resolving the code-review findings.");
        return;
      }

      const transcriptMessageId = options.activateResolutionSession(created.sessionId, requestWorkspace, prompt);
      const run = options.prompts.runPromptRequest(
        requestClient,
        created.sessionId,
        [{ type: "text", text: prompt }],
        [],
        transcriptMessageId,
      );
      options.onResolutionRunStarted(created.sessionId);
      void options.refreshSessions();
      void run
        .then(() => options.refreshSessions())
        .catch((error) => {
          if (requestClient === options.client() && requestWorkspace === options.workspace()) options.reportError(error);
        });
    } catch (error) {
      if (createdSessionId) {
        await requestClient.closeSession(createdSessionId).catch(() => undefined);
        options.forgetRuntime(createdSessionId);
      }
      if (requestClient === options.client() && requestWorkspace === options.workspace()) {
        options.git.setError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (requestClient === options.client() && requestWorkspace === options.workspace()) {
        options.git.setResolveRunning(false);
      }
    }
  }

  return { reviewDiff, generateCommitMessage, resolveReviewInNewSession };
}
