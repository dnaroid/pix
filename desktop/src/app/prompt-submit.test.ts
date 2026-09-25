import { describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import { createPromptSubmit } from "./prompt-submit";

describe("createPromptSubmit terminal commands", () => {
  it("renders the first normal draft prompt optimistically before materialization finishes", async () => {
    let promptText = "Implement the subsystem";
    const promptAttachments: never[] = [];
    let activeSessionId: string | null = null;
    let finishMaterialization!: (sessionId: string | null) => void;
    const materializeDraftSession = vi.fn(() => new Promise<string | null>((resolve) => {
      finishMaterialization = (sessionId) => {
        activeSessionId = sessionId;
        resolve(sessionId);
      };
    }));
    const rollbackOptimisticMessage = vi.fn();
    const appendUserMessage = vi.fn(() => rollbackOptimisticMessage);
    const beginOptimisticDraftSubmit = vi.fn(() => true);
    const runPromptRequest = vi.fn(async () => {});
    const client = {} as AcpClient;
    const submit = createPromptSubmit({
      client: () => client,
      sessionMutationRunning: () => false,
      sessionHistoryLoading: () => false,
      waitForAttachmentDraftSettled: async () => {},
      attachmentDraftKey: () => activeSessionId ? "session" : "draft",
      attachmentGeneration: () => 1,
      promptText: () => promptText,
      promptAttachments: () => promptAttachments,
      setPromptText: (text: string) => { promptText = text; },
      activeSessionId: () => activeSessionId,
      draftSessionTabActive: () => activeSessionId === null,
      beginOptimisticDraftSubmit,
      materializeDraftSession,
      activeSessionRuntimeReady: () => true,
      promptRunning: () => false,
      openSessionStartTab: async () => {},
      enhancePromptDraft: async () => {},
      importConversationPath: async () => {},
      chooseImportSession: async () => {},
      requestLocalTextInput: async () => undefined,
      deferDraft: async () => {},
      resumeConversationPath: async () => {},
      openSessionSelector: () => {},
      openJumpPicker: async () => {},
      openHistoryPicker: async () => {},
      showDesktopHotkeys: () => {},
      reloadResources: async () => {},
      forkConversation: async () => {},
      openInteractiveTerminal: async () => {},
      closeProjectSelector: () => {},
      closeSessionSelector: () => {},
      applyModelSlashCommand: async () => {},
      applyThinkingSlashCommand: async () => {},
      setCommandPicker: () => {},
      displayedConfigOptions: () => [],
      queueDraftForCurrentRun: async () => {},
      imagePromptSupported: () => true,
      invalidateAttachmentDraft: () => {},
      nextLocalMessageId: () => "local:1",
      appendUserMessage,
      scrollToLatest: async () => {},
      prompts: { runPromptRequest } as never,
      refreshAutocompleteSettings: async () => {},
      refreshSessions: async () => {},
      setErrorMessage: () => {},
      reportError: (error: unknown) => { throw error; },
    });

    const pendingSubmit = submit.submit();
    await vi.waitFor(() => expect(materializeDraftSession).toHaveBeenCalled());

    expect(beginOptimisticDraftSubmit).toHaveBeenCalledWith("Implement the subsystem", []);
    expect(promptText).toBe("");
    expect(appendUserMessage).toHaveBeenCalledWith("Implement the subsystem", "local:1", []);
    expect(materializeDraftSession).toHaveBeenCalledWith("Implement the subsystem", 0);
    expect(runPromptRequest).not.toHaveBeenCalled();

    finishMaterialization("session-auto");
    await pendingSubmit;

    expect(runPromptRequest).toHaveBeenCalled();
    expect(rollbackOptimisticMessage).not.toHaveBeenCalled();
  });

  it("opens !! in the interactive terminal without materializing or queueing a Pi session", async () => {
    let promptText = "!!  git status  ";
    const bash = vi.fn(async () => {});
    const openInteractiveTerminal = vi.fn(async () => {});
    const queueDraftForCurrentRun = vi.fn(async () => {});
    const runPromptRequest = vi.fn(async () => {});
    const client = { bash } as unknown as AcpClient;

    const submit = createPromptSubmit({
      client: () => null,
      sessionMutationRunning: () => false,
      sessionHistoryLoading: () => false,
      waitForAttachmentDraftSettled: async () => {},
      attachmentDraftKey: () => "draft",
      attachmentGeneration: () => 1,
      promptText: () => promptText,
      promptAttachments: () => [],
      setPromptText: (text: string) => { promptText = text; },
      activeSessionId: () => null,
      draftSessionTabActive: () => true,
      beginOptimisticDraftSubmit: () => true,
      materializeDraftSession: vi.fn(async () => { throw new Error("must not materialize"); }),
      activeSessionRuntimeReady: () => false,
      promptRunning: () => true,
      openSessionStartTab: async () => {},
      enhancePromptDraft: async () => {},
      importConversationPath: async () => {},
      chooseImportSession: async () => {},
      requestLocalTextInput: async () => undefined,
      deferDraft: async () => {},
      resumeConversationPath: async () => {},
      openSessionSelector: () => {},
      openJumpPicker: async () => {},
      openHistoryPicker: async () => {},
      showDesktopHotkeys: () => {},
      reloadResources: async () => {},
      forkConversation: async () => {},
      openInteractiveTerminal,
      closeProjectSelector: () => {},
      closeSessionSelector: () => {},
      applyModelSlashCommand: async () => {},
      applyThinkingSlashCommand: async () => {},
      setCommandPicker: () => {},
      displayedConfigOptions: () => [],
      queueDraftForCurrentRun,
      imagePromptSupported: () => true,
      invalidateAttachmentDraft: () => {},
      nextLocalMessageId: () => "local:1",
      appendUserMessage: () => () => {},
      scrollToLatest: async () => {},
      prompts: { runPromptRequest } as never,
      refreshAutocompleteSettings: async () => {},
      refreshSessions: async () => {},
      setErrorMessage: () => {},
      reportError: (error: unknown) => { throw error; },
    });

    await submit.submit();

    expect(openInteractiveTerminal).toHaveBeenCalledWith("git status");
    expect(bash).not.toHaveBeenCalled();
    expect(queueDraftForCurrentRun).not.toHaveBeenCalled();
    expect(runPromptRequest).not.toHaveBeenCalled();
    expect(promptText).toBe("");
  });

  it("keeps ! on the one-shot ACP bash path", async () => {
    let promptText = "!pwd";
    const bash = vi.fn(async () => {});
    const openInteractiveTerminal = vi.fn(async () => {});
    const client = { bash } as unknown as AcpClient;

    const submit = createPromptSubmit({
      client: () => client,
      sessionMutationRunning: () => false,
      sessionHistoryLoading: () => false,
      waitForAttachmentDraftSettled: async () => {},
      attachmentDraftKey: () => "draft",
      attachmentGeneration: () => 1,
      promptText: () => promptText,
      promptAttachments: () => [],
      setPromptText: (text: string) => { promptText = text; },
      activeSessionId: () => "session-1",
      draftSessionTabActive: () => false,
      beginOptimisticDraftSubmit: () => false,
      materializeDraftSession: async () => null,
      activeSessionRuntimeReady: () => true,
      promptRunning: () => false,
      openSessionStartTab: async () => {},
      enhancePromptDraft: async () => {},
      importConversationPath: async () => {},
      chooseImportSession: async () => {},
      requestLocalTextInput: async () => undefined,
      deferDraft: async () => {},
      resumeConversationPath: async () => {},
      openSessionSelector: () => {},
      openJumpPicker: async () => {},
      openHistoryPicker: async () => {},
      showDesktopHotkeys: () => {},
      reloadResources: async () => {},
      forkConversation: async () => {},
      openInteractiveTerminal,
      closeProjectSelector: () => {},
      closeSessionSelector: () => {},
      applyModelSlashCommand: async () => {},
      applyThinkingSlashCommand: async () => {},
      setCommandPicker: () => {},
      displayedConfigOptions: () => [],
      queueDraftForCurrentRun: async () => {},
      imagePromptSupported: () => true,
      invalidateAttachmentDraft: () => {},
      nextLocalMessageId: () => "local:1",
      appendUserMessage: () => () => {},
      scrollToLatest: async () => {},
      prompts: { runPromptRequest: vi.fn(async () => {}) } as never,
      refreshAutocompleteSettings: async () => {},
      refreshSessions: async () => {},
      setErrorMessage: () => {},
      reportError: (error: unknown) => { throw error; },
    });

    await submit.submit();

    expect(bash).toHaveBeenCalledWith("session-1", "pwd", false, "!pwd");
    expect(openInteractiveTerminal).not.toHaveBeenCalled();
    expect(promptText).toBe("");
  });

  it("rolls back the optimistic draft message when materialization fails", async () => {
    let promptText = "Retry me";
    const rollbackOptimisticMessage = vi.fn();
    const submit = createPromptSubmit({
      client: () => ({} as AcpClient),
      sessionMutationRunning: () => false,
      sessionHistoryLoading: () => false,
      waitForAttachmentDraftSettled: async () => {},
      attachmentDraftKey: () => "draft",
      attachmentGeneration: () => 1,
      promptText: () => promptText,
      promptAttachments: () => [],
      setPromptText: (text: string) => { promptText = text; },
      activeSessionId: () => null,
      draftSessionTabActive: () => true,
      beginOptimisticDraftSubmit: () => true,
      materializeDraftSession: async () => null,
      activeSessionRuntimeReady: () => false,
      promptRunning: () => false,
      openSessionStartTab: async () => {},
      enhancePromptDraft: async () => {},
      importConversationPath: async () => {},
      chooseImportSession: async () => {},
      requestLocalTextInput: async () => undefined,
      deferDraft: async () => {},
      resumeConversationPath: async () => {},
      openSessionSelector: () => {},
      openJumpPicker: async () => {},
      openHistoryPicker: async () => {},
      showDesktopHotkeys: () => {},
      reloadResources: async () => {},
      forkConversation: async () => {},
      openInteractiveTerminal: async () => {},
      closeProjectSelector: () => {},
      closeSessionSelector: () => {},
      applyModelSlashCommand: async () => {},
      applyThinkingSlashCommand: async () => {},
      setCommandPicker: () => {},
      displayedConfigOptions: () => [],
      queueDraftForCurrentRun: async () => {},
      imagePromptSupported: () => true,
      invalidateAttachmentDraft: () => {},
      nextLocalMessageId: () => "local:1",
      appendUserMessage: () => rollbackOptimisticMessage,
      scrollToLatest: async () => {},
      prompts: { runPromptRequest: vi.fn(async () => {}) } as never,
      refreshAutocompleteSettings: async () => {},
      refreshSessions: async () => {},
      setErrorMessage: () => {},
      reportError: (error: unknown) => { throw error; },
    });

    await submit.submit();

    expect(rollbackOptimisticMessage).toHaveBeenCalledOnce();
  });
});
