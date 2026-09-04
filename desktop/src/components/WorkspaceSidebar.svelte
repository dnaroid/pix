<script lang="ts">
  import Activity from "@lucide/svelte/icons/activity";
  import Bug from "@lucide/svelte/icons/bug";
  import CheckCircle2 from "@lucide/svelte/icons/check-circle-2";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Circle from "@lucide/svelte/icons/circle";
  import CircleDashed from "@lucide/svelte/icons/circle-dashed";
  import Clock3 from "@lucide/svelte/icons/clock-3";
  import Folder from "@lucide/svelte/icons/folder";
  import Gauge from "@lucide/svelte/icons/gauge";
  import ListTodo from "@lucide/svelte/icons/list-todo";
  import PanelLeftClose from "@lucide/svelte/icons/panel-left-close";
  import PanelLeftOpen from "@lucide/svelte/icons/panel-left-open";
  import Pencil from "@lucide/svelte/icons/pencil";
  import Play from "@lucide/svelte/icons/play";
  import Plus from "@lucide/svelte/icons/plus";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import Sparkles from "@lucide/svelte/icons/sparkles";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Wrench from "@lucide/svelte/icons/wrench";
  import X from "@lucide/svelte/icons/x";
  import { onMount, tick } from "svelte";
  import {
    filterProjectTasks,
    TASK_PRIORITIES,
    TASK_STATUSES,
    TASK_TYPES,
    taskPriorityLabel,
    taskStatusLabel,
    taskTypeLabel,
    type ProjectTask,
    type ProjectTaskFilters,
    type ProjectTaskPriority,
    type ProjectTaskStatus,
    type ProjectTaskType,
  } from "../lib/project-tasks";
  import { projectName } from "../lib/recent-projects";
  import { sessionTodoCounts, type SessionTodoSnapshot } from "../lib/session-todos";
  import SessionActivityPanel from "./SessionActivityPanel.svelte";

  type TaskDraft = {
    title: string;
    description?: string;
    type: ProjectTaskType;
    status: ProjectTaskStatus;
    priority: ProjectTaskPriority;
  };

  type SidebarTab = "tasks" | "project" | "session";

  const SIDEBAR_TABS: readonly SidebarTab[] = ["tasks", "project", "session"];

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
    onCreate,
    onUpdate,
    onDelete,
    onRun,
    onOpenSession,
    onReload,
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
    onCreate: (draft: TaskDraft) => void;
    onUpdate: (taskId: string, draft: TaskDraft) => void;
    onDelete: (taskId: string) => void;
    onRun: (task: ProjectTask) => void;
    onOpenSession: (task: ProjectTask) => void;
    onReload: () => void;
  } = $props();

  const COLLAPSED_WIDTH = 48;
  const DEFAULT_WIDTH = 296;
  const MIN_WIDTH = 236;
  const MAX_WIDTH = 420;
  const WIDTH_KEY = "pix.desktop.taskSidebarWidth";
  const COLLAPSED_KEY = "pix.desktop.taskSidebarCollapsed";

  let collapsed = $state(false);
  let sidebarWidth = $state(DEFAULT_WIDTH);
  let activeTab = $state<SidebarTab>("tasks");
  let filters = $state<ProjectTaskFilters>({ type: "all", status: "all", priority: "all" });
  let editorOpen = $state(false);
  let editingTaskId = $state<string | null>(null);
  let deleteTaskId = $state<string | null>(null);
  let title = $state("");
  let description = $state("");
  let taskType = $state<ProjectTaskType>("feature");
  let taskStatus = $state<ProjectTaskStatus>("todo");
  let taskPriority = $state<ProjectTaskPriority>("medium");
  let resizePointerId = $state<number | null>(null);
  let resizeStartX = 0;
  let resizeStartWidth = 0;
  let titleInput = $state<HTMLInputElement | null>(null);

  const visibleTasks = $derived(filterProjectTasks(tasks, filters));
  const busy = $derived(loading || saving || storageError || activeTaskId !== null);
  const doneCount = $derived(tasks.filter((task) => task.status === "done").length);
  const todoCounts = $derived(sessionTodoCounts(todoSnapshot));
  const openTodoCount = $derived(todoCounts.pending + todoCounts.in_progress + todoCounts.deferred);

  onMount(() => {
    try {
      collapsed = localStorage.getItem(COLLAPSED_KEY) === "true";
      const savedWidth = localStorage.getItem(WIDTH_KEY);
      if (savedWidth !== null) {
        const parsedWidth = Number(savedWidth);
        if (Number.isFinite(parsedWidth)) sidebarWidth = clampWidth(parsedWidth);
      }
    } catch {
      // Keep the defaults when webview storage is unavailable.
    }
  });

  function setCollapsed(next: boolean): void {
    collapsed = next;
    try {
      localStorage.setItem(COLLAPSED_KEY, String(next));
    } catch {
      // Persistence is a convenience, not a requirement for sidebar use.
    }
  }

  function selectTab(tab: SidebarTab): void {
    activeTab = tab;
    if (collapsed) setCollapsed(false);
  }

  function navigateTabs(event: KeyboardEvent, tab: SidebarTab): void {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const currentIndex = SIDEBAR_TABS.indexOf(tab);
    let nextIndex: number;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % SIDEBAR_TABS.length;
    else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + SIDEBAR_TABS.length) % SIDEBAR_TABS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = SIDEBAR_TABS.length - 1;
    else return;

    event.preventDefault();
    const nextTab = SIDEBAR_TABS[nextIndex];
    const currentTarget = event.currentTarget as HTMLButtonElement;
    if (!nextTab) return;
    activeTab = nextTab;
    const tabButtons = currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabButtons?.[nextIndex]?.focus();
  }

  function startResize(event: PointerEvent): void {
    if (collapsed || event.button !== 0) return;
    resizePointerId = event.pointerId;
    resizeStartX = event.clientX;
    resizeStartWidth = sidebarWidth;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function resize(event: PointerEvent): void {
    if (event.pointerId !== resizePointerId) return;
    sidebarWidth = clampWidth(resizeStartWidth + event.clientX - resizeStartX);
  }

  function finishResize(event: PointerEvent): void {
    if (event.pointerId !== resizePointerId) return;
    resizePointerId = null;
    try {
      localStorage.setItem(WIDTH_KEY, String(sidebarWidth));
    } catch {
      // Keep the in-memory width when persistence is unavailable.
    }
  }

  function resizeWithKeyboard(event: KeyboardEvent): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home") return;
    event.preventDefault();
    sidebarWidth = event.key === "Home"
      ? DEFAULT_WIDTH
      : clampWidth(sidebarWidth + (event.key === "ArrowLeft" ? -12 : 12));
    try {
      localStorage.setItem(WIDTH_KEY, String(sidebarWidth));
    } catch {
      // Keep the in-memory width when persistence is unavailable.
    }
  }

  function clampWidth(width: number): number {
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width));
  }

  function openCreate(): void {
    editingTaskId = null;
    title = "";
    description = "";
    taskType = "feature";
    taskStatus = "todo";
    taskPriority = "medium";
    editorOpen = true;
    void focusEditorTitle();
  }

  function openEdit(task: ProjectTask): void {
    editingTaskId = task.id;
    title = task.title;
    description = task.description ?? "";
    taskType = task.type;
    taskStatus = task.status;
    taskPriority = task.priority;
    editorOpen = true;
    void focusEditorTitle();
  }

  async function focusEditorTitle(): Promise<void> {
    await tick();
    titleInput?.focus();
  }

  function submitEditor(event: SubmitEvent): void {
    event.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle || busy) return;
    const draft: TaskDraft = {
      title: trimmedTitle,
      ...(description.trim() ? { description: description.trim() } : {}),
      type: taskType,
      status: taskStatus,
      priority: taskPriority,
    };
    if (editingTaskId) onUpdate(editingTaskId, draft);
    else onCreate(draft);
    editorOpen = false;
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

  function priorityTone(priority: ProjectTaskPriority): string {
    if (priority === "urgent") return "text-[var(--tool-error)]";
    if (priority === "high") return "text-[var(--tool-warning)]";
    if (priority === "medium") return "text-[var(--tool-info)]";
    return "text-[var(--tool-muted)]";
  }

</script>

<aside
  class="relative flex min-h-0 shrink-0 border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
  class:select-none={resizePointerId !== null}
  style:width={`${collapsed ? COLLAPSED_WIDTH : sidebarWidth}px`}
  aria-label="Workspace sidebar"
>
  {#if collapsed}
    <div class="flex h-full w-full flex-col items-center gap-1 py-2">
      <button
        class="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        type="button"
        title="Expand sidebar"
        aria-label="Expand workspace sidebar"
        onclick={() => setCollapsed(false)}
      ><PanelLeftOpen class="h-4 w-4" aria-hidden="true" /></button>
      <div class="my-1 h-px w-6 bg-sidebar-border"></div>
      <button
        class={["relative grid h-8 w-8 place-items-center rounded-lg hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring", activeTab === "tasks" ? "bg-sidebar-accent text-foreground" : "text-muted-foreground"]}
        type="button"
        title="Tasks"
        aria-label={`Tasks, ${tasks.length} total`}
        onclick={() => selectTab("tasks")}
      >
        <ListTodo class="h-4 w-4" aria-hidden="true" />
        {#if tasks.length > 0}<span class="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true"></span>{/if}
      </button>
      <button
        class={["grid h-8 w-8 place-items-center rounded-lg hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring", activeTab === "project" ? "bg-sidebar-accent text-foreground" : "text-muted-foreground"]}
        type="button"
        title="Project"
        aria-label="Project overview"
        onclick={() => selectTab("project")}
      ><Folder class="h-4 w-4" aria-hidden="true" /></button>
      <button
        class={["relative grid h-8 w-8 place-items-center rounded-lg hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring", activeTab === "session" ? "bg-sidebar-accent text-foreground" : "text-muted-foreground"]}
        type="button"
        title="Session"
        aria-label={`Session todos, ${openTodoCount} open`}
        onclick={() => selectTab("session")}
      >
        <Activity class="h-4 w-4" aria-hidden="true" />
        {#if openTodoCount > 0}<span class="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-[var(--tool-warning)]" aria-hidden="true"></span>{/if}
      </button>
    </div>
  {:else}
    <div class="grid min-w-0 flex-1 grid-rows-[40px_auto_minmax(0,1fr)]">
      <div class="flex items-center justify-between border-b border-sidebar-border px-2.5">
        <strong class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs font-semibold">Workspace</strong>
        <button
          class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          type="button"
          title="Collapse sidebar"
          aria-label="Collapse workspace sidebar"
          onclick={() => setCollapsed(true)}
        ><PanelLeftClose class="h-4 w-4" aria-hidden="true" /></button>
      </div>

      <div class="grid grid-cols-3 gap-1 border-b border-sidebar-border p-1.5" role="tablist" aria-label="Workspace sections">
        <button
          id="workspace-tasks-tab"
          class={["flex h-7 items-center justify-center gap-1.5 rounded-md text-[11px] font-medium hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring", activeTab === "tasks" ? "bg-sidebar-accent text-foreground" : "text-muted-foreground"]}
          type="button"
          role="tab"
          aria-selected={activeTab === "tasks"}
          aria-controls="workspace-tasks-panel"
          tabindex={activeTab === "tasks" ? 0 : -1}
          onclick={() => activeTab = "tasks"}
          onkeydown={(event) => navigateTabs(event, "tasks")}
        ><ListTodo class="h-3.5 w-3.5" aria-hidden="true" />Tasks <span class="text-[10px] opacity-70">{tasks.length}</span></button>
        <button
          id="workspace-project-tab"
          class={["flex h-7 items-center justify-center gap-1.5 rounded-md text-[11px] font-medium hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring", activeTab === "project" ? "bg-sidebar-accent text-foreground" : "text-muted-foreground"]}
          type="button"
          role="tab"
          aria-selected={activeTab === "project"}
          aria-controls="workspace-project-panel"
          tabindex={activeTab === "project" ? 0 : -1}
          onclick={() => activeTab = "project"}
          onkeydown={(event) => navigateTabs(event, "project")}
        ><Folder class="h-3.5 w-3.5" aria-hidden="true" />Project</button>
        <button
          id="workspace-session-tab"
          class={["flex h-7 items-center justify-center gap-1.5 rounded-md text-[11px] font-medium hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring", activeTab === "session" ? "bg-sidebar-accent text-foreground" : "text-muted-foreground"]}
          type="button"
          role="tab"
          aria-selected={activeTab === "session"}
          aria-controls="workspace-session-panel"
          tabindex={activeTab === "session" ? 0 : -1}
          onclick={() => activeTab = "session"}
          onkeydown={(event) => navigateTabs(event, "session")}
        ><Activity class="h-3.5 w-3.5" aria-hidden="true" />Session</button>
      </div>

      {#if activeTab === "tasks"}
        <section id="workspace-tasks-panel" class="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]" role="tabpanel" aria-labelledby="workspace-tasks-tab" tabindex="0">
          <div class="space-y-2 border-b border-sidebar-border p-2.5">
            <div class="flex items-center justify-between gap-2">
              <span class="text-[10px] text-muted-foreground">{visibleTasks.length} shown · {doneCount} done</span>
              <button
                class="flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 text-[11px] font-medium text-primary-foreground transition hover:brightness-110 active:brightness-95 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
                type="button"
                onclick={openCreate}
                disabled={!workspace || busy}
              ><Plus class="h-3.5 w-3.5" aria-hidden="true" />Add task</button>
            </div>
            <div class="grid grid-cols-3 gap-1">
              <label class="sr-only" for="task-filter-status">Filter by status</label>
              <div class="relative min-w-0">
                <select id="task-filter-status" class="h-7 w-full min-w-0 appearance-none rounded-md border border-input bg-background py-0 pr-6 pl-2 text-[10px] text-foreground shadow-none hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" value={filters.status} onchange={(event) => filters = { ...filters, status: event.currentTarget.value as ProjectTaskFilters["status"] }}>
                  <option value="all">All status</option>
                  {#each TASK_STATUSES as status}<option value={status}>{taskStatusLabel(status)}</option>{/each}
                </select>
                <ChevronDown class="pointer-events-none absolute top-1/2 right-1.5 h-3 w-3 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              </div>
              <label class="sr-only" for="task-filter-type">Filter by type</label>
              <div class="relative min-w-0">
                <select id="task-filter-type" class="h-7 w-full min-w-0 appearance-none rounded-md border border-input bg-background py-0 pr-6 pl-2 text-[10px] text-foreground shadow-none hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" value={filters.type} onchange={(event) => filters = { ...filters, type: event.currentTarget.value as ProjectTaskFilters["type"] }}>
                  <option value="all">All types</option>
                  {#each TASK_TYPES as type}<option value={type}>{taskTypeLabel(type)}</option>{/each}
                </select>
                <ChevronDown class="pointer-events-none absolute top-1/2 right-1.5 h-3 w-3 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              </div>
              <label class="sr-only" for="task-filter-priority">Filter by priority</label>
              <div class="relative min-w-0">
                <select id="task-filter-priority" class="h-7 w-full min-w-0 appearance-none rounded-md border border-input bg-background py-0 pr-6 pl-2 text-[10px] text-foreground shadow-none hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" value={filters.priority} onchange={(event) => filters = { ...filters, priority: event.currentTarget.value as ProjectTaskFilters["priority"] }}>
                  <option value="all">All priority</option>
                  {#each TASK_PRIORITIES as priority}<option value={priority}>{taskPriorityLabel(priority)}</option>{/each}
                </select>
                <ChevronDown class="pointer-events-none absolute top-1/2 right-1.5 h-3 w-3 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              </div>
            </div>
          </div>

          <div class="min-h-0 overflow-y-auto p-2">
            {#if loading}
              <div class="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground"><RotateCw class="h-4 w-4 animate-spin" aria-hidden="true" />Loading tasks…</div>
            {:else if storageError}
              <div class="px-4 py-8 text-center">
                <ListTodo class="mx-auto mb-2 h-5 w-5 text-[var(--tool-error)]" aria-hidden="true" />
                <p class="text-xs font-medium">Task file needs attention</p>
                <p class="mt-1 text-[10px] leading-4 text-muted-foreground">Fix <code class="font-mono">.pi/tasks.json</code>, then try again. Its contents were not replaced.</p>
                <button class="mt-3 inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[10px] font-medium hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" type="button" onclick={onReload}><RotateCw class="h-3 w-3" aria-hidden="true" />Retry</button>
              </div>
            {:else if !workspace}
              <div class="px-4 py-8 text-center"><Folder class="mx-auto mb-2 h-5 w-5 text-muted-foreground" aria-hidden="true" /><p class="text-xs font-medium">Choose a project</p><p class="mt-1 text-[10px] text-muted-foreground">Tasks are stored inside its .pi folder.</p></div>
            {:else if visibleTasks.length === 0}
              <div class="px-4 py-8 text-center"><ListTodo class="mx-auto mb-2 h-5 w-5 text-muted-foreground" aria-hidden="true" /><p class="text-xs font-medium">{tasks.length ? "No matching tasks" : "No tasks yet"}</p><p class="mt-1 text-[10px] text-muted-foreground">{tasks.length ? "Adjust the filters above." : "Add the first project task."}</p></div>
            {:else}
              <div class="space-y-1.5">
                {#each visibleTasks as task (task.id)}
                  <article class="group rounded-lg border border-sidebar-border bg-background/55 p-2.5 shadow-xs transition-colors hover:border-border" aria-label={task.title}>
                    <div class="flex items-start gap-2">
                      <div class={['mt-0.5 shrink-0', statusTone(task.status)]} title={taskStatusLabel(task.status)}>
                        {#if task.status === "done"}<CheckCircle2 class="h-4 w-4" aria-hidden="true" />
                        {:else if task.status === "in-progress"}<Clock3 class="h-4 w-4" aria-hidden="true" />
                        {:else if task.status === "backlog"}<CircleDashed class="h-4 w-4" aria-hidden="true" />
                        {:else}<Circle class="h-4 w-4" aria-hidden="true" />{/if}
                      </div>
                      <div class="min-w-0 flex-1">
                        <h3 class="break-words text-xs font-medium leading-4 text-foreground">{task.title}</h3>
                        {#if task.description}<p class="mt-1 line-clamp-2 break-words text-[10px] leading-3.5 text-muted-foreground">{task.description}</p>{/if}
                      </div>
                      <div class="flex shrink-0 items-center opacity-60 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                        <button class="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" type="button" title="Edit task" aria-label={`Edit ${task.title}`} onclick={() => openEdit(task)} disabled={busy}><Pencil class="h-3 w-3" aria-hidden="true" /></button>
                        <button class="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-[var(--tool-error)] focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" type="button" title="Delete task" aria-label={`Delete ${task.title}`} onclick={() => deleteTaskId = task.id} disabled={busy}><Trash2 class="h-3 w-3" aria-hidden="true" /></button>
                      </div>
                    </div>
                    <div class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[9px] font-medium">
                      <span class={["inline-flex items-center gap-1", statusTone(task.status)]}>
                        {#if task.status === "done"}<CheckCircle2 class="h-3 w-3" aria-hidden="true" />
                        {:else if task.status === "in-progress"}<Clock3 class="h-3 w-3" aria-hidden="true" />
                        {:else if task.status === "backlog"}<CircleDashed class="h-3 w-3" aria-hidden="true" />
                        {:else}<Circle class="h-3 w-3" aria-hidden="true" />{/if}
                        {taskStatusLabel(task.status)}
                      </span>
                      <span class="inline-flex items-center gap-1 text-muted-foreground">
                        {#if task.type === "bug"}<Bug class="h-3 w-3" aria-hidden="true" />{:else if task.type === "feature"}<Sparkles class="h-3 w-3" aria-hidden="true" />{:else}<Wrench class="h-3 w-3" aria-hidden="true" />{/if}
                        {taskTypeLabel(task.type)}
                      </span>
                      <span class={["inline-flex items-center gap-1", priorityTone(task.priority)]}><Gauge class="h-3 w-3" aria-hidden="true" />{taskPriorityLabel(task.priority)}</span>
                    </div>
                    <button
                      class="mt-2 flex h-7 w-full items-center justify-center gap-1.5 rounded-md border border-border bg-card text-[10px] font-medium text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
                      type="button"
                      onclick={() => task.sessionId ? onOpenSession(task) : onRun(task)}
                      disabled={!sessionReady || busy}
                    >
                      {#if activeTaskId === task.id}<RotateCw class="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      {:else if task.sessionId}<Folder class="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                      {:else}<Play class="h-3.5 w-3.5 text-primary" aria-hidden="true" />{/if}
                      {task.sessionId ? "Open session" : "Run task"}
                    </button>
                  </article>
                {/each}
              </div>
            {/if}
          </div>
        </section>
      {:else if activeTab === "project"}
        <section id="workspace-project-panel" class="min-h-0 overflow-y-auto p-3" role="tabpanel" aria-labelledby="workspace-project-tab" tabindex="0">
          <div class="rounded-xl border border-sidebar-border bg-background/55 p-3 shadow-xs">
            <Folder class="mb-3 h-5 w-5 text-primary" aria-hidden="true" />
            <h2 class="break-words text-sm font-semibold text-foreground">{workspace ? projectName(workspace) : "No project selected"}</h2>
            {#if workspace}<p class="mt-1 break-all font-mono text-[9px] leading-3.5 text-muted-foreground">{workspace}</p>{/if}
          </div>
          <dl class="mt-3 grid grid-cols-2 gap-2 text-center">
            <div class="rounded-lg border border-sidebar-border bg-background/55 p-2"><dt class="text-[9px] text-muted-foreground">Tasks</dt><dd class="mt-0.5 text-sm font-semibold text-foreground">{tasks.length}</dd></div>
            <div class="rounded-lg border border-sidebar-border bg-background/55 p-2"><dt class="text-[9px] text-muted-foreground">Done</dt><dd class="mt-0.5 text-sm font-semibold text-[var(--tool-success)]">{doneCount}</dd></div>
          </dl>
          <p class="mt-3 text-[10px] leading-4 text-muted-foreground">Project tasks are shared through <code class="rounded bg-muted px-1 py-0.5 font-mono">.pi/tasks.json</code>.</p>
        </section>
      {:else}
        <div id="workspace-session-panel" class="grid min-h-0" role="tabpanel" aria-labelledby="workspace-session-tab" tabindex="0">
          <SessionActivityPanel {activeSessionId} {todoSnapshot} />
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
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={MAX_WIDTH}
      aria-valuenow={sidebarWidth}
      tabindex="0"
      onpointerdown={startResize}
      onpointermove={resize}
      onpointerup={finishResize}
      onpointercancel={finishResize}
      onkeydown={resizeWithKeyboard}
      ondblclick={() => sidebarWidth = DEFAULT_WIDTH}
    ></div>
  {/if}

  {#if editorOpen && !collapsed}
    <div class="absolute inset-0 z-20 grid min-h-0 grid-rows-[40px_minmax(0,1fr)] bg-sidebar" role="dialog" aria-modal="true" aria-label={editingTaskId ? "Edit task" : "Add task"}>
      <div class="flex items-center justify-between border-b border-sidebar-border px-3">
        <strong class="text-xs font-semibold">{editingTaskId ? "Edit task" : "Add task"}</strong>
        <button class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" type="button" aria-label="Close task editor" onclick={() => editorOpen = false}><X class="h-4 w-4" aria-hidden="true" /></button>
      </div>
      <form class="min-h-0 space-y-3 overflow-y-auto p-3" onsubmit={submitEditor}>
        <label class="block text-[10px] font-medium text-muted-foreground">Title<input class="mt-1 h-8 w-full rounded-md border border-input bg-background px-2.5 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-ring" bind:this={titleInput} bind:value={title} maxlength="200" required /></label>
        <label class="block text-[10px] font-medium text-muted-foreground">Description<textarea class="mt-1 min-h-20 w-full resize-y rounded-md border border-input bg-background px-2.5 py-2 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-ring" bind:value={description} maxlength="10000" rows="4"></textarea></label>
        <div class="grid grid-cols-2 gap-2">
          <label class="block text-[10px] font-medium text-muted-foreground">Type<span class="relative mt-1 block"><select class="h-8 w-full appearance-none rounded-md border border-input bg-background py-0 pr-7 pl-2 text-xs text-foreground shadow-none hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" bind:value={taskType}>{#each TASK_TYPES as type}<option value={type}>{taskTypeLabel(type)}</option>{/each}</select><ChevronDown class="pointer-events-none absolute top-1/2 right-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" /></span></label>
          <label class="block text-[10px] font-medium text-muted-foreground">Priority<span class="relative mt-1 block"><select class="h-8 w-full appearance-none rounded-md border border-input bg-background py-0 pr-7 pl-2 text-xs text-foreground shadow-none hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" bind:value={taskPriority}>{#each TASK_PRIORITIES as priority}<option value={priority}>{taskPriorityLabel(priority)}</option>{/each}</select><ChevronDown class="pointer-events-none absolute top-1/2 right-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" /></span></label>
        </div>
        <label class="block text-[10px] font-medium text-muted-foreground">Status<span class="relative mt-1 block"><select class="h-8 w-full appearance-none rounded-md border border-input bg-background py-0 pr-7 pl-2 text-xs text-foreground shadow-none hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" bind:value={taskStatus}>{#each TASK_STATUSES as status}<option value={status}>{taskStatusLabel(status)}</option>{/each}</select><ChevronDown class="pointer-events-none absolute top-1/2 right-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" /></span></label>
        <div class="flex justify-end gap-2 pt-1">
          <button class="h-8 rounded-md px-3 text-xs text-muted-foreground hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring" type="button" onclick={() => editorOpen = false}>Cancel</button>
          <button class="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" type="submit" disabled={!title.trim() || busy}>{editingTaskId ? "Save" : "Add task"}</button>
        </div>
      </form>
    </div>
  {/if}

  {#if deleteTaskId && !collapsed}
    {@const deleteTask = tasks.find((task) => task.id === deleteTaskId)}
    <div class="absolute inset-0 z-30 grid place-items-center bg-[var(--overlay)] p-4" role="dialog" aria-modal="true" aria-label="Delete task">
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
