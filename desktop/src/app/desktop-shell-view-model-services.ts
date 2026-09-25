import { sessionSubagentIconNames } from "../lib/session-subagents";
import { createDesktopOverlaysViewModel } from "./desktop-overlays-view-model.svelte";
import { createDesktopStatusBarViewModel } from "./desktop-status-bar-view-model.svelte";
import type { DesktopViewModelServicesOptions } from "./desktop-view-model-service-options";

export function createDesktopShellViewModelServices(options: DesktopViewModelServicesOptions) {
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
    workspace: options.workspace,
    workspaceBranch: () => options.project.git.statusBranch,
    workspaceColor: () => options.project.workspace.projectColors.get(options.workspace()),
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
    sessionSubagentIcons: () => sessionSubagentIconNames(options.presentation.activeSubagentSnapshot),
    sessionNeedsInput: () => options.presentation.activePendingElicitation !== null,
    runtime: options.sessions.runtime,
    dcp: options.orchestration.dcp,
    modelConfig: options.model.config,
    sessionCoordinator: options.orchestration.coordinator,
    inspectorPreference: options.sessions.inspectorPreference,
  });

  return { overlays, statusBar };
}
