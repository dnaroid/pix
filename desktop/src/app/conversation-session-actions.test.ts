import { describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import { createConversationSessionActions } from "./conversation-session-actions";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe("conversation session local actions", () => {
  it("enhances a prompt without taking the global operation lock or overwriting later edits", async () => {
    const response = deferred<string>();
    const client = {
      enhancePrompt: vi.fn(() => response.promise),
    } as unknown as AcpClient;
    let promptText = "draft prompt";
    const setPromptText = vi.fn((text: string) => { promptText = text; });
    const setOperationRunning = vi.fn();
    const actions = createConversationSessionActions({
      client: () => client,
      state: { sessionId: "session-1", runtimeReady: true },
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
      reportError: vi.fn(),
    } as any);

    const pending = actions.enhancePromptDraft(promptText);
    expect(setOperationRunning).not.toHaveBeenCalled();
    expect(client.enhancePrompt).toHaveBeenCalledWith("session-1", "draft prompt");

    promptText = "user kept typing";
    response.resolve("enhanced prompt");
    await pending;

    expect(setPromptText).not.toHaveBeenCalled();
    expect(setOperationRunning).not.toHaveBeenCalled();
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
    const second = actions.enhancePromptDraft(promptText);

    expect(client.enhancePrompt).toHaveBeenCalledTimes(2);
    firstResponse.resolve("stale enhancement");
    await first;
    expect(setPromptText).not.toHaveBeenCalled();

    secondResponse.resolve("current enhancement");
    await second;
    expect(setPromptText).toHaveBeenCalledWith("current enhancement");
  });
});
