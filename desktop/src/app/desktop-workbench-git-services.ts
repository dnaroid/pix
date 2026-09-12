import type { AcpClient } from "../lib/acp-client";
import { appendLocalUserMessage } from "../lib/transcript";
import {
  workbenchSessionTabId,
  type WorkbenchTab,
  type WorkbenchTabId,
} from "../lib/workbench-tabs";
import type { ActiveSessionState } from "./active-session-state.svelte";
import type { DesktopProjectServices } from "./desktop-project-services";
import type { DesktopPromptServices } from "./desktop-prompt-services";
import type { DesktopSessionServices } from "./desktop-session-services";
import type { DesktopSessionTransitionServices } from "./desktop-session-transition-services";
import { createGitAssist } from "./git-assist";
import { createWorkbenchController } from "./workbench-controller";

type SessionCoordinatorRef = {
  forgetRuntime: (sessionId: string) => void;
};

type DesktopWorkbenchGitServicesOptions = {
  client: () => AcpClient | null;
  state: ActiveSessionState;
  workspace: () => string;
  operationRunning: () => boolean;
  statusReady: () => boolean;
  sessions: DesktopSessionServices;
  transitions: DesktopSessionTransitionServices;
  project: DesktopProjectServices;
  prompt: DesktopPromptServices;
  sessionCoordinator: () => SessionCoordinatorRef;
  tabs: () => readonly WorkbenchTab[];
  activeTabId: () => WorkbenchTabId | null;
  activeConversationTabId: () => WorkbenchTabId | null;
  setActiveTabId: (id: WorkbenchTabId | null) => void;
  previewPane: () => { requestClose: () => boolean } | null;
  nextLocalMessageId: () => string;
  scrollToLatest: () => Promise<void>;
  reportError: (error: unknown) => void;
};

export function createDesktopWorkbenchGitServices(options: DesktopWorkbenchGitServicesOptions) {
  const workbench = createWorkbenchController({
    tabs: options.tabs,
    activeTabId: options.activeTabId,
    activeConversationTabId: options.activeConversationTabId,
    setActiveTabId: options.setActiveTabId,
    handleSessionTabClick: options.transitions.sessionTabs.handleSessionTabClick,
    closeSessionTab: options.transitions.sessionTabs.closeSessionTab,
    previewPane: options.previewPane,
    closePreview: options.project.preview.close,
    closeGitDiff: options.project.git.closeDiff,
    retargetPreviewAnchor: options.project.preview.retargetAnchor,
    retargetGitAnchor: options.project.git.retargetAnchor,
  });

  const gitAssist = createGitAssist({
    client: options.client,
    activeSessionId: () => options.state.sessionId,
    workspace: options.workspace,
    activeSessionRuntimeReady: () => options.state.runtimeReady,
    operationRunning: options.operationRunning,
    statusReady: options.statusReady,
    git: options.project.git,
    runtime: options.sessions.runtime,
    prompts: options.prompt.runtime,
    forgetRuntime: (sessionId) => options.sessionCoordinator().forgetRuntime(sessionId),
    activateResolutionSession: (sessionId, workspace, prompt) => {
      options.state.saveActiveTranscript();
      options.sessions.catalog.ensureProvisional(sessionId, workspace);
      options.sessions.tabs.show(sessionId);
      options.state.setSessionId(sessionId);
      options.sessions.tabs.rememberActive(workspace, sessionId);
      options.state.initializeActiveConversation(
        sessionId,
        options.sessions.runtime.getConfigOptions(sessionId) ?? [],
        true,
        false,
      );
      const transcriptMessageId = options.nextLocalMessageId();
      const next = appendLocalUserMessage(options.state.transcript, prompt, transcriptMessageId, []);
      options.state.setActiveTranscriptForSession(sessionId, next);
      return transcriptMessageId;
    },
    onResolutionRunStarted: (sessionId) => {
      options.project.git.closeDiff();
      options.setActiveTabId(workbenchSessionTabId(sessionId));
      void options.scrollToLatest();
      void options.sessions.catalog.refresh();
    },
    refreshSessions: options.sessions.catalog.refresh,
    reportError: options.reportError,
  });

  return { workbench, gitAssist };
}

export type DesktopWorkbenchGitServices = ReturnType<typeof createDesktopWorkbenchGitServices>;
