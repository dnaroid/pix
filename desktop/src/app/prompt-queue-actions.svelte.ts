import type { Attachment } from "../lib/attachments";
import type {
  AcpClient,
  QueueAction,
  QueueItem,
  QueuedUserMessage,
} from "../lib/acp-client";
import type { createPromptRuntime } from "./prompt-runtime.svelte";
import { buildPromptPayload } from "./prompt-payload";
import { queuedMessageBlocks } from "./prompt-queue-runtime.svelte";

type PromptRuntime = ReturnType<typeof createPromptRuntime>;

type PromptQueueActionsOptions = {
  client: () => AcpClient | null;
  activeSessionId: () => string | null;
  promptText: () => string;
  promptAttachments: () => readonly Attachment[];
  setPromptText: (text: string) => void;
  setPromptAttachments: (attachments: Attachment[]) => void;
  attachmentDraftKey: () => string;
  attachmentGeneration: () => number;
  invalidateAttachmentDraft: () => void;
  bumpAttachmentGeneration: () => void;
  imagePromptSupported: () => boolean;
  promptRuntime: PromptRuntime;
  appendQueuedMessage: (sessionId: string, message: QueuedUserMessage) => string;
  restoreQueuedMessage: (message: QueuedUserMessage) => void;
  scrollToLatest: () => Promise<void>;
  focusComposer: () => void | Promise<void>;
  refreshSessions: () => void | Promise<void>;
  setErrorMessage: (message: string | null) => void;
  reportError: (error: unknown) => void;
  waitForAttachmentDraftSettled?: (key: string) => Promise<void>;
};

export function createPromptQueueActions(options: PromptQueueActionsOptions) {
  let actionRunning = $state(false);

  async function forkCurrentDraft(): Promise<void> {
    const requestClient = options.client();
    const sessionId = options.activeSessionId();
    if (!requestClient || !sessionId || actionRunning) return;
    const draftKey = options.attachmentDraftKey();
    const textBeforeWait = options.promptText();
    const generationBeforeWait = options.attachmentGeneration();
    actionRunning = true;
    try {
      await options.waitForAttachmentDraftSettled?.(draftKey);
      if (requestClient !== options.client() || sessionId !== options.activeSessionId()
        || draftKey !== options.attachmentDraftKey() || textBeforeWait !== options.promptText()
        || generationBeforeWait !== options.attachmentGeneration()) return;
      const text = options.promptText().trim();
      const attachments = options.promptAttachments();
      if (!text && attachments.length === 0) return;
      const { blocks, fileImages } = buildPromptPayload(text, attachments, options.imagePromptSupported());
      options.setErrorMessage(null);
      options.setPromptText("");
      options.invalidateAttachmentDraft();
      const clearedGeneration = options.attachmentGeneration();
      try {
        await requestClient.forkMessage(sessionId, blocks, text, fileImages);
        if (requestClient === options.client()) void options.promptRuntime.refreshQueueState(sessionId);
      } catch (error) {
        if (requestClient === options.client() && sessionId === options.activeSessionId()
          && draftKey === options.attachmentDraftKey() && clearedGeneration === options.attachmentGeneration()
          && !options.promptText() && options.promptAttachments().length === 0) {
          options.bumpAttachmentGeneration();
          options.setPromptText(text);
          options.setPromptAttachments([...attachments]);
        }
        throw error;
      }
    } catch (error) {
      if (requestClient === options.client()) options.reportError(error);
    } finally {
      actionRunning = false;
    }
  }

  async function queueDraftForCurrentRun(
    text: string,
    attachments: readonly Attachment[],
    draftKey: string,
    draftGeneration: number,
  ): Promise<void> {
    const requestClient = options.client();
    const sessionId = options.activeSessionId();
    if (!requestClient || !sessionId) return;
    try {
      const { blocks, fileImages } = buildPromptPayload(text, attachments, options.imagePromptSupported());
      if (
        requestClient !== options.client()
        || sessionId !== options.activeSessionId()
        || draftKey !== options.attachmentDraftKey()
        || draftGeneration !== options.attachmentGeneration()
        || attachments !== options.promptAttachments()
      ) return;
      options.setPromptText("");
      options.invalidateAttachmentDraft();
      await requestClient.queueMessage(sessionId, blocks, text, fileImages);
      void options.promptRuntime.refreshQueueState(sessionId);
    } catch (error) {
      if (requestClient === options.client() && sessionId === options.activeSessionId()) {
        if (!options.promptText() && options.promptAttachments().length === 0) {
          options.bumpAttachmentGeneration();
          options.setPromptText(text);
          options.setPromptAttachments([...attachments]);
        }
        options.reportError(error);
      }
    }
  }

  async function deferCurrentDraft(): Promise<void> {
    await deferDraft(options.promptText().trim(), options.promptAttachments(), { clearComposer: true });
  }

  async function deferDraft(
    text: string,
    attachments: readonly Attachment[],
    config: { clearComposer: boolean },
  ): Promise<void> {
    const requestClient = options.client();
    const sessionId = options.activeSessionId();
    if (!requestClient || !sessionId || (!text && attachments.length === 0)) return;
    const draftKey = options.attachmentDraftKey();
    const draftGeneration = options.attachmentGeneration();
    try {
      const { blocks, fileImages } = buildPromptPayload(text, attachments, options.imagePromptSupported());
      if (
        requestClient !== options.client()
        || sessionId !== options.activeSessionId()
        || draftKey !== options.attachmentDraftKey()
        || draftGeneration !== options.attachmentGeneration()
        || attachments !== options.promptAttachments()
      ) return;
      await requestClient.deferMessage(sessionId, blocks, text, fileImages);
      if (config.clearComposer) {
        options.setPromptText("");
        options.invalidateAttachmentDraft();
      }
      void options.promptRuntime.refreshQueueState(sessionId);
    } catch (error) {
      if (requestClient === options.client() && sessionId === options.activeSessionId()) options.reportError(error);
    }
  }

  async function actOnQueuedMessage(item: QueueItem, action: QueueAction): Promise<void> {
    // Fork payloads must never fall through to sending in the source session.
    if (item.source === "fork" && action === "send-now") return;
    const requestClient = options.client();
    const sessionId = options.activeSessionId();
    if (!requestClient || !sessionId || actionRunning) return;
    actionRunning = true;
    let ownsActionLock = true;
    function releaseActionLock(): void {
      if (!ownsActionLock) return;
      ownsActionLock = false;
      actionRunning = false;
    }
    const draftKey = options.attachmentDraftKey();
    const draftGeneration = options.attachmentGeneration();
    const draftText = options.promptText();
    const isCurrentSession = () => requestClient === options.client() && sessionId === options.activeSessionId();
    let releaseAutoQueue: (() => void) | undefined;
    let unsentMessage: QueuedUserMessage | undefined;
    try {
      options.setErrorMessage(null);
      if (action === "send-now") releaseAutoQueue = options.promptRuntime.holdAutoQueue(sessionId);
      const result = await requestClient.queueAction(sessionId, item, action);
      if (action === "send-now") unsentMessage = result.message;
      if (!isCurrentSession()) return;
      if (action === "edit") {
        if (!result.message) throw new Error("Queued message is no longer available.");
        options.restoreQueuedMessage(result.message);
        await options.focusComposer();
        return;
      }
      if (action !== "send-now") return;
      if (!result.message) throw new Error("Queued message is no longer available.");

      await options.promptRuntime.promptRun(sessionId)?.catch(() => undefined);
      if (!isCurrentSession()) return;
      const transcriptMessageId = options.appendQueuedMessage(sessionId, result.message);
      await options.scrollToLatest();
      if (!isCurrentSession()) return;
      const run = options.promptRuntime.runPromptRequest(
        requestClient,
        sessionId,
        queuedMessageBlocks(result.message),
        [],
        transcriptMessageId,
      );
      // The runtime now owns the prompt. Keep auto-dispatch suppressed, not the queue controls.
      releaseActionLock();
      await run;
      unsentMessage = undefined;
      void options.refreshSessions();
    } catch (error) {
      if (isCurrentSession()) options.reportError(error);
    } finally {
      if (unsentMessage) {
        try {
          await requestClient.deferMessage(sessionId, queuedMessageBlocks(unsentMessage), unsentMessage.displayText);
        } catch (error) {
          if (isCurrentSession()) {
            if (draftKey === options.attachmentDraftKey() && draftGeneration === options.attachmentGeneration()
              && draftText === options.promptText()) options.restoreQueuedMessage(unsentMessage);
            options.reportError(error);
          }
        }
      }
      releaseAutoQueue?.();
      releaseActionLock();
    }
  }

  return {
    get actionRunning() { return actionRunning; },
    queueDraftForCurrentRun,
    deferCurrentDraft,
    forkCurrentDraft,
    deferDraft,
    actOnQueuedMessage,
  };
}
