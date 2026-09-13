import { describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import { createPromptSubmit } from "./prompt-submit";

describe("createPromptSubmit terminal commands", () => {
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
      appendUserMessage: () => {},
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
      appendUserMessage: () => {},
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
});
