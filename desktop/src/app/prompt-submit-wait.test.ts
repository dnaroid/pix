import { expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import { createPromptSubmit } from "./prompt-submit";

it.each([false, true])("wait is out-of-band with running=%s", async (running) => {
  let text = "/wait 1h20m";
  const attachments: never[] = [];
  const prompt = vi.fn(async () => ({ stopReason: "end_turn" }));
  const appendUserMessage = vi.fn();
  const runPromptRequest = vi.fn();
  const submit = createPromptSubmit({
    client: () => ({ prompt }) as unknown as AcpClient,
    sessionMutationRunning: () => false,
    sessionHistoryLoading: () => false,
    waitForAttachmentDraftSettled: async () => {},
    attachmentDraftKey: () => "session",
    attachmentGeneration: () => 1,
    promptText: () => text,
    promptAttachments: () => attachments,
    setPromptText: (value) => { text = value; },
    activeSessionId: () => "session",
    draftSessionTabActive: () => false,
    beginOptimisticDraftSubmit: () => true,
    materializeDraftSession: async () => null,
    sessionRuntimeReady: () => true,
    promptRunning: () => running,
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
    runtimeExtensionCommand: () => true,
    queueDraftForCurrentRun: async () => { throw new Error("must not queue"); },
    imagePromptSupported: () => true,
    invalidateAttachmentDraft: () => {},
    nextLocalMessageId: () => "local:1",
    appendUserMessage,
    scrollToLatest: async () => {},
    prompts: { runPromptRequest } as never,
    refreshAutocompleteSettings: async () => {},
    refreshSessions: async () => {},
    setErrorMessage: () => {},
    reportError: (error) => { throw error; },
  });
  await submit.submit();
  expect(prompt).toHaveBeenCalledWith("session", [{ type: "text", text: "/wait 1h20m" }]);
  expect(appendUserMessage).not.toHaveBeenCalled();
  expect(runPromptRequest).not.toHaveBeenCalled();
  expect(text).toBe("");
});
