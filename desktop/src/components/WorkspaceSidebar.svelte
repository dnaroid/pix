<script lang="ts">
  import type { SessionConfigOption } from "@agentclientprotocol/sdk";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import FileText from "@lucide/svelte/icons/file-text";
  import Folder from "@lucide/svelte/icons/folder";
  import GripVertical from "@lucide/svelte/icons/grip-vertical";
  import ListTodo from "@lucide/svelte/icons/list-todo";
  import Plus from "@lucide/svelte/icons/plus";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import Settings from "@lucide/svelte/icons/settings";
  import SlidersHorizontal from "@lucide/svelte/icons/sliders-horizontal";
  import X from "@lucide/svelte/icons/x";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { windowLayoutKey } from "../lib/window-layout-storage";
  import { onMount, tick } from "svelte";
  import {
    extractAttachmentMarkers,
    textWithAttachmentMarkers,
    type Attachment,
  } from "../lib/attachments";
  import {
    projectTaskDisplayLabel,
    type ProjectTask,
    type ProjectTaskStatus,
    type ProjectTaskType,
  } from "../lib/project-tasks";
  import { fuzzySearch } from "../lib/fuzzy";
  import type { GitDiffScope, GitSnapshot } from "../lib/git";
  import type { GitCiPanelState } from "../lib/git-ci";
  import type { GitPanelWorkflow } from "../lib/git-workflow";
  import type { ProjectFileLineRange } from "../lib/project-files";
  import type { ProjectTreeEntry } from "../lib/project-tree";
  import type { SettingsConfigKind } from "../lib/settings";
  import {
    PROJECT_TODO_PATH,
    projectDocumentLabel,
    type ProjectDocumentsSnapshot,
  } from "../lib/project-documents";
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
  import { createWorkspaceSidebarIndicatorActions } from "./workspace-sidebar-indicator-actions";
  import { createSidebarProjectRetry } from "./sidebar-project-retry";
  import SidebarIndicatorMenu from "./SidebarIndicatorMenu.svelte";
  import RegistryPanel from "./RegistryPanel.svelte";
  import IdxPanel from "./IdxPanel.svelte";
  import GitPanel from "./GitPanel.svelte";
  import ProjectExplorer from "./ProjectExplorer.svelte";
  import PackageScriptsPanel from "./PackageScriptsPanel.svelte";
  import ProjectSettingsDialog from "./ProjectSettingsDialog.svelte";
  import ProjectSwitcher from "./ProjectSwitcher.svelte";
  import SettingsPanel from "./SettingsPanel.svelte";
  import WorkspaceSidebarActivityBar from "./WorkspaceSidebarActivityBar.svelte";
  import WorkspaceSidebarPlanSelector from "./WorkspaceSidebarPlanSelector.svelte";
  import { createWorkspaceSidebarLayoutController } from "./workspace-sidebar-layout-controller.svelte";
  import { createWorkspaceSidebarProjectSettingsController } from "./workspace-sidebar-project-settings-controller.svelte";
  import { createWorkspaceSidebarStatusMenuController } from "./workspace-sidebar-status-menu-controller.svelte";
  import {
    createWorkspaceSidebarTaskDragController,
    type WorkspaceSidebarTaskDropPosition,
  } from "./workspace-sidebar-task-drag-controller.svelte";
  import WorkspaceSidebarTaskEditor from "./WorkspaceSidebarTaskEditor.svelte";
  import WorkspaceSidebarTasksPanel from "./WorkspaceSidebarTasksPanel.svelte";

  type TaskDraft = {
    title: string;
    description?: string;
    type: ProjectTaskType;
  };

  type SidebarTab = SidebarIndicatorTab;
  type PackageScriptsPanelHandle = { refresh: () => void };
  type SettingsPanelHandle = { openSection: (id: string) => Promise<void> };
  const SIDEBAR_LABELS: Record<SidebarTab, string> = {
    tasks: "Tasks",
    project: "Project",
    git: "Source Control",
    registry: "Registry",
    scripts: "Launch Commands",
    idx: "IDX",
    settings: "Settings",
  };
  let {
    workspace,
    settingsConfigOptions,
    tasks,
    loading,
    initialLoading = loading,
    saving,
    storageError,
    taskStorageIndicatorError,
    activeTaskId,
    sessionReady,
    registryReady,
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
    recentProjects,
    projectColors,
    projectSwitchDisabled,
    externalEditorLabel,
    onCreate,
    onUpdate,
    onStatusChange,
    onChooseTaskAttachments,
    onPasteTaskAttachments,
    onOpenTaskAttachment,
    onDelete,
    onReorder,
    onRun,
    onOpenSession,
    onOpenProjectDocument,
    onListProjectDirectory,
    onValidateProjectFile,
    onOpenProjectFile,
    onOpenUserConfig,
    onOpenExternalEditor,
    onProjectSwitcherOpen,
    onSelectProject,
    onOpenProjectInNewWindow,
    onChooseWorkspace,
    onChooseWorkspaceInNewWindow,
    onSaveProjectColor,
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
    onGitStatusRefresh,
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
    onRefreshKnowledge,
  }: {
    workspace: string;
    settingsConfigOptions: SessionConfigOption[];
    tasks: ProjectTask[];
    loading: boolean;
    initialLoading?: boolean;
    saving: boolean;
    storageError: boolean;
    taskStorageIndicatorError: string | null;
    activeTaskId: string | null;
    sessionReady: boolean;
    registryReady: boolean;
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
    recentProjects: string[];
    projectColors: ReadonlyMap<string, string>;
    projectSwitchDisabled: boolean;
    externalEditorLabel: string;
    onCreate: (draft: TaskDraft) => void;
    onUpdate: (taskId: string, draft: TaskDraft) => void;
    onStatusChange: (taskId: string, status: ProjectTaskStatus) => void;
    onChooseTaskAttachments: (current: readonly Attachment[]) => Promise<Attachment[]>;
    onPasteTaskAttachments: (files: readonly File[], current: readonly Attachment[]) => Promise<Attachment[]>;
    onOpenTaskAttachment: (attachment: Attachment) => void;
    onDelete: (taskId: string) => void;
    onReorder: (
      taskId: string,
      targetType: ProjectTaskType,
      targetTaskId: string | null,
      position: WorkspaceSidebarTaskDropPosition,
    ) => void;
    onRun: (task: ProjectTask) => void;
    onOpenSession: (task: ProjectTask) => void;
    onOpenProjectDocument: (path: string, exists?: boolean) => void;
    onListProjectDirectory: (path: string) => Promise<ProjectTreeEntry[]>;
    onValidateProjectFile: (path: string) => Promise<boolean>;
    onOpenProjectFile: (path: string, range?: ProjectFileLineRange) => void;
    onOpenUserConfig: (kind: SettingsConfigKind) => void;
    onOpenExternalEditor: (path?: string) => void;
    onProjectSwitcherOpen: () => void;
    onSelectProject: (path: string) => void;
    onOpenProjectInNewWindow: (path: string) => void;
    onChooseWorkspace: () => void;
    onChooseWorkspaceInNewWindow: () => void;
    onSaveProjectColor: (color: string | undefined) => Promise<string | undefined>;
    onReload: () => void;
    onRegistryRefresh: () => void;
    onRegistryInitializeProject: () => void;
    onRegistryCleanProject: () => void;
    onRegistryAction: (request: RegistryActionRequest, actionId: string) => void;
    onRegistryDiff: (item: RegistryItem) => void;
    onRegistryCloseDiff: () => void;
    onRegistryProjectChange: (artifact: RegistryProjectArtifact) => void;
    onWorkspaceSettingsSave: (workspace: string) => void;
    onGitRefresh: () => void;
    onGitStatusRefresh?: () => Promise<void>;
    onGitInitialize: () => void;
    onGitOpenDiff: (path: string | undefined, scope: GitDiffScope) => void;
    onGitStage: (path?: string) => Promise<boolean>;
    onGitUnstage: (path?: string) => void;
    onGitCommit: (message: string, pushAfterCommit?: boolean) => Promise<boolean>;
    onGitPush: () => void;
    onGitSwitchBranch: (branch: string) => void;
    onGitCreateBranch: (branch: string) => void;
    onGitGenerateCommitMessage: () => Promise<string | undefined>;
    onGitStageGenerateCommitPush?: () => Promise<boolean>;
    onGitReview: (path: string | undefined, scope: GitDiffScope) => void;
    onRefreshKnowledge: () => void;
  } = $props();

  const ACTIVE_TAB_KEY = windowLayoutKey("workspaceSidebarTab");

  let sidebarElement = $state<HTMLElement | null>(null);
  let packageScriptsPanel = $state<PackageScriptsPanelHandle | null>(null);
  let settingsPanel = $state<SettingsPanelHandle | null>(null);
  let projectSwitcher = $state<{ close: () => void } | null>(null);
  let activeTab = $state<SidebarTab>("tasks");
  const layoutController = createWorkspaceSidebarLayoutController({ activeTab: () => activeTab });
  const projectSettingsController = createWorkspaceSidebarProjectSettingsController({
    workspace: () => workspace,
    closeProjectSwitcher: () => projectSwitcher?.close(),
    saveProjectColor: (color) => onSaveProjectColor(color),
  });
  let editorOpen = $state(false);
  let editingTaskId = $state<string | null>(null);
  let deleteTaskId = $state<string | null>(null);
  let title = $state("");
  let description = $state("");
  let editorAttachments = $state<Attachment[]>([]);
  let taskType = $state<ProjectTaskType>("feature");
  let statusMenu = $state<HTMLDivElement | null>(null);
  const statusMenuController = createWorkspaceSidebarStatusMenuController({
    menu: () => statusMenu,
    onStatusChange: (taskId, status) => onStatusChange(taskId, status),
  });
  let revealedTaskId = $state<string | null>(null);
  let planSelectorOpen = $state(false);
  let planSelectorQuery = $state("");
  let planSearchInput = $state<HTMLInputElement | null>(null);
  let projectTreeRefreshKey = $state(0);
  const taskDragController = createWorkspaceSidebarTaskDragController({
    busy: () => busy,
    closeStatusMenu: () => statusMenuController.close(),
    onReorder: (taskId, targetType, targetTaskId, position) => onReorder(taskId, targetType, targetTaskId, position),
  });
  let titleInput = $state<HTMLInputElement | null>(null);
  let indicatorService: SidebarIndicatorService | undefined;
  let indicatorServiceState = $state<SidebarIndicatorServiceState>({
    unseenScriptFailureIds: [],
    unseenIdxFailureIds: [],
  });
  let projectPanelError = $state<string | null>(null);
  let settingsPanelError = $state<string | null>(null);
  let observedRegistryProjectPollAt = 0;
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
  const idxBusy = $derived(Boolean(indicatorServiceState.poll?.idx.runningIds.length)
    || Boolean(indicatorServiceState.idxOperationHandoffPending));
  const indicatorActionEnabled = $derived({
    "project.retry": Boolean(workspace),
    "tasks.reload": !loading && !saving,
    "tasks.running": tasks.some((task) => task.id === activeTaskId && Boolean(task.sessionId)),
    "git.refresh": !gitBusy,
    "git.fetch": !gitBusy && Boolean(gitSnapshot?.remotes.length),
    "git.push": !gitBusy && !gitPushBlockedReason(gitSnapshot) && !gitSnapshot?.changes.some((change) => change.conflicted),
    "git.commit-push": Boolean(onGitStageGenerateCommitPush) && gitAssistantReady && !gitBusy && !gitStageGenerateCommitPushBlockedReason(gitSnapshot),
    "git.fix-ci": gitCi.canFixWithAi,
    "registry.refresh": registryReady && !registryLoading && !registryActionId,
    "registry.push-project-resources": registryReady && !registryLoading && !registryActionId
      && registrySnapshot?.configured !== false && !registrySnapshot?.projectIssue,
    "idx.review": sessionReady && !idxBusy,
  });
  const indicatorActions = createWorkspaceSidebarIndicatorActions({
    workspace: () => workspace,
    reasons: () => indicatorReasons,
    enabled: () => indicatorActionEnabled,
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
      "git.commit-push": () => { void onGitStageGenerateCommitPush?.(); },
      "registry.refresh": () => onRegistryRefresh(),
      "registry.push-project-resources": () => onRegistryAction({ action: "push-project-resources" }, "push-project-resources"),
      "idx.review": () => onRefreshKnowledge(),
    },
  });
  const indicatorMenuController = indicatorActions.menu;
  const indicatorMenuGroups = $derived(indicatorActions.groups());
  $effect(() => indicatorActions.reconcile());

  /** Menu navigation reveals the owning view; it never toggles it closed. */
  function revealIndicatorTab(tab: SidebarTab): void {
    if (activeTab !== tab || layoutController.collapsed) selectTab(tab);
  }

  const activeTabTitle = $derived(SIDEBAR_LABELS[activeTab]);
  const draggedTask = $derived(taskDragController.taskId ? tasks.find((task) => task.id === taskDragController.taskId) : undefined);
  const visiblePlanChoices = $derived.by(() => {
    if (!planSelectorQuery.trim()) return projectDocuments.plans;
    return fuzzySearch(
      projectDocuments.plans.map((plan) => ({
        value: plan,
        label: projectDocumentLabel(plan),
        aliases: [plan],
      })),
      planSelectorQuery,
      { minScorePerCharacter: 4 },
    ).map((match) => match.value);
  });

  function openRegistryProjectArtifact(artifact: RegistryProjectArtifact): void {
    if (artifact === "todo") {
      onOpenProjectDocument(PROJECT_TODO_PATH, projectDocuments.todoExists);
      return;
    }
    if (artifact === "plans") {
      if (projectDocuments.plans.length === 0) {
        setActiveTab("project");
        return;
      }
      planSelectorQuery = "";
      planSelectorOpen = true;
      void tick().then(() => planSearchInput?.focus());
      return;
    }
    if (artifact === "workspace") {
      projectSettingsController.show();
      return;
    }
    setActiveTab("tasks");
  }

  function choosePlan(plan: string): void {
    planSelectorOpen = false;
    planSelectorQuery = "";
    onOpenProjectDocument(plan);
  }

  $effect(() => {
    const requestWorkspace = workspace;
    // DesktopSidebar spreads one reactive props object; background updates can
    // invalidate this effect without changing the workspace identity.
    if (!projectSettingsController.syncWorkspace()) return;
    projectRetry.invalidate();
    observedGitRemoteTarget = "";
    projectPanelError = null;
    indicatorService?.setWorkspace(requestWorkspace);
  });

  $effect(() => {
    const viewedTab = layoutController.collapsed ? undefined : activeTab;
    indicatorService?.setViewedTab(viewedTab);
  });

  $effect(() => {
    // Full Git refreshes already happen after Pix-owned mutations. Use them as
    // an invalidation signal so the cheap Activity Bar snapshot does not wait
    // for its next timer tick. A branch/upstream switch forces one remote probe;
    // ordinary local refreshes only recheck the network while an update hint is
    // already active.
    const nextRemoteTarget = gitSnapshot
      ? `${gitSnapshot.branch}\0${gitSnapshot.upstream ?? ""}`
      : "";
    const remoteTargetChanged = observedGitRemoteTarget !== ""
      && nextRemoteTarget !== ""
      && nextRemoteTarget !== observedGitRemoteTarget;
    observedGitRemoteTarget = nextRemoteTarget;
    gitError;
    queueMicrotask(() => {
      indicatorService?.invalidateFast();
      indicatorService?.invalidateGitRemote(remoteTargetChanged);
    });
  });

  $effect(() => {
    // Registry session-state remains authoritative for remote state, but a
    // pushed refresh/action result is also a good point to recheck the cheap
    // local-dirty signal instead of waiting for the next fast poll.
    registrySnapshot;
    queueMicrotask(() => indicatorService?.invalidateFast());
  });

  $effect(() => {
    const checkedAtMs = indicatorServiceState.poll?.checkedAtMs ?? 0;
    const projectChanges = indicatorServiceState.poll?.registry.projectChanges ?? [];
    if (!checkedAtMs || checkedAtMs === observedRegistryProjectPollAt) return;
    observedRegistryProjectPollAt = checkedAtMs;
    if (projectChanges.length === 0) return;
    const changed = [...new Set(projectChanges)];
    const observedWorkspace = workspace;
    queueMicrotask(() => {
      if (workspace !== observedWorkspace) return;
      for (const artifact of changed) onRegistryProjectChange(artifact);
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
    indicatorService = new SidebarIndicatorService(
      getCurrentWindow().label,
      (state) => indicatorServiceState = state,
      () => gitCi.onRefreshIndicator?.(),
    );
    indicatorService.setViewedTab(layoutController.collapsed ? undefined : activeTab);
    indicatorService.start(workspace);

    return () => {
      cleanupLayout();
      statusMenuController.dispose();
      taskDragController.dispose();
      indicatorMenuController.dispose();
      projectRetry.dispose();
      indicatorService?.destroy();
      indicatorService = undefined;
    };
  });

  function isSidebarTab(value: string | null): value is SidebarTab {
    return value === "project" || value === "tasks" || value === "git" || value === "registry" || value === "scripts" || value === "idx" || value === "settings";
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
    planSelectorOpen = false;
    planSelectorQuery = "";
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

  /** Open the project Tasks view for actions initiated outside the sidebar. */
  export async function openTasksPanel(taskId?: string): Promise<void> {
    statusMenuController.close();
    planSelectorOpen = false;
    planSelectorQuery = "";
    editorOpen = false;
    deleteTaskId = null;
    setActiveTab("tasks");
    if (layoutController.collapsed) layoutController.setCollapsed(false);
    revealedTaskId = taskId ?? null;
    if (!taskId) return;
    await tick();
    const taskCard = [...(sidebarElement?.querySelectorAll<HTMLElement>("[data-task-card]") ?? [])]
      .find((card) => card.dataset.taskId === taskId);
    taskCard?.scrollIntoView({ block: "nearest" });
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

  /** Close the project picker when another top-level interaction takes focus. */
  export function closeProjectSwitcher(): void {
    projectSwitcher?.close();
  }

  function openCreate(): void {
    statusMenuController.close();
    editingTaskId = null;
    title = "";
    description = "";
    editorAttachments = [];
    taskType = "feature";
    editorOpen = true;
    void focusEditorTitle();
  }

  function openEdit(task: ProjectTask): void {
    statusMenuController.close();
    editingTaskId = task.id;
    title = task.title;
    const parsedDescription = extractAttachmentMarkers(task.description ?? "", `task-editor:${task.id}`);
    description = parsedDescription.text;
    editorAttachments = parsedDescription.attachments;
    taskType = task.type;
    editorOpen = true;
    void focusEditorTitle();
  }

  async function focusEditorTitle(): Promise<void> {
    await tick();
    titleInput?.focus();
  }

  function submitEditor(): void {
    const trimmedTitle = title.trim();
    const storedDescription = textWithAttachmentMarkers(description, editorAttachments);
    if (busy) return;
    if (!editingTaskId && !trimmedTitle) return;
    if (editingTaskId && !trimmedTitle && !storedDescription) return;
    const draft: TaskDraft = {
      title: trimmedTitle,
      ...(storedDescription ? { description: storedDescription } : {}),
      type: taskType,
    };
    if (editingTaskId) onUpdate(editingTaskId, draft);
    else onCreate(draft);
    editorOpen = false;
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
    if (!deleteTaskId || busy) return;
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
    collapsed={layoutController.collapsed}
    onSelect={selectTab}
    onIndicatorContext={indicatorActions.open}
  />
  <SidebarIndicatorMenu controller={indicatorMenuController} groups={indicatorMenuGroups} onAction={indicatorActions.run} />

  {#if !layoutController.collapsed}
    <div class="grid min-w-0 flex-1 grid-rows-[36px_minmax(0,1fr)] overflow-hidden border-r border-sidebar-border bg-sidebar">
      <div class="flex min-w-0 items-center gap-2 border-b border-sidebar-border bg-sidebar pl-3 pr-1">
        <strong class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs font-semibold tracking-wide text-muted-foreground uppercase">{activeTabTitle}</strong>
        {#if activeTab === "tasks"}
          <span class="shrink-0 text-xs text-muted-foreground">{tasks.length} {tasks.length === 1 ? "task" : "tasks"} · {doneCount} done</span>
          <button
            class="ml-auto grid h-6 w-6 shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
            type="button"
            title="Add task"
            aria-label="Add task"
            onclick={openCreate}
            disabled={!workspace || busy}
          ><Plus class="h-3.5 w-3.5" aria-hidden="true" /></button>
        {:else if activeTab === "project"}
          <div class="ml-auto flex shrink-0 items-center gap-0.5">
            <button
              class="grid h-6 w-6 place-items-center rounded-sm text-muted-foreground hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
              type="button"
              title="Project settings"
              aria-label="Project settings"
              onclick={projectSettingsController.show}
              disabled={!workspace}
            ><SlidersHorizontal class="h-3.5 w-3.5" aria-hidden="true" /></button>
            <button
              class="grid h-6 w-6 place-items-center rounded-sm text-muted-foreground hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
              type="button"
              title={`Open project in ${externalEditorLabel}`}
              aria-label={`Open project in ${externalEditorLabel}`}
              onclick={() => onOpenExternalEditor()}
              disabled={!workspace}
            ><ExternalLink class="h-3.5 w-3.5" aria-hidden="true" /></button>
            <button
              class="grid h-6 w-6 place-items-center rounded-sm text-muted-foreground hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
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
              class="grid h-6 w-6 place-items-center rounded-sm text-muted-foreground hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
              type="button"
              title="Browse plans"
              aria-label="Browse plans"
              onclick={() => openRegistryProjectArtifact("plans")}
              disabled={!workspace}
            ><FileText class="h-3.5 w-3.5" aria-hidden="true" /></button>
            <button
              class="grid h-6 w-6 place-items-center rounded-sm text-muted-foreground hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
              type="button"
              title="Configure registry"
              aria-label="Configure registry"
              onclick={() => onRegistryAction({ action: "configure" }, "configure")}
              disabled={!registryReady || registryActionId !== null}
            ><Settings class="h-3.5 w-3.5" aria-hidden="true" /></button>
            <button
              class="grid h-6 w-6 place-items-center rounded-sm text-muted-foreground hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
              type="button"
              title="Refresh registry"
              aria-label="Refresh registry"
              onclick={onRegistryRefresh}
              disabled={!registryReady || registryActionId !== null}
            ><RefreshCw class={["h-3.5 w-3.5", registryLoading || registryActionId === "refresh" ? "animate-spin" : ""]} aria-hidden="true" /></button>
          </div>
        {:else if activeTab === "scripts"}
          <button
            class="ml-auto grid h-6 w-6 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
            type="button"
            title="Refresh launch commands"
            aria-label="Refresh launch commands"
            onclick={() => packageScriptsPanel?.refresh()}
            disabled={!workspace}
          ><RefreshCw class="h-3.5 w-3.5" aria-hidden="true" /></button>
        {/if}
        <button
          class="grid h-6 w-6 shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          type="button"
          title={`Close ${activeTabTitle}`}
          aria-label={`Close ${activeTabTitle}`}
          onclick={closeActivePanel}
        ><X class="h-3.5 w-3.5" aria-hidden="true" /></button>
      </div>

      {#if activeTab === "tasks"}
        <WorkspaceSidebarTasksPanel
          {workspace}
          {tasks}
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
          bind:statusMenu
          onPanelPointerDown={statusMenuController.closeOutside}
          {onReload}
          onTaskDragStart={taskDragController.start}
          onTaskDragMove={taskDragController.move}
          onTaskDragFinish={taskDragController.finish}
          onTaskDragCancel={taskDragController.cancel}
          onToggleStatusMenu={statusMenuController.toggle}
          onStatusMenuKeydown={statusMenuController.handleKeydown}
          onSetTaskStatus={statusMenuController.setStatus}
          {onRun}
          {onOpenSession}
          onEdit={openEdit}
          onDeleteRequest={(taskId) => deleteTaskId = taskId}
        />
      {:else if activeTab === "project"}
        <section id="workspace-project-panel" class="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden" aria-label="Project">
          <ProjectSwitcher
            bind:this={projectSwitcher}
            {workspace}
            {recentProjects}
            {projectColors}
            currentWindowDisabled={projectSwitchDisabled}
            onOpen={onProjectSwitcherOpen}
            onMinimumWidthChange={layoutController.setProjectSwitcherMinimumWidth}
            {onSelectProject}
            {onOpenProjectInNewWindow}
            {onChooseWorkspace}
            {onChooseWorkspaceInNewWindow}
          />
          <div class="grid min-h-0 min-w-0 overflow-hidden">
            {#if !workspace}
              <div class="px-4 py-8 text-center"><Folder class="mx-auto mb-2 h-5 w-5 text-muted-foreground" aria-hidden="true" /><p class="text-xs font-medium">Open a project to browse files</p><p class="mt-1 text-xs leading-4 text-muted-foreground">Project files, search, and local actions appear here.</p></div>
            {:else}
              <ProjectExplorer
                {workspace}
                {gitSnapshot}
                {onGitStatusRefresh}
                {externalEditorLabel}
                refreshKey={projectTreeRefreshKey}
                onListDirectory={onListProjectDirectory}
                onOpenFile={onOpenProjectFile}
                onOpenExternal={(path) => onOpenExternalEditor(path)}
                onHealthChange={(error) => projectPanelError = error}
              />
            {/if}
          </div>
        </section>
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
          <RegistryPanel
            contextCommands={registryContextCommands}
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
        </div>
      {:else if activeTab === "scripts"}
        <div id="workspace-scripts-panel" class="grid min-h-0 min-w-0 overflow-hidden" aria-label="Launch Commands">
          <PackageScriptsPanel bind:this={packageScriptsPanel} {workspace} afterWorkspaceSave={onWorkspaceSettingsSave} />
        </div>
      {:else if activeTab === "idx"}
        <div id="workspace-idx-panel" class="grid min-h-0 min-w-0 overflow-hidden" aria-label="IDX">
          {#key workspace}
            <IdxPanel
              {workspace}
              {onValidateProjectFile}
              {onOpenProjectFile}
              {sessionReady}
              {onRefreshKnowledge}
              onOverviewChange={(sourceWorkspace, next) => indicatorService?.setIdxOverview(sourceWorkspace, next)}
              onOperationRunningChange={(sourceWorkspace, running) => indicatorService?.setIdxOperationRunning(sourceWorkspace, running)}
            />
          {/key}
        </div>
      {:else}
        <div id="workspace-settings-panel" class="grid min-h-0 min-w-0 overflow-hidden" aria-label="Settings">
          <SettingsPanel bind:this={settingsPanel} configOptions={settingsConfigOptions} {onOpenUserConfig} onIndicatorChange={(error) => settingsPanelError = error} />
        </div>
      {/if}
    </div>

    {#if planSelectorOpen}
      <WorkspaceSidebarPlanSelector
        choices={visiblePlanChoices}
        bind:query={planSelectorQuery}
        bind:searchInput={planSearchInput}
        onClose={() => {
          planSelectorOpen = false;
          planSelectorQuery = "";
        }}
        onChoose={choosePlan}
      />
    {/if}

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
      {busy}
      bind:title
      bind:description
      {editorAttachments}
      bind:taskType
      bind:titleInput
      onChooseAttachments={chooseEditorAttachments}
      onPasteAttachments={pasteEditorAttachments}
      onRemoveAttachment={removeEditorAttachment}
      onOpenAttachment={onOpenTaskAttachment}
      onClose={() => editorOpen = false}
      onSubmit={submitEditor}
    />
  {/if}

  {#if deleteTaskId && !layoutController.collapsed}
    {@const deleteTask = tasks.find((task) => task.id === deleteTaskId)}
    <div
      class="absolute inset-y-0 right-0 left-12 z-30 grid place-items-center border-r border-sidebar-border bg-overlay p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Delete task"
    >
      <div class="w-full rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-md">
        <strong class="text-xs font-semibold">Delete task?</strong>
        <p class="mt-1.5 break-words text-xs leading-4 text-muted-foreground">“{deleteTask ? projectTaskDisplayLabel(deleteTask) : "This task"}” will be removed from the project task file.</p>
        <div class="mt-3 flex justify-end gap-2">
          <button class="h-8 rounded-md px-3 text-xs text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" type="button" onclick={() => deleteTaskId = null}>Cancel</button>
          <button class="h-8 rounded-md bg-destructive px-3 text-xs font-medium text-destructive-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" type="button" onclick={confirmDelete} disabled={busy}>Delete</button>
        </div>
      </div>
    </div>
  {/if}

  {#if projectSettingsController.open && workspace}
    <ProjectSettingsDialog
      {workspace}
      color={projectColors.get(workspace)}
      saving={projectSettingsController.saving}
      error={projectSettingsController.error}
      onSave={(color) => void projectSettingsController.save(color)}
      onClose={projectSettingsController.close}
    />
  {/if}
</aside>
