import type { AcpClient } from "../lib/acp-client";
import type { Attachment } from "../lib/attachments";
import { buildPromptPayload } from "./prompt-payload";
import type { createPromptRuntime } from "./prompt-runtime.svelte";

export type MessageEdit = { text: string; attachments: readonly Attachment[] };

export function createEditedMessageSubmit(options: {
  client: () => AcpClient | null;
  sessionId: () => string | null;
  prompts: Pick<ReturnType<typeof createPromptRuntime>, "hasPromptRun" | "isRunning" | "runPromptRequest">;
  imagePromptSupported: () => boolean;
  nextLocalMessageId: () => string;
  appendUserMessage: (text: string, id: string, attachments: readonly Attachment[]) => () => void;
  scrollToLatest: () => Promise<void>;
  refreshSessions: () => void | Promise<void>;
  reportError: (error: unknown) => void;
}) {
  // Resolve and validate attachments BEFORE touching the active history.
  return async function prepare(sessionId: string, edit: MessageEdit): Promise<() => void> {
    const client = options.client();
    if (!client || options.sessionId() !== sessionId) throw new Error("The conversation changed.");
    const attachments = await Promise.all(edit.attachments.map(async (attachment) => {
      if (!attachment.deferredImageId || attachment.dataUrl) return attachment;
      const image = await client.sessionImage(sessionId, attachment.deferredImageId);
      return { ...attachment, dataUrl: `data:${image.mimeType};base64,${image.data}` };
    }));
    const payload = buildPromptPayload(edit.text, attachments, options.imagePromptSupported());
    return () => {
      if (client !== options.client() || options.sessionId() !== sessionId
        || options.prompts.hasPromptRun(sessionId) || options.prompts.isRunning(sessionId)) {
        throw new Error("The conversation changed before resending the message.");
      }
      const id = options.nextLocalMessageId();
      const rollback = options.appendUserMessage(edit.text, id, attachments);
      // The runtime claims the session synchronously. Do not hold the mutation
      // lock for the response, or clear the independent composer draft.
      void options.prompts.runPromptRequest(client, sessionId, payload.blocks, payload.fileImages, id)
        .catch((error: unknown) => { rollback(); options.reportError(error); });
      void options.scrollToLatest();
      void options.refreshSessions();
    };
  };
}
