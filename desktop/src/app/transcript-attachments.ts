import { invoke } from "@tauri-apps/api/core";
import type { AcpClient } from "../lib/acp-client";
import type { Attachment, AttachmentFile } from "../lib/attachments";
import {
  hydrateTranscriptAttachment,
} from "../lib/transcript";
import type { ActiveSessionState } from "./active-session-state.svelte";

type TranscriptAttachmentControllerOptions = {
  client: () => AcpClient | null;
  state: ActiveSessionState;
};

export function createTranscriptAttachmentController(options: TranscriptAttachmentControllerOptions) {
  const registeredPaths = new Set<string>();
  const preparingPaths = new Map<string, Promise<void>>();
  const preparingDeferredImages = new Map<string, Promise<void>>();

  function prepare(attachment: Attachment): Promise<void> {
    if (attachment.deferredImageId && !attachment.dataUrl) {
      const requestClient = options.client();
      const sessionId = options.state.sessionId;
      if (!requestClient || !sessionId) return Promise.resolve();
      const key = `${sessionId}\0${attachment.deferredImageId}`;
      const existingImage = preparingDeferredImages.get(key);
      if (existingImage) return existingImage;
      const pendingImage = requestClient.sessionImage(sessionId, attachment.deferredImageId)
        .then((image) => {
          if (requestClient !== options.client()) return;
          const current = options.state.transcriptFor(sessionId);
          if (!current) return;
          options.state.setTranscriptFor(
            sessionId,
            hydrateTranscriptAttachment(
              current,
              attachment.id,
              `data:${image.mimeType};base64,${image.data}`,
              image.mimeType,
            ),
          );
        })
        .finally(() => {
          if (preparingDeferredImages.get(key) === pendingImage) preparingDeferredImages.delete(key);
        });
      preparingDeferredImages.set(key, pendingImage);
      return pendingImage;
    }

    const path = attachment.path;
    if (!path || attachment.dataUrl || registeredPaths.has(path)) return Promise.resolve();
    const existing = preparingPaths.get(path);
    if (existing) return existing;
    const pending = invoke<AttachmentFile[]>("inspect_attachments", { paths: [path] })
      .then(() => {
        registeredPaths.add(path);
      })
      .finally(() => {
        if (preparingPaths.get(path) === pending) preparingPaths.delete(path);
      });
    preparingPaths.set(path, pending);
    return pending;
  }

  function reset(): void {
    registeredPaths.clear();
    preparingPaths.clear();
    preparingDeferredImages.clear();
  }

  return { prepare, reset };
}
