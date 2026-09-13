import { invoke } from "@tauri-apps/api/core";
import type { AcpClient } from "../lib/acp-client";
import {
  attachmentDataUrlBytes,
  type Attachment,
  type AttachmentFile,
} from "../lib/attachments";

export async function fileBase64(file: File): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`Failed to read ${file.name}.`));
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      const separator = value.indexOf(",");
      if (separator < 0) {
        reject(new Error(`Failed to encode ${file.name}.`));
        return;
      }
      resolve(value.slice(separator + 1));
    };
    reader.readAsDataURL(file);
  });
}

export async function cachePastedAttachment(file: File): Promise<AttachmentFile> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return invoke<AttachmentFile>("cache_attachment", bytes, {
    headers: { "x-pix-attachment-name": utf8Base64(file.name) },
  });
}

export async function cachePastedTaskAttachment(
  file: File,
  workspace: string,
): Promise<AttachmentFile> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return cacheTaskAttachmentBytes(file.name, bytes, workspace);
}

async function cacheTaskAttachmentBytes(
  name: string,
  bytes: Uint8Array,
  workspace: string,
): Promise<AttachmentFile> {
  return invoke<AttachmentFile>("cache_task_attachment", bytes, {
    headers: {
      "x-pix-attachment-name": utf8Base64(name),
      "x-pix-workspace": utf8Base64(workspace),
    },
  });
}

export async function persistTaskAttachment(
  attachment: Attachment,
  workspace: string,
): Promise<Attachment> {
  if (!attachment.path) return attachment;
  const stored = await invoke<AttachmentFile>("persist_task_attachment", {
    workspace,
    path: attachment.path,
  });
  return { ...attachment, path: stored.path, size: stored.size };
}

export async function materializeComposerTaskAttachments(
  attachments: readonly Attachment[],
  workspace: string,
  client: AcpClient | null,
  sessionId: string | null,
): Promise<Attachment[]> {
  const stored: Attachment[] = [];
  for (const attachment of attachments) {
    if (attachment.path) {
      stored.push(await persistTaskAttachment(attachment, workspace));
      continue;
    }

    let dataUrl = attachment.dataUrl;
    if (!dataUrl && attachment.deferredImageId && client && sessionId) {
      const image = await client.sessionImage(sessionId, attachment.deferredImageId);
      dataUrl = `data:${image.mimeType};base64,${image.data}`;
    }
    const bytes = dataUrl ? attachmentDataUrlBytes(dataUrl) : undefined;
    if (!bytes) throw new Error(`Cannot persist attachment ${attachment.name} in a project task.`);
    const cached = await cacheTaskAttachmentBytes(attachment.name, bytes, workspace);
    stored.push({ ...attachment, path: cached.path, size: cached.size });
  }
  return stored;
}

function utf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodedQuestionImageBytes(value: string): number | null {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}
