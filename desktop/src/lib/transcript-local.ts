import type { Attachment } from "./attachments";
import type { TranscriptState } from "./transcript-types";

export function hydrateTranscriptAttachment(
  state: TranscriptState,
  attachmentId: string,
  dataUrl: string,
  mimeType?: string,
): TranscriptState {
  let changed = false;
  const items = state.items.map((item) => {
    if (!item.attachments.some((attachment) => attachment.id === attachmentId)) return item;
    const attachments = item.attachments.map((attachment) => {
      if (attachment.id !== attachmentId) return attachment;
      changed = true;
      return { ...attachment, dataUrl, ...(mimeType ? { mimeType } : {}) };
    });
    return { ...item, attachments };
  });
  return changed ? { items } : state;
}

export function appendLocalUserMessage(
  state: TranscriptState,
  text: string,
  id: string,
  attachments: readonly Attachment[] = [],
  options: { localOnly?: boolean } = {},
): TranscriptState {
  return {
    items: [
      ...state.items,
      {
        type: "message",
        id,
        role: "user",
        text,
        attachments,
        ...(options.localOnly ? { localOnly: true } : {}),
      },
    ],
  };
}

export function appendLocalSystemMessage(state: TranscriptState, text: string, id: string): TranscriptState {
  return {
    items: [...state.items, { type: "message", id, role: "system", text, attachments: [] }],
  };
}

export function bindLocalUserMessageSessionEntry(
  state: TranscriptState,
  messageId: string,
  sessionEntryId: string | undefined,
): TranscriptState {
  let changed = false;
  const items = state.items.map((item) => {
    if (item.type !== "message" || item.role !== "user" || item.id !== messageId) return item;
    changed = true;
    const { sessionEntryId: _sessionEntryId, localOnly: _localOnly, ...base } = item;
    return sessionEntryId
      ? { ...base, sessionEntryId }
      : { ...base, localOnly: true };
  });
  return changed ? { items } : state;
}
