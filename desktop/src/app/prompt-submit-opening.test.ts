import { expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import { createPromptSubmit } from "./prompt-submit";

function setup() {
  let text = "Send immediately";
  let sessionId = "opening";
  let client = {} as AcpClient;
  let loaded = false;
  let running = false;
  const attachments = [{ id: "file", name: "file.txt", kind: "file", path: "/project/file.txt", mimeType: "text/plain" }] as never[];
  let finish!: (ready: boolean) => void;
  const waitForSessionReady = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  const runPromptRequest = vi.fn(async (_client: AcpClient, _sessionId: string) => {});
  const appendUserMessage = vi.fn(() => () => {});
  const reportError = vi.fn();
  const queueDraftForCurrentRun = vi.fn(async () => {});
  const noop = async () => {};
  const submit = createPromptSubmit({
    client: () => client,
    sessionMutationRunning: () => false,
    sessionHistoryLoading: () => !loaded,
    waitForAttachmentDraftSettled: noop,
    attachmentDraftKey: () => sessionId,
    attachmentGeneration: () => 1,
    promptText: () => text,
    promptAttachments: () => attachments,
    setPromptText: (value) => { text = value; },
    activeSessionId: () => sessionId,
    draftSessionTabActive: () => false,
    beginOptimisticDraftSubmit: () => false,
    materializeDraftSession: async () => null,
    sessionRuntimeReady: () => loaded,
    waitForSessionReady,
    promptRunning: () => running,
    openSessionStartTab: noop,
    enhancePromptDraft: noop,
    importConversationPath: noop,
    chooseImportSession: noop,
    requestLocalTextInput: async () => undefined,
    deferDraft: noop,
    resumeConversationPath: noop,
    openSessionSelector: noop,
    openJumpPicker: noop,
    openHistoryPicker: noop,
    showDesktopHotkeys: noop,
    reloadResources: noop,
    forkConversation: noop,
    openInteractiveTerminal: noop,
    closeProjectSelector: noop,
    closeSessionSelector: noop,
    applyModelSlashCommand: noop,
    applyThinkingSlashCommand: noop,
    setCommandPicker: noop,
    displayedConfigOptions: () => [],
    runtimeExtensionCommand: () => false,
    queueDraftForCurrentRun,
    imagePromptSupported: () => true,
    invalidateAttachmentDraft: noop,
    nextLocalMessageId: () => "local:opening",
    appendUserMessage,
    scrollToLatest: noop,
    prompts: { runPromptRequest } as never,
    refreshAutocompleteSettings: noop,
    refreshSessions: noop,
    setErrorMessage: noop,
    reportError,
  });
  return {
    submit, waitForSessionReady, runPromptRequest, appendUserMessage, reportError, attachments, queueDraftForCurrentRun,
    get text() { return text; },
    setText(value: string) { text = value; },
    select(value: string) { sessionId = value; },
    replaceClient() { client = {} as AcpClient; },
    finish(value: boolean) { finish(value); },
    setLoadedAndRunning() { loaded = true; running = true; },
  };
}

it("accepts text and attachments before startup, sends exactly once to the captured session", async () => {
  const ctx = setup();
  const pending = ctx.submit.submit();
  await vi.waitFor(() => expect(ctx.waitForSessionReady).toHaveBeenCalledOnce());
  expect(ctx.text).toBe("");
  expect(ctx.appendUserMessage).toHaveBeenCalledWith("Send immediately", "local:opening", ctx.attachments);
  expect(ctx.runPromptRequest).not.toHaveBeenCalled();
  ctx.setText("Next editable draft");
  await ctx.submit.submit();
  expect(ctx.text).toBe("Next editable draft");
  expect(ctx.appendUserMessage).toHaveBeenCalledOnce();
  ctx.select("other");
  ctx.setText("Other tab input");
  ctx.finish(true);
  await pending;
  expect(ctx.runPromptRequest).toHaveBeenCalledOnce();
  expect(ctx.runPromptRequest.mock.calls[0]?.[1]).toBe("opening");
  expect(ctx.text).toBe("Other tab input");
});

it("allows follow-up queueing once startup is complete, without waiting for the first response", async () => {
  const ctx = setup();
  let finishResponse!: () => void;
  ctx.runPromptRequest.mockImplementationOnce(() => new Promise<void>((resolve) => { finishResponse = resolve; }));
  const pending = ctx.submit.submit();
  await vi.waitFor(() => expect(ctx.waitForSessionReady).toHaveBeenCalledOnce());
  ctx.setLoadedAndRunning();
  ctx.finish(true);
  await vi.waitFor(() => expect(ctx.runPromptRequest).toHaveBeenCalledOnce());
  ctx.setText("Follow-up");
  await ctx.submit.submit();
  expect(ctx.queueDraftForCurrentRun).toHaveBeenCalledOnce();
  finishResponse();
  await pending;
});

it.each(["failed", "client changed"])("does not send when opening is invalidated: %s", async (reason) => {
  const ctx = setup();
  const pending = ctx.submit.submit();
  await vi.waitFor(() => expect(ctx.waitForSessionReady).toHaveBeenCalledOnce());
  if (reason === "client changed") ctx.replaceClient();
  ctx.finish(reason !== "failed");
  await pending;
  expect(ctx.runPromptRequest).not.toHaveBeenCalled();
  expect(ctx.reportError).toHaveBeenCalledOnce();
  expect(ctx.appendUserMessage).toHaveBeenCalledOnce();
});

it.each(["/model", "! pwd"])("leaves runtime-dependent command input intact during opening: %s", async (text) => {
  const ctx = setup();
  ctx.setText(text);
  // Commands with attachments are rejected without consuming the input too.
  await ctx.submit.submit();
  expect(ctx.text).toBe(text);
  expect(ctx.waitForSessionReady).not.toHaveBeenCalled();
});
