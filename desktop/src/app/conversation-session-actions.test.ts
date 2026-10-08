import { describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import { createConversationSessionActions } from "./conversation-session-actions";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("conversation session local actions", () => {
  it.each([false, true])("releases enhancement without a global lock or overwriting later edits (failure=%s)", async (failure) => {
    const response = deferred<string>();
    const client = {
      enhancePrompt: vi.fn(() => response.promise),
    } as unknown as AcpClient;
    let promptText = "draft prompt";
    const setPromptText = vi.fn((text: string) => { promptText = text; });
    const setOperationRunning = vi.fn();
    const state = { sessionId: "session-1", runtimeReady: true };
    const reportError = vi.fn();
    const actions = createConversationSessionActions({
      client: () => client,
      state,
      workspace: () => "/project",
      promptText: () => promptText,
      operationRunning: () => false,
      setOperationRunning,
      promptRunning: () => false,
      sessionHistoryLoading: () => false,
      setErrorMessage: vi.fn(),
      setPromptText,
      markRuntimeReady: vi.fn(),
      forgetRuntime: vi.fn(),
      beginHistoryLoad: () => 1,
      hydrateHistory: vi.fn(async () => {}),
      refreshSessions: vi.fn(),
      closeProjectSelector: vi.fn(),
      closeSessionSelector: vi.fn(),
      clearCommandPicker: vi.fn(),
      requestLocalTextInput: vi.fn(async () => undefined),
      nextLocalMessageId: () => "local-1",
      scrollToLatest: vi.fn(async () => {}),
      reportError,
    } as any);

    const pending = actions.enhancePromptDraft(promptText);
    expect(actions.promptEnhancing).toBe(true);
    state.sessionId = "session-2";
    expect(actions.promptEnhancing).toBe(false);
    state.sessionId = "session-1";
    expect(actions.promptEnhancing).toBe(true);
    expect(setOperationRunning).not.toHaveBeenCalled();
    expect(client.enhancePrompt).toHaveBeenCalledWith("session-1", "draft prompt");

    promptText = "user kept typing";
    if (failure) response.reject(new Error("Enhancement failed"));
    else response.resolve("enhanced prompt");
    await pending;
    expect(actions.promptEnhancing).toBe(false);

    expect(setPromptText).not.toHaveBeenCalled();
    expect(setOperationRunning).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(failure ? 1 : 0);
  });

  it("coalesces duplicate enhancement requests for the same session", async () => {
    const response = deferred<string>();
    const client = {
      enhancePrompt: vi.fn(() => response.promise),
    } as unknown as AcpClient;
    let promptText = "draft prompt";
    const actions = createConversationSessionActions({
      client: () => client,
      state: { sessionId: "session-1", runtimeReady: true },
      workspace: () => "/project",
      promptText: () => promptText,
      operationRunning: () => false,
      setOperationRunning: vi.fn(),
      promptRunning: () => false,
      sessionHistoryLoading: () => false,
      setErrorMessage: vi.fn(),
      setPromptText: (text: string) => { promptText = text; },
      markRuntimeReady: vi.fn(),
      forgetRuntime: vi.fn(),
      beginHistoryLoad: () => 1,
      hydrateHistory: vi.fn(async () => {}),
      refreshSessions: vi.fn(),
      closeProjectSelector: vi.fn(),
      closeSessionSelector: vi.fn(),
      clearCommandPicker: vi.fn(),
      requestLocalTextInput: vi.fn(async () => undefined),
      nextLocalMessageId: () => "local-1",
      scrollToLatest: vi.fn(async () => {}),
      reportError: vi.fn(),
    } as any);

    const first = actions.enhancePromptDraft(promptText);
    const second = actions.enhancePromptDraft(promptText);
    expect(client.enhancePrompt).toHaveBeenCalledTimes(1);
    await second;
    response.resolve("enhanced");
    await first;
  });

  it("lets a replacement workspace own enhancement for the same session id", async () => {
    const firstResponse = deferred<string>();
    const secondResponse = deferred<string>();
    const client = {
      enhancePrompt: vi.fn()
        .mockReturnValueOnce(firstResponse.promise)
        .mockReturnValueOnce(secondResponse.promise),
    } as unknown as AcpClient;
    let workspace = "/one";
    let promptText = "draft prompt";
    const setPromptText = vi.fn((text: string) => { promptText = text; });
    const actions = createConversationSessionActions({
      client: () => client,
      state: { sessionId: "session-1", runtimeReady: true },
      workspace: () => workspace,
      promptText: () => promptText,
      operationRunning: () => false,
      setOperationRunning: vi.fn(),
      promptRunning: () => false,
      sessionHistoryLoading: () => false,
      setErrorMessage: vi.fn(),
      setPromptText,
      markRuntimeReady: vi.fn(),
      forgetRuntime: vi.fn(),
      beginHistoryLoad: () => 1,
      hydrateHistory: vi.fn(async () => {}),
      refreshSessions: vi.fn(),
      closeProjectSelector: vi.fn(),
      closeSessionSelector: vi.fn(),
      clearCommandPicker: vi.fn(),
      requestLocalTextInput: vi.fn(async () => undefined),
      nextLocalMessageId: () => "local-1",
      scrollToLatest: vi.fn(async () => {}),
      reportError: vi.fn(),
    } as any);

    const first = actions.enhancePromptDraft(promptText);
    workspace = "/two";
    expect(actions.promptEnhancing).toBe(false);
    const second = actions.enhancePromptDraft(promptText);
    expect(actions.promptEnhancing).toBe(true);

    expect(client.enhancePrompt).toHaveBeenCalledTimes(2);
    firstResponse.resolve("stale enhancement");
    await first;
    expect(setPromptText).not.toHaveBeenCalled();
    expect(actions.promptEnhancing).toBe(true);

    secondResponse.resolve("current enhancement");
    await second;
    expect(actions.promptEnhancing).toBe(false);
    expect(setPromptText).toHaveBeenCalledWith("current enhancement");
  });
});
