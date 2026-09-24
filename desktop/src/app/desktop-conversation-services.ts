import type { AcpClient } from "../lib/acp-client";
import type { Attachment } from "../lib/attachments";
import type { CommandPickerState } from "../lib/command-interactions";
import type { DesktopShortcutPlatform } from "../lib/desktop-commands";
import { appendLocalSystemMessage } from "../lib/transcript";
import type { ActiveSessionState } from "./active-session-state.svelte";
import { createConversationBranchActions } from "./conversation-branch-actions";
import { createConversationNavigation } from "./conversation-navigation";
import { createConversationSessionActions } from "./conversation-session-actions";
import type { DesktopSessionServices } from "./desktop-session-services";

type SessionTabsRef = {
  closeSessionSelector: () => void;
};

type SessionCoordinatorRef = {
  clearActivity: (sessionId: string) => void;
  forgetRuntime: (sessionId: string) => void;
};

type DesktopConversationServicesOptions = {
  client: () => AcpClient | null;
  state: ActiveSessionState;
  workspace: () => string;
  operationRunning: () => boolean;
  setOperationRunning: (running: boolean) => void;
  promptRunning: () => boolean;
  sessionHistoryLoading: () => boolean;
  sessions: DesktopSessionServices;
  sessionTabs: () => SessionTabsRef;
  sessionCoordinator: () => SessionCoordinatorRef;
  closeProjectSelector: () => void;
  clearCommandPicker: () => void;
  setCommandPicker: (picker: CommandPickerState | null) => void;
  requestLocalTextInput: (message: string, title: string) => Promise<string | undefined>;
  setPromptText: (text: string) => void;
  setPromptAttachments: (attachments: Attachment[]) => void;
  invalidateAttachmentDraft: () => void;
  nextLocalMessageId: () => string;
  scrollToLatest: () => Promise<void>;
  scrollToEntry: (entryId: string) => void;
  scheduleScrollToLatest: () => void;
  platform: DesktopShortcutPlatform;
  setErrorMessage: (message: string | null) => void;
  reportError: (error: unknown) => void;
};

export function createDesktopConversationServices(options: DesktopConversationServicesOptions) {
  const actions = createConversationSessionActions({
    client: options.client,
    state: options.state,
    workspace: options.workspace,
    operationRunning: options.operationRunning,
    setOperationRunning: options.setOperationRunning,
    promptRunning: options.promptRunning,
    sessionHistoryLoading: options.sessionHistoryLoading,
    setErrorMessage: options.setErrorMessage,
    setPromptText: options.setPromptText,
    markRuntimeReady: options.sessions.runtime.markReady,
    forgetRuntime: (sessionId) => options.sessionCoordinator().forgetRuntime(sessionId),
    beginHistoryLoad: options.sessions.history.begin,
    hydrateHistory: options.sessions.history.hydrate,
    refreshSessions: options.sessions.catalog.refresh,
    closeProjectSelector: options.closeProjectSelector,
    closeSessionSelector: () => options.sessionTabs().closeSessionSelector(),
    clearCommandPicker: options.clearCommandPicker,
    requestLocalTextInput: options.requestLocalTextInput,
    nextLocalMessageId: options.nextLocalMessageId,
    scrollToLatest: options.scrollToLatest,
    reportError: options.reportError,
  });

  const branches = createConversationBranchActions({
    client: options.client,
    state: options.state,
    workspace: options.workspace,
    operationRunning: options.operationRunning,
    setOperationRunning: options.setOperationRunning,
    promptRunning: options.promptRunning,
    sessionHistoryLoading: options.sessionHistoryLoading,
    closeProjectSelector: options.closeProjectSelector,
    closeSessionSelector: () => options.sessionTabs().closeSessionSelector(),
    clearCommandPicker: options.clearCommandPicker,
    forgetRuntime: (sessionId) => options.sessionCoordinator().forgetRuntime(sessionId),
    clearSessionActivity: (sessionId) => options.sessionCoordinator().clearActivity(sessionId),
    markRuntimeReady: options.sessions.runtime.markReady,
    beginHistoryLoad: options.sessions.history.begin,
    hydrateHistory: options.sessions.history.hydrate,
    cancelHistoryLoad: options.sessions.history.cancel,
    isHistoryLoadCurrent: options.sessions.history.isCurrent,
    markHistoryFullyLoaded: options.sessions.history.markFullyLoaded,
    markSourceClosed: options.sessions.tabs.markClosedUnique,
    ensureProvisionalSession: options.sessions.catalog.ensureProvisional,
    showSessionTab: options.sessions.tabs.show,
    rememberActiveSession: options.sessions.tabs.rememberActive,
    nextLocalMessageId: options.nextLocalMessageId,
    setPromptText: options.setPromptText,
    setPromptAttachments: options.setPromptAttachments,
    invalidateAttachmentDraft: options.invalidateAttachmentDraft,
    refreshSessions: options.sessions.catalog.refresh,
    scrollToLatest: options.scrollToLatest,
    setErrorMessage: options.setErrorMessage,
    reportError: options.reportError,
  });

  const navigation = createConversationNavigation({
    client: options.client,
    activeSessionId: () => options.state.sessionId,
    activeSessionRuntimeReady: () => options.state.runtimeReady,
    workspace: options.workspace,
    transcript: () => options.state.transcript,
    setTranscript: options.state.setActiveTranscriptForSession,
    markHistoryFullyLoaded: options.sessions.history.markFullyLoaded,
    setPicker: options.setCommandPicker,
    scrollToEntry: options.scrollToEntry,
    appendSystemMessage: (text) => {
      const sessionId = options.state.sessionId;
      if (!sessionId) return;
      const next = appendLocalSystemMessage(options.state.transcript, text, options.nextLocalMessageId());
      options.state.setActiveTranscriptForSession(sessionId, next);
    },
    scheduleScrollToLatest: options.scheduleScrollToLatest,
    platform: options.platform,
    reportError: options.reportError,
  });

  return { actions, branches, navigation };
}

export type DesktopConversationServices = ReturnType<typeof createDesktopConversationServices>;
