<script lang="ts">
  import DeleteConfirmationDialog from "./DeleteConfirmationDialog.svelte";
  import { iconButtonClass } from "../lib/icon-button";
  import { confirmDesktopAction } from "../lib/confirm-action";
  import type { SessionConfigOption } from "@agentclientprotocol/sdk";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import FilePlus from "@lucide/svelte/icons/file-plus";
  import Folder from "@lucide/svelte/icons/folder";
  import FolderOpen from "@lucide/svelte/icons/folder-open";
  import FolderPlus from "@lucide/svelte/icons/folder-plus";
  import Globe from "@lucide/svelte/icons/globe";
  import GripVertical from "@lucide/svelte/icons/grip-vertical";
  import ListTodo from "@lucide/svelte/icons/list-todo";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import Settings from "@lucide/svelte/icons/settings";
  import X from "@lucide/svelte/icons/x";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { openExternalHref } from "../lib/external-links";
  import { invoke } from "@tauri-apps/api/core";
  import { windowLayoutKey } from "../lib/window-layout-storage";
  import { modelThinkingConfigState } from "../lib/model-thinking";
  import { onMount, tick, untrack } from "svelte";
  import { createWorkspaceSearchIndexOwner } from "../lib/workspace-search-index-owner.svelte";
  import {
    attachmentFromFile,
    type Attachment,
    type AttachmentFile,
  } from "../lib/attachments";
  import {
    projectTaskDisplayLabel,
    type ProjectTask,
    type ProjectTaskStatus,
    type ProjectTaskPriority,
    type ProjectTaskType,
    normalizeProjectTaskLink,
  } from "../lib/project-tasks";
  import type { GitDiffScope, GitSnapshot } from "../lib/git";
  import type { GitCiPanelState } from "../lib/git-ci";
  import type { GitPanelWorkflow } from "../lib/git-workflow";
  import type { ProjectFileLineRange } from "../lib/project-files";
  import type { ProjectWikiConfig } from "../lib/project-wiki";
  import type { ProjectTreeEntry } from "../lib/project-tree";
  import type { SettingsConfigKind } from "../lib/settings";
  import type { ProjectDocumentsSnapshot } from "../lib/project-documents";
  import {
    type RegistryActionRequest,
    type RegistryDiffState,
    type RegistryItem,
    type RegistryProjectArtifact,
    type RegistrySnapshot,
  } from "../lib/registry";
  import type { RegistryBackgroundSyncState } from "../lib/registry-background-sync";
  import {
    SidebarIndicatorService,
    sidebarIndicators,
    sidebarIndicatorReasons,
    type SidebarIndicatorMap,
    type SidebarIndicatorServiceState,
    type SidebarIndicatorTab,
  } from "../lib/sidebar-indicators";
  import { gitPushBlockedReason, gitStageGenerateCommitPushBlockedReason } from "../lib/git-workflow";
  import { sidebarGitSignature } from "../lib/sidebar-git-signature";
  import { createWorkspaceSidebarIndicatorActions } from "./workspace-sidebar-indicator-actions";
  import { createSidebarProjectRetry } from "./sidebar-project-retry";
  import SidebarIndicatorMenu from "./SidebarIndicatorMenu.svelte";
  import RegistryPanel from "./RegistryPanel.svelte";
  import SearchIndexPanel from "./SearchIndexPanel.svelte";
  import LspPanel from "./LspPanel.svelte";
  import UsagePanel, { type UsagePanelHandle } from "./usage/UsagePanel.svelte";
  import type { UsageSessionTarget } from "../lib/usage-stats";
  import LogsPanel from "./LogsPanel.svelte";
  import { createLogPanelPreference } from "../lib/log-panel-preference.svelte";
  import type { AcpClient, RuntimeStatus } from "../lib/acp-client";
  import GitPanel from "./GitPanel.svelte";
  import ProjectExplorer from "./ProjectExplorer.svelte";
  import ProjectWikiPanel from "./ProjectWikiPanel.svelte";
  import WikiAutoCheckControl from "./WikiAutoCheckControl.svelte";
  import type { WikiAutoCheckView } from "../lib/wiki-auto-check-config";
  import type { KnowledgeCitation, KnowledgeReportLanguage } from "../../../acp/src/knowledge/contract";
  import type { ProjectKnowledgeJob } from "../app/project-knowledge-queue.svelte";
  import PackageScriptsPanel from "./PackageScriptsPanel.svelte";
  import { createPackageScriptsController } from "./package-scripts-controller.svelte";
  import type { TerminalSurfaceHandle } from "./TerminalSessionsPane.svelte";
  import { hasLaunchCommandMenu, launchCommandMenu } from "../lib/launch-command-menu";
  import ProjectSettingsDialog from "./ProjectSettingsDialog.svelte";
  import type { ProjectIconImage, ProjectSettingsDraft } from "../lib/project-icon";
  import ProjectSwitcher from "./ProjectSwitcher.svelte";
  import SettingsPanel from "./SettingsPanel.svelte";
  import WorkspaceSidebarActivityBar from "./WorkspaceSidebarActivityBar.svelte";
  import { createRegistryPlansView } from "./registry-plans-view.svelte";
  import { createWorkspaceSidebarLayoutController } from "./workspace-sidebar-layout-controller.svelte";
  import { createWorkspaceSidebarProjectSettingsController } from "./workspace-sidebar-project-settings-controller.svelte";
  import { createWorkspaceSidebarStatusMenuController } from "./workspace-sidebar-status-menu-controller.svelte";
  import {
    createWorkspaceSidebarTaskDragController,
    type WorkspaceSidebarTaskDropPosition,
  } from "./workspace-sidebar-task-drag-controller.svelte";
  import WorkspaceSidebarTaskEditor from "./WorkspaceSidebarTaskEditor.svelte";
  import WorkspaceSidebarTaskQuickAdd from "./WorkspaceSidebarTaskQuickAdd.svelte";
  import WorkspaceSidebarTasksPanel from "./WorkspaceSidebarTasksPanel.svelte";
  import RegistryPlansPanel from "./RegistryPlansPanel.svelte";
  import { createWorkspaceSidebarTasksViewController } from "./workspace-sidebar-tasks-view-controller.svelte";
  import { createWorkPanelSections } from "../app/work-panel-sections.svelte";
  import type { WorkSectionId } from "../lib/work-panel-sections";
  import { createDiagnosticLogger } from "../lib/diagnostic-logging";

  type TaskDraft = {
    title: string;
    description?: string;
    type: ProjectTaskType;
    expectedTask?: ProjectTask;
    status?: ProjectTaskStatus;
    attachments?: readonly Attachment[];
    links?: readonly string[];
    relatedTaskIds?: readonly string[];
    parentId?: string;
    epic?: boolean;
    modelRef?: string;
  };

  type SidebarTab = SidebarIndicatorTab;
  type SettingsPanelHandle = { openSection: (id: string) => Promise<void>; openField: (section: string, fieldId: string) => Promise<void> };
  const SIDEBAR_LABELS: Record<SidebarTab, string> = {
    tasks: "Work",
    project: "Project",
    wiki: "Wiki",
    git: "Source Control",
    registry: "Registry",
    scripts: "Launch Commands",
    search: "Search Indexes",
    usage: "Usage",
    lsp: "Language Servers",
    logs: "Logs",
    settings: "Settings",
  };
  let {
    workspace,
    lspClient,
    lspSessionId,
    providerStatuses = [],
    settingsConfigOptions,
    visibleModelRefs,
    rememberedThinkingByModel = {},
    onVisibleModelsChange = () => {},
    tasks,
    loading,
    initialLoading = loading,
    taskAttachmentCounts = {},
    saving,
    storageError,
    taskStorageIndicatorError,
    activeTaskId,
    sessionReady,
    registryReady,
    registryActivity = null,
    gitAssistantReady,
    registrySnapshot,
    registryContextCommands = [],
    registryProjectInitialized,
    registryProjectPiSizeBytes,
    registryProjectPiCleanupBytes,
    registryProjectPiCleanupAvailable,
    registryProjectPiStorageLoading,
    registryProjectPiStorageError,
    registryBackgroundSync,
    registryLoading,
    registryActionId,
    registryDiff,
    gitSnapshot,
    gitUninitialized,
    gitLoading,
    gitError,
    gitActionId,
    gitLlmActionId,
    gitCi,
    gitWorkflow,
    projectDocuments,
    knowledgeJobs = [],
    wikiAutoCheck,
    onSetWikiAutoCheck,
    onCancelKnowledgeCheck,
    onDismissKnowledgeCheck,
    onOpenKnowledgeCitation,
    onResolveKnowledgeJob,
    onStartWikiMigration,
    knowledgeSourcesEnabled = true,
    knowledgeResolving = false,
    activeProjectDocumentPath = null,
    planActionsDisabled = false,
    planRunDisabled = false,
    onRunPlan = () => {},
    onDeletePlan = () => {},
    planOwners = {},
    planRuns = {},
    onOpenPlanRun,
    onResumePlan,
    recentProjects,
    projectColors,
    projectIcons = new Map(),
    projectSwitchDisabled,
    externalEditorLabel,
    onCreate,
    onUpdate,
    onStatusChange,
    onPriorityChange = () => {},
    onObserveTasks,
    onChooseTaskAttachments,
    onPasteTaskAttachments,
    onOpenTaskAttachment,
    onDelete,
    onReorder,
    onRun,
    onOpenSession,
    onCreateTaskPlan,
    onOpenUsageSession,
    onOpenProjectDocument,
    onRefreshPlans = async () => {},
    onListProjectDirectory,
    onValidateProjectFile,
    onOpenProjectFile,
    onOpenWikiFile,
    onOpenFilesFile,
    onBeforeFilesMutation,
    onOpenUserConfig,
    onOpenExternalEditor,
    onProjectSwitcherOpen,
    onSelectProject,
    onOpenProjectInNewWindow,
    onRemoveProject,
    onOpenProjectInFinder,
    onChooseWorkspace,
    onChooseWorkspaceInNewWindow,
    onSaveProjectSettings,
    onPickProjectIcon,
    onGenerateProjectIcon,
    onReload,
    onRegistryRefresh,
    onRegistryInitializeProject,
    onRegistryCleanProject,
    onRegistryAction,
    onRegistryDiff,
    onRegistryCloseDiff,
    onRegistryProjectChange,
    onWorkspaceSettingsSave,
    onGitRefresh,
    onGitOpen,
    onGitStatusRefresh,
    onGitExplorerStatusRefresh,
    onGitInitialize,
    onGitOpenDiff,
    onGitStage,
    onGitUnstage,
    onGitCommit,
    onGitPush,
    onGitSwitchBranch,
    onGitCreateBranch,
    onGitGenerateCommitMessage,
    onGitStageGenerateCommitPush,
    onGitReview,
  }: {
    workspace: string;
    lspClient: AcpClient | null;
    lspSessionId: string | null;
    providerStatuses?: readonly RuntimeStatus[];
    settingsConfigOptions: SessionConfigOption[];
    visibleModelRefs?: readonly string[];
    rememberedThinkingByModel?: Readonly<Record<string, string>>;
    onVisibleModelsChange?: (modelRefs: readonly string[]) => Promise<void> | void;
    tasks: ProjectTask[];
    taskAttachmentCounts?: Record<string, number>;
    loading: boolean;
    initialLoading?: boolean;
    saving: boolean;
    storageError: boolean;
    taskStorageIndicatorError: string | null;
    activeTaskId: string | null;
    sessionReady: boolean;
    registryReady: boolean;
    registryActivity?: string | null;
    gitAssistantReady: boolean;
    registrySnapshot: RegistrySnapshot | undefined;
    registryContextCommands?: readonly import("@agentclientprotocol/sdk").AvailableCommand[];
    registryProjectInitialized: boolean | undefined;
    registryProjectPiSizeBytes: number | null | undefined;
    registryProjectPiCleanupBytes: number | undefined;
    registryProjectPiCleanupAvailable: boolean;
    registryProjectPiStorageLoading: boolean;
    registryProjectPiStorageError: string | null;
    registryBackgroundSync: RegistryBackgroundSyncState;
    registryLoading: boolean;
    registryActionId: string | null;
    registryDiff: RegistryDiffState | undefined;
    gitSnapshot: GitSnapshot | undefined;
    gitUninitialized: boolean;
    gitLoading: boolean;
    gitError: string | null;
    gitActionId: string | null;
    gitLlmActionId: string | null;
    gitCi: GitCiPanelState;
    gitWorkflow: GitPanelWorkflow;
    projectDocuments: ProjectDocumentsSnapshot;
    knowledgeJobs?: readonly ProjectKnowledgeJob[];
    wikiAutoCheck?: WikiAutoCheckView;
    onSetWikiAutoCheck?: (enabled: boolean) => void | Promise<void>;
    onCancelKnowledgeCheck?: (id: number) => void;
    onDismissKnowledgeCheck?: (id: number) => void;
    onOpenKnowledgeCitation?: (citation: KnowledgeCitation, language?: KnowledgeReportLanguage) => void | Promise<void>;
    onResolveKnowledgeJob?: (job: ProjectKnowledgeJob) => void | Promise<void>;
    onStartWikiMigration?: (workspace: string, config: ProjectWikiConfig) => Promise<boolean>;
    knowledgeSourcesEnabled?: boolean;
    knowledgeResolving?: boolean;
    activeProjectDocumentPath?: string | null;
    planActionsDisabled?: boolean;
    planRunDisabled?: boolean;
    onRunPlan?: (path: string) => void;
    onDeletePlan?: (path: string) => void;
    planOwners?: Readonly<Record<string, string>>;
    planRuns?: Readonly<Record<string, readonly import("../lib/project-task-plans").PlanRun[]>>;
    onOpenPlanRun?: (sessionId: string) => void;
    onResumePlan?: (path: string) => void;
    recentProjects: string[];
    projectColors: ReadonlyMap<string, string>;
    projectIcons?: ReadonlyMap<string, string>;
    projectSwitchDisabled: boolean;
    externalEditorLabel: string;
    onCreate: (draft: TaskDraft) => void | boolean | Promise<boolean | void>;
    onUpdate: (taskId: string, draft: TaskDraft) => void | boolean | Promise<boolean | void>;
    onStatusChange: (taskId: string, status: ProjectTaskStatus) => void;
    onPriorityChange?: (taskId: string, priority: ProjectTaskPriority) => void;
    onObserveTasks?: () => () => void;
    onChooseTaskAttachments: (current: readonly Attachment[]) => Promise<Attachment[]>;
    onPasteTaskAttachments: (files: readonly File[], current: readonly Attachment[]) => Promise<Attachment[]>;
    onOpenTaskAttachment: (attachment: Attachment) => void;
    onDelete: (taskId: string) => void;
    onReorder: (
      taskId: string,
      targetStatus: ProjectTaskStatus,
      targetTaskId: string | null,
      position: WorkspaceSidebarTaskDropPosition,
    ) => void;
    onRun: (task: ProjectTask) => void;
    onOpenSession: (task: ProjectTask) => void;
    onCreateTaskPlan?: (task: ProjectTask) => void;
    onOpenUsageSession?: (target: UsageSessionTarget) => void;
    onOpenProjectDocument: (path: string, exists?: boolean) => void;
    onRefreshPlans?: () => Promise<void>;
    onListProjectDirectory: (path: string) => Promise<ProjectTreeEntry[]>;
    onValidateProjectFile: (path: string) => Promise<boolean | "directory">;
    onOpenProjectFile: (path: string, range?: ProjectFileLineRange) => void;
    onOpenWikiFile?: (path: string, searchRange?: ProjectFileLineRange) => void;
    onOpenFilesFile?: (path: string) => void;
    onBeforeFilesMutation?: () => Promise<() => void>;
    onOpenUserConfig: (kind: SettingsConfigKind) => void;
    onOpenExternalEditor: (path?: string) => void;
    onProjectSwitcherOpen: () => void;
    onSelectProject: (path: string) => void;
    onOpenProjectInNewWindow: (path: string) => void;
    onRemoveProject?: (path: string) => void;
    onOpenProjectInFinder?: (path: string) => void;
    onChooseWorkspace: () => void;
    onChooseWorkspaceInNewWindow: () => void;
    onSaveProjectSettings: (draft: ProjectSettingsDraft) => Promise<string | undefined>;
    onPickProjectIcon: () => Promise<ProjectIconImage | undefined>;
    onGenerateProjectIcon: (prompt?: string) => Promise<ProjectIconImage>;
    onReload: () => void;
    onRegistryRefresh: () => void;
    onRegistryInitializeProject: () => void;
    onRegistryCleanProject: () => void;
    onRegistryAction: (request: RegistryActionRequest, actionId: string) => void;
    onRegistryDiff: (item: RegistryItem) => void;
    onRegistryCloseDiff: () => void;
    onRegistryProjectChange: (artifact: RegistryProjectArtifact, reload: boolean) => void;
    onWorkspaceSettingsSave: (workspace: string) => void;
    onGitRefresh: () => void;
    onGitOpen?: () => void;
    onGitStatusRefresh?: () => Promise<void>;
    onGitExplorerStatusRefresh?: () => Promise<void>;
    onGitInitialize: () => void;
    onGitOpenDiff: (path: string | undefined, scope: GitDiffScope) => void;
    onGitStage: (path?: string) => Promise<boolean>;
    onGitUnstage: (path?: string) => void;
    onGitCommit: (message: string, pushAfterCommit?: boolean) => Promise<boolean>;
    onGitPush: () => void;
    onGitSwitchBranch: (branch: string) => void;
    onGitCreateBranch: (branch: string) => void;
    onGitGenerateCommitMessage: () => Promise<string | undefined>;
    onGitStageGenerateCommitPush?: (pushAfterCommit?: boolean) => Promise<boolean>;
    onGitReview: (path: string | undefined, scope: GitDiffScope) => void;
  } = $props();

  const ACTIVE_TAB_KEY = windowLayoutKey("workspaceSidebarTab");

  let sidebarElement = $state<HTMLElement | null>(null);
  let launchTerminalView = $state<TerminalSurfaceHandle | null>(null);
  const launchController = createPackageScriptsController({
    workspace: () => workspace,
    terminalView: () => launchTerminalView,
    afterWorkspaceSave: (savedWorkspace) => onWorkspaceSettingsSave(savedWorkspace),
  });
  onMount(launchController.start);
  const launchMenu = $derived(launchCommandMenu(launchController));
  $effect(() => {
    const error = launchController.error;
    if (error) {
      untrack(() => createDiagnosticLogger(() => ({ workspace })).warn("frontend:launch-commands", error));
    }
  });
  let usagePanel = $state<UsagePanelHandle | null>(null);
  const usageRefresh = $derived(usagePanel?.refreshState() ?? { busy: false, disabled: true });
  let settingsPanel = $state<SettingsPanelHandle | null>(null);
  let projectExplorer = $state<{ revealPath: (path: string) => Promise<void> } | null>(null);
  let projectRevealVersion = 0;
  let projectSwitcher = $state<{ close: () => void } | null>(null);
  let activeTab = $state<SidebarTab>("tasks");
  const searchIndexOwner = createWorkspaceSearchIndexOwner({ workspace: () => workspace, client: () => lspClient });
  const searchIndexes = $derived(searchIndexOwner.view);
  const searchIndexController = $derived(searchIndexOwner.controller);
  const layoutController = createWorkspaceSidebarLayoutController({ activeTab: () => activeTab });
  const projectSettingsController = createWorkspaceSidebarProjectSettingsController({
    workspace: () => workspace,
    closeProjectSwitcher: () => projectSwitcher?.close(),
    saveProjectSettings: (draft) => onSaveProjectSettings(draft),
  });
  let editorOpen = $state(false);
  let editorAttachmentsLoading = $state(false);
  let editorAttachmentError = $state<string | null>(null);
  let editorBaseTask = $state<ProjectTask | undefined>(undefined);
  let editorGeneration = 0;
  let editorCreateStatus = $state<ProjectTaskStatus>("todo");
  const tasksView = createWorkspaceSidebarTasksViewController();
  const effectWorkspace = $derived(workspace);
  const observeTasks = $derived(activeTab === "tasks" && !layoutController.collapsed && !editorOpen && Boolean(workspace));
  $effect(() => {
    const target = effectWorkspace;
    untrack(() => tasksView.selectWorkspace(target));
  });
  $effect(() => {
    effectWorkspace;
    if (observeTasks) {
      return untrack(() => onObserveTasks?.());
    }
  });
  let editingTaskId = $state<string | null>(null);
  let deleteTaskId = $state<string | null>(null);
  let deleteTaskWorkspace = $state("");
  let title = $state("");
  let description = $state("");
  let editorAttachments = $state<Attachment[]>([]);
  let editorOriginalAttachments = $state<string[]>([]);
  let taskType = $state<ProjectTaskType>("feature");
  let editorParentId = $state("");
  let editorEpic = $state(false);
  let editorLinks = $state<string[]>([]);
  let editorRelatedTaskIds = $state<string[]>([]);
  let editorModelRef = $state("");
  let statusMenu = $state<HTMLDivElement | null>(null);
  const statusMenuController = createWorkspaceSidebarStatusMenuController({
    menu: () => statusMenu,
    workspace: () => workspace,
    task: (taskId) => tasks.find((task) => task.id === taskId),
    busy: () => busy,
    get onCreatePlan() { return onCreateTaskPlan ? (task: ProjectTask) => { statusMenuController.close(); onCreateTaskPlan?.(task); } : undefined; },
    onOpenPlan: (path) => { statusMenuController.close(); onOpenProjectDocument(path, projectDocuments.plans.includes(path)); },
    canCreatePlan: () => sessionReady && !busy,
    reportError: (cause) => createDiagnosticLogger(() => ({ workspace })).warn("frontend:task-menu", cause),
    onStatusChange: (taskId, status) => onStatusChange(taskId, status),
    onPriorityChange: (taskId, priority) => onPriorityChange(taskId, priority),
    onDeleteRequest: (taskId) => {
      if (busy) return;
      deleteTaskWorkspace = workspace;
      deleteTaskId = taskId;
    },
  });
  let revealedTaskId = $state<string | null>(null);
  const plansView = createRegistryPlansView();
  // The Work tab stacks Plans and Tasks accordions; Registry stays a resource catalog.
  const workSections = createWorkPanelSections((cause, target) => {
    createDiagnosticLogger(() => ({ workspace: target })).warn("frontend:work-panel-state", cause);
  });
  $effect(() => {
    const target = effectWorkspace;
    untrack(() => void workSections.load(target));
  });
  $effect(() => () => workSections.dispose());
  // An empty Plans section stays collapsed: there is nothing to expand.
  const workSectionEmpty = (id: WorkSectionId) => id === "plans" && projectDocuments.plans.length === 0;
  const workSectionOpen = (id: WorkSectionId) => workSections.ready && !workSectionEmpty(id) && workSections.isOpen(id);
  $effect(() => {
    const target = effectWorkspace;
    untrack(() => plansView.selectWorkspace(target));
  });
  let projectTreeRefreshKey = $state(0);
  const taskDragController = createWorkspaceSidebarTaskDragController({
    busy: () => busy,
    closeStatusMenu: () => statusMenuController.close(),
    onReorder: (taskId, targetStatus, targetTaskId, position) => onReorder(taskId, targetStatus, targetTaskId, position),
  });
  let titleInput = $state<HTMLInputElement | null>(null);
  let indicatorService: SidebarIndicatorService | undefined;
  let indicatorServiceState = $state<SidebarIndicatorServiceState>({
    unseenScriptFailureIds: [],
  });
  let projectPanelError = $state<string | null>(null);
  let settingsPanelError = $state<string | null>(null);
  let observedRegistryProjectPollAt = 0;
  // Last content stamp per dirty artifact; reset per workspace and dropped
  // when an artifact becomes clean so a later edit always reloads.
  let observedRegistryProjectStamps = new Map<RegistryProjectArtifact, string>();
  let observedGitRemoteTarget = "";

  const busy = $derived(loading || saving || storageError || activeTaskId !== null);
  const doneCount = $derived(tasks.filter((task) => task.status === "done").length);
  const indicatorInputs = $derived({
    service: indicatorServiceState,
    projectPanelError,
    taskStorageError: storageError,
    taskStorageSaveError: taskStorageIndicatorError,
    activeTaskId,
    registrySnapshot,
    hasPlannedTasks: tasks.some((task) => task.status === "todo"),
    gitCiSnapshot: gitCi.snapshot,
    registryBackgroundSync,
    settingsPanelError,
    searchIndexes,
  });
  const indicators = $derived<SidebarIndicatorMap>(sidebarIndicators(indicatorInputs));
  const indicatorReasons = $derived(sidebarIndicatorReasons(indicatorInputs));
  const projectRetry = createSidebarProjectRetry({
    workspace: () => workspace,
    visible: () => activeTab === "project" && !layoutController.collapsed,
    invalidateTree: () => { projectTreeRefreshKey++; },
    listRoot: () => onListProjectDirectory(""),
    reportHealth: (error) => { projectPanelError = error; },
  });
  const gitBusy = $derived(gitLoading || Boolean(gitActionId || gitLlmActionId) || gitWorkflow.resolveRunning);
  const indicatorActionEnabled = $derived({
    "project.retry": Boolean(workspace),
    "tasks.reload": !loading && !saving,
    "tasks.running": tasks.some((task) => task.id === activeTaskId && Boolean(task.sessionId)),
    "git.refresh": !gitBusy,
    "git.fetch": !gitBusy && Boolean(gitSnapshot?.remotes.length),
    "git.push": !gitBusy && !gitPushBlockedReason(gitSnapshot) && !gitSnapshot?.changes.some((change) => change.conflicted),
    "git.commit-push": Boolean(onGitStageGenerateCommitPush) && gitAssistantReady && !gitBusy && !gitStageGenerateCommitPushBlockedReason(gitSnapshot, Boolean(gitSnapshot?.remotes.length)),
    "git.fix-ci": gitCi.canFixWithAi,
    "registry.refresh": registryReady && !registryLoading && !registryActionId,
    "registry.push-project-resources": registryReady && !registryLoading && !registryActionId
      && registrySnapshot?.configured !== false && !registrySnapshot?.projectIssue,
  });
  const indicatorActions = createWorkspaceSidebarIndicatorActions({
    bounds: () => sidebarElement?.getBoundingClientRect(),
    workspace: () => workspace,
    reasons: () => indicatorReasons,
    enabled: () => indicatorActionEnabled,
    gitRemotes: () => gitSnapshot?.remotes ?? [],
    extraGroups: (tab) => tab === "scripts" ? launchMenu.groups : [],
    runExtra: (id) => launchMenu.run(id),
    beforeOpen: () => statusMenuController.close(),
    reveal: revealIndicatorTab,
    handlers: {
      "project.retry": () => { void projectRetry.retry(); },
      "tasks.reload": () => onReload(),
      "tasks.running": () => {
        const task = tasks.find((task) => task.id === activeTaskId && task.sessionId);
        if (task) onOpenSession(task);
      },
      "git.refresh": () => { if (onGitStatusRefresh) void onGitStatusRefresh(); else onGitRefresh(); },
      "git.fix-ci": () => { void gitCi.onFixWithAi(); },
      "git.fetch": () => { void gitWorkflow.onRepositoryAction("fetch"); },
      "git.changes": () => onGitOpenDiff(undefined, "all"),
      "git.conflicts": () => onGitOpenDiff(undefined, "all"),
      "git.push": () => onGitPush(),
      "git.commit-push": () => { void onGitStageGenerateCommitPush?.(Boolean(gitSnapshot?.remotes.length)); },
      "registry.refresh": () => onRegistryRefresh(),
      "registry.push-project-resources": () => onRegistryAction({ action: "push-project-resources" }, "push-project-resources"),
    },
  });
  const indicatorMenuController = indicatorActions.menu;
  const indicatorMenuGroups = $derived(indicatorActions.groups());
  $effect(() => indicatorActions.reconcile());

  /** Menu navigation reveals the owning view; it never toggles it closed. */
  function revealIndicatorTab(tab: SidebarTab): void {
    if (activeTab !== tab || layoutController.collapsed) selectTab(tab);
  }

  let wikiPanel = $state<{ create: (kind: "new-file" | "new-directory") => void; exportHtml: () => void; showInFiles: () => void; refresh: () => void; openChecks: () => void } | null>(null);
  export async function openWikiChecks(): Promise<void> {
    const target = workspace;
    revealIndicatorTab("wiki");
    await tick();
    if (workspace === target) wikiPanel?.openChecks();
  }
  /** Wiki Conflicts entry points: the panel reads its Pages/Conflicts view from shared state. */
  export async function openWikiConflicts(): Promise<void> {
    revealIndicatorTab("wiki");
    await tick();
  }
  let wikiReady = $state(false);
  const activeTabTitle = $derived(SIDEBAR_LABELS[activeTab]);
  const draggedTask = $derived(taskDragController.taskId ? tasks.find((task) => task.id === taskDragController.taskId) : undefined);
  function openRegistryProjectArtifact(artifact: RegistryProjectArtifact): void {
    if (artifact === "plans") {
      void openPlansSegment();
      return;
    }
    if (artifact === "workspace") {
      projectSettingsController.show();
      return;
    }
    setActiveTab("tasks");
  }

  $effect(() => {
    const requestWorkspace = workspace;
    // DesktopSidebar spreads one reactive props object; background updates can
    // invalidate this effect without changing the workspace identity.
    if (!projectSettingsController.syncWorkspace()) return;
    projectRetry.invalidate();
    observedGitRemoteTarget = "";
    observedRegistryProjectStamps = new Map();
    projectPanelError = null;
    indicatorService?.setWorkspace(requestWorkspace);
  });

  $effect(() => {
    const viewedTab = layoutController.collapsed ? undefined : activeTab;
    indicatorService?.setViewedTab(viewedTab);
  });

  const gitIndicatorSignature = $derived(sidebarGitSignature(gitSnapshot, gitError));
  const gitRemoteTarget = $derived(gitSnapshot ? `${gitSnapshot.branch}\0${gitSnapshot.upstream ?? ""}` : "");
  $effect(() => {
    // Equal snapshots (including Explorer polls) must not trigger another
    // native Git/config/Registry poll. Svelte compares these derived strings.
    gitIndicatorSignature;
    const nextRemoteTarget = gitRemoteTarget;
    const remoteTargetChanged = observedGitRemoteTarget !== ""
      && nextRemoteTarget !== ""
      && nextRemoteTarget !== observedGitRemoteTarget;
    observedGitRemoteTarget = nextRemoteTarget;
    queueMicrotask(() => {
      indicatorService?.invalidateFast();
      indicatorService?.invalidateGitRemote(remoteTargetChanged);
    });
  });

  const effectRegistrySnapshot = $derived(registrySnapshot);
  $effect(() => {
    // Registry session-state remains authoritative for remote state, but a
    // pushed refresh/action result is also a good point to recheck the cheap
    // local-dirty signal instead of waiting for the next fast poll.
    effectRegistrySnapshot;
    queueMicrotask(() => indicatorService?.invalidateFast());
  });

  $effect(() => {
    const checkedAtMs = indicatorServiceState.poll?.checkedAtMs ?? 0;
    const registryPoll = indicatorServiceState.poll?.registry;
    const projectChanges = registryPoll?.projectChanges ?? [];
    if (!checkedAtMs || checkedAtMs === observedRegistryProjectPollAt) return;
    observedRegistryProjectPollAt = checkedAtMs;
    const previousStamps = observedRegistryProjectStamps;
    const changed = [...new Set(projectChanges)];
    const nextStamps = new Map<RegistryProjectArtifact, string>();
    const reload = new Set<RegistryProjectArtifact>();
    for (const artifact of changed) {
      const stamp = registryPoll?.projectStamps?.[artifact];
      if (stamp === undefined || previousStamps.get(artifact) !== stamp) reload.add(artifact);
      if (stamp !== undefined) nextStamps.set(artifact, stamp);
    }
    observedRegistryProjectStamps = nextStamps;
    if (changed.length === 0) return;
    const observedWorkspace = workspace;
    queueMicrotask(() => {
      if (workspace !== observedWorkspace) return;
      for (const artifact of changed) onRegistryProjectChange(artifact, reload.has(artifact));
    });
  });

  onMount(() => {
    try {
      const savedTab = localStorage.getItem(ACTIVE_TAB_KEY);
      if (isSidebarTab(savedTab)) activeTab = savedTab;
    } catch {
      // Keep the defaults when webview storage is unavailable.
    }
    const cleanupLayout = layoutController.mount();
    const cleanupLogPreference = logPreference.mount();
    indicatorService = new SidebarIndicatorService(
      getCurrentWindow().label,
      (state) => indicatorServiceState = state,
      () => gitCi.onRefreshIndicator?.(),
      (label, error) => createDiagnosticLogger(() => ({ workspace })).warn(label, error),
    );
    indicatorService.setViewedTab(layoutController.collapsed ? undefined : activeTab);
    indicatorService.start(workspace);

    return () => {
      cleanupLogPreference();
      cleanupLayout();
      statusMenuController.dispose();
      taskDragController.dispose();
      indicatorMenuController.dispose();
      projectRetry.dispose();
      indicatorService?.destroy();
      indicatorService = undefined;
    };
  });

  const logPreference = createLogPanelPreference(() => {
    if (activeTab === "logs") setActiveTab("tasks");
  });

  function isSidebarTab(value: string | null): value is SidebarTab {
    // Restore selection before the async preference resolves; the preference
    // gates mounting and demotes to Tasks if the loaded value is disabled.
    return value === "project" || value === "wiki" || value === "tasks" || value === "git" || value === "registry" || value === "scripts" || value === "search" || value === "usage" || value === "lsp" || value === "settings" || value === "logs";
  }

  function setActiveTab(tab: SidebarTab): void {
    activeTab = tab;
    try {
      localStorage.setItem(ACTIVE_TAB_KEY, tab);
    } catch {
      // Keep the in-memory selection when persistence is unavailable.
    }
  }

  function selectTab(tab: SidebarTab): void {
    indicatorMenuController.close();
    statusMenuController.close();
    revealedTaskId = null;
    if (activeTab === tab && !layoutController.collapsed) {
      editorOpen = false;
      deleteTaskId = null;
      layoutController.setCollapsed(true);
      return;
    }

    if (activeTab !== tab) {
      editorOpen = false;
      deleteTaskId = null;
    }
    setActiveTab(tab);
    if (layoutController.collapsed) layoutController.setCollapsed(false);
  }

  function closeActivePanel(): void {
    if (layoutController.collapsed) return;
    selectTab(activeTab);
  }

  async function openPlansSegment(): Promise<void> {
    const requestWorkspace = workspace;
    tasksView.selectWorkspace(requestWorkspace);
    void workSections.setOpen("plans", true);
    setActiveTab("tasks");
    if (layoutController.collapsed) layoutController.setCollapsed(false);
  }

  /** Open the project Tasks view for actions initiated outside the sidebar. */
  export async function openTasksPanel(taskId?: string, isCurrent: () => boolean = () => true): Promise<void> {
    if (!isCurrent()) return;
    const requestWorkspace = workspace;
    statusMenuController.close();
    editorOpen = false;
    deleteTaskId = null;
    void workSections.setOpen("tasks", true);
    setActiveTab("tasks");
    if (layoutController.collapsed) layoutController.setCollapsed(false);
    revealedTaskId = taskId ?? null;
    if (!taskId) return;
    tasksView.selectWorkspace(requestWorkspace);
    tasksView.typeFilter = "all";
    tasksView.priorityFilter = "all";
    const revealedTask = tasks.find((task) => task.id === taskId);
    if (revealedTask) tasksView.expandStatus(revealedTask.status);
    await tick();
    if (!isCurrent() || workspace !== requestWorkspace) return;
    const taskCard = [...(sidebarElement?.querySelectorAll<HTMLElement>("[data-task-card]") ?? [])]
      .find((card) => card.dataset.taskId === taskId);
    taskCard?.scrollIntoView({ block: "nearest" });
  }

  /** Reveal Source Control without toggling it closed when already active. */
  export function openGitPanel(isCurrent: () => boolean = () => true): void {
    if (!isCurrent()) return;
    statusMenuController.close();
    indicatorMenuController.close();
    editorOpen = false;
    deleteTaskId = null;
    setActiveTab("git");
    if (layoutController.collapsed) layoutController.setCollapsed(false);
  }

  /** Reverse navigation from links and Preview tabs into the workspace tree. */
  export async function revealProjectEntry(path: string): Promise<void> {
    const requestWorkspace = workspace;
    const request = ++projectRevealVersion;
    statusMenuController.close();
    revealIndicatorTab("project");
    await tick();
    if (request !== projectRevealVersion || workspace !== requestWorkspace
      || activeTab !== "project" || layoutController.collapsed) return;
    await projectExplorer?.revealPath(path);
  }

  /** Focus a named settings chapter from Desktop chrome without global DOM queries. */
  export async function openSettingsSection(id: string): Promise<void> {
    statusMenuController.close();
    setActiveTab("settings");
    if (layoutController.collapsed) layoutController.setCollapsed(false);
    await tick();
    if (activeTab !== "settings" || layoutController.collapsed) return;
    await settingsPanel?.openSection(id);
  }

  /** Open Settings and focus one specific authored field control. */
  export async function openSettingsField(section: string, fieldId: string): Promise<void> {
    statusMenuController.close();
    setActiveTab("settings");
    if (layoutController.collapsed) layoutController.setCollapsed(false);
    await tick();
    if (activeTab !== "settings" || layoutController.collapsed) return;
    await settingsPanel?.openField(section, fieldId);
  }

  /** Open the current project's name/color/logo settings dialog. */
  export function openProjectSettings(): void {
    if (!workspace) return;
    projectSwitcher?.close();
    projectSettingsController.show();
  }

  /** Close the project picker when another top-level interaction takes focus. */
  export function closeProjectSwitcher(): void {
    projectSwitcher?.close();
  }

  function openCreate(type: ProjectTaskType, status: ProjectTaskStatus = "todo"): void {
    if (!workspace || busy) return;
    editorGeneration++;
    statusMenuController.close();
    editingTaskId = null;
    editorBaseTask = undefined;
    editorAttachmentsLoading = false;
    editorAttachmentError = null;
    editorCreateStatus = status;
    title = "";
    description = "";
    editorAttachments = [];
    editorOriginalAttachments = [];
    taskType = type;
    editorParentId = "";
    editorEpic = false;
    editorLinks = [];
    editorRelatedTaskIds = [];
    editorModelRef = "";
    editorOpen = true;
    void focusEditorTitle();
  }

  async function createQuickTask(draft: TaskDraft): Promise<boolean> {
    const project = workspace;
    if (!project || busy) return false;
    const result = await onCreate(draft);
    if (result !== false && workspace === project) {
      // A just-created task must remain visible despite existing type/priority
      // filters and any collapsed Todo section.
      tasksView.typeFilter = "all";
      tasksView.priorityFilter = "all";
      tasksView.expandStatus("todo");
    }
    return result !== false;
  }

  function openEdit(task: ProjectTask): void {
    const owner = ++editorGeneration;
    const sourceWorkspace = workspace;
    statusMenuController.close();
    editingTaskId = task.id;
    editorBaseTask = $state.snapshot(task);
    title = task.title;
    description = task.description ?? "";
    editorAttachments = [];
    editorOriginalAttachments = [];
    editorAttachmentsLoading = true;
    editorAttachmentError = null;
    taskType = task.type;
    editorParentId = task.parentId ?? "";
    editorEpic = task.epic ?? false;
    editorLinks = [...(task.links ?? [])];
    editorRelatedTaskIds = [...(task.relatedTaskIds ?? [])];
    editorModelRef = task.modelRef ?? "";
    editorOpen = true;
    void focusEditorTitle();
    void invoke<AttachmentFile[]>("read_project_task_attachments", {
      workspace: sourceWorkspace, id: task.id,
    }).then(files => {
      if (owner !== editorGeneration || workspace !== sourceWorkspace || !editorOpen || editingTaskId !== task.id) return;
      editorAttachments = files.map((file, index) =>
        attachmentFromFile(file, `task:${task.id}:attachment:${index}`));
      editorOriginalAttachments = editorAttachmentIdentities(editorAttachments);
    }).catch(error => {
      if (owner === editorGeneration && workspace === sourceWorkspace && editorOpen && editingTaskId === task.id) {
        editorAttachmentError = error instanceof Error ? error.message : String(error);
      }
    }).finally(() => {
      if (owner === editorGeneration) editorAttachmentsLoading = false;
    });
  }

  function editorAttachmentIdentities(files: readonly Attachment[]): string[] {
    return files.map((file) => JSON.stringify([file.path ?? "", file.name, file.size ?? -1]));
  }

  async function openRelatedTask(task: ProjectTask): Promise<void> {
    if (busy || editorAttachmentsLoading || editorAttachmentError) return;
    const original = editorBaseTask;
    const hasUnsaved = original && (
      title !== original.title || description !== (original.description ?? "")
      || taskType !== original.type || editorParentId !== (original.parentId ?? "")
      || editorEpic !== (original.epic ?? false) || editorModelRef !== (original.modelRef ?? "")
      || JSON.stringify(editorLinks) !== JSON.stringify(original.links ?? [])
      || JSON.stringify(editorRelatedTaskIds) !== JSON.stringify(original.relatedTaskIds ?? [])
      || JSON.stringify(editorAttachmentIdentities(editorAttachments)) !== JSON.stringify(editorOriginalAttachments)
    );
    const generation = editorGeneration;
    if (hasUnsaved && !await confirmDesktopAction("Discard unsaved changes and open the related task?")) return;
    if (generation !== editorGeneration || busy || editorAttachmentsLoading || editorAttachmentError) return;
    editorGeneration++;
    openEdit(task);
  }

  function openTaskLink(link: string): void {
    const destination = normalizeProjectTaskLink(link);
    if (!destination) return;
    if (/^https?:\/\//i.test(destination)) {
      void openExternalHref(destination).catch(console.error);
    } else {
      onOpenProjectFile(destination);
    }
  }

  async function focusEditorTitle(): Promise<void> {
    await tick();
    titleInput?.focus();
  }

  async function submitEditor(): Promise<void> {
    const generation = editorGeneration;
    const trimmedTitle = title.trim();
    const storedDescription = description.trim()
      || (!trimmedTitle && editorAttachments.length
        ? editorAttachments.map((attachment) => `Attachment: ${attachment.name}`).join("\n")
        : "");
    if (busy || editorAttachmentsLoading || editorAttachmentError) return;
    if (!editingTaskId && !trimmedTitle) return;
    if (editingTaskId && !trimmedTitle && !storedDescription) return;
    const draft: TaskDraft = {
      title: trimmedTitle,
      ...(storedDescription ? { description: storedDescription } : {}),
      type: taskType,
      attachments: editorAttachments,
      links: editorLinks,
      relatedTaskIds: editorRelatedTaskIds,
      parentId: editorParentId,
      epic: editorEpic,
      modelRef: editorModelRef,
      ...(editorBaseTask ? { expectedTask: editorBaseTask } : {}),
      ...(!editingTaskId ? { status: editorCreateStatus } : {}),
    };
    const result = editingTaskId ? await onUpdate(editingTaskId, draft) : await onCreate(draft);
    if (result !== false && generation === editorGeneration) editorOpen = false;
  }

  async function chooseEditorAttachments(): Promise<void> {
    const current = editorAttachments;
    const next = await onChooseTaskAttachments(current);
    if (editorOpen && editorAttachments === current) editorAttachments = next;
  }

  async function pasteEditorAttachments(files: readonly File[]): Promise<void> {
    const current = editorAttachments;
    const next = await onPasteTaskAttachments(files, current);
    if (editorOpen && editorAttachments === current) editorAttachments = next;
  }

  function removeEditorAttachment(id: string): void {
    editorAttachments = editorAttachments.filter((attachment) => attachment.id !== id);
  }

  function confirmDelete(): void {
    if (!deleteTaskId || busy || workspace !== deleteTaskWorkspace || !tasks.some(task => task.id === deleteTaskId)) return;
    onDelete(deleteTaskId);
    deleteTaskId = null;
  }

</script>

<svelte:window onpointerdown={indicatorMenuController.outside} onblur={() => indicatorMenuController.close()} onresize={() => indicatorMenuController.close()} />

<aside
  bind:this={sidebarElement}
  class="relative flex min-h-0 shrink-0 bg-sidebar text-sidebar-foreground"
  class:select-none={layoutController.resizing}
  style:width={`${layoutController.renderedWidth}px`}
  style:min-width={`${layoutController.renderedMinWidth}px`}
  style:max-width="100vw"
  aria-label="Workspace sidebar"
>
  <WorkspaceSidebarActivityBar
    {indicators}
    {activeTab}
    logsEnabled={logPreference.enabled}
    collapsed={layoutController.collapsed}
    onSelect={selectTab}
    onIndicatorContext={indicatorActions.open}
    scriptsHaveActions={hasLaunchCommandMenu(launchController)}
  />
  <SidebarIndicatorMenu controller={indicatorMenuController} groups={indicatorMenuGroups} onAction={indicatorActions.run} />

  {#if !layoutController.collapsed}
    <div class={["grid min-w-0 flex-1 overflow-hidden border-r border-sidebar-border bg-sidebar", activeTab === "wiki" ? "grid-rows-[36px_auto_minmax(0,1fr)]" : "grid-rows-[36px_minmax(0,1fr)]"]}>
      <div class="flex min-w-0 items-center gap-2 border-b border-sidebar-border bg-sidebar pl-3 pr-1">
        <strong class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs font-semibold tracking-wide text-muted-foreground uppercase">{activeTabTitle}</strong>
        {#if activeTab === "tasks"}
          <span class="shrink-0 text-xs text-muted-foreground">{projectDocuments.plans.length} {projectDocuments.plans.length === 1 ? "plan" : "plans"} · {tasks.length} {tasks.length === 1 ? "task" : "tasks"}</span>
        {:else if activeTab === "project"}
          <div class="ml-auto flex shrink-0 items-center gap-0.5">
            <button
              class={iconButtonClass("sm", "chrome")}
              type="button"
              title={`Open project in ${externalEditorLabel}`}
              aria-label={`Open project in ${externalEditorLabel}`}
              onclick={() => onOpenExternalEditor()}
              disabled={!workspace}
            ><ExternalLink class="h-3.5 w-3.5" aria-hidden="true" /></button>
            <button
              class={iconButtonClass("sm", "chrome")}
              type="button"
              title="Refresh project files"
              aria-label="Refresh project files"
              onclick={() => projectTreeRefreshKey += 1}
              disabled={!workspace}
            ><RefreshCw class="h-3.5 w-3.5" aria-hidden="true" /></button>
          </div>
        {:else if activeTab === "registry"}
          <div class="ml-auto flex shrink-0 items-center gap-0.5">
            <button
              class={iconButtonClass("sm", "chrome")}
              type="button"
              title="Configure registry"
              aria-label="Configure registry"
              onclick={() => onRegistryAction({ action: "configure" }, "configure")}
              disabled={!registryReady || registryActionId !== null}
            ><Settings class="h-3.5 w-3.5" aria-hidden="true" /></button>
            <button
              class={iconButtonClass("sm", "chrome")}
              type="button"
              title="Refresh registry"
              aria-label="Refresh registry"
              onclick={onRegistryRefresh}
              disabled={!registryReady || registryActionId !== null}
            ><RefreshCw class={["h-3.5 w-3.5", registryLoading || registryActionId === "refresh" ? "animate-spin" : ""]} aria-hidden="true" /></button>
          </div>
        {:else if activeTab === "usage"}
          <button
            class={iconButtonClass("sm", "chrome")}
            type="button" title="Refresh usage" aria-label="Refresh usage"
            onclick={() => usagePanel?.refresh()}
            disabled={usageRefresh.disabled}
            aria-busy={usageRefresh.busy}
          ><RefreshCw class={["h-3.5 w-3.5", usageRefresh.busy && "animate-spin motion-reduce:animate-none"]} aria-hidden="true" /></button>
        {:else if activeTab === "scripts"}
          <button
            class={iconButtonClass("sm", "chrome", { extra: "ml-auto" })}
            type="button"
            title="Refresh launch commands"
            aria-label="Refresh launch commands"
            onclick={() => launchController.refresh()}
            disabled={!workspace}
          ><RefreshCw class="h-3.5 w-3.5" aria-hidden="true" /></button>
        {:else if activeTab === "wiki"}
          <div class="ml-auto flex shrink-0 items-center gap-0.5">
          <button class={iconButtonClass("sm", "chrome")} type="button" title="New page" aria-label="New page" disabled={!wikiReady} onclick={() => wikiPanel?.create("new-file")}><FilePlus class="h-3.5 w-3.5" aria-hidden="true" /></button>
          <button class={iconButtonClass("sm", "chrome")} type="button" title="New section" aria-label="New section" disabled={!wikiReady} onclick={() => wikiPanel?.create("new-directory")}><FolderPlus class="h-3.5 w-3.5" aria-hidden="true" /></button>
          <button class={iconButtonClass("sm", "chrome")} type="button" title="Show Wiki folder in Files" aria-label="Show Wiki folder in Files" disabled={!wikiReady} onclick={() => wikiPanel?.showInFiles()}><FolderOpen class="h-3.5 w-3.5" aria-hidden="true" /></button>
          <button class={iconButtonClass("sm", "chrome")} type="button" title="Open as HTML in browser" aria-label="Open as HTML in browser" disabled={!wikiReady} onclick={() => wikiPanel?.exportHtml()}><Globe class="h-3.5 w-3.5" aria-hidden="true" /></button>
          <button class={iconButtonClass("sm", "chrome")} type="button" title="Refresh Wiki" aria-label="Refresh Wiki" disabled={!wikiReady} onclick={() => wikiPanel?.refresh()}><RefreshCw class="h-3.5 w-3.5" aria-hidden="true" /></button>
          <WikiAutoCheckControl state={wikiAutoCheck} disabled={!workspace} onChange={onSetWikiAutoCheck} />
          </div>
        {/if}
        <button
          class={iconButtonClass("sm", "chrome")}
          type="button"
          title={`Close ${activeTabTitle}`}
          aria-label={`Close ${activeTabTitle}`}
          onclick={closeActivePanel}
        ><X class="h-3.5 w-3.5" aria-hidden="true" /></button>
      </div>

      {#if activeTab === "wiki"}
        <!-- Keep the auto grid row occupied even when the notice renders nothing. -->
        <div class="min-w-0" data-wiki-auto-check-notice-slot>
          <WikiAutoCheckControl part="notice" state={wikiAutoCheck} />
        </div>
      {/if}

      {#if activeTab === "tasks"}
        <div class="flex min-h-0 min-w-0 flex-col overflow-hidden" data-work-sections>
        {#snippet workSectionHeader(id: WorkSectionId, label: string, count: string)}
          <button
            type="button"
            class="flex h-8 w-full shrink-0 items-center gap-1.5 border-b border-sidebar-border px-3 text-left text-xs font-semibold text-muted-foreground hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
            aria-expanded={workSectionOpen(id)}
            disabled={workSectionEmpty(id)}
            aria-controls={`workspace-${id}-panel`}
            data-work-section-toggle={id}
            onclick={() => void workSections.toggle(id)}
          >
            <ChevronRight class={["h-3.5 w-3.5 shrink-0 transition-transform motion-reduce:transition-none", workSectionOpen(id) ? "rotate-90" : "rotate-0"]} aria-hidden="true" />
            <span class="min-w-0 flex-1 truncate uppercase tracking-wide">{label}</span>
            <span class="shrink-0 font-normal">{count}</span>
          </button>
        {/snippet}
        <section class={["flex min-w-0 flex-col", !workSectionOpen("plans") ? "shrink-0" : ["min-h-0 flex-initial", workSectionOpen("tasks") && "max-h-[50%]"]]} aria-label="Plans" data-work-section="plans">
        {@render workSectionHeader("plans", "Plans", `${projectDocuments.plans.length}`)}
        {#if workSectionOpen("plans")}
        <div id="workspace-plans-panel" class="flex min-h-0 min-w-0 flex-initial flex-col overflow-hidden [&>section]:flex-initial">
          <RegistryPlansPanel
            plans={projectDocuments.plans}
            planProgress={projectDocuments.planProgress}
            onRefresh={onRefreshPlans}
            activePath={activeProjectDocumentPath}
            view={plansView}
            onChoose={onOpenProjectDocument}
            actionsDisabled={planActionsDisabled}
            runDisabled={planRunDisabled}
            onRun={onRunPlan}
            onDelete={onDeletePlan}
            owners={planOwners}
            runs={planRuns}
            onOpenRun={onOpenPlanRun}
            onResume={onResumePlan}
          />
        </div>
        {/if}
        </section>
        <section class={["flex min-w-0 flex-col", workSectionOpen("tasks") ? "min-h-0 flex-1 basis-0" : "shrink-0"]} aria-label="Tasks" data-work-section="tasks">
        {@render workSectionHeader("tasks", "Tasks", `${tasks.length} · ${doneCount} done`)}
        {#if workSectionOpen("tasks")}
        <div id="workspace-tasks-panel" class="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)]">
          {#if workspace && !initialLoading && !storageError}
            <WorkspaceSidebarTaskQuickAdd {workspace} client={lspClient} {busy} onCreate={createQuickTask} />
          {/if}
        <WorkspaceSidebarTasksPanel
          {workspace}
          {tasks}
          attachmentCounts={taskAttachmentCounts}
          loading={initialLoading}
          {storageError}
          {busy}
          {activeTaskId}
          {sessionReady}
          draggedTaskId={taskDragController.taskId}
          taskDropTarget={taskDragController.dropTarget}
          draggedTaskHeight={taskDragController.height}
          {revealedTaskId}
          statusMenuTaskId={statusMenuController.taskId}
          statusMenuSection={statusMenuController.section}
          bind:statusMenu
          onPanelPointerDown={statusMenuController.closeOutside}
          {onReload}
          onTaskDragStart={taskDragController.start}
          onTaskDragMove={taskDragController.move}
          onTaskDragFinish={taskDragController.finish}
          onTaskDragCancel={taskDragController.cancel}
          onCardDragClickConsumed={taskDragController.consumeClick}
          onToggleStatusMenu={statusMenuController.toggle}
          onStatusMenuKeydown={statusMenuController.handleKeydown}
          onSetTaskStatus={statusMenuController.setStatus}
          onSetTaskPriority={statusMenuController.setPriority}
          isStatusCollapsed={tasksView.isStatusCollapsed}
          onToggleStatusCollapsed={tasksView.toggleStatusCollapsed}
          bind:typeFilter={tasksView.typeFilter}
          bind:priorityFilter={tasksView.priorityFilter}
          bind:expandedTaskIds={tasksView.expandedTaskIds}
          {onRun}
          {onOpenSession}
          onCreate={openCreate}
          onEdit={openEdit}
          onDeleteRequest={statusMenuController.requestDelete}
          onCreatePlan={onCreateTaskPlan ? (task) => { statusMenuController.close(); onCreateTaskPlan(task); } : undefined}
          onOpenPlan={(path) => { statusMenuController.close(); onOpenProjectDocument(path, projectDocuments.plans.includes(path)); }}
          planProgress={projectDocuments.planProgress ?? {}}
        />
        </div>
        {/if}
        </section>
        </div>
      {:else if activeTab === "project"}
        <section id="workspace-project-panel" class="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden" aria-label="Project">
          <ProjectSwitcher
            bind:this={projectSwitcher}
            {workspace}
            {recentProjects}
            {projectColors}
            {projectIcons}
            currentWindowDisabled={projectSwitchDisabled}
            onOpen={onProjectSwitcherOpen}
            onMinimumWidthChange={layoutController.setProjectSwitcherMinimumWidth}
            {onSelectProject}
            {onOpenProjectInNewWindow}
            {onRemoveProject}
            {onOpenProjectInFinder}
            {onChooseWorkspace}
            {onChooseWorkspaceInNewWindow}
            onOpenProjectSettings={openProjectSettings}
          />
          <div class="grid min-h-0 min-w-0 overflow-hidden">
            {#if !workspace}
              <div class="px-4 py-8 text-center"><Folder class="mx-auto mb-2 h-5 w-5 text-muted-foreground" aria-hidden="true" /><p class="text-xs font-medium">Open a project to browse files</p><p class="mt-1 text-xs leading-4 text-muted-foreground">Project files, search, and local actions appear here.</p></div>
            {:else}
              <ProjectExplorer
                bind:this={projectExplorer}
                {workspace}
                {gitSnapshot}
                onGitStatusRefresh={onGitExplorerStatusRefresh ?? onGitStatusRefresh}
                {externalEditorLabel}
                refreshKey={projectTreeRefreshKey}
                onListDirectory={onListProjectDirectory}
                onOpenFile={onOpenFilesFile ?? onOpenProjectFile}
                onBeforeMutation={onBeforeFilesMutation}
                onOpenExternal={(path) => onOpenExternalEditor(path)}
                onHealthChange={(error) => projectPanelError = error}
              />
            {/if}
          </div>
        </section>
      {:else if activeTab === "wiki"}
        <div id="workspace-wiki-panel" class="flex min-h-0 min-w-0 flex-col overflow-hidden" aria-label="Project wiki">
          <ProjectWikiPanel
            bind:this={wikiPanel}
            bind:ready={wikiReady}
            {workspace}
            activePath={activeProjectDocumentPath}
            {knowledgeJobs}
            {onCancelKnowledgeCheck}
            {onDismissKnowledgeCheck}
            {onOpenKnowledgeCitation}
            {onResolveKnowledgeJob}
            {onStartWikiMigration}
            {knowledgeSourcesEnabled}
            {knowledgeResolving}
            onOpenFile={onOpenWikiFile ?? onOpenProjectFile}
            onOpenFiles={onOpenProjectFile}
            onBeforeMutation={onBeforeFilesMutation}
            onOpenExternal={onOpenExternalEditor}
          />
        </div>
      {:else if activeTab === "git"}
        <div id="workspace-git-panel" class="grid min-h-0 min-w-0 overflow-hidden" aria-label="Source Control">
          <GitPanel
            {workspace}
            snapshot={gitSnapshot}
            uninitialized={gitUninitialized}
            loading={gitLoading}
            error={gitError}
            actionId={gitActionId}
            llmActionId={gitLlmActionId}
            ci={gitCi}
            workflow={gitWorkflow}
            {gitAssistantReady}
            onRefresh={onGitRefresh}
            onOpen={onGitOpen ?? onGitRefresh}
            onInitialize={onGitInitialize}
            onOpenDiff={onGitOpenDiff}
            onStage={onGitStage}
            onUnstage={onGitUnstage}
            onCommit={onGitCommit}
            onPush={onGitPush}
            onSwitchBranch={onGitSwitchBranch}
            onCreateBranch={onGitCreateBranch}
            onGenerateCommitMessage={onGitGenerateCommitMessage}
            onReview={onGitReview}
          />
        </div>
      {:else if activeTab === "registry"}
        <div id="workspace-registry-panel" class="grid min-h-0 min-w-0 overflow-hidden" aria-label="Registry">
          {#key workspace}
          <RegistryPanel
            contextCommands={registryContextCommands}
            agentModels={modelThinkingConfigState(settingsConfigOptions).models}
            snapshot={registrySnapshot}
            backgroundSync={registryBackgroundSync}
            projectInitialized={registryProjectInitialized}
            projectPiSizeBytes={registryProjectPiSizeBytes}
            projectPiCleanupBytes={registryProjectPiCleanupBytes}
            projectPiCleanupAvailable={registryProjectPiCleanupAvailable}
            projectPiStorageLoading={registryProjectPiStorageLoading}
            projectPiStorageError={registryProjectPiStorageError}
            loading={registryLoading}
            remoteDisabled={!registryReady}
            activity={registryActivity}
            actionId={registryActionId}
            diff={registryDiff}
            onRefresh={onRegistryRefresh}
            onInitializeProject={onRegistryInitializeProject}
            onCleanProject={onRegistryCleanProject}
            onAction={onRegistryAction}
            onOpenProjectArtifact={openRegistryProjectArtifact}
            onDiff={onRegistryDiff}
            onCloseDiff={onRegistryCloseDiff}
          />
          {/key}
        </div>
      {:else if activeTab === "scripts"}
        <div id="workspace-scripts-panel" class="grid min-h-0 min-w-0 overflow-hidden" aria-label="Launch Commands">
          <PackageScriptsPanel {workspace} controller={launchController} bind:terminalView={launchTerminalView} />
        </div>
      {:else if activeTab === "search"}
        <div id="workspace-search-index-panel" class="grid min-h-0 min-w-0 overflow-hidden" aria-label="Search indexes">
          {#key workspace}<SearchIndexPanel view={searchIndexes} controller={searchIndexController} connected={Boolean(lspClient)} onSettings={() => void openSettingsField("pi-tools-suite-search", "embedding-model")} />{/key}
        </div>
      {:else if activeTab === "usage"}
        <div id="workspace-usage-panel" class="grid min-h-0 min-w-0 overflow-hidden" aria-label="Usage">
          {#key workspace}<UsagePanel bind:this={usagePanel} client={lspClient} {workspace} {providerStatuses} {...(onOpenUsageSession ? { onOpenSession: onOpenUsageSession } : {})} />{/key}
        </div>
      {:else if activeTab === "lsp"}
        <div id="workspace-lsp-panel" class="grid min-h-0 min-w-0 overflow-hidden" aria-label="Language Servers">
          <LspPanel client={lspClient} sessionId={lspSessionId} />
        </div>
      {:else if activeTab === "logs"}
        <div id="workspace-logs-panel" class="grid min-h-0 min-w-0 overflow-hidden" aria-label="Logs">
          {#if logPreference.enabled}<LogsPanel {workspace} />{/if}
        </div>
      {:else}
        <div id="workspace-settings-panel" class="grid min-h-0 min-w-0 overflow-hidden" aria-label="Settings">
          <SettingsPanel bind:this={settingsPanel} configOptions={settingsConfigOptions} {workspace} searchClient={lspClient ?? undefined} {onOpenUserConfig} onIndicatorChange={(error) => settingsPanelError = error} />
        </div>
      {/if}
    </div>

    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="absolute inset-y-0 -right-[3px] z-10 w-[6px] cursor-col-resize touch-none after:absolute after:inset-y-0 after:left-[2px] after:w-px hover:after:bg-primary"
      role="separator"
      aria-label="Resize workspace sidebar"
      aria-orientation="vertical"
      aria-valuemin={layoutController.activeMinWidth}
      aria-valuemax={layoutController.activeMaxWidth}
      aria-valuenow={layoutController.expandedWidth}
      tabindex="0"
      onpointerdown={layoutController.startResize}
      onpointermove={layoutController.resize}
      onpointerup={layoutController.finishResize}
      onpointercancel={layoutController.finishResize}
      onlostpointercapture={layoutController.finishResize}
      onkeydown={layoutController.resizeWithKeyboard}
      ondblclick={layoutController.resetWidth}
    ></div>
  {/if}

  {#if draggedTask && taskDragController.pointerId !== null}
    <div
      class="pointer-events-none fixed z-50 select-none rounded-md border border-chat-user-border bg-popover px-1.5 py-1.5 text-popover-foreground shadow-md"
      style:left={`${taskDragController.clientX - taskDragController.offsetX}px`}
      style:top={`${taskDragController.clientY - taskDragController.offsetY}px`}
      style:width={`${taskDragController.width}px`}
      style:min-height={`${taskDragController.height}px`}
      aria-hidden="true"
    >
      <div class="flex min-w-0 items-start gap-1">
        <div class="mt-px grid h-6 w-5 shrink-0 place-items-center text-muted-foreground/70">
          <GripVertical class="h-3.5 w-3.5" aria-hidden="true" />
        </div>
        <div class="min-w-0 flex-1">
          <h3 class="break-words pt-1 text-xs font-medium leading-4">{projectTaskDisplayLabel(draggedTask)}</h3>
        </div>
      </div>
    </div>
  {/if}

  {#if editorOpen && !layoutController.collapsed}
    <WorkspaceSidebarTaskEditor
      {editingTaskId}
      busy={busy || editorAttachmentsLoading}
      attachmentError={editorAttachmentError}
      bind:title
      bind:description
      {editorAttachments}
      bind:taskType
      bind:editorParentId
      bind:editorEpic
      bind:editorLinks
      bind:editorRelatedTaskIds
      bind:editorModelRef
      {tasks}
      configOptions={settingsConfigOptions}
      {visibleModelRefs}
      {rememberedThinkingByModel}
      {onVisibleModelsChange}
      projectFileSuggestions={projectDocuments.plans}
      onValidateProjectFile={onValidateProjectFile}
      onOpenRelatedTask={openRelatedTask}
      onOpenLink={openTaskLink}
      bind:titleInput
      onChooseAttachments={chooseEditorAttachments}
      onPasteAttachments={pasteEditorAttachments}
      onRemoveAttachment={removeEditorAttachment}
      onOpenAttachment={onOpenTaskAttachment}
      onClose={() => { editorGeneration++; editorOpen = false; }}
      onSubmit={submitEditor}
    />
  {/if}

  {#if deleteTaskId && workspace === deleteTaskWorkspace && !layoutController.collapsed}
    {@const deleteTask = tasks.find((task) => task.id === deleteTaskId)}
    <DeleteConfirmationDialog
      title="Delete task?"
      message={`“${deleteTask ? projectTaskDisplayLabel(deleteTask) : "This task"}”\n\nThis cannot be undone.`}
      disabled={busy}
      onconfirm={confirmDelete}
      oncancel={() => deleteTaskId = null}
    />
  {/if}

  {#if projectSettingsController.open && workspace}
    <ProjectSettingsDialog
      {workspace}
      color={projectColors.get(workspace)}
      icon={projectIcons.get(workspace)}
      saving={projectSettingsController.saving}
      error={projectSettingsController.error}
      onSave={(draft) => void projectSettingsController.save(draft)}
      onPickIcon={onPickProjectIcon}
      onGenerateIcon={onGenerateProjectIcon}
      onClose={projectSettingsController.close}
    />
  {/if}
</aside>
