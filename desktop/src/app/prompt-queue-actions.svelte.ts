import type { Attachment } from "../lib/attachments";
import type {
  AcpClient,
  QueueAction,
  QueueItem,
  QueuedUserMessage,
} from "../lib/acp-client";
import type { createPromptRuntime } from "./prompt-runtime.svelte";
import { buildPromptPayload } from "./prompt-payload";

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
  focusComposer: () => void | Promise<void>;
  refreshSessions: () => void | Promise<void>;
  setErrorMessage: (message: string | null) => void;
  reportError: (error: unknown) => void;
};

export function createPromptQueueActions(options: PromptQueueActionsOptions) {
  let actionRunning = $state(false);

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
    const requestClient = options.client();
    const sessionId = options.activeSessionId();
    if (!requestClient || !sessionId || actionRunning) return;
    actionRunning = true;
    options.setErrorMessage(null);
    try {
      const result = await requestClient.queueAction(sessionId, item, action);
      if (requestClient !== options.client() || sessionId !== options.activeSessionId()) return;
      if (action === "edit") {
        if (!result.message) throw new Error("Queued message is no longer available.");
        options.restoreQueuedMessage(result.message);
        await options.focusComposer();
        return;
      }
      if (action !== "send-now") return;
      if (!result.message) throw new Error("Queued message is no longer available.");

      await options.promptRuntime.promptRun(sessionId)?.catch(() => undefined);
      const transcriptMessageId = options.appendQueuedMessage(sessionId, result.message);
      await options.promptRuntime.runPromptRequest(
        requestClient,
        sessionId,
        [
          ...(result.message.promptText ? [{ type: "text" as const, text: result.message.promptText }] : []),
          ...result.message.images.map((image) => ({
            type: "image" as const,
            data: image.data,
            mimeType: image.mimeType,
          })),
        ],
        [],
        transcriptMessageId,
      );
      void options.refreshSessions();
    } catch (error) {
      if (requestClient === options.client() && sessionId === options.activeSessionId()) options.reportError(error);
    } finally {
      actionRunning = false;
    }
  }

  return {
    get actionRunning() { return actionRunning; },
    queueDraftForCurrentRun,
    deferCurrentDraft,
    deferDraft,
    actOnQueuedMessage,
  };
}
