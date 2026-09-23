import { externalEditorLabel } from "../lib/desktop-config";
import { isEditableProjectMarkdown } from "../lib/project-documents";
import type { DesktopViewModelServicesOptions } from "./desktop-view-model-service-options";
import { createDesktopWorkbenchViewModel } from "./desktop-workbench-view-model.svelte";
import { createSessionTodoActions } from "./session-todo-actions";

export function createDesktopWorkbenchViewModelServices(options: DesktopViewModelServicesOptions) {
  const todoActions = createSessionTodoActions({
    client: options.client,
    ready: (sessionId) => sessionId === options.state.sessionId
      && options.state.runtimeReady
      && !options.presentation.promptRunning
      && !options.presentation.sessionMutationRunning
      && !options.sessions.history.loading,
    reportError: (error) => options.errors.report(error),
  });
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
      transcript: () => options.state.transcript,
      activeSessionId: () => options.state.sessionId,
      workspace: options.workspace,
      promptRunning: () => options.presentation.promptRunning,
      operationRunning: options.operationRunning,
      sessionHistoryLoading: () => options.sessions.history.loading,
      promptText: options.promptText,
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
    },
    editor: {
      workspace: options.workspace,
      statusReady: () => options.status() === "ready",
      clientAvailable: options.clientAvailable,
      operationRunning: options.operationRunning,
      activeWorkbenchTabId: options.activeWorkbenchTabId,
      externalEditorLabel: () => externalEditorLabel(options.project.workspace.externalEditor),
      isEditableProjectMarkdown,
      preview: options.project.preview,
      projectDocuments: options.project.documents,
      projectWorkspace: options.project.workspace,
      git: options.project.git,
      gitAssist: options.workbenchGit.gitAssist,
    },
    inspector: {
      activeSessionId: () => options.state.sessionId,
      activeTitle: () => options.presentation.activeTitle,
      activeSessionActivity: () => options.presentation.activeSessionActivity,
      activeTodoSnapshot: () => options.presentation.activeTodoSnapshot,
      activeSubagentSnapshot: () => options.presentation.activeSubagentSnapshot,
      canClearTodos: () => Boolean(
        options.state.sessionId && todoActions.canClear(options.state.sessionId),
      ),
      clearSessionTodos: todoActions.clear,
      inspectorPreference: options.sessions.inspectorPreference,
    },
  });
}
