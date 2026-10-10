import { createDesktopOverlaysViewModel } from "./desktop-overlays-view-model.svelte";
import { createDesktopStatusBarViewModel } from "./desktop-status-bar-view-model.svelte";
import type { DesktopViewModelServicesOptions } from "./desktop-view-model-service-options";
import type { createSessionTodoActions } from "./session-todo-actions";
import { createBrainstormSessionOpener } from "./desktop-brainstorm-navigation";

export function createDesktopShellViewModelServices(
  options: DesktopViewModelServicesOptions,
  todoActions: ReturnType<typeof createSessionTodoActions>,
) {
  const openBrainstormSession = createBrainstormSessionOpener(options);
  const overlays = createDesktopOverlaysViewModel({
    pendingElicitation: () => options.presentation.activePendingElicitation,
    displayedConfigOptions: options.displayedConfigOptions,
    canUseSession: () => options.presentation.canUseSession,
    changingConfig: options.changingConfig,
    draftSessionTabActive: () => options.transitions.draft.active,
    draftConfigAvailable: () => options.model.config.draftConfigOptions.length > 0,
    activeSessionRuntimeReady: () => options.state.runtimeReady,
    activeSessionId: () => options.state.sessionId,
    elicitation: options.interactions.elicitation,
    commands: options.commands.controller,
    modelConfig: options.model.config,
    preferences: options.model.preferences,
    quotaWait: options.quotaWait,
    focusComposer: options.focusComposer,
  });

  const statusBar = createDesktopStatusBarViewModel({
    status: options.status,
    workspace: options.workspace,
    tabs: options.sessions.tabs,
    displayedConfigOptions: options.displayedConfigOptions,
    changingConfig: options.changingConfig,
    promptRunning: () => options.presentation.promptRunning,
    canUseSession: () => options.presentation.canUseSession,
    sessionHistoryLoading: () => options.sessions.history.loading,
    draftSessionTabActive: () => options.transitions.draft.active,
    draftConfigAvailable: () => options.model.config.draftConfigOptions.length > 0,
    activeSessionRuntimeReady: () => options.state.runtimeReady,
    activeSessionId: () => options.state.sessionId,
    sessionActivity: () => options.presentation.activeSessionActivity,
    sessionSubagentSnapshot: () => options.presentation.activeSubagentSnapshot,
    sessionTodoSnapshot: () => options.presentation.activeTodoSnapshot,
    sessionBrainstormSnapshot: () => options.presentation.activeBrainstormSnapshot,
    sessionNeedsInput: () => options.presentation.activePendingElicitation !== null,
    canClearTodos: () => Boolean(
      options.state.sessionId && todoActions.canClear(options.state.sessionId),
    ),
    clearSessionTodos: todoActions.clear,
    runtime: options.sessions.runtime,
    modelConfig: options.model.config,
    sessionCoordinator: options.orchestration.coordinator,
    quotaWait: options.quotaWait,
    headsUp: options.headsUp,
    openObserverSettings: options.openObserverSettings,
    openBrainstormParticipant: (sessionId) => {
      void openBrainstormSession(sessionId).catch(options.errors.report);
    },
  });

  return { overlays, statusBar };
}
