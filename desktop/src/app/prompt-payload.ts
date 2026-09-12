import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { PromptFileImage } from "../lib/acp-client";
import {
  MAX_EMBEDDED_ATTACHMENT_BYTES,
  MAX_EMBEDDED_PROMPT_BYTES,
  fileUriFromPath,
  type Attachment,
} from "../lib/attachments";

export function buildPromptPayload(
  text: string,
  attachments: readonly Attachment[],
  imagePromptSupported: boolean,
): { blocks: ContentBlock[]; fileImages: PromptFileImage[] } {
  const blocks: ContentBlock[] = [];
  const fileImages: PromptFileImage[] = [];
  let embeddedBytes = 0;
  if (text) blocks.push({ type: "text", text });
  for (const attachment of attachments) {
    if (attachment.kind === "image" && imagePromptSupported) {
      if (attachment.path) {
        if ((attachment.size ?? 0) > MAX_EMBEDDED_ATTACHMENT_BYTES) {
          throw new Error(`${attachment.name} is too large to send as an image (maximum 25 MB).`);
        }
        embeddedBytes += attachment.size ?? 0;
        if (embeddedBytes > MAX_EMBEDDED_PROMPT_BYTES) {
          throw new Error("Attached images exceed the 50 MB combined prompt limit.");
        }
        const uri = fileUriFromPath(attachment.path);
        blocks.push({
          type: "resource_link",
          uri,
          name: attachment.name,
          mimeType: attachment.mimeType,
          ...(attachment.size ? { size: attachment.size } : {}),
        });
        fileImages.push({
          uri,
          mimeType: attachment.mimeType,
          ...(attachment.size === undefined ? {} : { size: attachment.size }),
          name: attachment.name,
        });
        continue;
      }

      const dataUrl = attachment.dataUrl;
      if (!dataUrl) throw new Error(`Cannot read ${attachment.name}.`);
      const separator = dataUrl.indexOf(",");
      if (separator < 0) throw new Error(`Cannot decode ${attachment.name}.`);
      const data = dataUrl.slice(separator + 1);
      embeddedBytes += Math.floor(data.length * 3 / 4);
      if (embeddedBytes > MAX_EMBEDDED_PROMPT_BYTES) {
        throw new Error("Attached images exceed the 50 MB combined prompt limit.");
      }
      blocks.push({ type: "image", data, mimeType: attachment.mimeType });
      continue;
    }
    if (!attachment.path) {
      throw new Error(`${attachment.name} cannot be sent because it has no local path.`);
    }
    blocks.push({
      type: "resource_link",
      uri: fileUriFromPath(attachment.path),
      name: attachment.name,
      mimeType: attachment.mimeType,
      ...(attachment.size ? { size: attachment.size } : {}),
    });
  }
  return { blocks, fileImages };
}
