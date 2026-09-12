import type { QueuedUserMessage } from "../lib/acp-client";
import {
  attachmentFromImage,
  extractAttachmentMarkers,
  type Attachment,
} from "../lib/attachments";
import {
  appendLocalUserMessage,
  emptyTranscript,
} from "../lib/transcript";
import type { ActiveSessionState } from "./active-session-state.svelte";

type QueuedMessageControllerOptions = {
  state: ActiveSessionState;
  followsLatest: () => boolean;
  scheduleScrollToLatest: () => void;
  nextAttachmentId: () => string;
  bumpAttachmentGeneration: () => void;
  setPromptText: (text: string) => void;
  setPromptAttachments: (attachments: Attachment[]) => void;
};

export function createQueuedMessageController(options: QueuedMessageControllerOptions) {
  function draft(message: QueuedUserMessage): { text: string; attachments: Attachment[] } {
    const parsed = extractAttachmentMarkers(message.promptText, `queue:${message.id}`);
    const images = message.images.map((image) =>
      attachmentFromImage(image.data, image.mimeType, options.nextAttachmentId()));
    return {
      text: parsed.text || message.displayText,
      attachments: [...parsed.attachments, ...images],
    };
  }

  function appendToTranscript(sessionId: string, message: QueuedUserMessage): string {
    const messageId = `queued:${message.id}`;
    const current = options.state.transcriptFor(sessionId) ?? emptyTranscript;
    if (current.items.some((item) => item.type === "message" && item.id === messageId)) return messageId;
    const queuedDraft = draft(message);
    const next = appendLocalUserMessage(
      current,
      message.displayText || queuedDraft.text,
      messageId,
      queuedDraft.attachments,
    );
    options.state.setTranscriptFor(sessionId, next);
    if (sessionId === options.state.sessionId && options.followsLatest()) {
      options.scheduleScrollToLatest();
    }
    return messageId;
  }

  function restoreToComposer(message: QueuedUserMessage): void {
    const queuedDraft = draft(message);
    options.bumpAttachmentGeneration();
    options.setPromptText(queuedDraft.text);
    options.setPromptAttachments(queuedDraft.attachments);
  }

  return { draft, appendToTranscript, restoreToComposer };
}
