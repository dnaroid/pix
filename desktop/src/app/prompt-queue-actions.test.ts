import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcpClient, QueueItem, QueuedUserMessage } from "../lib/acp-client";
import { createPromptQueueActions } from "./prompt-queue-actions.svelte";
import { createTranscriptScrollController } from "./transcript-scroll.svelte";

type Options = Parameters<typeof createPromptQueueActions>[0];

const message: QueuedUserMessage = {
  id: "queued-1", promptText: "Continue", displayText: "Continue", images: [],
};
const item: QueueItem = {
  id: message.id, source: "deferred", mode: "steering", index: 0,
  text: message.displayText, message,
};

function pending() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  let sessionId = "session-1";
  const client = { queueAction: vi.fn().mockResolvedValue({ message }) };
  let currentClient: AcpClient | null = client as unknown as AcpClient;
  const pane = { scrollTop: 100, scrollHeight: 1000, clientHeight: 300 };
  const scroll = createTranscriptScrollController({
    activeSessionId: () => sessionId,
    pane: () => pane as HTMLDivElement,
    content: () => null,
  });
  scroll.handleScroll();
  const options: Options = {
    client: () => currentClient,
    activeSessionId: () => sessionId,
    promptText: () => "",
    promptAttachments: () => [],
    setPromptText: vi.fn(), setPromptAttachments: vi.fn(),
    attachmentDraftKey: () => sessionId, attachmentGeneration: () => 0,
    invalidateAttachmentDraft: vi.fn(), bumpAttachmentGeneration: vi.fn(),
    imagePromptSupported: () => true,
    promptRuntime: {
      promptRun: vi.fn(), runPromptRequest: vi.fn().mockResolvedValue(undefined),
    } as unknown as Options["promptRuntime"],
    appendQueuedMessage: vi.fn(() => { pane.scrollHeight = 1300; return "queued:queued-1"; }),
    restoreQueuedMessage: vi.fn(), focusComposer: vi.fn(),
    scrollToLatest: vi.fn(scroll.scrollToLatest),
    refreshSessions: vi.fn(), setErrorMessage: vi.fn(), reportError: vi.fn(),
  };
  return {
    options, client, pane, scroll, actions: createPromptQueueActions(options),
    switchSession: () => { sessionId = "session-2"; },
    disconnect: () => { currentClient = null; },
  };
}

describe("queued send latest-content intent", () => {
  afterEach(() => vi.restoreAllMocks());

  it("scrolls fully down after append and resumes following before starting the prompt", async () => {
    const { actions, options, pane, scroll } = setup();
    expect(scroll.followsLatest).toBe(false);
    vi.mocked(options.promptRuntime.runPromptRequest).mockImplementation(async () => {
      expect(pane.scrollTop).toBe(1300);
      expect(scroll.followsLatest).toBe(true);
    });
    await actions.actOnQueuedMessage(item, "send-now");
    expect(options.appendQueuedMessage).toHaveBeenCalledWith("session-1", message);
    expect(options.scrollToLatest).toHaveBeenCalledOnce();
    expect(options.promptRuntime.runPromptRequest).toHaveBeenCalledOnce();
  });

  it.each(["edit", "cancel"] as const)("does not scroll for %s", async (action) => {
    const { actions, options } = setup();
    await actions.actOnQueuedMessage(item, action);
    expect(options.appendQueuedMessage).not.toHaveBeenCalled();
    expect(options.scrollToLatest).not.toHaveBeenCalled();
    expect(options.promptRuntime.runPromptRequest).not.toHaveBeenCalled();
  });

  it.each(["session", "client"] as const)("ignores a stale %s after waiting for the old run", async (ownership) => {
    const { actions, options, switchSession, disconnect } = setup();
    const oldRun = pending();
    const waiting = pending();
    vi.mocked(options.promptRuntime.promptRun).mockImplementation(() => {
      waiting.resolve();
      return oldRun.promise;
    });
    const sending = actions.actOnQueuedMessage(item, "send-now");
    await waiting.promise;
    if (ownership === "session") switchSession();
    else disconnect();
    oldRun.resolve();
    await sending;
    expect(options.appendQueuedMessage).not.toHaveBeenCalled();
    expect(options.scrollToLatest).not.toHaveBeenCalled();
    expect(options.promptRuntime.runPromptRequest).not.toHaveBeenCalled();
    expect(actions.actionRunning).toBe(false);
  });

  it("does not start a stale request after scroll rendering yields", async () => {
    const { actions, options, switchSession } = setup();
    vi.mocked(options.scrollToLatest).mockImplementation(async () => { switchSession(); });
    await actions.actOnQueuedMessage(item, "send-now");
    expect(options.promptRuntime.runPromptRequest).not.toHaveBeenCalled();
    expect(actions.actionRunning).toBe(false);
  });
});
