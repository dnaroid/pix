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

  return { titlebar, sidebar };
}
