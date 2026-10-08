import { DRAFT_SESSION_TAB_ID } from "./draft-session.svelte";
import { confirmRunningTabClose } from "../lib/close-confirmation";
import type { SessionLoader, SessionTabControllerOptions } from "./session-tab-controller-options";

export type SessionActionTracker = {
  isBusy: (sessionId: string) => boolean;
  begin: (sessionId: string) => boolean;
  end: (sessionId: string) => void;
};

export function createSessionActionTracker(): SessionActionTracker {
  const sessionIds = new Set<string>();
  return {
    isBusy: (sessionId) => sessionIds.has(sessionId),
    begin: (sessionId) => {
      if (sessionIds.has(sessionId)) return false;
      sessionIds.add(sessionId);
      return true;
    },
    end: (sessionId) => { sessionIds.delete(sessionId); },
  };
}

export function createSessionTabClosure(
  options: SessionTabControllerOptions,
  loadSession: SessionLoader,
  sessionActions: SessionActionTracker = createSessionActionTracker(),
) {
  async function closeWorkspaceSessions(): Promise<void> {
    options.runtime.invalidatePrewarm();
    options.draft.reset();
    options.resetComposerDrafts();
    const sessionIds = [...new Set([
      ...options.tabSessionIds(),
      ...(options.state.sessionId ? [options.state.sessionId] : []),
    ])];
    options.history.reset();
    options.state.setSessionId(null);
    options.state.setRuntimeReady(false);
    options.state.clearSessionTranscripts();
    const requestClient = options.client();
    if (!requestClient) {
      for (const sessionId of sessionIds) options.clearSessionActivity(sessionId);
      options.resetSessionActivity();
      return;
    }
    await Promise.allSettled(sessionIds.map(async (sessionId) => {
      try {
        await requestClient.closeSession(sessionId);
      } finally {
        options.forgetRuntime(sessionId);
        options.clearSessionActivity(sessionId);
      }
    }));
    options.runtime.reset();
    options.resetSessionActivity();
  }

  async function closeSessionTab(
    sessionId: string,
    preferredNextSessionId?: string,
    onClosing?: () => void,
  ): Promise<boolean> {
    options.tabs.closeSelector();
    if (options.sessionMutationRunning() || sessionActions.isBusy(sessionId)) return false;
    const tabSessionIds = options.tabSessionIds();
    if (sessionId === DRAFT_SESSION_TAB_ID) {
      if (!options.draft.open || tabSessionIds.length === 0) return false;
      const wasActive = options.draft.active;
      onClosing?.();
      options.draft.close();
      if (!wasActive) return true;
      options.clearPrompt();
      options.invalidateAttachmentDraft();
      const fallbackSessionId = preferredNextSessionId && tabSessionIds.includes(preferredNextSessionId)
        ? preferredNextSessionId
        : tabSessionIds.at(-1);
      if (fallbackSessionId) options.retargetWorkbenchAnchors(DRAFT_SESSION_TAB_ID, fallbackSessionId);
      if (fallbackSessionId) await loadSession(fallbackSessionId);
      else {
        options.history.cancel();
        options.state.clearActiveSession();
      }
      return true;
    }

    // A participant tab is only a view of a council-owned runtime. Never send
    // session/close (or clear its runtime/activity) when dismissing that view.
    if (options.isBrainstormParticipant?.(sessionId)) {
      onClosing?.();
      options.tabs.markClosed(sessionId);
      if (sessionId !== options.state.sessionId) {
        options.retargetWorkbenchAnchors(sessionId, options.state.sessionId ?? undefined);
        return true;
      }
      const nextSessionId = preferredNextSessionId !== sessionId && tabSessionIds.includes(preferredNextSessionId ?? "")
        ? preferredNextSessionId
        : tabSessionIds.find((id) => id !== sessionId);
      options.state.saveActiveTranscript();
      options.history.cancel();
      options.state.clearActiveSession();
      options.tabs.forgetActive(options.workspace());
      options.retargetWorkbenchAnchors(sessionId, nextSessionId);
      if (nextSessionId) await loadSession(nextSessionId);
      else await options.draft.openStartTab();
      return true;
    }

    if (options.promptRunning(sessionId)) {
      const title = options.catalog.sessions.find((session) => session.sessionId === sessionId)?.title || "Untitled conversation";
      const confirmationClient = options.client();
      const confirmationWorkspace = options.workspace();
      if (!sessionActions.begin(sessionId)) return false;
      try {
        if (!await confirmRunningTabClose(title)) return false;
        if (confirmationClient !== options.client()
          || confirmationWorkspace !== options.workspace()
          || options.sessionMutationRunning()
          || !options.tabSessionIds().includes(sessionId)) return false;
      } catch (error) {
        options.reportError(error);
        return false;
      } finally {
        sessionActions.end(sessionId);
      }
    }
    options.runtime.invalidatePrewarm();
    const requestClient = options.client();
    const requestWorkspace = options.workspace();
    const current = () => requestClient === options.client() && requestWorkspace === options.workspace();
    if (!sessionActions.begin(sessionId)) return false;
    const restoreHistory = options.history.captureRollback(sessionId);
    const wasActive = sessionId === options.state.sessionId;
    // Consent may have yielded while other tabs were closed or opened.
    const remainingSessionIds = options.tabSessionIds().filter((id) => (
      id !== sessionId && !sessionActions.isBusy(id)
    ));
    let nextSessionId = options.state.sessionId ?? undefined;
    if (wasActive) {
      nextSessionId = preferredNextSessionId && remainingSessionIds.includes(preferredNextSessionId)
        ? preferredNextSessionId
        : remainingSessionIds[0];
    }
    options.setErrorMessage(null);
    onClosing?.();
    options.tabs.markClosed(sessionId);
    // Retire ownership now, not on completion: pending sends, history and late
    // updates must not revive the closed view while ACP is stopping its runtime.
    // Keep transcript/composer snapshots until success so failure can restore it.
    options.forgetRuntime(sessionId);
    options.clearSessionActivity(sessionId);
    options.retargetWorkbenchAnchors(sessionId, nextSessionId);
    let navigation: Promise<void> | undefined;
    if (wasActive) {
      options.history.cancel();
      if (nextSessionId) navigation = loadSession(nextSessionId);
      else {
        options.tabs.forgetActive(requestWorkspace);
        navigation = options.draft.openStartTab();
      }
    }

    // Only this session stays busy. Close/focus callers complete without waiting
    // for ACP teardown; a late failure restores membership, never navigation.
    void (async () => {
      try {
        await requestClient?.closeSession(sessionId);
        if (!current()) return;
        options.state.deleteSessionTranscript(sessionId);
        options.forgetComposerDraft(sessionId);
      } catch (error) {
        if (!current()) return;
        restoreHistory();
        options.tabs.show(sessionId);
        options.reportError(error);
      } finally {
        sessionActions.end(sessionId);
      }
    })();
    await navigation;
    return true;
  }

  async function deleteSelectedSession(sessionId: string): Promise<void> {
    const requestClient = options.client();
    if (
      !requestClient
      || options.sessionMutationRunning()
      || options.promptRunning(sessionId)
      || sessionActions.isBusy(sessionId)
    ) return;
    const requestWorkspace = options.workspace();
    const current = () => requestClient === options.client() && requestWorkspace === options.workspace();
    const session = options.catalog.sessions.find((candidate) => candidate.sessionId === sessionId);
    const title = session?.title || "Untitled conversation";
    if (!window.confirm(`Permanently delete “${title}”?\n\nThis removes the Pi session file and its DCP sidecar state.`)) return;

    options.tabs.closeSelector();
    const deletingActive = sessionId === options.state.sessionId;
    const nextSessionId = deletingActive
      ? options.catalog.sessions.find((candidate) => candidate.sessionId !== sessionId)?.sessionId
      : undefined;
    if (deletingActive) options.setOperationRunning(true);
    else if (!sessionActions.begin(sessionId)) return;
    options.setErrorMessage(null);
    try {
      await requestClient.deleteSession(sessionId);
      if (!current()) return;
      options.forgetRuntime(sessionId);
      options.clearSessionActivity(sessionId);
      options.state.deleteSessionTranscript(sessionId);
      options.forgetComposerDraft(sessionId);
      options.catalog.remove(sessionId);
      options.tabs.remove(sessionId);
      if (deletingActive) {
        options.history.cancel();
        options.state.clearActiveSession();
        options.tabs.forgetActive(options.workspace());
      }
      await options.catalog.refresh();
    } catch (error) {
      if (current()) options.reportError(error);
      return;
    } finally {
      if (deletingActive) {
        if (current()) options.setOperationRunning(false);
      } else {
        sessionActions.end(sessionId);
      }
    }

    if (!current()) return;
    if (!deletingActive) return;
    if (nextSessionId && options.catalog.sessions.some((candidate) => candidate.sessionId === nextSessionId)) {
      await loadSession(nextSessionId);
    } else {
      await options.draft.openStartTab();
    }
  }

  return { closeWorkspaceSessions, closeSessionTab, deleteSelectedSession };
}
