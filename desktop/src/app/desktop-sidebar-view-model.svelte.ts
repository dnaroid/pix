import type { ComponentProps } from "svelte";
import type { SessionConfigOption, SessionInfo } from "@agentclientprotocol/sdk";
import { resolveUsageSessionId, type UsageSessionTarget } from "../lib/usage-stats";
import DesktopSidebar from "../components/DesktopSidebar.svelte";
import type { AcpClient, RuntimeStatus } from "../lib/acp-client";
import ProjectSwitcher from "../components/ProjectSwitcher.svelte";
import type { createAttachmentDraftController } from "./attachment-drafts";
import type { createGitAssist } from "./git-assist";
import type { createKnowledgeResolution } from "./knowledge-resolution.svelte";
import type { createGitCiStore } from "./git-ci.svelte";
import type { createGitWorkspaceStore } from "./git-workspace.svelte";
import type { createPreviewStore } from "./preview.svelte";
import type { createProjectActions } from "./project-actions.svelte";
import type { createProjectDocumentsStore } from "./project-documents.svelte";
import type { createProjectTasksStore } from "./project-tasks.svelte";
import type { createPlanLaunchesStore } from "./plan-launches.svelte";
import { planOwners, type PlanRun } from "../lib/project-task-plans";
import { planRunStatus } from "../lib/plan-launches";
import { projectTaskDisplayLabel } from "../lib/project-tasks";
import type { createModelPreferencesStore } from "./model-preferences.svelte";
import type { createProjectWorkspaceStore } from "./project-workspace.svelte";
import type { createRegistryStore } from "./registry.svelte";
import type { createSessionTabController } from "./session-tab-controller";
import type { createWorkspaceController } from "./workspace-controller";

type SidebarProps = ComponentProps<typeof DesktopSidebar>["props"];

/** Reopening the Git panel within this window reuses the last remote check. */
const GIT_OPEN_REMOTE_MAX_AGE_MS = 5 * 60_000;
type ProjectSwitcherProps = Omit<ComponentProps<typeof ProjectSwitcher>, "variant">;

export function createDesktopSidebarViewModel(options: {
  workspace: () => string;
  client: () => AcpClient | null;
  lspSessionId: () => string | null;
  providerStatuses?: () => readonly RuntimeStatus[];
  configOptions: () => SessionConfigOption[];
  modelPreferences: ReturnType<typeof createModelPreferencesStore>;
  canUseSession: () => boolean;
  /** ACP client initialized and workspace session restoration finished. */
  planRunReady?: () => boolean;
  registryReady: () => boolean;
  contextCommands?: () => readonly import("@agentclientprotocol/sdk").AvailableCommand[];
  gitAssistantReady: () => boolean;
  anyPromptRunning: () => boolean;
  sessionMutationRunning: () => boolean;
  externalEditorLabel: () => string;
  projectTasks: ReturnType<typeof createProjectTasksStore>;
  projectWorkspace: ReturnType<typeof createProjectWorkspaceStore>;
  projectActions: ReturnType<typeof createProjectActions>;
  projectDocuments: ReturnType<typeof createProjectDocumentsStore>;
  planLaunches?: ReturnType<typeof createPlanLaunchesStore>;
  /** Sessions with a prompt in flight (plan run status). */
  runningSessionIds?: () => ReadonlySet<string>;
  registry: ReturnType<typeof createRegistryStore>;
  git: ReturnType<typeof createGitWorkspaceStore>;
  gitCi: ReturnType<typeof createGitCiStore>;
  gitAssist: ReturnType<typeof createGitAssist>;
  knowledgeResolution?: ReturnType<typeof createKnowledgeResolution>;
  preview: ReturnType<typeof createPreviewStore>;
  attachments: ReturnType<typeof createAttachmentDraftController>;
  sessionTabs: ReturnType<typeof createSessionTabController>;
  sessions: () => readonly SessionInfo[];
  refreshSessions: () => Promise<void>;
  reportError: (error: unknown) => void;
  openProjectSettings?: () => void;
  workspaceController: ReturnType<typeof createWorkspaceController>;
}) {
  const projectSwitchDisabled = $derived(
    options.anyPromptRunning()
      || options.sessionMutationRunning()
      || options.projectTasks.saving
      || options.projectActions.actionId !== null,
  );
  const onProjectSwitcherOpen = () => {
    options.sessionTabs.closeSessionSelector();
    options.projectWorkspace.refreshColors(options.projectWorkspace.recentProjects);
  };
  const onSelectProject = (path: string) => void options.workspaceController.select(path);
  /** Usage reports Pi header ids; Desktop sessions are keyed by ACP ids. */
  async function openUsageSession(target: UsageSessionTarget): Promise<void> {
    let sessionId = resolveUsageSessionId(target, options.sessions());
    if (!sessionId) {
      await options.refreshSessions();
      sessionId = resolveUsageSessionId(target, options.sessions());
    }
    if (sessionId) await options.sessionTabs.loadSession(sessionId);
    else options.reportError(new Error("This session is not in the current project's session list."));
  }
  const planOwnerLabels = $derived.by(() => {
    const labels: Record<string, string> = {};
    for (const [path, task] of Object.entries(planOwners(options.projectTasks.document.tasks))) labels[path] = projectTaskDisplayLabel(task);
    return labels;
  });
  const planRuns = $derived.by(() => {
    const workspace = options.workspace();
    const launches = options.planLaunches;
    const runs: Record<string, PlanRun[]> = {};
    if (!launches || !workspace) return runs;
    const titles = new Map(options.sessions().map((session) => [session.sessionId, session.title]));
    const running = options.runningSessionIds?.() ?? new Set<string>();
    const snapshot = options.projectDocuments.snapshot;
    for (const path of snapshot.plans) {
      // Runs whose session was deleted are not listed: there is nothing to open.
      const entries = launches.sessionsFor(workspace, path).filter((run) => titles.has(run.sessionId));
      if (entries.length) runs[path] = entries.map((run) => ({
        sessionId: run.sessionId,
        launchedAt: run.launchedAt,
        title: titles.get(run.sessionId) || "Untitled conversation",
        status: planRunStatus(run, run.live || running.has(run.sessionId), snapshot.planProgress?.[path]),
      }));
    }
    return runs;
  });
  const onChooseWorkspace = () => void options.workspaceController.choose();
  const onChooseWorkspaceInNewWindow = () => void options.workspaceController.chooseInNewWindow();

  const projectSwitcher = $derived.by<ProjectSwitcherProps>(() => ({
    workspace: options.workspace(),
    recentProjects: options.projectWorkspace.recentProjects,
    projectColors: options.projectWorkspace.projectColors,
    projectIcons: options.projectWorkspace.projectIcons,
    currentWindowDisabled: projectSwitchDisabled,
    onOpen: onProjectSwitcherOpen,
    onSelectProject,
    onOpenProjectInNewWindow: options.workspaceController.openInNewWindow,
    onRemoveProject: options.projectWorkspace.forget,
    onOpenProjectInFinder: (path) => void options.projectWorkspace.openInFinder(path),
    onChooseWorkspace,
    onChooseWorkspaceInNewWindow,
    onOpenProjectSettings: options.openProjectSettings,
  }));

  const props = $derived.by<SidebarProps>(() => ({
    workspace: options.workspace(),
    lspClient: options.client(),
    lspSessionId: options.lspSessionId(),
    providerStatuses: options.providerStatuses?.() ?? [],
    settingsConfigOptions: options.configOptions(),
    visibleModelRefs: options.modelPreferences.visibleModelRefs,
    rememberedThinkingByModel: options.modelPreferences.rememberedThinkingByModel,
    onVisibleModelsChange: options.modelPreferences.saveVisibleModelRefs,
    tasks: options.projectTasks.document.tasks,
    taskAttachmentCounts: options.projectTasks.attachmentCounts,
    loading: options.projectTasks.loading,
    initialLoading: options.projectTasks.initialLoading,
    saving: options.projectTasks.saving,
    storageError: options.projectTasks.loadFailed,
    taskStorageIndicatorError: options.projectTasks.saveError,
    activeTaskId: options.projectActions.actionId,
    sessionReady: options.canUseSession(),
    registryReady: options.registryReady(),
    gitAssistantReady: options.gitAssistantReady(),
    registrySnapshot: options.registry.snapshot,
    registryContextCommands: options.contextCommands?.() ?? [],
    registryProjectInitialized: options.registry.projectInitialized,
    registryProjectPiSizeBytes: options.registry.projectPiSizeBytes,
    registryProjectPiCleanupBytes: options.registry.projectPiCleanupBytes,
    registryProjectPiCleanupAvailable: options.registry.projectPiCleanupAvailable,
    registryProjectPiStorageLoading: options.registry.projectPiStorageLoading,
    registryProjectPiStorageError: options.registry.projectPiStorageError,
    registryBackgroundSync: options.registry.backgroundSyncState,
    registryLoading: options.registry.actionId === "refresh",
    registryActionId: options.registry.actionId
      ?? (options.registry.backgroundSyncState.phase === "syncing" ? "background-sync" : null)
      ?? (options.registry.resourceAutoPushState.phase === "syncing" ? "resource-auto-push" : null),
    registryDiff: options.registry.diff,
    gitSnapshot: options.git.snapshot,
    gitUninitialized: options.git.uninitialized,
    gitLoading: options.git.loading,
    gitError: options.git.error,
    gitActionId: options.git.actionId,
    gitLlmActionId: options.git.llmActionId,
    gitCi: {
      snapshot: options.gitCi.snapshot,
      loading: options.gitCi.loading,
      error: options.gitCi.error,
      jobs: options.gitCi.jobs,
      jobsLoading: options.gitCi.jobsLoading,
      jobsErrors: options.gitCi.jobsErrors,
      onActivate: options.gitCi.activate,
      onDeactivate: options.gitCi.deactivate,
      onRefresh: () => void options.gitCi.refresh(true),
      onRefreshIndicator: () => void options.gitCi.refreshIndicator(),
      onLoadJobs: options.gitCi.loadJobs,
      canFixWithAi: options.gitAssist.canFixCi(options.gitCi.snapshot),
      onFixWithAi: () => options.gitAssist.fixCiInNewSession(options.gitCi.snapshot),
    },
    gitWorkflow: {
      review: options.git.reviewResult,
      resolveRunning: options.git.resolveRunning,
      canResolve: options.canUseSession() && !options.sessionMutationRunning() && !options.anyPromptRunning(),
            details: options.git.details,
      detailsLoading: options.git.detailsLoading,
      selectedCommit: options.git.diffPreview?.commit ?? null,
      onShowCommitDiff: () => {
        const diff = options.git.diffPreview;
        if (diff?.commit) options.git.showDiff(diff);
      },
      onOpenCommit: (hash) => {
        void options.git.openCommitDiff(hash).catch((error: unknown) => {
          options.git.setError(error instanceof Error ? error.message : String(error));
        });
      },
      onShowReview: options.git.showReview,
      onResolve: () => void options.gitAssist.resolveReviewInNewSession(),
      onLoadDetails: () => void options.git.loadDetails(),
      onRepositoryAction: options.git.repositoryAction,
      onSaveIdentity: options.git.saveIdentity,
    },
    projectDocuments: options.projectDocuments.snapshot,
    knowledgeJobs: options.projectDocuments.knowledgeJobs,
    wikiAutoCheck: options.projectDocuments.wikiAutoCheck,
    onSetWikiAutoCheck: options.projectDocuments.setWikiAutoCheck,
    onCancelKnowledgeCheck: options.projectDocuments.cancelKnowledgeCheck,
    onDismissKnowledgeCheck: options.projectDocuments.dismissKnowledgeCheck,
    onOpenKnowledgeCitation: (citation, language) => options.preview.openKnowledgeCitation(citation, "push", language),
    knowledgeSourcesEnabled: !options.preview.dirty,
    knowledgeResolving: options.knowledgeResolution?.starting ?? false,
    onResolveKnowledgeJob: options.knowledgeResolution && options.gitAssistantReady() && !options.sessionMutationRunning()
      ? (job) => {
        if (job.result && options.projectDocuments.knowledgeJobs.some(current => current.id === job.id && current.workspace === job.workspace && current.result === job.result)) {
          return options.knowledgeResolution!.start({ workspace: job.workspace, result: job.result, content: job.content });
        }
      }
      : undefined,
    onStartWikiMigration: options.knowledgeResolution && options.gitAssistantReady() && !options.sessionMutationRunning()
      ? (workspace, config) => options.knowledgeResolution!.startWikiMigration(workspace, config)
      : undefined,
    activeProjectDocumentPath: options.preview.active?.kind === "file"
      ? options.preview.active.file.virtualWikiDirectory ?? options.preview.active.file.path : null,
    planActionsDisabled: options.projectActions.actionId !== null || options.projectDocuments.removing !== null,
    planRunDisabled: !(options.planRunReady?.() ?? true) || !options.canUseSession() || options.sessionMutationRunning(),
    recentProjects: options.projectWorkspace.recentProjects,
    projectColors: options.projectWorkspace.projectColors,
    projectIcons: options.projectWorkspace.projectIcons,
    projectSwitchDisabled,
    externalEditorLabel: options.externalEditorLabel(),
    onCreate: options.projectTasks.create,
    onUpdate: options.projectTasks.update,
    onPriorityChange: options.projectTasks.updatePriority,
    onObserveTasks: options.projectTasks.observe,
    onStatusChange: options.projectTasks.updateStatus,
    onChooseTaskAttachments: options.attachments.chooseTaskAttachments,
    onPasteTaskAttachments: options.attachments.pasteTaskAttachments,
    onOpenTaskAttachment: (attachment) => void options.preview.activateAttachment(attachment),
    onDelete: options.projectTasks.remove,
    onReorder: options.projectTasks.reorder,
    onRun: (task) => void options.projectActions.runTask(task),
    onOpenSession: (task) => void options.projectActions.openTaskSession(task),
    onCreateTaskPlan: (task) => void options.projectActions.createTaskPlan(task),
    onOpenUsageSession: (target) => void openUsageSession(target),
    onOpenProjectDocument: options.projectDocuments.open,
    onRefreshPlans: options.projectDocuments.refresh,
    onRunPlan: (path) => void options.projectActions.runPlan(path),
    onResumePlan: (path) => void options.projectActions.resumePlan(path),
    onDeletePlan: (path) => void options.projectDocuments.removePlan(path),
    planOwners: planOwnerLabels,
    planRuns,
    onOpenPlanRun: (sessionId) => void options.sessionTabs.loadSession(sessionId),
    onListProjectDirectory: options.projectWorkspace.listDirectory,
    onValidateProjectFile: options.preview.validateProjectFile,
    onOpenProjectFile: (path, range) => void options.preview.openProjectFile(path, "replace", range),
    onOpenWikiFile: (path, searchRange) => void options.preview.openProjectFile(path, "push", undefined, true, "document", searchRange),
    onOpenFilesFile: (path) => void options.preview.openProjectFile(path, "replace", undefined, true),
    onBeforeFilesMutation: async () => {
      if (options.preview.dirty) throw new Error("Save or discard the Preview draft before changing files.");
      const release = await options.projectDocuments.prepareFileMutation();
      if (options.preview.dirty) { release(); throw new Error("Save or discard the Preview draft before changing files."); }
      // Closing clean Preview also invalidates pending reads and stale save targets.
      options.preview.close();
      return release;
    },
    onOpenUserConfig: (kind) => void options.preview.openUserConfig(kind, "replace"),
    onOpenExternalEditor: (path) => void options.projectWorkspace.openInEditor(path),
    onProjectSwitcherOpen,
    onSelectProject,
    onOpenProjectInNewWindow: options.workspaceController.openInNewWindow,
    onRemoveProject: options.projectWorkspace.forget,
    onOpenProjectInFinder: (path) => void options.projectWorkspace.openInFinder(path),
    onChooseWorkspace,
    onChooseWorkspaceInNewWindow,
    onSaveProjectSettings: options.projectWorkspace.saveSettings,
    onPickProjectIcon: options.projectWorkspace.pickIcon,
    onGenerateProjectIcon: options.projectWorkspace.generateIcon,
    onReload: () => void options.projectTasks.load(options.workspace()),
    onRegistryRefresh: options.registry.refresh,
    onRegistryInitializeProject: () => void options.registry.initializeProject(),
    onRegistryCleanProject: () => void options.registry.cleanProject(),
    onRegistryAction: (request, actionId) => void options.registry.runAction(request, actionId),
    onRegistryDiff: options.registry.openDiff,
    onRegistryCloseDiff: options.registry.closeDiff,
    onRegistryProjectChange: options.registry.observeProjectChange,
    onWorkspaceSettingsSave: (workspace) => {
      if (workspace === options.workspace()) options.registry.scheduleProjectSync("workspace");
    },
    onGitRefresh: () => void (async () => {
      await options.git.refreshRemoteStatus();
      await options.gitCi.refresh();
    })(),
    onGitOpen: () => void (async () => {
      // Panel open: show local status immediately; reuse a recent remote check.
      await options.git.refreshRemoteStatus({ maxAgeMs: GIT_OPEN_REMOTE_MAX_AGE_MS });
      await options.gitCi.refresh();
    })(),
    onGitStatusRefresh: options.git.refresh,
    onGitExplorerStatusRefresh: options.git.refreshExplorer,
    onGitInitialize: () => void options.git.initialize(),
    onGitOpenDiff: (path, scope) => void options.git.openDiff(path, scope),
    onGitStage: options.git.stage,
    onGitUnstage: options.git.unstage,
    onGitCommit: options.git.commit,
    onGitPush: options.git.push,
    onGitSwitchBranch: options.git.switchBranch,
    onGitCreateBranch: options.git.createBranch,
    onGitGenerateCommitMessage: options.gitAssist.generateCommitMessage,
    onGitStageGenerateCommitPush: options.gitAssist.stageGenerateCommitPush,
    onGitReview: (path, scope) => void options.gitAssist.reviewDiff(path, scope),
  }));

  return {
    get props() { return props; },
    get projectSwitcher() { return projectSwitcher; },
  };
}
