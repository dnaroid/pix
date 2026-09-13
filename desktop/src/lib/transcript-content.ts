import type { ContentBlock, ToolCallContent } from "@agentclientprotocol/sdk";
import {
  attachmentFromDeferredImage,
  attachmentFromFile,
  attachmentFromImage,
  extractAttachmentMarkers,
  fileNameFromPath,
  filePathFromUri,
  type Attachment,
} from "./attachments";
import type { ToolDiff } from "./diff";
import type { MessageRole } from "./transcript-types";

export function agentMessageRole(messageId: string | undefined): Extract<MessageRole, "assistant" | "system"> {
  return messageId?.startsWith("pix-system:") ? "system" : "assistant";
}

export function messageContent(
  content: ContentBlock,
  role: MessageRole,
  idPrefix: string,
  attachmentOffset: number,
): { text: string; attachments: Attachment[] } {
  switch (content.type) {
    case "text":
      return role === "user"
        ? extractAttachmentMarkers(content.text, idPrefix, attachmentOffset)
        : { text: content.text, attachments: [] };
    case "image":
      return {
        text: "",
        attachments: [attachmentFromImage(
          content.data,
          content.mimeType,
          `${idPrefix}:attachment:${attachmentOffset}`,
          content.uri,
        )],
      };
    case "audio":
      return { text: "[audio]", attachments: [] };
    case "resource_link": {
      if (content.uri.startsWith("pix-deferred-image:")) {
        const encoded = content.uri.slice("pix-deferred-image:".length);
        let imageId: string;
        try {
          imageId = decodeURIComponent(encoded);
        } catch {
          imageId = encoded;
        }
        return {
          text: "",
          attachments: [attachmentFromDeferredImage(
            imageId,
            content.mimeType ?? "image/png",
            `${idPrefix}:attachment:${attachmentOffset}`,
            content.name ?? undefined,
          )],
        };
      }
      const path = filePathFromUri(content.uri);
      if (!path) return { text: content.uri, attachments: [] };
      const name = content.name || fileNameFromPath(path);
      return {
        text: "",
        attachments: [attachmentFromFile(
          { path, name, size: content.size ?? 0 },
          `${idPrefix}:attachment:${attachmentOffset}`,
        )],
      };
    }
    case "resource":
      return { text: "[resource]", attachments: [] };
  }
}

export function toolContent(
  content: readonly ToolCallContent[] | null | undefined,
  idPrefix: string,
): { text: string; diffs: ToolDiff[]; attachments: Attachment[] } {
  if (!content) return { text: "", diffs: [], attachments: [] };
  const text: string[] = [];
  const diffs: ToolDiff[] = [];
  const attachments: Attachment[] = [];
  for (const item of content) {
    if (item.type === "content") {
      const next = messageContent(item.content, "assistant", idPrefix, attachments.length);
      if (next.text) text.push(next.text);
      attachments.push(...next.attachments);
    } else if (item.type === "diff") {
      diffs.push({
        path: item.path,
        ...(item.oldText === undefined ? {} : { oldText: item.oldText }),
        newText: item.newText,
      });
    } else {
      text.push(`[terminal ${item.terminalId}]`);
    }
  }
  return { text: text.join("\n"), diffs, attachments };
}
