import type { AcpClient } from "../lib/acp-client";
import { emptyTranscript } from "../lib/transcript";
import type { ActiveSessionState } from "./active-session-state.svelte";
import { DRAFT_SESSION_TAB_ID, type createDraftSession } from "./draft-session.svelte";
import type { createSessionCatalog } from "./session-catalog.svelte";
import type { createSessionHistory } from "./session-history.svelte";
import type { createSessionRuntimeStore } from "./session-runtime.svelte";
import type { createSessionTabsState } from "./session-tabs-state.svelte";

type SessionCatalog = ReturnType<typeof createSessionCatalog>;
type SessionHistory = ReturnType<typeof createSessionHistory>;
type SessionRuntime = ReturnType<typeof createSessionRuntimeStore>;
type SessionTabsState = ReturnType<typeof createSessionTabsState>;
type DraftSession = ReturnType<typeof createDraftSession>;

type SessionTabControllerOptions = {
  client: () => AcpClient | null;
  workspace: () => string;
  statusReady: () => boolean;
  canUseSession: () => boolean;
  sessionMutationRunning: () => boolean;
  state: ActiveSessionState;
  operationRunning: () => boolean;
  setOperationRunning: (running: boolean) => void;
  promptRunning: (sessionId: string) => boolean;
  catalog: SessionCatalog;
  tabs: SessionTabsState;
  draft: DraftSession;
  runtime: SessionRuntime;
  history: SessionHistory;
  closeProjectSelector: () => void;
  clearSessionActivity: (sessionId: string) => void;
  forgetRuntime: (sessionId: string) => void;
  retargetWorkbenchAnchors: (sourceSessionId: string, targetSessionId?: string) => void;
  clearPrompt: () => void;
  invalidateAttachmentDraft: () => void;
  tabSessionIds: () => readonly string[];
  focusComposer: () => void | Promise<void>;
  refreshQueueState: (sessionId: string) => void | Promise<void>;
  setErrorMessage: (message: string | null) => void;
  reportError: (error: unknown) => void;
};

export function createSessionTabController(options: SessionTabControllerOptions) {
  async function loadSession(sessionId: string): Promise<void> {
    const requestClient = options.client();
    if (!requestClient || !options.canUseSession() || sessionId === options.state.sessionId) return;
    const requestWorkspace = options.workspace();
    options.closeProjectSelector();
    options.tabs.closeSelector();
    options.setErrorMessage(null);
    const currentSessionId = options.state.sessionId;
    if (currentSessionId) options.state.setSessionTranscript(currentSessionId, options.state.transcript);
    options.draft.deactivate();
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

  async function closeWorkspaceSessions(): Promise<void> {
    options.runtime.invalidatePrewarm();
    options.draft.reset();
    const sessionIds = [...new Set([
      ...options.tabSessionIds(),
      ...(options.state.sessionId ? [options.state.sessionId] : []),
    ])];
    options.history.cancel();
    options.state.setSessionId(null);
    options.state.setRuntimeReady(false);
    options.state.clearSessionTranscripts();
    const requestClient = options.client();
    if (!requestClient) {
      for (const sessionId of sessionIds) options.clearSessionActivity(sessionId);
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
    else await options.draft.openStartTab();
    return true;
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

  function openSessionSelector(query = "", mode: "open" | "delete" = "open"): void {
    if (!options.workspace() || !options.statusReady()) return;
    options.tabs.openSelector(query, mode);
    void options.catalog.refresh();
  }

  function closeSessionSelector(): void {
    options.tabs.closeSelector();
  }

  function selectSession(sessionId: string): void {
    if (options.draft.active) {
      void selectSessionFromDraft(sessionId);
      return;
    }
    if (sessionId === options.state.sessionId) {
      options.tabs.closeSelector();
      return;
    }
    void replaceCurrentTabWithSession(sessionId);
  }

  async function selectSessionFromDraft(sessionId: string): Promise<void> {
    if (!options.draft.active || options.sessionMutationRunning()) return;
    options.draft.close();
    options.clearPrompt();
    options.invalidateAttachmentDraft();
    options.retargetWorkbenchAnchors(DRAFT_SESSION_TAB_ID, sessionId);
    await loadSession(sessionId);
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

  return {
    loadSession,
    replaceCurrentTabWithSession,
    closeWorkspaceSessions,
    closeSessionTab,
    handleSessionTabClick,
    openSessionSelector,
    closeSessionSelector,
    selectSession,
    selectSessionFromDraft,
    deleteSelectedSession,
  };
}
