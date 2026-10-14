import type { AcpClient } from "../lib/acp-client";
import type { Attachment } from "../lib/attachments";
import { applySessionUpdates, emptyTranscript, markDeferredToolResults, type MessageItem } from "../lib/transcript";
import type { ActiveSessionState } from "./active-session-state.svelte";
import type { MessageEdit } from "./edited-message-submit";

/** Draft-owned editing. Selecting/cancelling never navigates the session tree. */
export function createComposerMessageEdit(options: {
  client: () => AcpClient | null;
  state: ActiveSessionState;
  draftKey: () => string;
  promptText: () => string;
  promptAttachments: () => readonly Attachment[];
  setPromptText: (text: string) => void;
  setPromptAttachments: (attachments: Attachment[]) => void;
  invalidateAttachments: () => void;
  operationRunning: () => boolean;
  promptRunning: (sessionId: string) => boolean;
  historyLoading: () => boolean;
  setOperationRunning: (value: boolean) => void;
  prepare: (sessionId: string, edit: MessageEdit) => Promise<() => void>;
  markHistoryFullyLoaded: (sessionId: string) => void;
  focus: () => void | Promise<void>;
  reportError: (error: unknown) => void;
}) {
  type Pending = {
    client: AcpClient; sessionId: string; entryId: string;
    transcript: ActiveSessionState["transcript"]; previous: MessageEdit;
  };
  let drafts = $state(new Map<string, Pending>());
  const current = () => drafts.get(options.draftKey());
  // Background sessions must not lock selection, Cancel or Send in this draft.
  const busy = (sessionId: string) => options.operationRunning()
    || options.promptRunning(sessionId) || options.historyLoading();
  function remove(key: string) {
    const next = new Map(drafts); next.delete(key); drafts = next;
  }
  function prune(client: AcpClient | null, openDraftKeys: readonly string[]): void {
    const open = new Set(openDraftKeys);
    drafts = new Map([...drafts].filter(([key, pending]) => pending.client === client && open.has(key)));
  }
  function begin(entryId: string, message: MessageItem) {
    const client = options.client();
    const sessionId = options.state.sessionId;
    if (!client || !sessionId || busy(sessionId)) return;
    const previous = current()?.previous ?? {
      text: options.promptText(), attachments: [...options.promptAttachments()],
    };
    drafts = new Map(drafts).set(options.draftKey(), {
      client, sessionId, entryId, transcript: options.state.transcript, previous,
    });
    options.invalidateAttachments();
    options.setPromptText(message.text);
    options.setPromptAttachments(message.attachments.map((attachment) => ({ ...attachment })));
    void options.focus();
  }
  function cancel() {
    const pending = current();
    if (!pending || busy(pending.sessionId)) return;
    remove(options.draftKey());
    options.invalidateAttachments();
    options.setPromptText(pending.previous.text);
    options.setPromptAttachments([...pending.previous.attachments]);
    void options.focus();
  }
  async function submit(): Promise<boolean> {
    const pending = current();
    if (!pending) return false;
    if (busy(pending.sessionId)) return true;
    const key = options.draftKey();
    const isCurrent = () => options.client() === pending.client
      && options.state.sessionId === pending.sessionId && options.draftKey() === key
      && current() === pending;
    const edit = { text: options.promptText(), attachments: [...options.promptAttachments()] };
    const draftUnchanged = () => options.promptText() === edit.text
      && options.promptAttachments().length === edit.attachments.length
      && options.promptAttachments().every((attachment, index) => attachment === edit.attachments[index]);
    if (!edit.text.trim() && edit.attachments.length === 0) return true;
    let rewound = false;
    options.setOperationRunning(true);
    try {
      if (!isCurrent() || options.state.transcript !== pending.transcript) {
        throw new Error("The conversation changed while editing. Cancel the edit and select the message again.");
      }
      const resend = await options.prepare(pending.sessionId, edit);
      if (!isCurrent()) return true;
      if (!draftUnchanged()) throw new Error("The edited draft changed while preparing. Send again.");
      if (options.state.transcript !== pending.transcript) throw new Error("The conversation changed while preparing the edit.");
      const result = await pending.client.userMessageAction(pending.sessionId, pending.entryId, "rewind");
      if (result.status === "cancelled") return true;
      rewound = true;
      // Rewind has committed even when selection changes during the RPC. Never
      // keep a retryable edit or a cached pre-rewind branch after this point.
      if (options.client() !== pending.client) return true;
      options.state.setTranscriptFor(pending.sessionId, emptyTranscript);
      const history = await pending.client.sessionHistory(pending.sessionId, true);
      if (options.client() !== pending.client) return true;
      const loaded = markDeferredToolResults(applySessionUpdates(emptyTranscript, history.updates), history.deferredToolCallIds);
      options.state.setTranscriptFor(pending.sessionId, loaded);
      options.markHistoryFullyLoaded(pending.sessionId);
      if (!isCurrent()) return true;
      resend();
      if (draftUnchanged()) {
        options.invalidateAttachments();
        options.setPromptText("");
        options.setPromptAttachments([]);
      }
    } catch (error) {
      if (isCurrent()) options.reportError(error);
    } finally {
      if (rewound && drafts.get(key) === pending) remove(key);
      // Operation ownership is global: release even if selection changed.
      options.setOperationRunning(false);
    }
    return true;
  }
  return { begin, cancel, submit, prune, dispose: () => { drafts = new Map(); }, get active() { return current() !== undefined; } };
}
