import { externalEditorLabel } from "../lib/desktop-config";
import { desktopCommandShortcutLabel } from "../lib/desktop-commands";
import { createDesktopSidebarViewModel } from "./desktop-sidebar-view-model.svelte";
import { createDesktopTitlebarViewModel } from "./desktop-titlebar-view-model.svelte";
import type { DesktopViewModelServicesOptions } from "./desktop-view-model-service-options";

export function createDesktopNavigationViewModelServices(options: DesktopViewModelServicesOptions) {
  const titlebar = createDesktopTitlebarViewModel({
    newSessionShortcut: () => desktopCommandShortcutLabel("session.new", options.platform),
    tabs: () => options.presentation.workbenchTabs,
    activeId: options.activeWorkbenchTabId,
    canCreateSession: () => options.presentation.canCreateSession,
    selectWorkbenchTab: options.workbenchGit.workbench.select,
    closeWorkbenchTab: options.workbenchGit.workbench.close,
    reorderWorkbenchTab: options.presentation.reorderWorkbenchTab,
    workspace: options.workspace,
    openSessionStartTab: options.transitions.draft.openStartTab,
    selectorOpen: () => options.sessions.tabs.selectorOpen,
    // SessionSelector hides sub-agent viewers by default and owns the show toggle.
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
    client: () => options.status() === "ready" ? options.client() : null,
    lspSessionId: () => options.state.sessionId,
    providerStatuses: () => {
      if (options.status() !== "ready") return [];
      const statuses = [...options.sessions.runtime.statuses.values()];
      const draft = options.model.config.draftRuntimeStatus;
      if (draft) statuses.push(draft);
      return statuses;
    },
    contextCommands: () => options.state.runtimeReady && options.state.sessionId
      ? options.sessions.metadata.slashCommandsBySession.get(options.state.sessionId) ?? []
      : [],
    workspace: options.workspace,
    configOptions: options.displayedConfigOptions,
    modelPreferences: options.model.preferences,
    canUseSession: () => options.presentation.canUseSession,
    runningSessionIds: () => options.prompt.runtime.runningSessionIds,
    planRunReady: () => options.status() === "ready" && options.clientAvailable() && !options.workspaceOpening?.(),
    registryReady: () => options.status() === "ready" && options.clientAvailable() && !!options.workspace(),
    gitAssistantReady: () => options.status() === "ready" && options.clientAvailable() && !!options.workspace(),
    anyPromptRunning: () => options.presentation.anyPromptRunning,
    sessionMutationRunning: () => options.presentation.sessionMutationRunning,
    externalEditorLabel: () => externalEditorLabel(options.project.workspace.externalEditor),
    projectTasks: options.project.tasks,
    projectWorkspace: options.project.workspace,
    projectActions: options.projectActions.actions,
    projectDocuments: options.project.documents,
    planLaunches: options.project.planLaunches,
    registry: options.project.registry,
    git: options.project.git,
    gitCi: options.project.gitCi,
    gitAssist: options.workbenchGit.gitAssist,
    preview: options.project.preview,
    attachments: options.interactions.attachments,
    sessionTabs: options.transitions.sessionTabs,
    sessions: () => options.sessions.catalog.sessions,
    refreshSessions: () => options.sessions.catalog.refresh(),
    reportError: (error) => options.errors.report(error),
    workspaceController: options.workspaceController,
    openProjectSettings: options.openProjectSettings,
  });

  return { titlebar, sidebar };
}
