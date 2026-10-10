<script lang="ts">
  import CheckCircle2 from "@lucide/svelte/icons/check-circle-2";
  import CircleX from "@lucide/svelte/icons/circle-x";
  import Circle from "@lucide/svelte/icons/circle";
  import CircleDashed from "@lucide/svelte/icons/circle-dashed";
  import Clock3 from "@lucide/svelte/icons/clock-3";
  import Folder from "@lucide/svelte/icons/folder";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ListTodo from "@lucide/svelte/icons/list-todo";
  import Link2 from "@lucide/svelte/icons/link-2";
  import Paperclip from "@lucide/svelte/icons/paperclip";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import Crown from "@lucide/svelte/icons/crown";
  import BrainCircuit from "@lucide/svelte/icons/brain-circuit";
  import Play from "@lucide/svelte/icons/play";
  import Plus from "@lucide/svelte/icons/plus";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Ellipsis from "@lucide/svelte/icons/ellipsis";
  import Bug from "@lucide/svelte/icons/bug";
  import Sparkles from "@lucide/svelte/icons/sparkles";
  import Wrench from "@lucide/svelte/icons/wrench";
  import Lightbulb from "@lucide/svelte/icons/lightbulb";
  import TaskFieldSelect from "./TaskFieldSelect.svelte";
  import {
    TASK_STATUSES,
    TASK_PRIORITIES,
    filterProjectTasks,
    projectTaskDisplayLabel,
    taskHierarchyHoverRelation,
    taskPriorityLabel,
    taskStatusLabel,
    taskTypeLabel,
    type ProjectTask,
    type ProjectTaskStatus,
    type ProjectTaskPriority,
    type ProjectTaskType,
  } from "../lib/project-tasks";

  type TaskDropPosition = "before" | "after";
  type TaskDropTarget = {
    status: ProjectTaskStatus;
    targetTaskId: string | null;
    position: TaskDropPosition;
  };

  const TASK_GROUPS: readonly { type: ProjectTaskType; label: string; tone: string }[] = [
    { type: "bug", label: "Bug", tone: "text-tool-error/75" },
    { type: "feature", label: "Feature", tone: "text-tool-success/75" },
    { type: "improvement", label: "Improve", tone: "text-tool-info/75" },
    { type: "idea", label: "Idea", tone: "text-tool-warning/75" },
  ];
  const STATUS_GROUP_ORDER: readonly ProjectTaskStatus[] = ["in-progress", "todo", "backlog", "done", "failed"];
  const TYPE_ICONS = { bug: Bug, feature: Sparkles, improvement: Wrench, idea: Lightbulb };
  const typeFilterOptions = [{ value: "all", label: "All types" }, ...TASK_GROUPS.map((item) => ({ value: item.type, label: item.label }))];
  const priorityFilterOptions = [{ value: "all", label: "All priorities" }, ...TASK_PRIORITIES.map((priority) => ({ value: priority, label: taskPriorityLabel(priority) }))];

  let {
    workspace,
    tasks,
    attachmentCounts = {},
    loading,
    storageError,
    busy,
    activeTaskId,
    sessionReady,
    draggedTaskId,
    taskDropTarget,
    draggedTaskHeight,
    revealedTaskId,
    statusMenuTaskId,
    statusMenuSection = "all",
    statusMenu = $bindable(null),
    onPanelPointerDown,
    onReload,
    onTaskDragStart,
    onTaskDragMove,
    onTaskDragFinish,
    onTaskDragCancel,
    onCardDragClickConsumed = () => false,
    onToggleStatusMenu,
    onStatusMenuKeydown,
    onSetTaskStatus,
    onRun,
    onOpenSession,
    onCreate,
    onEdit,
    onDeleteRequest,
    onSetTaskPriority = () => {},
    isStatusCollapsed = (status: ProjectTaskStatus) => status === "done",
    onToggleStatusCollapsed = () => {},
    typeFilter = $bindable<ProjectTaskType | "all">("all"),
    priorityFilter = $bindable<ProjectTaskPriority | "all">("all"),
  }: {
    workspace: string;
    tasks: ProjectTask[];
    attachmentCounts?: Readonly<Record<string, number>>;
    loading: boolean;
    storageError: boolean;
    busy: boolean;
    activeTaskId: string | null;
    sessionReady: boolean;
    draggedTaskId: string | null;
    taskDropTarget: TaskDropTarget | null;
    draggedTaskHeight: number;
    revealedTaskId: string | null;
    statusMenuTaskId: string | null;
    statusMenuSection?: "all" | "priority";
    statusMenu: HTMLDivElement | null;
    onPanelPointerDown: (event: PointerEvent) => void;
    onReload: () => void;
    onTaskDragStart: (event: PointerEvent, taskId: string) => void;
    onTaskDragMove: (event: PointerEvent) => void;
    onTaskDragFinish: (event: PointerEvent) => void;
    onTaskDragCancel: (event: PointerEvent) => void;
    onCardDragClickConsumed?: () => boolean;
    onToggleStatusMenu: (event: MouseEvent, task: ProjectTask, section?: "all" | "priority") => void;
    onStatusMenuKeydown: (event: KeyboardEvent) => void;
    onSetTaskStatus: (taskId: string, status: ProjectTaskStatus) => void;
    onRun: (task: ProjectTask) => void;
    onOpenSession: (task: ProjectTask) => void;
    onCreate: (type: ProjectTaskType, status?: ProjectTaskStatus) => void;
    onEdit: (task: ProjectTask) => void;
    onDeleteRequest: (taskId: string) => void;
    onSetTaskPriority?: (taskId: string, priority: ProjectTaskPriority) => void;
    isStatusCollapsed?: (status: ProjectTaskStatus) => boolean;
    onToggleStatusCollapsed?: (status: ProjectTaskStatus) => void;
    typeFilter?: ProjectTaskType | "all";
    priorityFilter?: ProjectTaskPriority | "all";
  } = $props();

  const visibleTasks = $derived(filterProjectTasks(tasks, {
    type: typeFilter, status: "all", priority: priorityFilter,
  }));
  const groups = STATUS_GROUP_ORDER.map((status) => ({ status,
    label: taskStatusLabel(status) }));
  let hoveredTaskId = $state<string | null>(null);

  function priorityTone(priority: ProjectTaskPriority): string {
    if (priority === "urgent") return "bg-tool-error/15 text-tool-error font-semibold";
    if (priority === "high") return "bg-tool-warning/15 text-tool-warning font-semibold";
    if (priority === "low") return "text-muted-foreground opacity-55";
    return "text-muted-foreground";
  }

  function statusTone(status: ProjectTaskStatus): string {
    if (status === "failed") return "text-tool-error";
    if (status === "done") return "text-tool-success";
    if (status === "in-progress") return "text-tool-warning";
    if (status === "todo") return "text-tool-info";
    return "text-tool-neutral";
  }

  function isDropPlaceholder(status: ProjectTaskStatus, targetTaskId: string | null, position: TaskDropPosition): boolean {
    return taskDropTarget?.status === status
      && taskDropTarget.targetTaskId === targetTaskId
      && taskDropTarget.position === position;
  }

  // Preserve direct card drag without intercepting buttons and menu controls.
  function isInteractiveTarget(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest("button, select, a, input, [role=\"menu\"]") !== null;
  }

  function startCardDrag(event: PointerEvent, taskId: string): void {
    if (isInteractiveTarget(event.target)) return;
    onTaskDragStart(event, taskId);
  }

</script>

<section
  id="workspace-tasks-panel"
  class="min-h-0 select-none overflow-y-auto p-2"
  aria-label="Tasks"
  onpointerdown={onPanelPointerDown}
>
  <div class="min-h-0">
    {#if loading}
      <div class="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground"><RotateCw class="h-4 w-4 animate-spin" aria-hidden="true" />Loading tasks…</div>
    {:else if storageError}
      <div class="px-4 py-8 text-center">
        <ListTodo class="mx-auto mb-2 h-5 w-5 text-tool-error" aria-hidden="true" />
        <p class="text-xs font-medium">Task database needs attention</p>
        <p class="mt-1 text-xs leading-4 text-muted-foreground">Check <code class="font-mono">.pi/tasks.sqlite</code>, then try again. Other tasks were not replaced.</p>
        <button class="mt-3 inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-panel-strong px-2.5 text-xs font-medium hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring" type="button" onclick={onReload}><RotateCw class="h-3 w-3" aria-hidden="true" />Retry</button>
      </div>
    {:else if !workspace}
      <div class="px-4 py-8 text-center"><Folder class="mx-auto mb-2 h-5 w-5 text-muted-foreground" aria-hidden="true" /><p class="text-xs font-medium">Choose a project</p><p class="mt-1 text-xs text-muted-foreground">Tasks are stored inside its .pi folder.</p></div>
    {:else}
      <div class="mb-2.5 flex flex-wrap items-center gap-1 p-1 text-xs" data-task-filters>
        <div class="w-[112px] max-w-full min-w-0">
          <TaskFieldSelect value={typeFilter} options={typeFilterOptions} ariaLabel="Filter tasks by type" compact onChange={(value) => typeFilter = value as ProjectTaskType | "all"} />
        </div>
        <div class="w-[126px] max-w-full min-w-0">
          <TaskFieldSelect value={priorityFilter} options={priorityFilterOptions} ariaLabel="Filter tasks by priority" compact onChange={(value) => priorityFilter = value as ProjectTaskPriority | "all"} />
        </div>
      </div>
      <div class="space-y-3">
        {#each groups as group (group.status)}
          {@const collapsed = isStatusCollapsed(group.status)}
          {@const groupTasks = collapsed ? [] : visibleTasks.filter((task) => task.status === group.status)}
          {@const total = tasks.filter((task) => task.status === group.status).length}
          <section class="space-y-1" aria-label={`${group.label} tasks`} data-task-status-group={group.status}>
            <div class="flex h-6 items-center gap-1.5 px-1 text-xs font-semibold text-muted-foreground">
              <button type="button" class="inline-flex min-w-0 items-center gap-1.5 rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" aria-label={`Toggle ${group.label} tasks`} aria-expanded={!collapsed} aria-controls={`workspace-tasks-${group.status}-list`} onclick={() => onToggleStatusCollapsed(group.status)}>
                <ChevronDown class={["h-3.5 w-3.5 transition-transform motion-reduce:transition-none", collapsed ? "-rotate-90" : "rotate-0"]} aria-hidden="true" />
                <span class={[statusTone(group.status), "opacity-80"]}>{group.label}</span>
                <span class="rounded-full bg-panel-strong px-1.5 py-px font-mono text-xs font-normal tracking-normal text-muted-foreground/80 normal-case" title={`${total} total tasks`}>{total}</span>
              </button>
              <button
                class="ml-auto grid h-6 w-6 shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default"
                type="button"
                title={`Add ${group.label} task`}
                aria-label={`Add ${group.label} task`}
                onclick={() => onCreate(typeFilter === "all" ? "feature" : typeFilter, group.status)}
                disabled={busy}
              ><Plus class="h-3.5 w-3.5" aria-hidden="true" /></button>
            </div>

            <div
              id={`workspace-tasks-${group.status}-list`}
              hidden={collapsed}
              class={[
                "space-y-1.5 rounded-md transition-colors",
                groupTasks.length || draggedTaskId ? "min-h-8" : "",
                draggedTaskId && taskDropTarget?.status === group.status ? "bg-panel-hover/35" : "",
              ]}
              role="list"
            >

              {#each groupTasks as task (task.id)}
                {@const taskLabel = projectTaskDisplayLabel(task)}
                {@const parent = task.parentId ? tasks.find((candidate) => candidate.id === task.parentId) : undefined}
                {@const subtaskCount = tasks.filter((candidate) => candidate.parentId === task.id).length}
                {@const relation = taskHierarchyHoverRelation(task, hoveredTaskId, tasks)}
                {@const linksToTask = tasks.filter((candidate) => candidate.id !== task.id && candidate.relatedTaskIds?.includes(task.id)).length}
                {@const linkCount = (task.links?.length ?? 0) + (task.relatedTaskIds?.length ?? 0) + linksToTask}
                {@const typeGroup = TASK_GROUPS.find((group) => group.type === task.type)!}
                {@const typeLabel = taskTypeLabel(task.type)}
                {@const TypeIcon = TYPE_ICONS[task.type]}
                {#if isDropPlaceholder(group.status, task.id, "before")}
                  <div
                    data-task-drop-placeholder
                    class="grid place-items-center rounded-md border border-dashed border-primary/60 bg-panel-selected text-xs font-medium text-primary"
                    style:min-height={`${draggedTaskHeight}px`}
                    role="presentation"
                  >Move to {group.label}</div>
                {/if}
                <div
                  data-task-card
                  data-task-id={task.id}
                  data-task-parent-id={task.parentId ?? undefined}
                  class={[
                    "group relative touch-none rounded-lg border border-border/60 bg-panel-strong/30 px-2 py-1 shadow-xs transition-[background-color,border-color,opacity,box-shadow] duration-150 hover:border-border hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring",
                    "cursor-pointer active:cursor-grabbing",
                    draggedTaskId === task.id ? "cursor-grabbing border-dashed border-primary/40 bg-primary/5 opacity-25" : "",
                    revealedTaskId === task.id ? "border-primary/50 bg-panel-selected ring-1 ring-primary/30" : "",
                    relation === "parent" ? "border-primary/80 bg-primary/15 ring-1 ring-primary/40" : "",
                    relation === "sibling" ? "opacity-40" : "",
                  ]}
                  role="button"
                  tabindex="0"
                  aria-label={`${taskLabel}. Open task editor. Drag to reorder or change status.`}
                  onpointerdown={(event) => startCardDrag(event, task.id)}
                  onpointermove={onTaskDragMove}
                  onpointerup={onTaskDragFinish}
                  onpointercancel={onTaskDragCancel}
                  onlostpointercapture={onTaskDragCancel}
                  onmouseenter={() => hoveredTaskId = task.id}
                  onmouseleave={() => { if (hoveredTaskId === task.id) hoveredTaskId = null; }}
                  onfocus={(event) => { if (event.target === event.currentTarget) hoveredTaskId = task.id; }}
                  onblur={(event) => { if (event.target === event.currentTarget && hoveredTaskId === task.id) hoveredTaskId = null; }}
                  onclick={(event) => { if (onCardDragClickConsumed() || isInteractiveTarget(event.target)) return; if (!busy) onEdit(task); }}
                  onkeydown={(event) => { if (event.target !== event.currentTarget || busy) return; if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onEdit(task); } }}
                >
                  <div class="flex min-w-0 items-center gap-1.5" data-task-title-row>
                    <span class={["shrink-0", typeGroup.tone]} aria-label={`Type: ${typeLabel}`} title={typeLabel}><TypeIcon class="h-3 w-3" aria-hidden="true" /></span>
                    <h3 class="min-w-0 flex-1 truncate text-xs leading-4 font-medium text-foreground" title={taskLabel}>{taskLabel}</h3>
                    {#if task.epic}<span data-task-epic class="inline-flex shrink-0 items-center gap-0.5 text-tool-warning" aria-label={`Epic with ${subtaskCount} subtasks`} title={`Epic · ${subtaskCount} subtasks`}><Crown class="h-3 w-3" aria-hidden="true" />{#if subtaskCount}<span class="font-mono text-xs">{subtaskCount}</span>{/if}</span>{/if}
                    {#if parent}<span data-task-subtask class="shrink-0 text-primary/80" aria-label={`Subtask of ${projectTaskDisplayLabel(parent)}`} title={`Subtask of ${projectTaskDisplayLabel(parent)}`}><GitBranch class="h-3.5 w-3.5" aria-hidden="true" /></span>{/if}
                    {#if attachmentCounts[task.id]}<span data-task-attachments class="inline-flex shrink-0 items-center gap-0.5 text-muted-foreground" aria-label={`${attachmentCounts[task.id]} attachments`} title={`${attachmentCounts[task.id]} attachments`}><Paperclip class="h-3 w-3" aria-hidden="true" />{#if attachmentCounts[task.id]! > 1}<span class="font-mono text-xs">{attachmentCounts[task.id]}</span>{/if}</span>{/if}
                    {#if linkCount}<span data-task-links class="inline-flex shrink-0 items-center gap-0.5 text-muted-foreground" aria-label={`${linkCount} links`} title={[...(task.links ?? []), ...(task.relatedTaskIds ?? []), ...(linksToTask ? ["Linked from other tasks"] : [])].join("\n")}><Link2 class="h-3 w-3" aria-hidden="true" />{#if linkCount > 1}<span class="font-mono text-xs">{linkCount}</span>{/if}</span>{/if}
                    {#if task.modelRef}<span data-task-model class="shrink-0 text-muted-foreground" aria-label={`Assigned model: ${task.modelRef}`} title={`Model: ${task.modelRef}`}><BrainCircuit class="h-3 w-3" aria-hidden="true" /></span>{/if}
                    {#if task.priority !== "medium"}
                      <button
                        type="button"
                        class={["shrink-0 rounded px-1.5 py-0.5 text-xs focus-visible:outline-2 focus-visible:outline-ring", priorityTone(task.priority)]}
                        data-task-priority-badge
                        title={`Priority: ${taskPriorityLabel(task.priority)}`}
                        aria-label={`Priority for ${taskLabel}`}
                        aria-haspopup="menu"
                        aria-expanded={statusMenuTaskId === task.id && statusMenuSection === "priority"}
                        disabled={busy}
                        onclick={(event) => onToggleStatusMenu(event, task, "priority")}
                      >{taskPriorityLabel(task.priority)}</button>
                    {/if}
                    <div data-task-actions class={["ml-auto flex shrink-0 items-center gap-0.5 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none", revealedTaskId === task.id || statusMenuTaskId === task.id ? "opacity-100" : "opacity-0"]}>
                      <button
                        class={[
                          "grid h-6 w-6 place-items-center rounded-md hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring",
                          !sessionReady ? "opacity-35" : "",
                          activeTaskId === task.id || task.sessionId ? "text-primary" : "text-muted-foreground hover:text-primary",
                        ]}
                        type="button"
                        title={task.sessionId ? "Open session" : "Run task"}
                        aria-label={`${task.sessionId ? "Open session for" : "Run"} ${taskLabel}`}
                        onclick={() => task.sessionId ? onOpenSession(task) : onRun(task)}
                        disabled={!sessionReady || busy}
                      >
                        {#if activeTaskId === task.id}<RotateCw class="h-3 w-3 animate-spin" aria-hidden="true" />
                        {:else if task.sessionId}<Folder class="h-3 w-3" aria-hidden="true" />
                        {:else}<Play class="h-3 w-3" aria-hidden="true" />{/if}
                      </button>
                      <div class="relative" data-task-status-control>
                        <button
                          class="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                          type="button"
                          title={`Status: ${taskStatusLabel(task.status)}`}
                          aria-label={`Change status for ${taskLabel}. Current status: ${taskStatusLabel(task.status)}`}
                          aria-haspopup="menu"
                          aria-expanded={statusMenuTaskId === task.id && statusMenuSection === "all"}
                          onclick={(event) => onToggleStatusMenu(event, task)}
                          disabled={busy}
                        ><Ellipsis class="h-3.5 w-3.5" aria-hidden="true" /></button>
                        {#if statusMenuTaskId === task.id}
                          <div
                            bind:this={statusMenu}
                            class="absolute top-7 right-0 z-40 w-40 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
                            role="menu"
                            tabindex="-1"
                            aria-label={`${statusMenuSection === "priority" ? "Priority" : "Actions"} for ${taskLabel}`}
                            onkeydown={onStatusMenuKeydown}
                          >
                            {#if statusMenuSection === "all"}
                              <div role="group" aria-label="Status">
                                <p class="px-2 py-1 text-xs font-semibold text-muted-foreground">Status</p>
                                {#each TASK_STATUSES as status}
                                  <button
                                    class={["flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left text-xs leading-none whitespace-nowrap hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring", status === task.status ? "bg-accent text-foreground" : "text-muted-foreground"]}
                                    type="button"
                                    role="menuitemradio"
                                    tabindex="-1"
                                    aria-checked={status === task.status}
                                    onclick={() => onSetTaskStatus(task.id, status)}
                                  >
                                    <span class={["grid h-4 w-4 shrink-0 place-items-center", statusTone(status)]}>
                                      {#if status === "done"}<CheckCircle2 class="h-3 w-3" aria-hidden="true" />
                                      {:else if status === "failed"}<CircleX class="h-3 w-3" aria-hidden="true" />
                                      {:else if status === "in-progress"}<Clock3 class="h-3 w-3" aria-hidden="true" />
                                      {:else if status === "backlog"}<CircleDashed class="h-3 w-3" aria-hidden="true" />
                                      {:else}<Circle class="h-3 w-3" aria-hidden="true" />{/if}
                                    </span>
                                    <span class="truncate">{taskStatusLabel(status)}</span>
                                  </button>
                                {/each}
                              </div>
                            {/if}
                            <div role="group" aria-label="Priority">
                              <p class="px-2 py-1 text-xs font-semibold text-muted-foreground">Priority</p>
                              {#each TASK_PRIORITIES as priority}
                                <button
                                  class={["flex h-7 w-full items-center rounded-sm px-2 text-left text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring", priorityTone(priority), priority === task.priority ? "bg-accent" : ""]}
                                  type="button"
                                  role="menuitemradio"
                                  tabindex="-1"
                                  aria-checked={priority === task.priority}
                                  onclick={() => onSetTaskPriority(task.id, priority)}
                                >{taskPriorityLabel(priority)}</button>
                              {/each}
                            </div>
                            {#if statusMenuSection === "all"}
                              <button class="flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left text-xs text-tool-error hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" type="button" role="menuitem" tabindex="-1" title="Delete task" aria-label={`Delete ${taskLabel}`} onclick={() => onDeleteRequest(task.id)}><Trash2 class="h-3 w-3" aria-hidden="true" />Delete task</button>
                            {/if}
                          </div>
                        {/if}
                      </div>
                    </div>
                  </div>
                </div>

                {#if isDropPlaceholder(group.status, task.id, "after")}
                  <div
                    data-task-drop-placeholder
                    class="grid place-items-center border border-dashed border-primary/60 bg-panel-selected text-xs font-medium text-primary"
                    style:min-height={`${draggedTaskHeight}px`}
                    role="presentation"
                  >Move to {group.label}</div>
                {/if}
              {/each}
              {#if !collapsed && isDropPlaceholder(group.status, null, "after")}
                <div
                  data-task-drop-placeholder
                  class="grid place-items-center border border-dashed border-primary/60 bg-panel-selected text-xs font-medium text-primary"
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
