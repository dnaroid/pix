import type { ComponentProps } from "svelte";
import DesktopSidebar from "../components/DesktopSidebar.svelte";
import type { createAttachmentDraftController } from "./attachment-drafts";
import type { createGitAssist } from "./git-assist";
import type { createGitWorkspaceStore } from "./git-workspace.svelte";
import type { createPreviewStore } from "./preview.svelte";
import type { createProjectActions } from "./project-actions.svelte";
import type { createProjectDocumentsStore } from "./project-documents.svelte";
import type { createProjectTasksStore } from "./project-tasks.svelte";
import type { createProjectWorkspaceStore } from "./project-workspace.svelte";
import type { createRegistryStore } from "./registry.svelte";
import type { createSessionTabController } from "./session-tab-controller";
import type { createWorkspaceController } from "./workspace-controller";

type SidebarProps = ComponentProps<typeof DesktopSidebar>["props"];

export function createDesktopSidebarViewModel(options: {
  workspace: () => string;
  canUseSession: () => boolean;
  anyPromptRunning: () => boolean;
  sessionMutationRunning: () => boolean;
  externalEditorLabel: () => string;
  projectTasks: ReturnType<typeof createProjectTasksStore>;
  projectWorkspace: ReturnType<typeof createProjectWorkspaceStore>;
  projectActions: ReturnType<typeof createProjectActions>;
  projectDocuments: ReturnType<typeof createProjectDocumentsStore>;
  registry: ReturnType<typeof createRegistryStore>;
  git: ReturnType<typeof createGitWorkspaceStore>;
  gitAssist: ReturnType<typeof createGitAssist>;
  preview: ReturnType<typeof createPreviewStore>;
  attachments: ReturnType<typeof createAttachmentDraftController>;
  sessionTabs: ReturnType<typeof createSessionTabController>;
  workspaceController: ReturnType<typeof createWorkspaceController>;
}) {
  const props = $derived.by<SidebarProps>(() => ({
    workspace: options.workspace(),
    tasks: options.projectTasks.document.tasks,
    loading: options.projectTasks.loading,
    saving: options.projectTasks.saving,
    storageError: options.projectTasks.loadFailed,
    taskStorageIndicatorError: options.projectTasks.saveError,
    activeTaskId: options.projectActions.actionId,
    sessionReady: options.canUseSession(),
    registrySnapshot: options.registry.snapshot,
    registryBackgroundSync: options.registry.backgroundSyncState,
    registryLoading: options.registry.actionId === "refresh",
    registryActionId: options.registry.actionId
      ?? (options.registry.backgroundSyncState.phase === "syncing" ? "background-sync" : null),
    gitSnapshot: options.git.snapshot,
    gitLoading: options.git.loading,
    gitError: options.git.error,
    gitActionId: options.git.actionId,
    gitLlmActionId: options.git.llmActionId,
    projectDocuments: options.projectDocuments.snapshot,
    recentProjects: options.projectWorkspace.recentProjects,
    projectColors: options.projectWorkspace.projectColors,
    projectSwitchDisabled: options.anyPromptRunning()
      || options.sessionMutationRunning()
      || options.projectTasks.saving
      || options.projectActions.actionId !== null,
    externalEditorLabel: options.externalEditorLabel(),
    onCreate: options.projectTasks.create,
    onUpdate: options.projectTasks.update,
    onStatusChange: options.projectTasks.updateStatus,
    onChooseTaskAttachments: options.attachments.chooseTaskAttachments,
    onPasteTaskAttachments: options.attachments.pasteTaskAttachments,
    onOpenTaskAttachment: (attachment) => void options.preview.activateAttachment(attachment),
    onDelete: options.projectTasks.remove,
    onReorder: options.projectTasks.reorder,
    onRun: (task) => void options.projectActions.runTask(task),
    onOpenSession: (task) => void options.projectActions.openTaskSession(task),
    onOpenProjectDocument: options.projectDocuments.open,
    onListProjectDirectory: options.projectWorkspace.listDirectory,
    onValidateProjectFile: options.preview.validateProjectFile,
    onOpenProjectFile: (path, range) => void options.preview.openProjectFile(path, "replace", range),
    onOpenExternalEditor: (path) => void options.projectWorkspace.openInEditor(path),
    onProjectSwitcherOpen: () => {
      options.sessionTabs.closeSessionSelector();
      options.projectWorkspace.refreshColors(options.projectWorkspace.recentProjects);
    },
    onSelectProject: (path) => void options.workspaceController.select(path),
    onOpenProjectInNewWindow: options.workspaceController.openInNewWindow,
    onChooseWorkspace: () => void options.workspaceController.choose(),
    onChooseWorkspaceInNewWindow: () => void options.workspaceController.chooseInNewWindow(),
    onSaveProjectColor: options.projectWorkspace.saveColor,
    onReload: () => void options.projectTasks.load(options.workspace()),
    onRegistryRefresh: options.registry.refresh,
    onRegistryAction: (request, actionId) => void options.registry.runAction(request, actionId),
    onRegistryProjectChange: options.registry.scheduleProjectSync,
    onGitRefresh: () => void options.git.refresh(),
    onGitOpenDiff: (path, scope) => void options.git.openDiff(path, scope),
    onGitStage: options.git.stage,
    onGitUnstage: options.git.unstage,
    onGitCommit: options.git.commit,
    onGitPush: options.git.push,
    onGitSwitchBranch: options.git.switchBranch,
    onGitCreateBranch: options.git.createBranch,
    onGitGenerateCommitMessage: options.gitAssist.generateCommitMessage,
    onGitReview: (path, scope) => void options.gitAssist.reviewDiff(path, scope),
    onRefreshKnowledge: () => void options.projectActions.refreshKnowledgeBase(),
  }));

  return {
    get props() { return props; },
  };
}
