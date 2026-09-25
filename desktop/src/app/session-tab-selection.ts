import { emptyTranscript } from "../lib/transcript";
import { DRAFT_SESSION_TAB_ID } from "./draft-session.svelte";
import type { SessionTabControllerOptions } from "./session-tab-controller-options";

export function createSessionTabSelection(options: SessionTabControllerOptions) {
  async function loadSession(sessionId: string): Promise<void> {
    const requestClient = options.client();
    const canSelectDuringDraftStartup = options.draft.materializing
      && options.statusReady()
      && !!options.workspace()
      && !options.operationRunning();
    if (
      !requestClient
      || (!options.canUseSession() && !canSelectDuringDraftStartup)
      || sessionId === options.state.sessionId
    ) return;
    const requestWorkspace = options.workspace();
    options.closeProjectSelector();
    options.tabs.closeSelector();
    options.setErrorMessage(null);
    const currentSessionId = options.state.sessionId;
    const sourceOwnerId = options.draft.active ? DRAFT_SESSION_TAB_ID : currentSessionId;
    if (currentSessionId) options.state.setSessionTranscript(currentSessionId, options.state.transcript);
    options.draft.deactivate();
    options.switchComposerDraft(sourceOwnerId, sessionId);
    options.state.setSessionId(sessionId);
    const cachedTranscript = options.state.sessionTranscript(sessionId);
    options.state.setTranscript(cachedTranscript ?? emptyTranscript);
    options.state.setConfigOptions(options.runtime.getConfigOptions(sessionId) ?? []);
    options.state.setRuntimeReady(options.runtime.isReady(sessionId));
    if (cachedTranscript) {
      options.history.cancel();
    } else {
      const historyGeneration = options.history.begin();
      void options.history.hydrate(requestClient, sessionId, requestWorkspace, historyGeneration);
    }
    options.tabs.show(sessionId);
    options.tabs.rememberActive(requestWorkspace, sessionId);
    const runtime = options.runtime.ensure(requestClient, sessionId, requestWorkspace);
    void runtime.then(() => {
      if (options.runtime.isReady(sessionId)) {
        options.runtime.schedulePrewarm(requestClient, requestWorkspace, options.tabSessionIds());
      }
    });
  }

  async function replaceCurrentTabWithSession(sessionId: string): Promise<void> {
    const requestClient = options.client();
    const requestWorkspace = options.workspace();
    const sourceSessionId = options.state.sessionId;
    if (
      !requestClient
      || !requestWorkspace
      || !options.statusReady()
      || options.sessionMutationRunning()
      || sessionId === sourceSessionId
    ) {
      if (sessionId === sourceSessionId) options.tabs.closeSelector();
      return;
    }
    if (sourceSessionId && options.promptRunning(sourceSessionId)) {
      options.reportError(new Error("Cannot replace the current tab while its session is running."));
      return;
    }

    options.closeProjectSelector();
    options.tabs.closeSelector();
    options.runtime.invalidatePrewarm();
    options.setOperationRunning(true);
    options.setErrorMessage(null);
    try {
      await options.runtime.ensure(requestClient, sessionId, requestWorkspace);
      if (
        requestClient !== options.client()
        || requestWorkspace !== options.workspace()
        || !options.runtime.isReady(sessionId)
      ) {
        if (requestClient === options.client() && requestWorkspace === options.workspace()) {
          throw new Error("Could not load the selected session.");
        }
        return;
      }

      if (sourceSessionId) {
        options.state.setSessionTranscript(sourceSessionId, options.state.transcript);
        await requestClient.closeSession(sourceSessionId);
        options.state.deleteSessionTranscript(sourceSessionId);
        if (
          requestClient !== options.client()
          || requestWorkspace !== options.workspace()
          || options.state.sessionId !== sourceSessionId
        ) return;
        options.forgetRuntime(sourceSessionId);
        options.clearSessionActivity(sourceSessionId);
      }

      options.tabs.replace(sourceSessionId, sessionId);
      if (sourceSessionId) options.retargetWorkbenchAnchors(sourceSessionId, sessionId);

      options.history.cancel();
      options.switchComposerDraft(sourceSessionId, sessionId, { preserveSource: false });
      options.state.setSessionId(sessionId);
      const cachedTranscript = options.state.sessionTranscript(sessionId);
      options.state.setTranscript(cachedTranscript ?? emptyTranscript);
      options.state.setConfigOptions(options.runtime.getConfigOptions(sessionId) ?? []);
      options.state.setRuntimeReady(true);
      if (!cachedTranscript) {
        const historyGeneration = options.history.begin();
        void options.history.hydrate(requestClient, sessionId, requestWorkspace, historyGeneration);
      }
      options.tabs.rememberActive(requestWorkspace, sessionId);
      void options.refreshQueueState(sessionId);
      void options.catalog.refresh();
      options.runtime.schedulePrewarm(requestClient, requestWorkspace, options.tabSessionIds());
    } catch (error) {
      if (requestClient === options.client() && requestWorkspace === options.workspace()) options.reportError(error);
    } finally {
      if (requestClient === options.client() && requestWorkspace === options.workspace()) {
        options.setOperationRunning(false);
      }
    }
  }

  function handleSessionTabClick(sessionId: string): void {
    options.closeProjectSelector();
    options.tabs.closeSelector();
    if (sessionId === DRAFT_SESSION_TAB_ID) {
      if (!options.draft.active) options.draft.activate();
      return;
    }
    if (sessionId !== options.state.sessionId) void loadSession(sessionId);
  }

  return { loadSession, replaceCurrentTabWithSession, handleSessionTabClick };
}
