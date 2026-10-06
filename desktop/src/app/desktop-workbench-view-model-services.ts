import { externalEditorLabel } from "../lib/desktop-config";
import type { DesktopViewModelServicesOptions } from "./desktop-view-model-service-options";
import { createDesktopWorkbenchViewModel } from "./desktop-workbench-view-model.svelte";
import { createBrainstormSessionOpener } from "./desktop-brainstorm-navigation";

export function createDesktopWorkbenchViewModelServices(
  options: DesktopViewModelServicesOptions,
) {
  const openBrainstormSession = createBrainstormSessionOpener(options);
  return createDesktopWorkbenchViewModel({
    layout: {
      conversationVisible: () => options.presentation.activeWorkbenchTab?.kind === "session",
      conversationLabelledBy: () => options.presentation.activeConversationWorkbenchTabId
        ? `workbench-tab-${options.presentation.activeConversationWorkbenchTabId}`
        : undefined,
    },
    shell: {
      errorMessage: () => options.errors.message,
      statusError: () => options.status() === "error",
      reconnect: options.reconnect,
      errors: options.errors,
      sessionStartOpen: () => options.presentation.sessionStartOpen,
      sessionStartCandidates: () => options.presentation.sessionStartCandidates,
      sessionTabs: options.transitions.sessionTabs,
    },
    conversation: {
      brainstormLink: () => options.presentation.activeBrainstormLink,
      openBrainstormSession,
      transcript: () => options.state.transcript,
      activeSessionId: () => options.state.sessionId,
      workspace: options.workspace,
      promptRunning: () => options.presentation.promptRunning,
      operationRunning: options.operationRunning,
      sessionHistoryLoading: () => options.sessions.history.loading,
      promptText: options.promptText,
      setPromptText: (text) => options.setPromptText(text),
      promptAttachments: options.promptAttachments,
      statusReady: () => options.status() === "ready",
      activeSessionRuntimeReady: () => options.state.runtimeReady,
      sessionMutationRunning: () => options.presentation.sessionMutationRunning,
      dragActive: options.dragActive,
      activeAgentControlState: () => options.presentation.activeAgentControlState,
      activeSlashCommands: () => options.presentation.activeSlashCommands,
      pendingElicitation: () => options.presentation.activePendingElicitation,
      questionImageAdding: (requestId) => options.interactions.questionImageOperationIds.has(requestId),
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
      openHistoryPicker: options.conversation.navigation.openHistoryPicker,
      promptSubmit: options.promptActions.submit,
      projectActions: options.projectActions.actions,
      attachments: options.interactions.attachments,
      elicitation: options.interactions.elicitation,
      questionImages: options.interactions.questionImages,
      lspOnboarding: options.lspOnboarding,
      quotaWait: options.quotaWait,
      headsUp: options.headsUp,
      openBtw: options.openBtw,
    },
    editor: {
      workspace: options.workspace,
      statusReady: () => options.status() === "ready",
      clientAvailable: options.clientAvailable,
      operationRunning: options.operationRunning,
      activeWorkbenchTabId: options.activeWorkbenchTabId,
      terminalOpen: () => options.presentation.workbenchTabs.some((tab) => tab.id === "terminal"),
      externalEditorLabel: () => externalEditorLabel(options.project.workspace.externalEditor),
      preview: options.project.preview,
      projectDocuments: options.project.documents,
      projectWorkspace: options.project.workspace,
      git: options.project.git,
      gitAssist: options.workbenchGit.gitAssist,
      lspOnboarding: options.lspOnboarding,
    },
  });
}
