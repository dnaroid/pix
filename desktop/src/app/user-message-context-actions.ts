import {
  appendLocalSystemMessage,
  applySessionUpdates,
  emptyTranscript,
  markDeferredToolResults,
  type MessageItem,
} from "../lib/transcript";
import type {
  ConversationBranchActionsOptions,
  ForkConversation,
} from "./conversation-branch-options";

export type UserMessageContextAction = "copy" | "fork" | "fork-new-tab" | "undo";

export function createUserMessageContextActions(
  options: ConversationBranchActionsOptions,
  forkConversation: ForkConversation,
) {
  async function resolveUserMessageSessionEntryId(message: MessageItem): Promise<string> {
    const requestClient = options.client();
    const sessionId = options.state.sessionId;
    if (!requestClient || !sessionId || message.localOnly) {
      throw new Error("This message is not backed by a Pi session entry.");
    }
    if (message.sessionEntryId) return message.sessionEntryId;

    // History carries the persisted entry identity, not a position in the visible
    // tail. Hidden entries and in-flight prompts make positional offsets unsafe.
    const replayPrefix = "replay-entry:";
    if (message.messageId?.startsWith(replayPrefix)) {
      const entryId = message.messageId.slice(replayPrefix.length);
      if (entryId) return entryId;
    }
    throw new Error("This message's session entry is not available yet. Wait for the prompt to finish or reload the conversation.");
  }

  async function runUserMessageContextAction(
    message: MessageItem,
    action: UserMessageContextAction,
  ): Promise<void> {
    const requestClient = options.client();
    const sessionId = options.state.sessionId;
    const requestWorkspace = options.workspace();
    if (!requestClient || !sessionId) return;
    let ownsUndoOperation = false;

    if (action === "copy" && message.localOnly) {
      try {
        await navigator.clipboard.writeText(message.text);
      } catch (error) {
        options.reportError(error);
      }
      return;
    }

    try {
      const entryId = await resolveUserMessageSessionEntryId(message);
      if (
        requestClient !== options.client()
        || sessionId !== options.state.sessionId
        || requestWorkspace !== options.workspace()
      ) return;
      if (action === "copy") {
        await requestClient.userMessageAction(sessionId, entryId, "copy");
        return;
      }
      if (action === "fork") {
        await forkConversation(entryId);
        return;
      }
      if (action === "fork-new-tab") {
        await forkConversation(entryId, { keepSourceOpen: true });
        return;
      }
      if (
        !options.state.runtimeReady
        || options.operationRunning()
        || options.promptRunning()
        || options.sessionHistoryLoading()
      ) return;

      options.setOperationRunning(true);
      ownsUndoOperation = true;
      options.setErrorMessage(null);
      const result = await requestClient.userMessageAction(sessionId, entryId, "undo");
      if (
        requestClient !== options.client()
        || sessionId !== options.state.sessionId
        || requestWorkspace !== options.workspace()
      ) return;
      if (result.status === "cancelled") return;

      const history = await requestClient.sessionHistory(sessionId, true);
      if (
        requestClient !== options.client()
        || sessionId !== options.state.sessionId
        || requestWorkspace !== options.workspace()
      ) return;
      let loaded = applySessionUpdates(emptyTranscript, history.updates);
      loaded = markDeferredToolResults(loaded, history.deferredToolCallIds);
      options.markHistoryFullyLoaded(sessionId);
      const summary = result.status === "warning"
        ? `Session rewound, but workspace revert had conflicts.\n\n${result.warning ?? "Some recorded mutations could not be reverted safely."}`
        : `Undid changes from entry ${entryId}. Reverted ${result.revertedChanges ?? 0} recorded command${result.revertedChanges === 1 ? "" : "s"} across ${result.changedFiles ?? 0} file${result.changedFiles === 1 ? "" : "s"}.`;
      const next = appendLocalSystemMessage(loaded, summary, options.nextLocalMessageId());
      options.state.setTranscript(next);
      options.state.setSessionTranscript(sessionId, next);
      options.setPromptText(result.editorText ?? message.text);
      options.setPromptAttachments([]);
      options.invalidateAttachmentDraft();
      void options.refreshSessions();
      await options.scrollToLatest();
    } catch (error) {
      if (
        requestClient === options.client()
        && sessionId === options.state.sessionId
        && requestWorkspace === options.workspace()
      ) options.reportError(error);
    } finally {
      if (
        ownsUndoOperation
        && requestClient === options.client()
        && sessionId === options.state.sessionId
        && requestWorkspace === options.workspace()
      ) options.setOperationRunning(false);
    }
  }

  return { resolveUserMessageSessionEntryId, runUserMessageContextAction };
}
