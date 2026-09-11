import { describe, expect, it } from "vitest";
import appSource from "../App.svelte?raw";

describe("draft-session concurrency guards", () => {
  it("uses a draft-scoped materialization lock instead of the global operation lock", () => {
    expect(appSource).toContain("let draftSessionMaterializing = $state(false)");
    expect(appSource).toContain("const sessionMutationRunning = $derived(operationRunning || draftSessionMaterializing)");
    const materializeStart = appSource.indexOf("async function materializeDraftSession()");
    const materializeEnd = appSource.indexOf("const KNOWLEDGE_REFRESH_PROMPT", materializeStart);
    const materialize = appSource.slice(materializeStart, materializeEnd);
    expect(materialize).toContain("draftSessionMaterializing = true");
    expect(materialize).not.toContain("operationRunning = true");
    expect(materialize).toContain("generation !== draftSessionMaterializationGeneration");
    expect(materialize).toContain("void requestClient.closeSession(sessionId).catch(() => undefined)");
  });

  it("invalidates stale runtime-load completions when a session is forgotten", () => {
    expect(appSource).toContain("const runtimeLoadGenerations = new Map<string, number>()");
    expect(appSource).toContain("runtimeLoadGenerations.get(sessionId) !== generation");
    expect(appSource).toContain(
      "runtimeLoadGenerations.set(sessionId, (runtimeLoadGenerations.get(sessionId) ?? 0) + 1)",
    );
  });

  it("waits for pending attachment adds before snapshotting and sending the first prompt", () => {
    expect(appSource).toContain("const attachmentAddQueues = new Map<string, Promise<void>>()");
    expect(appSource).toContain("async function waitForAttachmentDraftSettled(key: string)");
    const submitStart = appSource.indexOf("async function submitPrompt()");
    const snapshot = appSource.indexOf("const text = promptText.trim()", submitStart);
    const settle = appSource.indexOf("await waitForAttachmentDraftSettled(initialDraftKey)", submitStart);
    expect(settle).toBeGreaterThan(submitStart);
    expect(snapshot).toBeGreaterThan(settle);
    expect(appSource).toContain("if (initialDraftKey !== attachmentDraftKey) return");
    expect(appSource).toContain("attachmentAddQueues.clear()");
  });

  it("does not delete an unavailable-history session until its concurrent runtime load also fails", () => {
    const historyStart = appSource.indexOf("async function hydrateSessionHistory(");
    const historyEnd = appSource.indexOf("async function loadDeferredToolResult", historyStart);
    const history = appSource.slice(historyStart, historyEnd);
    const unavailable = history.indexOf("session history ${sessionId} is unavailable");
    const awaitRuntime = history.indexOf("await ensureSessionRuntime", unavailable);
    const deleteSession = history.indexOf("requestClient.deleteSession", unavailable);
    expect(unavailable).toBeGreaterThanOrEqual(0);
    expect(awaitRuntime).toBeGreaterThan(unavailable);
    expect(deleteSession).toBeGreaterThan(awaitRuntime);
  });
});
