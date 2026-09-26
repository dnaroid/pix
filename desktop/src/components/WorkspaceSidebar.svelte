<script lang="ts">
  import type { SessionConfigOption } from "@agentclientprotocol/sdk";
  import ExternalLink from "@lucide/svelte/icons/external-link";
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
  import {
    PROJECT_TODO_PATH,
    projectDocumentLabel,
    type ProjectDocumentsSnapshot,
  } from "../lib/project-documents";
  import {
    type RegistryActionRequest,
    type RegistryProjectArtifact,
    type RegistrySnapshot,
  } from "../lib/registry";
  import type { RegistryBackgroundSyncState } from "../lib/registry-background-sync";
  import {
    SidebarIndicatorService,
    sidebarIndicators,
    type SidebarIndicatorMap,
    type SidebarIndicatorServiceState,
    type SidebarIndicatorTab,
  } from "../lib/sidebar-indicators";
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
  const SIDEBAR_LABELS: Record<SidebarTab, string> = {
    tasks: "Tasks",
    project: "Project",
    git: "Source Control",
    registry: "Registry",
    scripts: "Package Scripts",
    idx: "IDX",
    settings: "Settings",
  };
  let {
    workspace,
    settingsConfigOptions,
    tasks,
    loading,
    saving,
    storageError,
    taskStorageIndicatorError,
    activeTaskId,
    sessionReady,
    registryReady,
    gitAssistantReady,
    registrySnapshot,
    registryProjectInitialized,
    registryProjectPiSizeBytes,
    registryProjectPiCleanupBytes,
    registryProjectPiCleanupAvailable,
    registryProjectPiStorageLoading,
    registryProjectPiStorageError,
    registryBackgroundSync,
    registryLoading,
    registryActionId,
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
    onRegistryProjectChange,
    onWorkspaceSettingsSave,
    onGitRefresh,
    onGitInitialize,
    onGitOpenDiff,
    onGitStage,
    onGitUnstage,
    onGitCommit,
    onGitPush,
    onGitSwitchBranch,
    onGitCreateBranch,
    onGitGenerateCommitMessage,
    onGitReview,
    onRefreshKnowledge,
  }: {
    workspace: string;
    settingsConfigOptions: SessionConfigOption[];
    tasks: ProjectTask[];
    loading: boolean;
    saving: boolean;
    storageError: boolean;
    taskStorageIndicatorError: string | null;
    activeTaskId: string | null;
    sessionReady: boolean;
    registryReady: boolean;
    gitAssistantReady: boolean;
    registrySnapshot: RegistrySnapshot | undefined;
    registryProjectInitialized: boolean | undefined;
    registryProjectPiSizeBytes: number | null | undefined;
    registryProjectPiCleanupBytes: number | undefined;
    registryProjectPiCleanupAvailable: boolean;
    registryProjectPiStorageLoading: boolean;
    registryProjectPiStorageError: string | null;
    registryBackgroundSync: RegistryBackgroundSyncState;
    registryLoading: boolean;
    registryActionId: string | null;
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
    onRegistryProjectChange: (artifact: RegistryProjectArtifact) => void;
    onWorkspaceSettingsSave: (workspace: string) => void;
    onGitRefresh: () => void;
    onGitInitialize: () => void;
    onGitOpenDiff: (path: string | undefined, scope: GitDiffScope) => void;
    onGitStage: (path?: string) => Promise<boolean>;
    onGitUnstage: (path?: string) => void;
    onGitCommit: (message: string, pushAfterCommit?: boolean) => Promise<boolean>;
    onGitPush: () => void;
    onGitSwitchBranch: (branch: string) => void;
    onGitCreateBranch: (branch: string) => void;
    onGitGenerateCommitMessage: () => Promise<string | undefined>;
    onGitReview: (path: string | undefined, scope: GitDiffScope) => void;
    onRefreshKnowledge: () => void;
  } = $props();

  const ACTIVE_TAB_KEY = "pix.desktop.workspaceSidebarTab";

  let sidebarElement = $state<HTMLElement | null>(null);
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

  const busy = $derived(loading || saving || storageError || activeTaskId !== null);
  const doneCount = $derived(tasks.filter((task) => task.status === "done").length);
  const indicators = $derived<SidebarIndicatorMap>(sidebarIndicators({
    service: indicatorServiceState,
    projectPanelError,
    taskStorageError: storageError,
    taskStorageSaveError: taskStorageIndicatorError,
    activeTaskId,
    registrySnapshot,
    registryBackgroundSync,
    settingsPanelError,
  }));
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
    projectPanelError = null;
    projectSettingsController.reset();
    indicatorService?.setWorkspace(requestWorkspace);
  });

  $effect(() => {
    const viewedTab = layoutController.collapsed ? undefined : activeTab;
    indicatorService?.setViewedTab(viewedTab);
  });

  $effect(() => {
    // Full Git refreshes already happen after Pix-owned mutations. Use them as
    // an invalidation signal so the cheap Activity Bar snapshot does not wait
    // for its next timer tick.
    gitSnapshot;
    gitError;
    queueMicrotask(() => indicatorService?.invalidateFast());
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
    if (registryBackgroundSync.phase !== "idle" || projectChanges.length === 0) return;
    const changed = [...new Set(projectChanges)];
    queueMicrotask(() => {
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
    );
    indicatorService.setViewedTab(layoutController.collapsed ? undefined : activeTab);
    indicatorService.start(workspace);

    return () => {
      cleanupLayout();
      statusMenuController.dispose();
      taskDragController.dispose();
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
  />

  {#if !layoutController.collapsed}
    <div class="grid min-w-0 flex-1 grid-rows-[36px_minmax(0,1fr)] overflow-hidden border-r border-sidebar-border bg-sidebar">
      <div class="flex min-w-0 items-center gap-2 border-b border-sidebar-border bg-chrome pl-3 pr-1">
        <strong class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs font-semibold">{activeTabTitle}</strong>
        {#if activeTab === "tasks"}
          <span class="shrink-0 text-xs text-muted-foreground">{tasks.length} {tasks.length === 1 ? "task" : "tasks"} · {doneCount} done</span>
          <button
            class="ml-auto flex h-6 shrink-0 items-center gap-1 rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 active:opacity-80 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
            type="button"
            onclick={openCreate}
            disabled={!workspace || busy}
          ><Plus class="h-3 w-3" aria-hidden="true" />Add</button>
        {:else if activeTab === "project"}
          <div class="ml-auto flex shrink-0 items-center gap-0.5">
            <button
              class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
              type="button"
              title="Project settings"
              aria-label="Project settings"
              onclick={projectSettingsController.show}
              disabled={!workspace}
            ><SlidersHorizontal class="h-3.5 w-3.5" aria-hidden="true" /></button>
            <button
              class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
              type="button"
              title={`Open project in ${externalEditorLabel}`}
              aria-label={`Open project in ${externalEditorLabel}`}
              onclick={() => onOpenExternalEditor()}
              disabled={!workspace}
            ><ExternalLink class="h-3.5 w-3.5" aria-hidden="true" /></button>
            <button
              class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
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
              class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
              type="button"
              title="Configure registry"
              aria-label="Configure registry"
              onclick={() => onRegistryAction({ action: "configure" }, "configure")}
              disabled={!registryReady || registryActionId !== null}
            ><Settings class="h-3.5 w-3.5" aria-hidden="true" /></button>
            <button
              class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
              type="button"
              title="Refresh registry"
              aria-label="Refresh registry"
              onclick={onRegistryRefresh}
              disabled={!registryReady || registryActionId !== null}
            ><RefreshCw class={["h-3.5 w-3.5", registryLoading || registryActionId === "refresh" ? "animate-spin" : ""]} aria-hidden="true" /></button>
          </div>
        {/if}
        <button
          class="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
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
          {loading}
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
            snapshot={registrySnapshot}
            projectInitialized={registryProjectInitialized}
            projectPiSizeBytes={registryProjectPiSizeBytes}
            projectPiCleanupBytes={registryProjectPiCleanupBytes}
            projectPiCleanupAvailable={registryProjectPiCleanupAvailable}
            projectPiStorageLoading={registryProjectPiStorageLoading}
            projectPiStorageError={registryProjectPiStorageError}
            loading={registryLoading}
            remoteDisabled={!registryReady}
            actionId={registryActionId}
            onRefresh={onRegistryRefresh}
            onInitializeProject={onRegistryInitializeProject}
            onCleanProject={onRegistryCleanProject}
            onAction={onRegistryAction}
            onOpenProjectArtifact={openRegistryProjectArtifact}
          />
        </div>
      {:else if activeTab === "scripts"}
        <div id="workspace-scripts-panel" class="grid min-h-0 min-w-0 overflow-hidden" aria-label="Package Scripts">
          <PackageScriptsPanel {workspace} afterWorkspaceSave={onWorkspaceSettingsSave} />
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
            />
          {/key}
        </div>
      {:else}
        <div id="workspace-settings-panel" class="grid min-h-0 min-w-0 overflow-hidden" aria-label="Settings">
          <SettingsPanel configOptions={settingsConfigOptions} onIndicatorChange={(error) => settingsPanelError = error} />
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
