import { describe, expect, it } from "vitest";
import attachmentDraftSource from "../app/attachment-drafts.ts?raw";
import presentationStateSource from "../app/desktop-presentation-state.svelte.ts?raw";
import draftSource from "../app/draft-session.svelte.ts?raw";
import promptActionServicesSource from "../app/desktop-prompt-action-services.ts?raw";
import historySource from "../app/session-history.svelte.ts?raw";
import modelDraftConfigSource from "../app/model-draft-config.svelte.ts?raw";
import promptSubmitSource from "../app/prompt-submit.ts?raw";
import runtimeLoadingSource from "../app/session-runtime-loading.ts?raw";

describe("draft-session concurrency guards", () => {
  it("uses a draft-scoped materialization lock instead of the global operation lock", () => {
    expect(draftSource).toContain("let materializing = $state(false)");
    expect(presentationStateSource).toContain(
      "const sessionMutationRunning = $derived(options.operationRunning() || options.draft.materializing)",
    );
    const materializeStart = draftSource.indexOf("async function materialize()");
    const materializeEnd = draftSource.indexOf("function deactivate()", materializeStart);
    const materialize = draftSource.slice(materializeStart, materializeEnd);
    expect(materialize).toContain("materializing = true");
    expect(materialize).not.toContain("operationRunning = true");
    expect(materialize).toContain("generation !== materializationGeneration");
    expect(materialize).toContain("void requestClient.closeSession(sessionId).catch(() => undefined)");
  });

  it("invalidates stale runtime-load completions when a session is forgotten", () => {
    expect(runtimeLoadingSource).toContain("const loadGenerations = new Map<string, number>()");
    expect(runtimeLoadingSource).toContain("loadGenerations.get(sessionId) !== generation");
    expect(runtimeLoadingSource).toContain(
      "loadGenerations.set(sessionId, (loadGenerations.get(sessionId) ?? 0) + 1)",
    );
  });

  it("waits for pending attachment adds before snapshotting and sending the first prompt", () => {
    expect(attachmentDraftSource).toContain("const addQueues = new Map<string, Promise<void>>()");
    expect(attachmentDraftSource).toContain("async function waitForSettled(key: string)");
    expect(promptActionServicesSource).toContain("waitForAttachmentDraftSettled: options.attachments.waitForSettled");
    const submitStart = promptSubmitSource.indexOf("async function submit()");
    const snapshot = promptSubmitSource.indexOf("const text = options.promptText().trim()", submitStart);
    const settle = promptSubmitSource.indexOf("await options.waitForAttachmentDraftSettled(initialDraftKey)", submitStart);
    expect(settle).toBeGreaterThan(submitStart);
    expect(snapshot).toBeGreaterThan(settle);
    expect(promptSubmitSource).toContain("if (initialDraftKey !== options.attachmentDraftKey()) return");
    expect(attachmentDraftSource).toContain("addQueues.clear()");
  });

  it("loads and applies model selection on the UI-only draft before materializing a session", () => {
    expect(modelDraftConfigSource).toContain("const response = await requestClient.draftConfig(requestWorkspace)");
    expect(modelDraftConfigSource).toContain("configOptions = response.configOptions");
    expect(modelDraftConfigSource).toContain("configOptions = applyLocalModelThinkingSelection(configOptions, modelRef, thinkingLevel)");
    expect(draftSource).toContain("requestClient.newSession(requestWorkspace, options.draftModelOverride() ?? undefined)");

    const activateStart = draftSource.indexOf("function activate(");
    const activateEnd = draftSource.indexOf("async function openStartTab", activateStart);
    const activateDraft = draftSource.slice(activateStart, activateEnd);
    expect(activateDraft).toContain("void options.refreshDraftConfig()");
    expect(activateDraft).not.toContain("newSession(");
  });

  it("does not delete an unavailable-history session until its concurrent runtime load also fails", () => {
    const historyStart = historySource.indexOf("async function hydrate(");
    const historyEnd = historySource.indexOf("async function loadDeferredToolResult", historyStart);
    const history = historySource.slice(historyStart, historyEnd);
    const unavailable = history.indexOf("session history ${sessionId} is unavailable");
    const awaitRuntime = history.indexOf("await options.ensureRuntime", unavailable);
    const runtimeReady = history.indexOf("if (options.runtimeReady(sessionId))", awaitRuntime);
    const recover = history.indexOf("await options.recoverUnavailableSession", runtimeReady);
    expect(unavailable).toBeGreaterThanOrEqual(0);
    expect(awaitRuntime).toBeGreaterThan(unavailable);
    expect(runtimeReady).toBeGreaterThan(awaitRuntime);
    expect(recover).toBeGreaterThan(runtimeReady);
  });
});
