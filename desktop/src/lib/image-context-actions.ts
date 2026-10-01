import { invoke } from "@tauri-apps/api/core";
import { writeImage } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cachePastedAttachment } from "../app/attachment-io";
import { normalizeExternalHref } from "./markdown-links";

// Bound canvas allocation; conversion happens only after explicit activation.
const MAX_IMAGE_PIXELS = 16_777_216;

async function imagePng(image: HTMLImageElement): Promise<Blob> {
  if (!image.complete || !image.naturalWidth || !image.naturalHeight) {
    throw new Error("Image is not loaded. Wait for it to load and try again.");
  }
  if (image.naturalWidth * image.naturalHeight > MAX_IMAGE_PIXELS) {
    throw new Error("Image is too large to copy. Open it in an external application instead.");
  }
  const canvas = image.ownerDocument.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image conversion is unavailable.");
  context.drawImage(image, 0, 0);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not copy this image.")), "image/png");
  });
}

export async function copyContextImage(image: HTMLImageElement, isActive: () => boolean): Promise<void> {
  const blob = await imagePng(image);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (isActive() && image.isConnected) await writeImage(bytes);
}

export async function openContextImage(image: HTMLImageElement, isActive: () => boolean): Promise<void> {
  const path = image.dataset.imagePath;
  if (path) {
    await invoke("open_attachment", { path });
    return;
  }
  const source = image.currentSrc || image.src;
  const url = normalizeExternalHref(source);
  if (url && /^https?:/iu.test(url)) {
    await openUrl(url);
    return;
  }
  if (!source.startsWith("data:image/")) throw new Error("Image has no supported external source.");
  const blob = await imagePng(image);
  if (!isActive() || !image.isConnected) return;
  const cached = await cachePastedAttachment(new File([blob], "preview-image.png", { type: "image/png" }));
  if (isActive() && image.isConnected) await invoke("open_attachment", { path: cached.path });
}
