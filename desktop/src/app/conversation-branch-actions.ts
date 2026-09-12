import type { AcpClient } from "../lib/acp-client";
import type { Attachment } from "../lib/attachments";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import {
  appendLocalSystemMessage,
  applySessionUpdates,
  emptyTranscript,
  markDeferredToolResults,
  type MessageItem,
} from "../lib/transcript";
import type { ActiveSessionState } from "./active-session-state.svelte";

export type UserMessageContextAction = "copy" | "fork" | "fork-new-tab" | "undo";

type ConversationBranchActionsOptions = {
  client: () => AcpClient | null;
  state: ActiveSessionState;
  workspace: () => string;
  operationRunning: () => boolean;
  setOperationRunning: (running: boolean) => void;
  promptRunning: () => boolean;
  sessionHistoryLoading: () => boolean;
  closeProjectSelector: () => void;
  closeSessionSelector: () => void;
  clearCommandPicker: () => void;
  forgetRuntime: (sessionId: string) => void;
  clearSessionActivity: (sessionId: string) => void;
  markRuntimeReady: (sessionId: string, options: SessionConfigOption[]) => void;
  beginHistoryLoad: () => number;
  hydrateHistory: (
    client: AcpClient,
    sessionId: string,
    workspace: string,
    generation: number,
  ) => Promise<void>;
  cancelHistoryLoad: () => void;
  markSourceClosed: (sessionId: string) => void;
  ensureProvisionalSession: (sessionId: string, workspace: string) => void;
  showSessionTab: (sessionId: string) => void;
  rememberActiveSession: (workspace: string, sessionId: string) => void;
  nextLocalMessageId: () => string;
  setPromptText: (text: string) => void;
  setPromptAttachments: (attachments: Attachment[]) => void;
  invalidateAttachmentDraft: () => void;
  refreshSessions: () => void | Promise<void>;
  scrollToLatest: () => Promise<void>;
  setErrorMessage: (message: string | null) => void;
  reportError: (error: unknown) => void;
};

export function createConversationBranchActions(options: ConversationBranchActionsOptions) {
  async function forkConversation(
    requestedEntryId?: string,
    config: { keepSourceOpen?: boolean } = {},
  ): Promise<void> {
    const requestClient = options.client();
    const sourceSessionId = options.state.sessionId;
    const requestWorkspace = options.workspace();
    if (
      !requestClient
      || !sourceSessionId
      || !options.state.runtimeReady
      || options.operationRunning()
      || options.promptRunning()
      || options.sessionHistoryLoading()
    ) return;
    options.closeProjectSelector();
    options.closeSessionSelector();
    options.clearCommandPicker();
    options.setOperationRunning(true);
    options.setErrorMessage(null);
    let forkedSessionId: string | undefined;
    let sourceClosed = false;
    try {
      let entryId = requestedEntryId;
      if (!entryId) {
        const messages = await requestClient.forkMessages(sourceSessionId);
        entryId = messages.at(-1)?.entryId;
      }
      if (!entryId) throw new Error("No user messages to fork from.");

      const forked = await requestClient.forkSession(sourceSessionId, requestWorkspace, entryId);
      forkedSessionId = forked.sessionId;
      if (
        requestClient !== options.client()
        || sourceSessionId !== options.state.sessionId
        || requestWorkspace !== options.workspace()
      ) return;

      options.state.setSessionTranscript(sourceSessionId, options.state.transcript);
      if (!config.keepSourceOpen) {
        await requestClient.closeSession(sourceSessionId);
        sourceClosed = true;
        options.forgetRuntime(sourceSessionId);
        options.clearSessionActivity(sourceSessionId);
      }
      options.state.setSessionId(forked.sessionId);
      options.state.setTranscript(emptyTranscript);
      options.state.setConfigOptions(forked.configOptions);
      options.markRuntimeReady(forked.sessionId, forked.configOptions);

      const historyGeneration = options.beginHistoryLoad();
      void options.hydrateHistory(requestClient, forked.sessionId, requestWorkspace, historyGeneration);
      if (!config.keepSourceOpen) options.markSourceClosed(sourceSessionId);
      options.ensureProvisionalSession(forked.sessionId, requestWorkspace);
      options.showSessionTab(forked.sessionId);
      options.rememberActiveSession(requestWorkspace, forked.sessionId);
      const next = appendLocalSystemMessage(
        options.state.transcript,
        `Forked from entry ${entryId}.`,
        options.nextLocalMessageId(),
      );
      options.state.setTranscript(next);
      options.state.setSessionTranscript(forked.sessionId, next);
      options.setPromptText(forked.selectedText ?? "");
      void options.refreshSessions();
      await options.scrollToLatest();
    } catch (error) {
      if (requestClient !== options.client() || requestWorkspace !== options.workspace()) return;
      if (config.keepSourceOpen && forkedSessionId && options.state.sessionId !== forkedSessionId) {
        await requestClient.closeSession(forkedSessionId).catch(() => {});
        options.forgetRuntime(forkedSessionId);
      }
      if (sourceClosed) {
        if (forkedSessionId) {
          await requestClient.closeSession(forkedSessionId).catch(() => {});
          options.forgetRuntime(forkedSessionId);
        }
        options.state.setSessionId(sourceSessionId);
        options.state.resetConversation();
        try {
          const historyGeneration = options.beginHistoryLoad();
          void options.hydrateHistory(requestClient, sourceSessionId, requestWorkspace, historyGeneration);
          const restored = await requestClient.loadSession(sourceSessionId, requestWorkspace);
          const configOptions = restored.configOptions ?? [];
          options.state.setConfigOptions(configOptions);
          options.markRuntimeReady(sourceSessionId, configOptions);
          options.rememberActiveSession(requestWorkspace, sourceSessionId);
        } catch (restoreError) {
          options.cancelHistoryLoad();
          options.state.setSessionId(null);
          options.reportError(new Error(
            `${error instanceof Error ? error.message : String(error)}; source conversation restore failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
          ));
          return;
        }
      }
      options.reportError(error);
    } finally {
      if (requestClient === options.client() && requestWorkspace === options.workspace()) {
        options.setOperationRunning(false);
      }
    }
  }

  async function resolveUserMessageSessionEntryId(message: MessageItem): Promise<string> {
    const requestClient = options.client();
    const sessionId = options.state.sessionId;
    if (!requestClient || !sessionId || message.localOnly) {
      throw new Error("This message is not backed by a Pi session entry.");
    }
    if (message.sessionEntryId) return message.sessionEntryId;

    const branchMessages = await requestClient.branchUserMessages(sessionId);
    if (requestClient !== options.client() || sessionId !== options.state.sessionId) {
      throw new Error("The active conversation changed while resolving the message.");
    }
    const visibleUsers = options.state.transcript.items.filter(
      (item): item is MessageItem => item.type === "message" && item.role === "user" && !item.localOnly,
    );
    const visibleIndex = visibleUsers.findIndex((item) => item.id === message.id);
    if (visibleIndex < 0) throw new Error("User message is no longer visible.");

    const offset = branchMessages.length - visibleUsers.length;
    if (offset < 0) throw new Error("Could not resolve this message on the active session branch.");
    const resolved = branchMessages[offset + visibleIndex];
    if (!resolved) throw new Error("Could not resolve this message on the active session branch.");
    return resolved.entryId;
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

  return { forkConversation, runUserMessageContextAction };
}
