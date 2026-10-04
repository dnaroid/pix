import { externalEditorLabel } from "../lib/desktop-config";
import type { DesktopViewModelServicesOptions } from "./desktop-view-model-service-options";
import { createDesktopWorkbenchViewModel } from "./desktop-workbench-view-model.svelte";
import type { createSessionTodoActions } from "./session-todo-actions";

export function createDesktopWorkbenchViewModelServices(
  options: DesktopViewModelServicesOptions,
  todoActions: ReturnType<typeof createSessionTodoActions>,
) {
  async function openBrainstormSession(sessionId: string): Promise<void> {
    const workspace = options.workspace();
    const activeSessionId = options.state.sessionId;
    const client = options.client();
    await options.sessions.catalog.refresh();
    if (workspace !== options.workspace() || activeSessionId !== options.state.sessionId || client !== options.client()) return;
    if (options.sessions.catalog.sessions.some((session) => session.sessionId === sessionId)) {
      await options.transitions.sessionTabs.loadSession(sessionId);
    } else options.errors.report(new Error("This brainstorm session is no longer available."));
  }
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
    inspector: {
      activeSessionId: () => options.state.sessionId,
      activeTitle: () => options.presentation.activeTitle,
      activeSessionActivity: () => options.presentation.activeSessionActivity,
      activeTodoSnapshot: () => options.presentation.activeTodoSnapshot,
      activeSubagentSnapshot: () => options.presentation.activeSubagentSnapshot,
      activeBrainstormSnapshot: () => options.presentation.activeBrainstormSnapshot,
      canClearTodos: () => Boolean(
        options.state.sessionId && todoActions.canClear(options.state.sessionId),
      ),
      clearSessionTodos: todoActions.clear,
      openBrainstormParticipant: openBrainstormSession,
      inspectorPreference: options.sessions.inspectorPreference,
    },
  });
}
