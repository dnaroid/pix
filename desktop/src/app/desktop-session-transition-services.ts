import type { AcpClient } from "../lib/acp-client";
import type { ActiveSessionState } from "./active-session-state.svelte";
import type { DesktopSessionServices } from "./desktop-session-services";
import { createDraftSession } from "./draft-session.svelte";
import { createSessionTabController } from "./session-tab-controller";

type DraftModelOverride = { modelRef: string; thinkingLevel: string } | null;

type SessionCoordinatorRef = {
  clearActivity: (sessionId: string) => void;
  forgetRuntime: (sessionId: string) => void;
};

type WorkbenchControllerRef = {
  retargetSessionAnchors: (sourceSessionId: string, targetSessionId?: string) => void;
};

type DesktopSessionTransitionServicesOptions = {
  client: () => AcpClient | null;
  workspace: () => string;
  statusReady: () => boolean;
  operationRunning: () => boolean;
  setOperationRunning: (running: boolean) => void;
  canUseSession: () => boolean;
  sessionMutationRunning: () => boolean;
  state: ActiveSessionState;
  sessions: DesktopSessionServices;
  closeProjectSelector: () => void;
  resetModelDraft: () => void;
  draftConfigAvailable: () => boolean;
  refreshDraftConfig: () => void | Promise<void>;
  draftModelOverride: () => DraftModelOverride;
  routeDraftModel: (prompt: string, attachmentCount: number, signal?: AbortSignal) => Promise<DraftModelOverride>;
  clearPrompt: () => void;
  invalidateAttachmentDraft: () => void;
  focusComposer: () => void | Promise<void>;
  sessionCoordinator: () => SessionCoordinatorRef;
  workbenchController: () => WorkbenchControllerRef;
  retargetAttachmentDraftKey: (workspace: string, sessionId: string) => void;
  promptRunning: (sessionId: string) => boolean;
  tabSessionIds: () => readonly string[];
  refreshQueueState: (sessionId: string) => void | Promise<void>;
  setErrorMessage: (message: string | null) => void;
  reportError: (error: unknown) => void;
};

export function createDesktopSessionTransitionServices(
  options: DesktopSessionTransitionServicesOptions,
) {
  let sessionTabs!: ReturnType<typeof createSessionTabController>;

  const draft = createDraftSession({
    client: options.client,
    workspace: options.workspace,
    statusReady: options.statusReady,
    operationRunning: options.operationRunning,
    canUseSession: options.canUseSession,
    activeSessionId: () => options.state.sessionId,
    setActiveSessionId: options.state.setSessionId,
    saveActiveTranscript: options.state.saveActiveTranscript,
    resetActiveConversation: options.state.resetConversation,
    closeProjectSelector: options.closeProjectSelector,
    closeSessionSelector: () => sessionTabs.closeSessionSelector(),
    cancelHistoryLoad: options.sessions.history.cancel,
    resetModelDraft: options.resetModelDraft,
    draftConfigAvailable: options.draftConfigAvailable,
    refreshDraftConfig: options.refreshDraftConfig,
    draftModelOverride: options.draftModelOverride,
    routeDraftModel: options.routeDraftModel,
    clearPrompt: options.clearPrompt,
    invalidateAttachmentDraft: options.invalidateAttachmentDraft,
    focusComposer: options.focusComposer,
    forgetRuntime: (sessionId) => options.sessionCoordinator().forgetRuntime(sessionId),
    ensureProvisionalSession: options.sessions.catalog.ensureProvisional,
    showSessionTab: options.sessions.tabs.show,
    retargetWorkbenchAnchors: (sourceSessionId, targetSessionId) =>
      options.workbenchController().retargetSessionAnchors(sourceSessionId, targetSessionId),
    retargetAttachmentDraftKey: options.retargetAttachmentDraftKey,
    setMaterializedTranscript: options.state.initializeSessionTranscript,
    setConfigOptions: options.state.setConfigOptions,
    markRuntimeReady: options.sessions.runtime.markReady,
    rememberActiveSession: options.sessions.tabs.rememberActive,
    setErrorMessage: options.setErrorMessage,
    reportError: options.reportError,
  });

  sessionTabs = createSessionTabController({
    client: options.client,
    workspace: options.workspace,
    statusReady: options.statusReady,
    canUseSession: options.canUseSession,
    sessionMutationRunning: options.sessionMutationRunning,
    state: options.state,
    operationRunning: options.operationRunning,
    setOperationRunning: options.setOperationRunning,
    promptRunning: options.promptRunning,
    catalog: options.sessions.catalog,
    tabs: options.sessions.tabs,
    draft,
    runtime: options.sessions.runtime,
    history: options.sessions.history,
    closeProjectSelector: options.closeProjectSelector,
    clearSessionActivity: (sessionId) => options.sessionCoordinator().clearActivity(sessionId),
    forgetRuntime: (sessionId) => options.sessionCoordinator().forgetRuntime(sessionId),
    retargetWorkbenchAnchors: (sourceSessionId, targetSessionId) =>
      options.workbenchController().retargetSessionAnchors(sourceSessionId, targetSessionId),
    clearPrompt: options.clearPrompt,
    invalidateAttachmentDraft: options.invalidateAttachmentDraft,
    tabSessionIds: options.tabSessionIds,
    focusComposer: options.focusComposer,
    refreshQueueState: options.refreshQueueState,
    setErrorMessage: options.setErrorMessage,
    reportError: options.reportError,
  });

  return {
    draft,
    sessionTabs,
  };
}

export type DesktopSessionTransitionServices = ReturnType<typeof createDesktopSessionTransitionServices>;
