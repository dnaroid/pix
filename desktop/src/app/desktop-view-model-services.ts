import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { Attachment } from "../lib/attachments";
import { externalEditorLabel } from "../lib/desktop-config";
import {
  desktopCommandShortcutLabel,
  type DesktopShortcutPlatform,
} from "../lib/desktop-commands";
import { isEditableProjectMarkdown } from "../lib/project-documents";
import type { WorkbenchTabId } from "../lib/workbench-tabs";
import type { ActiveSessionState } from "./active-session-state.svelte";
import type { ConnectionStatus } from "./connection.svelte";
import type { DesktopCommandServices } from "./desktop-command-services";
import type { DesktopConversationServices } from "./desktop-conversation-services";
import type { DesktopInteractionServices } from "./desktop-interaction-services.svelte";
import type { DesktopModelServices } from "./desktop-model-services";
import { createDesktopOverlaysViewModel } from "./desktop-overlays-view-model.svelte";
import type { DesktopPresentationState } from "./desktop-presentation-state.svelte";
import type { DesktopProjectActionServices } from "./desktop-project-action-services";
import type { DesktopProjectServices } from "./desktop-project-services";
import type { DesktopPromptActionServices } from "./desktop-prompt-action-services";
import type { DesktopPromptServices } from "./desktop-prompt-services";
import type { DesktopSessionServices } from "./desktop-session-services";
import type { DesktopSessionTransitionServices } from "./desktop-session-transition-services";
import { createDesktopSidebarViewModel } from "./desktop-sidebar-view-model.svelte";
import { createDesktopStatusBarViewModel } from "./desktop-status-bar-view-model.svelte";
import { createDesktopTitlebarViewModel } from "./desktop-titlebar-view-model.svelte";
import { createDesktopWorkbenchViewModel } from "./desktop-workbench-view-model.svelte";
import type { DesktopWorkbenchGitServices } from "./desktop-workbench-git-services";
import type { DesktopWorkspaceServices } from "./desktop-workspace-services";
import type { createErrorState } from "./error-state.svelte";
import type { createDesktopSessionOrchestration } from "./desktop-session-orchestration";
import type { createTranscriptAttachmentController } from "./transcript-attachments";
import type { createTranscriptScrollController } from "./transcript-scroll.svelte";

type ErrorState = ReturnType<typeof createErrorState>;
type SessionOrchestration = ReturnType<typeof createDesktopSessionOrchestration>;
type TranscriptAttachments = ReturnType<typeof createTranscriptAttachmentController>;
type TranscriptScroll = ReturnType<typeof createTranscriptScrollController>;

type DesktopViewModelServicesOptions = {
  platform: DesktopShortcutPlatform;
  workspace: () => string;
  status: () => ConnectionStatus;
  clientAvailable: () => boolean;
  operationRunning: () => boolean;
  dragActive: () => boolean;
  activeWorkbenchTabId: () => WorkbenchTabId | null;
  promptText: () => string;
  promptAttachments: () => Attachment[];
  changingConfig: () => string | null;
  displayedConfigOptions: () => SessionConfigOption[];
  reconnect: () => void | Promise<void>;
  state: ActiveSessionState;
  errors: ErrorState;
  sessions: DesktopSessionServices;
  project: DesktopProjectServices;
  prompt: DesktopPromptServices;
  transitions: DesktopSessionTransitionServices;
  conversation: DesktopConversationServices;
  promptActions: DesktopPromptActionServices;
  projectActions: DesktopProjectActionServices;
  workbenchGit: DesktopWorkbenchGitServices;
  model: DesktopModelServices;
  commands: DesktopCommandServices;
  interactions: DesktopInteractionServices;
  presentation: DesktopPresentationState;
  workspaceController: DesktopWorkspaceServices["controller"];
  transcriptScroll: TranscriptScroll;
  transcriptAttachments: TranscriptAttachments;
  orchestration: SessionOrchestration;
};

export function createDesktopViewModelServices(options: DesktopViewModelServicesOptions) {
  const titlebar = createDesktopTitlebarViewModel({
    newSessionShortcut: () => desktopCommandShortcutLabel("session.new", options.platform),
    tabs: () => options.presentation.workbenchTabs,
    activeId: options.activeWorkbenchTabId,
    canCreateSession: () => options.presentation.canUseSession,
    selectWorkbenchTab: options.workbenchGit.workbench.select,
    closeWorkbenchTab: options.workbenchGit.workbench.close,
    openSessionStartTab: options.transitions.draft.openStartTab,
    selectorOpen: () => options.sessions.tabs.selectorOpen,
    sessions: () => options.sessions.catalog.sessions,
    activeSessionId: () => options.state.sessionId,
    activeTitle: () => options.presentation.activeTitle,
    selectorQuery: () => options.sessions.tabs.selectorQuery,
    selectorMode: () => options.sessions.tabs.selectorMode,
    sessionMutationRunning: () => options.presentation.sessionMutationRunning,
    deleteSession: options.transitions.sessionTabs.deleteSelectedSession,
    selectSession: options.transitions.sessionTabs.selectSession,
    closeSelector: options.transitions.sessionTabs.closeSessionSelector,
  });

  const sidebar = createDesktopSidebarViewModel({
    workspace: options.workspace,
    canUseSession: () => options.presentation.canUseSession,
    anyPromptRunning: () => options.presentation.anyPromptRunning,
    sessionMutationRunning: () => options.presentation.sessionMutationRunning,
    externalEditorLabel: () => externalEditorLabel(options.project.workspace.externalEditor),
    projectTasks: options.project.tasks,
    projectWorkspace: options.project.workspace,
    projectActions: options.projectActions.actions,
    projectDocuments: options.project.documents,
    registry: options.project.registry,
    git: options.project.git,
    gitAssist: options.workbenchGit.gitAssist,
    preview: options.project.preview,
    attachments: options.interactions.attachments,
    sessionTabs: options.transitions.sessionTabs,
    workspaceController: options.workspaceController,
  });

  const workbench = createDesktopWorkbenchViewModel({
    conversationVisible: () => options.presentation.activeWorkbenchTab?.kind === "session",
    conversationLabelledBy: () => options.presentation.activeConversationWorkbenchTabId
      ? `workbench-tab-${options.presentation.activeConversationWorkbenchTabId}`
      : undefined,
    errorMessage: () => options.errors.message,
    statusError: () => options.status() === "error",
    statusReady: () => options.status() === "ready",
    clientAvailable: options.clientAvailable,
    sessionStartOpen: () => options.presentation.sessionStartOpen,
    sessionStartCandidates: () => options.presentation.sessionStartCandidates,
    transcript: () => options.state.transcript,
    activeSessionId: () => options.state.sessionId,
    workspace: options.workspace,
    promptRunning: () => options.presentation.promptRunning,
    operationRunning: options.operationRunning,
    sessionHistoryLoading: () => options.sessions.history.loading,
    promptText: options.promptText,
    promptAttachments: options.promptAttachments,
    activeSessionRuntimeReady: () => options.state.runtimeReady,
    sessionMutationRunning: () => options.presentation.sessionMutationRunning,
    dragActive: options.dragActive,
    activeAgentControlState: () => options.presentation.activeAgentControlState,
    activeSlashCommands: () => options.presentation.activeSlashCommands,
    activeWorkbenchTabId: options.activeWorkbenchTabId,
    activeTitle: () => options.presentation.activeTitle,
    activeSessionActivity: () => options.presentation.activeSessionActivity,
    activeTodoSnapshot: () => options.presentation.activeTodoSnapshot,
    activeSubagentSnapshot: () => options.presentation.activeSubagentSnapshot,
    pendingElicitation: () => options.presentation.activePendingElicitation,
    questionImageAdding: (requestId) => options.interactions.questionImageOperationIds.has(requestId),
    externalEditorLabel: () => externalEditorLabel(options.project.workspace.externalEditor),
    isEditableProjectMarkdown,
    reconnect: options.reconnect,
    errors: options.errors,
    sessionTabs: options.transitions.sessionTabs,
    transcriptScroll: options.transcriptScroll,
    workspaceController: options.workspaceController,
    preview: options.project.preview,
    transcriptAttachments: options.transcriptAttachments,
    branchActions: options.conversation.branches,
    history: options.sessions.history,
    promptQueue: options.promptActions.queue,
    promptRuntime: options.prompt.runtime,
    autocomplete: options.sessions.autocomplete,
    draft: options.transitions.draft,
    conversationActions: options.conversation.actions,
    promptSubmit: options.promptActions.submit,
    projectActions: options.projectActions.actions,
    attachments: options.interactions.attachments,
    projectDocuments: options.project.documents,
    projectWorkspace: options.project.workspace,
    git: options.project.git,
    gitAssist: options.workbenchGit.gitAssist,
    inspectorPreference: options.sessions.inspectorPreference,
    elicitation: options.interactions.elicitation,
    questionImages: options.interactions.questionImages,
  });

  const overlays = createDesktopOverlaysViewModel({
    pendingElicitation: () => options.presentation.activePendingElicitation,
    displayedConfigOptions: options.displayedConfigOptions,
    canUseSession: () => options.presentation.canUseSession,
    changingConfig: options.changingConfig,
    draftSessionTabActive: () => options.transitions.draft.active,
    draftConfigAvailable: () => options.model.config.draftConfigOptions.length > 0,
    activeSessionRuntimeReady: () => options.state.runtimeReady,
    elicitation: options.interactions.elicitation,
    commands: options.commands.controller,
    modelConfig: options.model.config,
    preferences: options.model.preferences,
  });

  const statusBar = createDesktopStatusBarViewModel({
    status: options.status,
    displayedConfigOptions: options.displayedConfigOptions,
    changingConfig: options.changingConfig,
    promptRunning: () => options.presentation.promptRunning,
    canUseSession: () => options.presentation.canUseSession,
    sessionHistoryLoading: () => options.sessions.history.loading,
    draftSessionTabActive: () => options.transitions.draft.active,
    draftConfigAvailable: () => options.model.config.draftConfigOptions.length > 0,
    activeSessionRuntimeReady: () => options.state.runtimeReady,
    activeSessionId: () => options.state.sessionId,
    activeAgentControlState: () => options.presentation.activeAgentControlState,
    dcpCompressionAvailable: () => options.presentation.dcpCompressionAvailable,
    sessionActivity: () => options.presentation.activeSessionActivity,
    sessionNeedsInput: () => options.presentation.activePendingElicitation !== null,
    commandPaletteShortcut: () => desktopCommandShortcutLabel("application.commandPalette", options.platform),
    runtime: options.sessions.runtime,
    dcp: options.orchestration.dcp,
    modelConfig: options.model.config,
    sessionCoordinator: options.orchestration.coordinator,
    inspectorPreference: options.sessions.inspectorPreference,
    navigation: options.conversation.navigation,
    commands: options.commands.controller,
  });

  return { titlebar, sidebar, workbench, overlays, statusBar };
}

export type DesktopViewModelServices = ReturnType<typeof createDesktopViewModelServices>;
