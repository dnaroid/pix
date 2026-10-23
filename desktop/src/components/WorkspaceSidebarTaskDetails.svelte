<script lang="ts">
  import {
    projectTaskDisplayLabel,
    taskPriorityLabel,
    taskStatusLabel,
    taskTypeLabel,
    type ProjectTask,
  } from "../lib/project-tasks";

  let { task, parent, tasks, attachmentCount = 0 }: {
    task: ProjectTask;
    parent?: ProjectTask;
    tasks: readonly ProjectTask[];
    attachmentCount?: number;
  } = $props();

  const relatedTasks = $derived(tasks.filter((candidate) => candidate.id !== task.id
    && (task.relatedTaskIds?.includes(candidate.id) || candidate.relatedTaskIds?.includes(task.id))));
</script>

<div class="mt-1.5 space-y-2 border-t border-border/60 pt-2 pb-1 text-xs leading-4">
  <p class="whitespace-pre-wrap break-words font-medium text-foreground [overflow-wrap:anywhere]" data-task-detail-title>{projectTaskDisplayLabel(task)}</p>
  <p class="whitespace-pre-wrap break-words text-foreground [overflow-wrap:anywhere]" data-task-description>{task.description?.trim() || "No description."}</p>
  <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-muted-foreground [&_dd]:min-w-0 [&_dd]:break-words [&_dd]:[overflow-wrap:anywhere]">
    <dt>Type</dt><dd>{taskTypeLabel(task.type)}</dd>
    <dt>Status</dt><dd>{taskStatusLabel(task.status)}</dd>
    <dt>Priority</dt><dd>{taskPriorityLabel(task.priority)}</dd>
    {#if task.epic}<dt>Epic</dt><dd>Yes</dd>{/if}
    {#if parent}<dt>Parent</dt><dd>{projectTaskDisplayLabel(parent)}</dd>{/if}
    {#if task.modelRef}<dt>Model</dt><dd>{task.modelRef}</dd>{/if}
    {#if attachmentCount}<dt>Attachments</dt><dd>{attachmentCount}</dd>{/if}
    {#if relatedTasks.length}
      <dt>Related tasks</dt><dd><ul class="space-y-1">{#each relatedTasks as related (related.id)}<li>{projectTaskDisplayLabel(related)}</li>{/each}</ul></dd>
    {/if}
    {#if task.links?.length}
      <dt>Links</dt><dd><ul class="space-y-1">{#each task.links as link}<li>{link}</li>{/each}</ul></dd>
    {/if}
  </dl>
</div>
