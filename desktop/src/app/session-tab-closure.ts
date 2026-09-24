import { DRAFT_SESSION_TAB_ID } from "./draft-session.svelte";
import type { SessionLoader, SessionTabControllerOptions } from "./session-tab-controller-options";

export function createSessionTabClosure(
  options: SessionTabControllerOptions,
  loadSession: SessionLoader,
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
  ): Promise<boolean> {
    options.tabs.closeSelector();
    if (options.sessionMutationRunning()) return false;
    const tabSessionIds = options.tabSessionIds();
    if (sessionId === DRAFT_SESSION_TAB_ID) {
      if (!options.draft.open || tabSessionIds.length === 0) return false;
      const wasActive = options.draft.active;
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

    if (options.promptRunning(sessionId)) {
      const title = options.catalog.sessions.find((session) => session.sessionId === sessionId)?.title || "Untitled conversation";
      if (!window.confirm(`“${title}” is still running.\n\nClosing this tab will stop the active run. Close it?`)) return false;
    }
    options.runtime.invalidatePrewarm();
    const requestClient = options.client();
    if (sessionId !== options.state.sessionId) {
      options.setOperationRunning(true);
      options.setErrorMessage(null);
      try {
        await requestClient?.closeSession(sessionId);
        options.forgetRuntime(sessionId);
        options.clearSessionActivity(sessionId);
        options.state.deleteSessionTranscript(sessionId);
        options.forgetComposerDraft(sessionId);
        options.retargetWorkbenchAnchors(sessionId, options.state.sessionId ?? undefined);
        options.tabs.markClosed(sessionId);
      } catch (error) {
        options.reportError(error);
        return false;
      } finally {
        options.setOperationRunning(false);
      }
      return true;
    }

    const nextSessionId = preferredNextSessionId && tabSessionIds.includes(preferredNextSessionId)
      ? preferredNextSessionId
      : tabSessionIds.find((id) => id !== sessionId);
    let closed = false;
    options.setOperationRunning(true);
    options.setErrorMessage(null);
    try {
      await requestClient?.closeSession(sessionId);
      options.forgetRuntime(sessionId);
      options.clearSessionActivity(sessionId);
      options.state.deleteSessionTranscript(sessionId);
      options.forgetComposerDraft(sessionId);
      options.history.cancel();
      options.state.clearActiveSession();
      options.retargetWorkbenchAnchors(sessionId, nextSessionId);
      options.tabs.markClosed(sessionId);
      closed = true;
    } catch (error) {
      options.reportError(error);
    } finally {
      options.setOperationRunning(false);
    }
    if (!closed) return false;
    if (nextSessionId) await loadSession(nextSessionId);
    else {
      options.tabs.forgetActive(options.workspace());
      await options.draft.openStartTab();
    }
    return true;
  }

  async function deleteSelectedSession(sessionId: string): Promise<void> {
    const requestClient = options.client();
    if (!requestClient || options.sessionMutationRunning() || options.promptRunning(sessionId)) return;
    const session = options.catalog.sessions.find((candidate) => candidate.sessionId === sessionId);
    const title = session?.title || "Untitled conversation";
    if (!window.confirm(`Permanently delete “${title}”?\n\nThis removes the Pi session file and its DCP sidecar state.`)) return;

    options.tabs.closeSelector();
    const deletingActive = sessionId === options.state.sessionId;
    const nextSessionId = deletingActive
      ? options.catalog.sessions.find((candidate) => candidate.sessionId !== sessionId)?.sessionId
      : undefined;
    options.setOperationRunning(true);
    options.setErrorMessage(null);
    try {
      await requestClient.deleteSession(sessionId);
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
      options.reportError(error);
      return;
    } finally {
      options.setOperationRunning(false);
    }

    if (!deletingActive) return;
    if (nextSessionId && options.catalog.sessions.some((candidate) => candidate.sessionId === nextSessionId)) {
      await loadSession(nextSessionId);
    } else {
      await options.draft.openStartTab();
    }
  }

  return { closeWorkspaceSessions, closeSessionTab, deleteSelectedSession };
}
