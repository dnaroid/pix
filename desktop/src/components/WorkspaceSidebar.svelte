<script lang="ts">
  import Activity from "@lucide/svelte/icons/activity";
  import CheckCircle2 from "@lucide/svelte/icons/check-circle-2";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Circle from "@lucide/svelte/icons/circle";
  import CircleDashed from "@lucide/svelte/icons/circle-dashed";
  import Clock3 from "@lucide/svelte/icons/clock-3";
  import Database from "@lucide/svelte/icons/database";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import FileText from "@lucide/svelte/icons/file-text";
  import Folder from "@lucide/svelte/icons/folder";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import GripVertical from "@lucide/svelte/icons/grip-vertical";
  import ListTodo from "@lucide/svelte/icons/list-todo";
  import Pencil from "@lucide/svelte/icons/pencil";
  import Play from "@lucide/svelte/icons/play";
  import Plus from "@lucide/svelte/icons/plus";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import Search from "@lucide/svelte/icons/search";
  import Settings from "@lucide/svelte/icons/settings";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import X from "@lucide/svelte/icons/x";
  import { onMount, tick } from "svelte";
  import {
    extractAttachmentMarkers,
    textWithAttachmentMarkers,
    type Attachment,
  } from "../lib/attachments";
  import {
    TASK_STATUSES,
    TASK_TYPES,
    taskStatusLabel,
    taskTypeLabel,
    type ProjectTask,
    type ProjectTaskStatus,
    type ProjectTaskType,
  } from "../lib/project-tasks";
  import { fuzzySearch } from "../lib/fuzzy";
  import type { GitDiffScope, GitSnapshot } from "../lib/git";
  import type { ProjectTreeEntry } from "../lib/project-tree";
  import {
    PROJECT_TODO_PATH,
    projectDocumentLabel,
    type ProjectDocumentsSnapshot,
  } from "../lib/project-documents";
  import {
    registryHasAttention,
    type RegistryActionRequest,
    type RegistryProjectArtifact,
    type RegistrySnapshot,
  } from "../lib/registry";
  import { sessionTodoCounts, type SessionTodoSnapshot } from "../lib/session-todos";
  import { sessionSubagentCount, type SessionSubagentSnapshot } from "../lib/session-subagents";
  import RegistryPanel from "./RegistryPanel.svelte";
  import GitPanel from "./GitPanel.svelte";
  import ProjectExplorer from "./ProjectExplorer.svelte";
  import PromptComposer from "./PromptComposer.svelte";
  import SessionActivityPanel from "./SessionActivityPanel.svelte";

  type TaskDraft = {
    title: string;
    description?: string;
    type: ProjectTaskType;
  };

  type SidebarTab = "tasks" | "project" | "git" | "registry" | "session";
  type TaskDropPosition = "before" | "after";
  type TaskDropTarget = {
    type: ProjectTaskType;
    targetTaskId: string | null;
    position: TaskDropPosition;
  };

  const TASK_GROUPS: readonly { type: ProjectTaskType; label: string }[] = [
    { type: "bug", label: "Bug" },
    { type: "feature", label: "Feature" },
    { type: "improvement", label: "Improve" },
  ];

  const SIDEBAR_LABELS: Record<SidebarTab, string> = {
    tasks: "Tasks",
    project: "Project",
    git: "Source Control",
    registry: "Registry",
    session: "Session",
  };

  let {
    workspace,
    tasks,
    loading,
    saving,
    storageError,
    activeTaskId,
    sessionReady,
    activeSessionId,
    todoSnapshot,
    subagentSnapshot,
    registrySnapshot,
    registryLoading,
    registryActionId,
    gitSnapshot,
    gitLoading,
    gitError,
    gitActionId,
    gitLlmActionId,
    projectDocuments,
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
    onOpenProjectFile,
    onOpenExternalEditor,
    onReload,
    onRegistryRefresh,
    onRegistryAction,
    onGitRefresh,
    onGitOpenDiff,
    onGitStage,
    onGitUnstage,
    onGitCommit,
    onGitPush,
    onGitSwitchBranch,
    onGitCreateBranch,
    onGitGenerateCommitMessage,
    onGitReview,
  }: {
    workspace: string;
    tasks: ProjectTask[];
    loading: boolean;
    saving: boolean;
    storageError: boolean;
    activeTaskId: string | null;
    sessionReady: boolean;
    activeSessionId: string | null;
    todoSnapshot: SessionTodoSnapshot | undefined;
    subagentSnapshot: SessionSubagentSnapshot | undefined;
    registrySnapshot: RegistrySnapshot | undefined;
    registryLoading: boolean;
    registryActionId: string | null;
    gitSnapshot: GitSnapshot | undefined;
    gitLoading: boolean;
    gitError: string | null;
    gitActionId: string | null;
    gitLlmActionId: string | null;
    projectDocuments: ProjectDocumentsSnapshot;
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
      position: TaskDropPosition,
    ) => void;
    onRun: (task: ProjectTask) => void;
    onOpenSession: (task: ProjectTask) => void;
    onOpenProjectDocument: (path: string, exists?: boolean) => void;
    onListProjectDirectory: (path: string) => Promise<ProjectTreeEntry[]>;
    onOpenProjectFile: (path: string) => void;
    onOpenExternalEditor: (path?: string) => void;
    onReload: () => void;
    onRegistryRefresh: () => void;
    onRegistryAction: (request: RegistryActionRequest, actionId: string) => void;
    onGitRefresh: () => void;
    onGitOpenDiff: (path: string | undefined, scope: GitDiffScope) => void;
    onGitStage: (path?: string) => void;
    onGitUnstage: (path?: string) => void;
    onGitCommit: (message: string) => Promise<boolean>;
    onGitPush: () => void;
    onGitSwitchBranch: (branch: string) => void;
    onGitCreateBranch: (branch: string) => void;
    onGitGenerateCommitMessage: () => Promise<string | undefined>;
    onGitReview: (path: string | undefined, scope: GitDiffScope) => void;
  } = $props();

  const ACTIVITY_BAR_WIDTH = 48;
  const DEFAULT_WIDTH = 296;
  const MIN_WIDTH = 236;
  const REGISTRY_MIN_WIDTH = 344;
  const MAX_WIDTH = 420;
  const WIDTH_KEY = "pix.desktop.taskSidebarWidth";
  const COLLAPSED_KEY = "pix.desktop.taskSidebarCollapsed";
  const ACTIVE_TAB_KEY = "pix.desktop.workspaceSidebarTab";

  let collapsed = $state(false);
  let sidebarWidth = $state(DEFAULT_WIDTH);
  let activeTab = $state<SidebarTab>("tasks");
  let editorOpen = $state(false);
  let editingTaskId = $state<string | null>(null);
  let deleteTaskId = $state<string | null>(null);
  let title = $state("");
  let description = $state("");
  let editorAttachments = $state<Attachment[]>([]);
  let taskType = $state<ProjectTaskType>("feature");
  let statusMenuTaskId = $state<string | null>(null);
  let planSelectorOpen = $state(false);
  let planSelectorQuery = $state("");
  let planSearchInput = $state<HTMLInputElement | null>(null);
  let projectTreeRefreshKey = $state(0);
  let draggedTaskId = $state<string | null>(null);
  let taskDropTarget = $state<TaskDropTarget | null>(null);
  let draggedTaskHeight = $state(44);
  let draggedTaskWidth = $state(0);
  let dragPointerId = $state<number | null>(null);
  let dragClientX = $state(0);
  let dragClientY = $state(0);
  let dragOffsetX = $state(0);
  let dragOffsetY = $state(0);
  let resizePointerId = $state<number | null>(null);
  let resizeStartX = 0;
  let resizeStartWidth = 0;
  let previousDocumentUserSelect: string | null = null;
  let previousDocumentCursor: string | null = null;
  let previousTaskDragUserSelect: string | null = null;
  let previousTaskDragCursor: string | null = null;
  let titleInput = $state<HTMLInputElement | null>(null);

  const busy = $derived(loading || saving || storageError || activeTaskId !== null);
  const doneCount = $derived(tasks.filter((task) => task.status === "done").length);
  const todoCounts = $derived(sessionTodoCounts(todoSnapshot));
  const openTodoCount = $derived(todoCounts.pending + todoCounts.in_progress + todoCounts.deferred);
  const activeSubagentCount = $derived(sessionSubagentCount(subagentSnapshot));
  const registryAttention = $derived(registryHasAttention(registrySnapshot));
  const gitChangeCount = $derived(gitSnapshot?.changes.length ?? 0);
  const activeMinWidth = $derived(sidebarMinWidth(activeTab));
  const expandedSidebarWidth = $derived(Math.max(sidebarWidth, activeMinWidth));
  const renderedSidebarWidth = $derived(ACTIVITY_BAR_WIDTH + (collapsed ? 0 : expandedSidebarWidth));
  const activeTabTitle = $derived(SIDEBAR_LABELS[activeTab]);
  const draggedTask = $derived(draggedTaskId ? tasks.find((task) => task.id === draggedTaskId) : undefined);
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
    setActiveTab("tasks");
  }

  function choosePlan(plan: string): void {
    planSelectorOpen = false;
    planSelectorQuery = "";
    onOpenProjectDocument(plan);
  }

  onMount(() => {
    try {
      collapsed = localStorage.getItem(COLLAPSED_KEY) === "true";
      const savedTab = localStorage.getItem(ACTIVE_TAB_KEY);
      if (isSidebarTab(savedTab)) activeTab = savedTab;
      const savedWidth = localStorage.getItem(WIDTH_KEY);
      if (savedWidth !== null) {
        const parsedWidth = Number(savedWidth);
        if (Number.isFinite(parsedWidth)) sidebarWidth = clampWidth(parsedWidth);
      }
    } catch {
      // Keep the defaults when webview storage is unavailable.
    }

    return () => {
      setDocumentResizeState(false);
      setDocumentTaskDragState(false);
    };
  });

  function setCollapsed(next: boolean): void {
    collapsed = next;
    try {
      localStorage.setItem(COLLAPSED_KEY, String(next));
    } catch {
      // Persistence is a convenience, not a requirement for sidebar use.
    }
  }

  function isSidebarTab(value: string | null): value is SidebarTab {
    return value === "project" || value === "tasks" || value === "git" || value === "registry" || value === "session";
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
    statusMenuTaskId = null;
    planSelectorOpen = false;
    planSelectorQuery = "";
    if (activeTab === tab && !collapsed) {
      editorOpen = false;
      deleteTaskId = null;
      setCollapsed(true);
      return;
    }

    if (activeTab !== tab) {
      editorOpen = false;
      deleteTaskId = null;
    }
    setActiveTab(tab);
    if (collapsed) setCollapsed(false);
  }

  function startResize(event: PointerEvent): void {
    if (collapsed || event.button !== 0) return;
    event.preventDefault();
    resizePointerId = event.pointerId;
    resizeStartX = event.clientX;
    resizeStartWidth = expandedSidebarWidth;
    setDocumentResizeState(true);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function resize(event: PointerEvent): void {
    if (event.pointerId !== resizePointerId) return;
    const candidate = resizeStartWidth + event.clientX - resizeStartX;
    if (candidate <= activeMinWidth && sidebarWidth < activeMinWidth) return;
    sidebarWidth = clampWidth(candidate, activeMinWidth);
  }

  function finishResize(event: PointerEvent): void {
    if (event.pointerId !== resizePointerId) return;
    resizePointerId = null;
    setDocumentResizeState(false);
    try {
      localStorage.setItem(WIDTH_KEY, String(sidebarWidth));
    } catch {
      // Keep the in-memory width when persistence is unavailable.
    }
  }

  function setDocumentResizeState(active: boolean): void {
    const root = document.documentElement;
    if (active) {
      if (previousDocumentUserSelect === null) previousDocumentUserSelect = root.style.userSelect;
      if (previousDocumentCursor === null) previousDocumentCursor = root.style.cursor;
      root.style.userSelect = "none";
      root.style.cursor = "col-resize";
      return;
    }

    if (previousDocumentUserSelect !== null) {
      root.style.userSelect = previousDocumentUserSelect;
      previousDocumentUserSelect = null;
    }
    if (previousDocumentCursor !== null) {
      root.style.cursor = previousDocumentCursor;
      previousDocumentCursor = null;
    }
  }

  function resizeWithKeyboard(event: KeyboardEvent): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home") return;
    event.preventDefault();
    if (event.key === "Home") {
      sidebarWidth = DEFAULT_WIDTH;
    } else if (event.key === "ArrowLeft" && sidebarWidth < activeMinWidth) {
      return;
    } else {
      const baseWidth = Math.max(sidebarWidth, activeMinWidth);
      sidebarWidth = clampWidth(baseWidth + (event.key === "ArrowLeft" ? -12 : 12), activeMinWidth);
    }
    try {
      localStorage.setItem(WIDTH_KEY, String(sidebarWidth));
    } catch {
      // Keep the in-memory width when persistence is unavailable.
    }
  }

  function sidebarMinWidth(tab: SidebarTab): number {
    return tab === "registry" ? REGISTRY_MIN_WIDTH : MIN_WIDTH;
  }

  function clampWidth(width: number, minimum = MIN_WIDTH): number {
    return Math.min(MAX_WIDTH, Math.max(minimum, width));
  }

  function openCreate(): void {
    statusMenuTaskId = null;
    editingTaskId = null;
    title = "";
    description = "";
    editorAttachments = [];
    taskType = "feature";
    editorOpen = true;
    void focusEditorTitle();
  }

  function openEdit(task: ProjectTask): void {
    statusMenuTaskId = null;
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
    if (!trimmedTitle || busy) return;
    const storedDescription = textWithAttachmentMarkers(description, editorAttachments);
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

  function statusTone(status: ProjectTaskStatus): string {
    if (status === "done") return "text-[var(--tool-success)]";
    if (status === "in-progress") return "text-[var(--tool-warning)]";
    return "text-[var(--tool-muted)]";
  }

  function setTaskStatus(taskId: string, status: ProjectTaskStatus): void {
    statusMenuTaskId = null;
    onStatusChange(taskId, status);
  }

  function closeStatusMenuOutside(event: PointerEvent): void {
    if (!statusMenuTaskId) return;
    const target = event.target as HTMLElement | null;
    if (!target?.closest("[data-task-status-control]")) statusMenuTaskId = null;
  }

  function startTaskDrag(event: PointerEvent, taskId: string): void {
    if (busy || event.button !== 0) return;
    statusMenuTaskId = null;
    const handle = event.currentTarget as HTMLElement;
    const card = handle.closest<HTMLElement>("[data-task-card]");
    if (!card) return;
    event.preventDefault();
    const bounds = card.getBoundingClientRect();
    draggedTaskHeight = Math.max(36, Math.round(bounds.height));
    draggedTaskWidth = Math.round(bounds.width);
    dragPointerId = event.pointerId;
    dragOffsetX = event.clientX - bounds.left;
    dragOffsetY = event.clientY - bounds.top;
    dragClientX = event.clientX;
    dragClientY = event.clientY;
    draggedTaskId = taskId;
    taskDropTarget = null;
    setDocumentTaskDragState(true);
    handle.setPointerCapture(event.pointerId);
  }

  function moveTaskDrag(event: PointerEvent): void {
    if (event.pointerId !== dragPointerId || !draggedTaskId) return;
    event.preventDefault();
    dragClientX = event.clientX;
    dragClientY = event.clientY;
    const hit = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
    if (hit?.closest("[data-task-drop-placeholder]") && taskDropTarget) return;
    taskDropTarget = taskDropTargetAt(event.clientX, event.clientY);
  }

  function taskDropTargetAt(clientX: number, clientY: number): TaskDropTarget | null {
    const groups = [...document.querySelectorAll<HTMLElement>("[data-task-group]")];
    const group = groups.find((candidate) => {
      const bounds = candidate.getBoundingClientRect();
      return clientX >= bounds.left - 12
        && clientX <= bounds.right + 12
        && clientY >= bounds.top
        && clientY <= bounds.bottom;
    });
    if (!group) return null;

    const type = group.dataset.taskGroup as ProjectTaskType | undefined;
    if (!type || !TASK_GROUPS.some((candidate) => candidate.type === type)) return null;
    const cards = [...group.querySelectorAll<HTMLElement>("[data-task-card]")]
      .filter((card) => card.dataset.taskId !== draggedTaskId);
    if (cards.length === 0) return { type, targetTaskId: null, position: "after" };

    for (const card of cards) {
      const taskId = card.dataset.taskId;
      if (!taskId) continue;
      const bounds = card.getBoundingClientRect();
      if (clientY < bounds.top + bounds.height / 2) {
        return { type, targetTaskId: taskId, position: "before" };
      }
    }

    const lastTaskId = cards.at(-1)?.dataset.taskId;
    return lastTaskId ? { type, targetTaskId: lastTaskId, position: "after" } : null;
  }

  function finishTaskDrag(event: PointerEvent): void {
    if (event.pointerId !== dragPointerId) return;
    const taskId = draggedTaskId;
    const target = taskDropTarget;
    clearTaskDrag();
    if (!taskId || !target) return;
    onReorder(taskId, target.type, target.targetTaskId, target.position);
  }

  function cancelTaskDrag(event: PointerEvent): void {
    if (event.pointerId !== dragPointerId) return;
    clearTaskDrag();
  }

  function clearTaskDrag(): void {
    draggedTaskId = null;
    taskDropTarget = null;
    dragPointerId = null;
    setDocumentTaskDragState(false);
  }

  function setDocumentTaskDragState(active: boolean): void {
    const root = document.documentElement;
    if (active) {
      if (previousTaskDragUserSelect === null) previousTaskDragUserSelect = root.style.userSelect;
      if (previousTaskDragCursor === null) previousTaskDragCursor = root.style.cursor;
      root.style.userSelect = "none";
      root.style.cursor = "grabbing";
      return;
    }

    if (previousTaskDragUserSelect !== null) {
      root.style.userSelect = previousTaskDragUserSelect;
      previousTaskDragUserSelect = null;
    }
    if (previousTaskDragCursor !== null) {
      root.style.cursor = previousTaskDragCursor;
      previousTaskDragCursor = null;
    }
  }

  function isDropPlaceholder(
    type: ProjectTaskType,
    targetTaskId: string | null,
    position: TaskDropPosition,
  ): boolean {
    return taskDropTarget?.type === type
      && taskDropTarget.targetTaskId === targetTaskId
      && taskDropTarget.position === position;
  }

</script>

<aside
  class="relative flex min-h-0 shrink-0 bg-sidebar text-sidebar-foreground"
  class:select-none={resizePointerId !== null}
  style:width={`${renderedSidebarWidth}px`}
  style:max-width="100vw"
  aria-label="Workspace sidebar"
>
  <nav class="flex h-full w-12 shrink-0 flex-col items-center border-r border-sidebar-border py-1.5" aria-label="Workspace views">
    <button
      class={["relative grid h-11 w-12 place-items-center border-l-2 hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring", activeTab === "project" ? "border-l-primary text-foreground" : "border-l-transparent text-muted-foreground"]}
      type="button"
      title={activeTab === "project" && !collapsed ? "Hide Project" : "Project"}
      aria-label="Project files"
      aria-controls="workspace-project-panel"
      aria-pressed={activeTab === "project" && !collapsed}
      onclick={() => selectTab("project")}
    ><Folder class="h-5 w-5" aria-hidden="true" /></button>
    <button
      class={["relative grid h-11 w-12 place-items-center border-l-2 hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring", activeTab === "tasks" ? "border-l-primary text-foreground" : "border-l-transparent text-muted-foreground"]}
      type="button"
      title={activeTab === "tasks" && !collapsed ? "Hide Tasks" : "Tasks"}
      aria-label={`Tasks, ${tasks.length} total`}
      aria-controls="workspace-tasks-panel"
      aria-pressed={activeTab === "tasks" && !collapsed}
      onclick={() => selectTab("tasks")}
    >
      <ListTodo class="h-5 w-5" aria-hidden="true" />
      {#if tasks.length > 0}<span class="absolute top-2 right-2 h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true"></span>{/if}
    </button>
    <button
      class={["relative grid h-11 w-12 place-items-center border-l-2 hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring", activeTab === "git" ? "border-l-primary text-foreground" : "border-l-transparent text-muted-foreground"]}
      type="button"
      title={activeTab === "git" && !collapsed ? "Hide Source Control" : "Source Control"}
      aria-label={`Source Control, ${gitChangeCount} changed ${gitChangeCount === 1 ? "file" : "files"}`}
      aria-controls="workspace-git-panel"
      aria-pressed={activeTab === "git" && !collapsed}
      onclick={() => selectTab("git")}
    >
      <GitBranch class="h-5 w-5" aria-hidden="true" />
      {#if gitChangeCount > 0}<span class="absolute top-1.5 right-1.5 min-w-3 rounded-full bg-primary px-0.5 text-center font-mono text-[7px] leading-3 text-primary-foreground" aria-hidden="true">{Math.min(gitChangeCount, 99)}</span>{/if}
    </button>
    <button
      class={["relative grid h-11 w-12 place-items-center border-l-2 hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring", activeTab === "registry" ? "border-l-primary text-foreground" : "border-l-transparent text-muted-foreground"]}
      type="button"
      title={activeTab === "registry" && !collapsed ? "Hide Registry" : "Registry"}
      aria-label={`Resource registry${registryAttention ? ", attention needed" : ""}`}
      aria-controls="workspace-registry-panel"
      aria-pressed={activeTab === "registry" && !collapsed}
      onclick={() => selectTab("registry")}
    >
      <Database class="h-5 w-5" aria-hidden="true" />
      {#if registryAttention}<span class="absolute top-2 right-2 h-1.5 w-1.5 rounded-full bg-[var(--tool-warning)]" aria-hidden="true"></span>{/if}
    </button>
    <button
      class={["relative grid h-11 w-12 place-items-center border-l-2 hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring", activeTab === "session" ? "border-l-primary text-foreground" : "border-l-transparent text-muted-foreground"]}
      type="button"
      title={activeTab === "session" && !collapsed ? "Hide Session" : "Session"}
      aria-label={`Session activity, ${openTodoCount} open todos, ${activeSubagentCount} active subagents`}
      aria-controls="workspace-session-panel"
      aria-pressed={activeTab === "session" && !collapsed}
      onclick={() => selectTab("session")}
    >
      <Activity class="h-5 w-5" aria-hidden="true" />
      {#if openTodoCount > 0 || activeSubagentCount > 0}<span class="absolute top-2 right-2 h-1.5 w-1.5 rounded-full bg-[var(--tool-warning)]" aria-hidden="true"></span>{/if}
    </button>
  </nav>

  {#if !collapsed}
    <div class="grid min-w-0 flex-1 grid-rows-[40px_minmax(0,1fr)] overflow-hidden border-r border-sidebar-border">
      <div class="flex min-w-0 items-center gap-2 border-b border-sidebar-border px-3">
        <strong class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[11px] font-semibold uppercase tracking-wide">{activeTabTitle}</strong>
        {#if activeTab === "tasks"}
          <span class="min-w-0 truncate text-[9px] text-muted-foreground">{tasks.length} {tasks.length === 1 ? "task" : "tasks"} · {doneCount} done</span>
          <button
            class="ml-auto flex h-6 shrink-0 items-center gap-1 rounded-md bg-primary px-2 text-[10px] font-medium text-primary-foreground transition hover:brightness-110 active:brightness-95 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
            type="button"
            onclick={openCreate}
            disabled={!workspace || busy}
          ><Plus class="h-3 w-3" aria-hidden="true" />Add</button>
        {:else if activeTab === "project"}
          <div class="ml-auto flex shrink-0 items-center gap-0.5">
            <button
              class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
              type="button"
              title={`Open project in ${externalEditorLabel}`}
              aria-label={`Open project in ${externalEditorLabel}`}
              onclick={() => onOpenExternalEditor()}
              disabled={!workspace}
            ><ExternalLink class="h-3.5 w-3.5" aria-hidden="true" /></button>
            <button
              class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
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
              class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
              type="button"
              title="Configure registry"
              aria-label="Configure registry"
              onclick={() => onRegistryAction({ action: "configure" }, "configure")}
              disabled={!sessionReady || registryActionId !== null}
            ><Settings class="h-3.5 w-3.5" aria-hidden="true" /></button>
            <button
              class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
              type="button"
              title="Refresh registry"
              aria-label="Refresh registry"
              onclick={onRegistryRefresh}
              disabled={!sessionReady || registryActionId !== null}
            ><RefreshCw class={["h-3.5 w-3.5", registryLoading || registryActionId === "refresh" ? "animate-spin" : ""]} aria-hidden="true" /></button>
          </div>
        {/if}
      </div>

      {#if activeTab === "tasks"}
        <section
          id="workspace-tasks-panel"
          class="min-h-0 select-none overflow-y-auto p-1.5"
          aria-label="Tasks"
          onpointerdown={closeStatusMenuOutside}
        >
          <div class="min-h-0">
            {#if loading}
              <div class="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground"><RotateCw class="h-4 w-4 animate-spin" aria-hidden="true" />Loading tasks…</div>
            {:else if storageError}
              <div class="px-4 py-8 text-center">
                <ListTodo class="mx-auto mb-2 h-5 w-5 text-[var(--tool-error)]" aria-hidden="true" />
                <p class="text-xs font-medium">Task file needs attention</p>
                <p class="mt-1 text-[10px] leading-4 text-muted-foreground">Fix <code class="font-mono">.pi/tasks.jsonc</code>, then try again. Its contents were not replaced.</p>
                <button class="mt-3 inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[10px] font-medium hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" type="button" onclick={onReload}><RotateCw class="h-3 w-3" aria-hidden="true" />Retry</button>
              </div>
            {:else if !workspace}
              <div class="px-4 py-8 text-center"><Folder class="mx-auto mb-2 h-5 w-5 text-muted-foreground" aria-hidden="true" /><p class="text-xs font-medium">Choose a project</p><p class="mt-1 text-[10px] text-muted-foreground">Tasks are stored inside its .pi folder.</p></div>
            {:else if tasks.length === 0}
              <div class="px-4 py-8 text-center"><ListTodo class="mx-auto mb-2 h-5 w-5 text-muted-foreground" aria-hidden="true" /><p class="text-xs font-medium">No tasks yet</p><p class="mt-1 text-[10px] text-muted-foreground">Add the first project task.</p></div>
            {:else}
              <div class="space-y-2.5">
                {#each TASK_GROUPS as group (group.type)}
                  {@const groupTasks = tasks.filter((task) => task.type === group.type)}
                  <section class="space-y-1" aria-label={`${group.label} tasks`} data-task-group={group.type}>
                    <div class="flex h-5 items-center gap-1.5 px-1 text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                      <span>{group.label}</span>
                      <span class="font-mono text-[8px] font-normal opacity-65">{groupTasks.length}</span>
                    </div>

                    <div
                      class={[
                        "min-h-8 space-y-1 rounded-lg p-0.5 transition-colors",
                        draggedTaskId && taskDropTarget?.type === group.type ? "bg-sidebar-accent/30" : "",
                      ]}
                      role="list"
                    >
                      {#if groupTasks.length === 0 && !isDropPlaceholder(group.type, null, "after")}
                        <div class="pointer-events-none grid h-8 place-items-center rounded-md border border-dashed border-sidebar-border/70 text-[9px] text-muted-foreground/55">
                          Empty
                        </div>
                      {/if}

                      {#each groupTasks as task (task.id)}
                        {#if isDropPlaceholder(group.type, task.id, "before")}
                          <div
                            data-task-drop-placeholder
                            class="grid place-items-center rounded-md border border-dashed border-primary/60 bg-primary/5 text-[9px] font-medium text-primary shadow-inner"
                            style:min-height={`${draggedTaskHeight}px`}
                            role="presentation"
                          >Move to {group.label}</div>
                        {/if}

                        <article
                          data-task-card
                          data-task-id={task.id}
                          class={[
                            "group relative rounded-md border border-sidebar-border bg-background/45 px-1.5 py-1.5 shadow-xs transition-[border-color,opacity,transform] duration-150 hover:border-border",
                            draggedTaskId === task.id ? "border-dashed border-primary/35 bg-primary/5 opacity-25" : "",
                          ]}
                          aria-label={task.title}
                        >
                          <div class="flex min-w-0 items-start gap-1">
                            <button
                              class="mt-px grid h-6 w-5 shrink-0 touch-none cursor-grab place-items-center rounded text-muted-foreground/70 hover:bg-accent hover:text-foreground active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-30"
                              type="button"
                              title="Drag to reorder or move between groups"
                              aria-label={`Drag ${task.title} to reorder or change type`}
                              disabled={busy}
                              onpointerdown={(event) => startTaskDrag(event, task.id)}
                              onpointermove={moveTaskDrag}
                              onpointerup={finishTaskDrag}
                              onpointercancel={cancelTaskDrag}
                              onlostpointercapture={cancelTaskDrag}
                            ><GripVertical class="h-3.5 w-3.5" aria-hidden="true" /></button>

                            <div class="min-w-0 flex-1">
                              <div class="flex min-w-0 items-start gap-1">
                                <h3 class="min-w-0 flex-1 break-words pt-1 text-[11px] font-medium leading-4 text-foreground">{task.title}</h3>
                                <div class="flex shrink-0 items-center opacity-65 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                                  <div class="relative" data-task-status-control>
                                    <button
                                      class={["grid h-6 w-6 place-items-center rounded-md hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-35", statusTone(task.status)]}
                                      type="button"
                                      title={`Status: ${taskStatusLabel(task.status)}`}
                                      aria-label={`Change status for ${task.title}. Current status: ${taskStatusLabel(task.status)}`}
                                      aria-haspopup="menu"
                                      aria-expanded={statusMenuTaskId === task.id}
                                      onclick={() => statusMenuTaskId = statusMenuTaskId === task.id ? null : task.id}
                                      disabled={busy}
                                    >
                                      {#if task.status === "done"}<CheckCircle2 class="h-3 w-3" aria-hidden="true" />
                                      {:else if task.status === "in-progress"}<Clock3 class="h-3 w-3" aria-hidden="true" />
                                      {:else if task.status === "backlog"}<CircleDashed class="h-3 w-3" aria-hidden="true" />
                                      {:else}<Circle class="h-3 w-3" aria-hidden="true" />{/if}
                                    </button>

                                    {#if statusMenuTaskId === task.id}
                                      <div class="absolute top-7 right-0 z-40 w-36 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg" role="menu" aria-label={`Status for ${task.title}`}>
                                        {#each TASK_STATUSES as status}
                                          <button
                                            class={["flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left text-[10px] leading-none whitespace-nowrap hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring", status === task.status ? "bg-accent text-foreground" : "text-muted-foreground"]}
                                            type="button"
                                            role="menuitemradio"
                                            aria-checked={status === task.status}
                                            onclick={() => setTaskStatus(task.id, status)}
                                          >
                                            <span class={["grid h-4 w-4 shrink-0 place-items-center", statusTone(status)]}>
                                              {#if status === "done"}<CheckCircle2 class="h-3 w-3" aria-hidden="true" />
                                              {:else if status === "in-progress"}<Clock3 class="h-3 w-3" aria-hidden="true" />
                                              {:else if status === "backlog"}<CircleDashed class="h-3 w-3" aria-hidden="true" />
                                              {:else}<Circle class="h-3 w-3" aria-hidden="true" />{/if}
                                            </span>
                                            <span class="truncate">{taskStatusLabel(status)}</span>
                                          </button>
                                        {/each}
                                      </div>
                                    {/if}
                                  </div>
                                  <button
                                    class="grid h-6 w-6 place-items-center rounded-md text-primary hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-35"
                                    type="button"
                                    title={task.sessionId ? "Open session" : "Run task"}
                                    aria-label={`${task.sessionId ? "Open session for" : "Run"} ${task.title}`}
                                    onclick={() => task.sessionId ? onOpenSession(task) : onRun(task)}
                                    disabled={!sessionReady || busy}
                                  >
                                    {#if activeTaskId === task.id}<RotateCw class="h-3 w-3 animate-spin" aria-hidden="true" />
                                    {:else if task.sessionId}<Folder class="h-3 w-3" aria-hidden="true" />
                                    {:else}<Play class="h-3 w-3" aria-hidden="true" />{/if}
                                  </button>
                                  <button class="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-35" type="button" title="Edit task" aria-label={`Edit ${task.title}`} onclick={() => openEdit(task)} disabled={busy}><Pencil class="h-3 w-3" aria-hidden="true" /></button>
                                  <button class="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-[var(--tool-error)] focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-35" type="button" title="Delete task" aria-label={`Delete ${task.title}`} onclick={() => deleteTaskId = task.id} disabled={busy}><Trash2 class="h-3 w-3" aria-hidden="true" /></button>
                                </div>
                              </div>

                            </div>
                          </div>
                        </article>

                        {#if isDropPlaceholder(group.type, task.id, "after")}
                          <div
                            data-task-drop-placeholder
                            class="grid place-items-center rounded-md border border-dashed border-primary/60 bg-primary/5 text-[9px] font-medium text-primary shadow-inner"
                            style:min-height={`${draggedTaskHeight}px`}
                            role="presentation"
                          >Move to {group.label}</div>
                        {/if}
                      {/each}

                      {#if isDropPlaceholder(group.type, null, "after")}
                        <div
                          data-task-drop-placeholder
                          class="grid place-items-center rounded-md border border-dashed border-primary/60 bg-primary/5 text-[9px] font-medium text-primary shadow-inner"
                          style:min-height={`${draggedTaskHeight}px`}
                          role="presentation"
                        >Move to {group.label}</div>
                      {/if}
                    </div>
                  </section>
                {/each}
              </div>
            {/if}
          </div>
        </section>
      {:else if activeTab === "project"}
        <section id="workspace-project-panel" class="grid min-h-0 min-w-0 overflow-hidden" aria-label="Project">
          {#if !workspace}
            <div class="px-4 py-8 text-center"><Folder class="mx-auto mb-2 h-5 w-5 text-muted-foreground" aria-hidden="true" /><p class="text-xs font-medium">Choose a project</p></div>
          {:else}
            <ProjectExplorer
              {workspace}
              {externalEditorLabel}
              refreshKey={projectTreeRefreshKey}
              onListDirectory={onListProjectDirectory}
              onOpenFile={onOpenProjectFile}
              onOpenExternal={(path) => onOpenExternalEditor(path)}
            />
          {/if}
        </section>
      {:else if activeTab === "git"}
        <div id="workspace-git-panel" class="grid min-h-0 min-w-0 overflow-hidden" aria-label="Source Control">
          <GitPanel
            {workspace}
            snapshot={gitSnapshot}
            loading={gitLoading}
            error={gitError}
            actionId={gitActionId}
            llmActionId={gitLlmActionId}
            {sessionReady}
            onRefresh={onGitRefresh}
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
            loading={registryLoading}
            disabled={!sessionReady}
            actionId={registryActionId}
            onRefresh={onRegistryRefresh}
            onAction={onRegistryAction}
            onOpenProjectArtifact={openRegistryProjectArtifact}
          />
        </div>
      {:else}
        <div id="workspace-session-panel" class="grid min-h-0" aria-label="Session">
          <SessionActivityPanel {activeSessionId} {todoSnapshot} {subagentSnapshot} />
        </div>
      {/if}
    </div>

    {#if planSelectorOpen}
      <div
        class="absolute top-12 right-2 left-14 z-40 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-xl"
        role="dialog"
        aria-label="Choose plan"
      >
        <div class="flex h-9 items-center gap-2 border-b border-border px-2.5">
          <strong class="min-w-0 flex-1 truncate text-[11px] font-semibold">Choose plan</strong>
          <button
            class="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            type="button"
            title="Close plan selector"
            aria-label="Close plan selector"
            onclick={() => {
              planSelectorOpen = false;
              planSelectorQuery = "";
            }}
          ><X class="h-3.5 w-3.5" aria-hidden="true" /></button>
        </div>

        <div class="border-b border-border p-2">
          <div class="relative">
            <Search class="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <input
              bind:this={planSearchInput}
              class="h-7 w-full rounded-md border border-input bg-background pr-2 pl-7 text-[10px] text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring/30"
              type="search"
              placeholder="Find plan…"
              bind:value={planSelectorQuery}
              autocomplete="off"
              spellcheck="false"
            />
          </div>
        </div>

        <div class="max-h-72 overflow-y-auto p-1.5">
          {#if visiblePlanChoices.length === 0}
            <div class="px-2 py-5 text-center text-[10px] text-muted-foreground">No matching plans</div>
          {:else}
            {#each visiblePlanChoices as plan (plan)}
              <button
                class="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                type="button"
                title={plan}
                onclick={() => choosePlan(plan)}
              >
                <FileText class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span class="min-w-0 flex-1 truncate text-[10px] font-medium">{projectDocumentLabel(plan)}</span>
              </button>
            {/each}
          {/if}
        </div>
      </div>
    {/if}

    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="absolute inset-y-0 -right-[3px] z-10 w-[6px] cursor-col-resize touch-none after:absolute after:inset-y-0 after:left-[2px] after:w-px hover:after:bg-primary"
      role="separator"
      aria-label="Resize workspace sidebar"
      aria-orientation="vertical"
      aria-valuemin={activeMinWidth}
      aria-valuemax={MAX_WIDTH}
      aria-valuenow={expandedSidebarWidth}
      tabindex="0"
      onpointerdown={startResize}
      onpointermove={resize}
      onpointerup={finishResize}
      onpointercancel={finishResize}
      onlostpointercapture={finishResize}
      onkeydown={resizeWithKeyboard}
      ondblclick={() => sidebarWidth = DEFAULT_WIDTH}
    ></div>
  {/if}

  {#if draggedTask && dragPointerId !== null}
    <div
      class="pointer-events-none fixed z-50 select-none rounded-md border border-primary/45 bg-popover px-1.5 py-1.5 text-popover-foreground shadow-xl ring-1 ring-primary/15"
      style:left={`${dragClientX - dragOffsetX}px`}
      style:top={`${dragClientY - dragOffsetY}px`}
      style:width={`${draggedTaskWidth}px`}
      style:min-height={`${draggedTaskHeight}px`}
      aria-hidden="true"
    >
      <div class="flex min-w-0 items-start gap-1">
        <div class="mt-px grid h-6 w-5 shrink-0 place-items-center text-muted-foreground/70">
          <GripVertical class="h-3.5 w-3.5" aria-hidden="true" />
        </div>
        <div class="min-w-0 flex-1">
          <h3 class="break-words pt-1 text-[11px] font-medium leading-4">{draggedTask.title}</h3>
        </div>
      </div>
    </div>
  {/if}

  {#if editorOpen && !collapsed}
    <div
      class="absolute inset-y-0 right-0 left-12 z-20 grid min-h-0 grid-rows-[40px_minmax(0,1fr)] border-r border-sidebar-border bg-sidebar"
      role="dialog"
      aria-modal="true"
      aria-label={editingTaskId ? "Edit task" : "Add task"}
    >
      <div class="flex items-center justify-between border-b border-sidebar-border px-3">
        <strong class="text-sm font-semibold">{editingTaskId ? "Edit task" : "Add task"}</strong>
        <button class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" type="button" aria-label="Close task editor" onclick={() => editorOpen = false}><X class="h-4 w-4" aria-hidden="true" /></button>
      </div>
      <div class="min-h-0 space-y-3 overflow-y-auto p-3">
        <label class="block text-xs font-medium text-muted-foreground">Title<input class="mt-1 h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring" bind:this={titleInput} bind:value={title} maxlength="200" required /></label>
        <div class="space-y-1">
          <span class="block text-xs font-medium text-muted-foreground">Description</span>
          <PromptComposer
            bind:promptText={description}
            attachments={editorAttachments}
            variant="editor"
            placeholder="Describe the task…"
            ariaLabel="Task description"
            activeSessionId={null}
            ready={!busy}
            promptRunning={false}
            dragActive={false}
            autocompleteEnabled={false}
            autocompleteDebounceMs={0}
            onAutocomplete={async () => ""}
            onSubmit={() => {}}
            onDefer={() => {}}
            onCancel={() => {}}
            onChooseAttachments={chooseEditorAttachments}
            onPasteAttachments={pasteEditorAttachments}
            onRemoveAttachment={removeEditorAttachment}
            onOpenAttachment={onOpenTaskAttachment}
          />
        </div>
        <label class="block text-xs font-medium text-muted-foreground">Type<span class="relative mt-1 block"><select class="h-9 w-full appearance-none rounded-md border border-input bg-background py-0 pr-8 pl-2.5 text-sm text-foreground shadow-none hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" bind:value={taskType}>{#each TASK_TYPES as type}<option value={type}>{taskTypeLabel(type)}</option>{/each}</select><ChevronDown class="pointer-events-none absolute top-1/2 right-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" /></span></label>
        <div class="flex justify-end gap-2 pt-1">
          <button class="h-9 rounded-md px-3 text-sm text-muted-foreground hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring" type="button" onclick={() => editorOpen = false}>Cancel</button>
          <button class="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" type="button" onclick={submitEditor} disabled={!title.trim() || busy}>{editingTaskId ? "Save" : "Add task"}</button>
        </div>
      </div>
    </div>
  {/if}

  {#if deleteTaskId && !collapsed}
    {@const deleteTask = tasks.find((task) => task.id === deleteTaskId)}
    <div
      class="absolute inset-y-0 right-0 left-12 z-30 grid place-items-center border-r border-sidebar-border bg-[var(--overlay)] p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Delete task"
    >
      <div class="w-full rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-md">
        <strong class="text-xs font-semibold">Delete task?</strong>
        <p class="mt-1.5 break-words text-[10px] leading-4 text-muted-foreground">“{deleteTask?.title ?? "This task"}” will be removed from the project task file.</p>
        <div class="mt-3 flex justify-end gap-2">
          <button class="h-8 rounded-md px-3 text-xs text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" type="button" onclick={() => deleteTaskId = null}>Cancel</button>
          <button class="h-8 rounded-md bg-destructive px-3 text-xs font-medium text-destructive-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" type="button" onclick={confirmDelete} disabled={busy}>Delete</button>
        </div>
      </div>
    </div>
  {/if}
</aside>
