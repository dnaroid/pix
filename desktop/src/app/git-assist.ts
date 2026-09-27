import type { AcpClient } from "../lib/acp-client";
import { gitCiAggregate, gitCiFixPrompt, type GitCiSnapshot } from "../lib/git-ci";
import {
  gitDiffForLlm,
  gitReviewHasFindings,
  gitReviewResolutionPrompt,
  type GitDiffScope,
} from "../lib/git";
import type { createGitWorkspaceStore } from "./git-workspace.svelte";
import type { createSessionRuntimeStore } from "./session-runtime.svelte";
import type { createPromptRuntime } from "./prompt-runtime.svelte";
import { sameGitDiff } from "../lib/git-workflow";
import { parseDesktopModelRef } from "./desktop-helpers";

type GitWorkspaceStore = ReturnType<typeof createGitWorkspaceStore>;
type SessionRuntimeStore = ReturnType<typeof createSessionRuntimeStore>;
type PromptRuntime = ReturnType<typeof createPromptRuntime>;

type GitAssistOptions = {
  client: () => AcpClient | null;
  workspace: () => string;
  gitAssistantReady: () => boolean;
  operationRunning: () => boolean;
  statusReady: () => boolean;
  git: GitWorkspaceStore;
  runtime: SessionRuntimeStore;
  prompts: PromptRuntime;
  ciSnapshot: () => GitCiSnapshot | undefined;
  ciFixModelRef: () => Promise<string | undefined>;
  forgetRuntime: (sessionId: string) => void;
  activateResolutionSession: (sessionId: string, workspace: string, prompt: string) => string;
  onResolutionRunStarted: (sessionId: string) => void;
  refreshSessions: () => void | Promise<void>;
  reportError: (error: unknown) => void;
};

export function createGitAssist(options: GitAssistOptions) {
  function currentResolutionPrompt(): string | undefined {
    const result = options.git.reviewResult;
    const diff = result?.diff;
    const review = result?.text;
    if (!diff || !review || result?.stale || !gitReviewHasFindings(review)) return undefined;
    return gitReviewResolutionPrompt(diff, review);
  }

  function canFixCi(snapshot: GitCiSnapshot | undefined): boolean {
    if (
      !snapshot
      || snapshot.availability !== "ready"
      || gitCiAggregate(snapshot) !== "failure"
      || !options.gitAssistantReady()
      || options.git.actionId !== null
      || options.git.llmActionId !== null
      || options.git.resolveRunning
      || options.operationRunning()
      || !options.statusReady()
    ) return false;
    const localHead = options.git.snapshot?.head;
    return !localHead || localHead === snapshot.headSha;
  }

  function sameFailedCi(snapshot: GitCiSnapshot): boolean {
    const current = options.ciSnapshot();
    return current?.headSha === snapshot.headSha
      && current.provider === snapshot.provider
      && current.project === snapshot.project
      && current.availability === "ready"
      && gitCiAggregate(current) === "failure";
  }

  async function reviewDiff(path: string | undefined, scope: GitDiffScope): Promise<void> {
    const requestClient = options.client();
    const requestWorkspace = options.workspace();
    const requestGeneration = options.git.generation;
    if (
      !requestClient
      || !requestWorkspace
      || !options.gitAssistantReady()
      || options.git.llmActionId !== null
    ) return;
    const actionId = `review:${path ? `${scope}:${path}` : "all"}`;
    if (!options.git.beginLlmAction(actionId)) return;
    try {
      // An open editor is a snapshot, not a source for a fresh review.
      const diff = await options.git.requestDiff(path, scope);
      if (
        !diff
        || requestClient !== options.client()
        || requestWorkspace !== options.workspace()
        || requestGeneration !== options.git.generation
      ) return;
      options.git.showDiff(diff);
      options.git.setReview(undefined);
      if (!diff.content.trim()) {
        options.git.setReview("No diff to review.", diff);
        return;
      }
      const review = await requestClient.gitAssist(requestWorkspace, "review", gitDiffForLlm(diff));
      if (
        requestClient !== options.client()
        || requestWorkspace !== options.workspace()
        || requestGeneration !== options.git.generation
      ) return;
      options.git.setReview(review, diff);
      const current = await options.git.requestDiff(path, scope);
      if (requestClient === options.client() && requestWorkspace === options.workspace()
        && requestGeneration === options.git.generation && options.git.reviewResult?.text === review
        && (!current || !sameGitDiff(current, diff))) options.git.invalidateReview();
    } catch (error) {
      if (
        requestClient === options.client()
        && requestWorkspace === options.workspace()
        && requestGeneration === options.git.generation
      ) {
        const detail = error instanceof Error ? error.message : String(error);
        options.git.setError(`Review failed: ${detail}`);
        if (options.git.diffPreview?.path === path && options.git.diffPreview?.scope === scope) {
          options.git.setReview(`### Review failed\n\n${detail}`);
        }
      }
    } finally {
      options.git.finishLlmAction(actionId, requestGeneration);
    }
  }

  async function generateCommitMessage(): Promise<string | undefined> {
    const requestClient = options.client();
    const requestWorkspace = options.workspace();
    const requestGeneration = options.git.generation;
    const current = () => requestClient === options.client()
      && requestWorkspace === options.workspace() && requestGeneration === options.git.generation;
    if (
      !requestClient
      || !requestWorkspace
      || !options.gitAssistantReady()
      || options.git.llmActionId !== null
    ) return undefined;
    const actionId = "commit-message";
    if (!options.git.beginLlmAction(actionId)) return undefined;
    try {
      const diff = await options.git.requestDiff(undefined, "staged");
      if (!diff || !current()) return undefined;
      if (!diff.content.trim()) {
        options.git.setError("There are no staged changes to describe.");
        return undefined;
      }
      const message = await requestClient.gitAssist(requestWorkspace, "commit-message", gitDiffForLlm(diff));
      if (!current()) return undefined;
      const latest = await options.git.requestDiff(undefined, "staged");
      if (!current()) return undefined;
      if (!latest || !sameGitDiff(diff, latest)) {
        options.git.setError("Staged changes changed during generation. Generate the message again.");
        return undefined;
      }
      return message;
    } catch (error) {
      if (current()) options.git.setError(error instanceof Error ? error.message : String(error));
      return undefined;
    } finally {
      options.git.finishLlmAction(actionId, requestGeneration);
    }
  }

  async function resolveReviewInNewSession(): Promise<void> {
    const requestClient = options.client();
    const requestWorkspace = options.workspace();
    const requestGeneration = options.git.generation;
    const reviewedDiff = options.git.reviewResult?.diff;
    const prompt = currentResolutionPrompt();
    if (
      !requestClient
      || !requestWorkspace
      || !prompt
      || !reviewedDiff
      || options.git.actionId !== null
      || options.git.llmActionId !== null
      || options.git.resolveRunning
      || options.operationRunning()
      || !options.statusReady()
    ) return;

    options.git.setResolveRunning(true);
    options.git.setError(null);
    let createdSessionId: string | undefined;
    try {
      const current = await options.git.requestDiff(reviewedDiff.path, reviewedDiff.scope);
      if (requestClient !== options.client() || requestWorkspace !== options.workspace() || requestGeneration !== options.git.generation) return;
      if (!current || !sameGitDiff(current, reviewedDiff)) {
        options.git.invalidateReview();
        options.git.setError("Changes have changed since this review. Run code review again before starting a fix session.");
        return;
      }
      const created = await requestClient.newSession(requestWorkspace);
      createdSessionId = created.sessionId;
      if (requestClient !== options.client() || requestWorkspace !== options.workspace() || requestGeneration !== options.git.generation) {
        options.forgetRuntime(created.sessionId);
        await requestClient.closeSession(created.sessionId).catch(() => undefined);
        return;
      }

      await options.runtime.ensure(requestClient, created.sessionId, requestWorkspace);
      if (requestClient !== options.client() || requestWorkspace !== options.workspace() || requestGeneration !== options.git.generation) {
        options.forgetRuntime(created.sessionId);
        await requestClient.closeSession(created.sessionId).catch(() => undefined);
        return;
      }
      if (!options.runtime.isReady(created.sessionId)) {
        options.forgetRuntime(created.sessionId);
        await requestClient.closeSession(created.sessionId).catch(() => undefined);
        options.git.setError("Could not start a new session for resolving the code-review findings.");
        return;
      }

      options.git.invalidateReview();
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
        .then(() => {
          if (requestClient === options.client() && requestWorkspace === options.workspace() && requestGeneration === options.git.generation) return options.refreshSessions();
        })
        .catch((error) => {
          if (requestClient === options.client() && requestWorkspace === options.workspace() && requestGeneration === options.git.generation) options.reportError(error);
        });
    } catch (error) {
      if (createdSessionId) {
        options.forgetRuntime(createdSessionId);
        await requestClient.closeSession(createdSessionId).catch(() => undefined);
      }
      if (requestClient === options.client() && requestWorkspace === options.workspace() && requestGeneration === options.git.generation) {
        options.git.setError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (requestClient === options.client() && requestWorkspace === options.workspace() && requestGeneration === options.git.generation) {
        options.git.setResolveRunning(false);
      }
    }
  }

  async function fixCiInNewSession(snapshot: GitCiSnapshot | undefined): Promise<void> {
    const requestClient = options.client();
    const requestWorkspace = options.workspace();
    const requestGeneration = options.git.generation;
    if (!requestClient || !requestWorkspace || !snapshot || !canFixCi(snapshot)) return;

    const prompt = gitCiFixPrompt(snapshot);
    options.git.setResolveRunning(true);
    options.git.setError(null);
    let createdSessionId: string | undefined;
    try {
      const configuredModel = (await options.ciFixModelRef())?.trim();
      if (
        requestClient !== options.client()
        || requestWorkspace !== options.workspace()
        || requestGeneration !== options.git.generation
        || !sameFailedCi(snapshot)
      ) return;

      let draftConfig: { modelRef: string; thinkingLevel?: string } | undefined;
      if (configuredModel) {
        const parsed = parseDesktopModelRef(configuredModel);
        if (!parsed) throw new Error("CI fix model must use provider/model[:thinking] format.");
        draftConfig = {
          modelRef: parsed.modelRef,
          ...(parsed.thinking ? { thinkingLevel: parsed.thinking } : {}),
        };
      }

      const created = draftConfig
        ? await requestClient.newSession(requestWorkspace, draftConfig)
        : await requestClient.newSession(requestWorkspace);
      createdSessionId = created.sessionId;
      if (
        requestClient !== options.client()
        || requestWorkspace !== options.workspace()
        || requestGeneration !== options.git.generation
        || !sameFailedCi(snapshot)
      ) {
        options.forgetRuntime(created.sessionId);
        await requestClient.closeSession(created.sessionId).catch(() => undefined);
        return;
      }

      await options.runtime.ensure(requestClient, created.sessionId, requestWorkspace);
      if (
        requestClient !== options.client()
        || requestWorkspace !== options.workspace()
        || requestGeneration !== options.git.generation
        || !sameFailedCi(snapshot)
      ) {
        options.forgetRuntime(created.sessionId);
        await requestClient.closeSession(created.sessionId).catch(() => undefined);
        return;
      }
      if (!options.runtime.isReady(created.sessionId)) {
        options.forgetRuntime(created.sessionId);
        await requestClient.closeSession(created.sessionId).catch(() => undefined);
        options.git.setError("Could not start a new session for fixing CI.");
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
        .then(() => {
          if (requestClient === options.client() && requestWorkspace === options.workspace()) return options.refreshSessions();
        })
        .catch((error) => {
          if (requestClient === options.client() && requestWorkspace === options.workspace()) options.reportError(error);
        });
    } catch (error) {
      if (createdSessionId) {
        options.forgetRuntime(createdSessionId);
        await requestClient.closeSession(createdSessionId).catch(() => undefined);
      }
      if (requestClient === options.client() && requestWorkspace === options.workspace() && requestGeneration === options.git.generation) {
        options.git.setError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (requestClient === options.client() && requestWorkspace === options.workspace() && requestGeneration === options.git.generation) {
        options.git.setResolveRunning(false);
      }
    }
  }

  async function copyReviewResolutionPrompt(): Promise<boolean> {
    const prompt = currentResolutionPrompt();
    if (
      !prompt
      || options.git.resolveRunning
      || options.git.actionId != null
      || options.git.llmActionId?.startsWith("review:") === true
      || options.operationRunning()
      || !options.statusReady()
    ) return false;
    try {
      await navigator.clipboard.writeText(prompt);
      return true;
    } catch (error) {
      options.reportError(error);
      return false;
    }
  }

  return { reviewDiff, generateCommitMessage, resolveReviewInNewSession, copyReviewResolutionPrompt, canFixCi, fixCiInNewSession };
}
