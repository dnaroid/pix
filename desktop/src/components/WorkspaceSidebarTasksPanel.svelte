<script lang="ts">
  import CheckCircle2 from "@lucide/svelte/icons/check-circle-2";
  import Circle from "@lucide/svelte/icons/circle";
  import CircleDashed from "@lucide/svelte/icons/circle-dashed";
  import Clock3 from "@lucide/svelte/icons/clock-3";
  import Folder from "@lucide/svelte/icons/folder";
  import GripVertical from "@lucide/svelte/icons/grip-vertical";
  import ListTodo from "@lucide/svelte/icons/list-todo";
  import Pencil from "@lucide/svelte/icons/pencil";
  import Play from "@lucide/svelte/icons/play";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import {
    TASK_STATUSES,
    projectTaskDisplayLabel,
    taskStatusLabel,
    type ProjectTask,
    type ProjectTaskStatus,
    type ProjectTaskType,
  } from "../lib/project-tasks";

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

  let {
    workspace,
    tasks,
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
    statusMenu = $bindable(null),
    onPanelPointerDown,
    onReload,
    onTaskDragStart,
    onTaskDragMove,
    onTaskDragFinish,
    onTaskDragCancel,
    onToggleStatusMenu,
    onStatusMenuKeydown,
    onSetTaskStatus,
    onRun,
    onOpenSession,
    onEdit,
    onDeleteRequest,
  }: {
    workspace: string;
    tasks: ProjectTask[];
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
    statusMenu: HTMLDivElement | null;
    onPanelPointerDown: (event: PointerEvent) => void;
    onReload: () => void;
    onTaskDragStart: (event: PointerEvent, taskId: string) => void;
    onTaskDragMove: (event: PointerEvent) => void;
    onTaskDragFinish: (event: PointerEvent) => void;
    onTaskDragCancel: (event: PointerEvent) => void;
    onToggleStatusMenu: (event: MouseEvent, task: ProjectTask) => void;
    onStatusMenuKeydown: (event: KeyboardEvent) => void;
    onSetTaskStatus: (taskId: string, status: ProjectTaskStatus) => void;
    onRun: (task: ProjectTask) => void;
    onOpenSession: (task: ProjectTask) => void;
    onEdit: (task: ProjectTask) => void;
    onDeleteRequest: (taskId: string) => void;
  } = $props();

  function statusTone(status: ProjectTaskStatus): string {
    if (status === "done") return "text-tool-success";
    if (status === "in-progress") return "text-tool-warning";
    return "text-tool-muted";
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

<section
  id="workspace-tasks-panel"
  class="min-h-0 select-none overflow-y-auto p-1.5"
  aria-label="Tasks"
  onpointerdown={onPanelPointerDown}
>
  <div class="min-h-0">
    {#if loading}
      <div class="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground"><RotateCw class="h-4 w-4 animate-spin" aria-hidden="true" />Loading tasks…</div>
    {:else if storageError}
      <div class="px-4 py-8 text-center">
        <ListTodo class="mx-auto mb-2 h-5 w-5 text-tool-error" aria-hidden="true" />
        <p class="text-xs font-medium">Task file needs attention</p>
        <p class="mt-1 text-xs leading-4 text-muted-foreground">Fix <code class="font-mono">.pi/tasks.jsonc</code>, then try again. Its contents were not replaced.</p>
        <button class="mt-3 inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-panel-strong px-2.5 text-xs font-medium hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring" type="button" onclick={onReload}><RotateCw class="h-3 w-3" aria-hidden="true" />Retry</button>
      </div>
    {:else if !workspace}
      <div class="px-4 py-8 text-center"><Folder class="mx-auto mb-2 h-5 w-5 text-muted-foreground" aria-hidden="true" /><p class="text-xs font-medium">Choose a project</p><p class="mt-1 text-xs text-muted-foreground">Tasks are stored inside its .pi folder.</p></div>
    {:else if tasks.length === 0}
      <div class="px-4 py-8 text-center"><ListTodo class="mx-auto mb-2 h-5 w-5 text-muted-foreground" aria-hidden="true" /><p class="text-xs font-medium">No tasks yet</p><p class="mt-1 text-xs text-muted-foreground">Add the first project task.</p></div>
    {:else}
      <div class="space-y-2.5">
        {#each TASK_GROUPS as group (group.type)}
          {@const groupTasks = tasks.filter((task) => task.type === group.type)}
          <section class="space-y-1" aria-label={`${group.label} tasks`} data-task-group={group.type}>
            <div class="flex h-5 items-center gap-1.5 px-1 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              <span>{group.label}</span>
              <span class="font-mono text-xs font-normal opacity-65">{groupTasks.length}</span>
            </div>

            <div
              class={[
                "min-h-8 divide-y divide-sidebar-border/60 transition-colors",
                draggedTaskId && taskDropTarget?.type === group.type ? "bg-panel-hover/40" : "",
              ]}
              role="list"
            >
              {#if groupTasks.length === 0 && !isDropPlaceholder(group.type, null, "after")}
                <div class="pointer-events-none grid h-8 place-items-center border border-dashed border-sidebar-border/70 text-xs text-muted-foreground/55">Empty</div>
              {/if}

              {#each groupTasks as task (task.id)}
                {@const taskLabel = projectTaskDisplayLabel(task)}
                {#if isDropPlaceholder(group.type, task.id, "before")}
                  <div
                    data-task-drop-placeholder
                    class="grid place-items-center border border-dashed border-primary/60 bg-panel-selected text-xs font-medium text-primary"
                    style:min-height={`${draggedTaskHeight}px`}
                    role="presentation"
                  >Move to {group.label}</div>
                {/if}

                <article
                  data-task-card
                  data-task-id={task.id}
                  class={[
                    "group relative px-1.5 py-1.5 transition-[background-color,opacity,transform] duration-150 hover:bg-panel-hover",
                    draggedTaskId === task.id ? "border border-dashed border-primary/35 bg-primary/5 opacity-25" : "",
                    revealedTaskId === task.id ? "border-l-2 border-l-primary bg-panel-selected" : "",
                  ]}
                  aria-label={taskLabel}
                >
                  <div class="flex min-w-0 items-start gap-1">
                    <button
                      class="mt-px grid h-6 w-5 shrink-0 touch-none cursor-grab place-items-center rounded text-muted-foreground/70 hover:bg-accent hover:text-foreground active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-30"
                      type="button"
                      title="Drag to reorder or move between groups"
                      aria-label={`Drag ${taskLabel} to reorder or change type`}
                      disabled={busy}
                      onpointerdown={(event) => onTaskDragStart(event, task.id)}
                      onpointermove={onTaskDragMove}
                      onpointerup={onTaskDragFinish}
                      onpointercancel={onTaskDragCancel}
                      onlostpointercapture={onTaskDragCancel}
                    ><GripVertical class="h-3.5 w-3.5" aria-hidden="true" /></button>

                    <div class="min-w-0 flex-1">
                      <div class="flex min-w-0 items-start gap-1">
                        <h3 class="min-w-0 flex-1 break-words pt-1 text-xs font-medium leading-4 text-foreground">{taskLabel}</h3>
                        <div class="flex shrink-0 items-center opacity-65 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                          <div class="relative" data-task-status-control>
                            <button
                              class={["grid h-6 w-6 place-items-center rounded-md hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-35", statusTone(task.status)]}
                              type="button"
                              title={`Status: ${taskStatusLabel(task.status)}`}
                              aria-label={`Change status for ${taskLabel}. Current status: ${taskStatusLabel(task.status)}`}
                              aria-haspopup="menu"
                              aria-expanded={statusMenuTaskId === task.id}
                              onclick={(event) => onToggleStatusMenu(event, task)}
                              disabled={busy}
                            >
                              {#if task.status === "done"}<CheckCircle2 class="h-3 w-3" aria-hidden="true" />
                              {:else if task.status === "in-progress"}<Clock3 class="h-3 w-3" aria-hidden="true" />
                              {:else if task.status === "backlog"}<CircleDashed class="h-3 w-3" aria-hidden="true" />
                              {:else}<Circle class="h-3 w-3" aria-hidden="true" />{/if}
                            </button>

                            {#if statusMenuTaskId === task.id}
                              <div
                                bind:this={statusMenu}
                                class="absolute top-7 right-0 z-40 w-36 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
                                role="menu"
                                tabindex="-1"
                                aria-label={`Status for ${taskLabel}`}
                                onkeydown={onStatusMenuKeydown}
                              >
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
                            aria-label={`${task.sessionId ? "Open session for" : "Run"} ${taskLabel}`}
                            onclick={() => task.sessionId ? onOpenSession(task) : onRun(task)}
                            disabled={!sessionReady || busy}
                          >
                            {#if activeTaskId === task.id}<RotateCw class="h-3 w-3 animate-spin" aria-hidden="true" />
                            {:else if task.sessionId}<Folder class="h-3 w-3" aria-hidden="true" />
                            {:else}<Play class="h-3 w-3" aria-hidden="true" />{/if}
                          </button>
                          <button class="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-35" type="button" title="Edit task" aria-label={`Edit ${taskLabel}`} onclick={() => onEdit(task)} disabled={busy}><Pencil class="h-3 w-3" aria-hidden="true" /></button>
                          <button class="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-tool-error focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-35" type="button" title="Delete task" aria-label={`Delete ${taskLabel}`} onclick={() => onDeleteRequest(task.id)} disabled={busy}><Trash2 class="h-3 w-3" aria-hidden="true" /></button>
                        </div>
                      </div>
                    </div>
                  </div>
                </article>

                {#if isDropPlaceholder(group.type, task.id, "after")}
                  <div
                    data-task-drop-placeholder
                    class="grid place-items-center border border-dashed border-primary/60 bg-panel-selected text-xs font-medium text-primary"
                    style:min-height={`${draggedTaskHeight}px`}
                    role="presentation"
                  >Move to {group.label}</div>
                {/if}
              {/each}

              {#if isDropPlaceholder(group.type, null, "after")}
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
