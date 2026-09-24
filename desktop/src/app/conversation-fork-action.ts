import { appendLocalSystemMessage, emptyTranscript } from "../lib/transcript";
import type { ConversationBranchActionsOptions } from "./conversation-branch-options";

export function createForkConversation(options: ConversationBranchActionsOptions) {
  return async function forkConversation(
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
      ) {
        options.forgetRuntime(forked.sessionId);
        void requestClient.closeSession(forked.sessionId).catch(() => undefined);
        return;
      }

      options.state.setSessionTranscript(sourceSessionId, options.state.transcript);
      if (!config.keepSourceOpen) {
        await requestClient.closeSession(sourceSessionId);
        sourceClosed = true;
        options.state.deleteSessionTranscript(sourceSessionId);
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
      if (forkedSessionId && options.state.sessionId !== forkedSessionId && !sourceClosed) {
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
        const historyGeneration = options.beginHistoryLoad();
        try {
          void options.hydrateHistory(requestClient, sourceSessionId, requestWorkspace, historyGeneration);
          const restored = await requestClient.loadSession(sourceSessionId, requestWorkspace);
          const configOptions = restored.configOptions ?? [];
          options.state.setConfigOptions(configOptions);
          options.markRuntimeReady(sourceSessionId, configOptions);
          options.rememberActiveSession(requestWorkspace, sourceSessionId);
        } catch (restoreError) {
          // Another attachment may have taken over this ID while loadSession was pending.
          if (!options.isHistoryLoadCurrent(requestClient, sourceSessionId, requestWorkspace, historyGeneration)
            || options.state.runtimeReady) return;
          options.cancelHistoryLoad();
          options.forgetRuntime(sourceSessionId);
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
  };
}
