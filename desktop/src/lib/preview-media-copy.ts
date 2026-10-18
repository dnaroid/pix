import { invoke } from "@tauri-apps/api/core";
import type { Attachment } from "./attachments";
import { copyContextImage } from "./image-context-actions";
import { contextFilePath } from "./desktop-context-target";

export function previewCopyFilePath(path: string | undefined, workspace: string): string | undefined {
  if (path?.startsWith("~/") && !path.includes("\0")) return path;
  return contextFilePath(path, workspace);
}

export async function copyPreviewFile(path: string, isCurrent: () => boolean): Promise<void> {
  if (isCurrent()) await invoke("preview_file_action", { path, action: "copy" });
}

/** Reuse approved image decoding and the native file-pasteboard action. */
export async function copyPreviewMedia(
  attachment: Attachment,
  image: HTMLImageElement | undefined,
  isCurrent: () => boolean,
): Promise<void> {
  if (!isCurrent()) return;
  if (attachment.kind === "image") {
    if (!image) throw new Error("Image is not loaded. Wait for it to load and try again.");
    await copyContextImage(image, isCurrent);
  } else if (attachment.kind === "video") {
    if (!attachment.path) throw new Error("This video has no local file to copy.");
    await copyPreviewFile(attachment.path, isCurrent);
  }
}
