<script lang="ts">
  import Brain from "@lucide/svelte/icons/brain";
  import CheckCircle2 from "@lucide/svelte/icons/check-circle-2";
  import Circle from "@lucide/svelte/icons/circle";
  import CirclePause from "@lucide/svelte/icons/circle-pause";
  import Clock3 from "@lucide/svelte/icons/clock-3";
  import ListChecks from "@lucide/svelte/icons/list-checks";
  import UserRound from "@lucide/svelte/icons/user-round";
  import {
    hasOpenSessionTodos,
    sessionTodoCounts,
    visibleSessionTodoRows,
    type SessionTodoSnapshot,
    type SessionTodoStatus,
  } from "../lib/session-todos";

  let { snapshot }: { snapshot: SessionTodoSnapshot | undefined } = $props();

  const rows = $derived(visibleSessionTodoRows(snapshot));
  const counts = $derived(sessionTodoCounts(snapshot));
  const openCount = $derived(counts.pending + counts.in_progress + counts.deferred);

  function statusTone(status: SessionTodoStatus): string {
    if (status === "completed") return "text-[var(--tool-success)]";
    if (status === "in_progress") return "text-[var(--tool-warning)]";
    if (status === "deferred") return "text-muted-foreground";
    return "text-[var(--tool-info)]";
  }

  function statusLabel(status: SessionTodoStatus): string {
    if (status === "in_progress") return "In progress";
    return status.charAt(0).toUpperCase() + status.slice(1);
  }
</script>

<section class="border-t border-sidebar-border" aria-labelledby="session-todos-heading">
  <div class="border-b border-sidebar-border p-2.5">
    <div class="flex items-center justify-between gap-2">
      <div class="flex min-w-0 items-center gap-1.5">
        <ListChecks class="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
        <h2 id="session-todos-heading" class="text-xs font-semibold text-foreground">Todos</h2>
      </div>
      {#if hasOpenSessionTodos(snapshot)}
        <span class="text-[10px] text-muted-foreground">{openCount} open · {counts.completed} done</span>
      {/if}
    </div>
    <p class="mt-1 text-[9px] leading-3.5 text-muted-foreground">Read-only plan for the active session.</p>
  </div>

  <div class="p-2">
    {#if rows.length === 0}
      <div class="px-4 py-5 text-center">
        <ListChecks class="mx-auto mb-2 h-5 w-5 text-muted-foreground" aria-hidden="true" />
        <p class="text-xs font-medium">No open todos</p>
        <p class="mt-1 text-[10px] leading-4 text-muted-foreground">This session has no unfinished plan.</p>
      </div>
    {:else}
      <div class="space-y-1.5">
        {#each rows as row (row.task.id)}
          {@const task = row.task}
          <article
            class={["rounded-lg border border-sidebar-border bg-background/55 p-2.5 shadow-xs", task.status === "completed" && "opacity-65"]}
            style:margin-left={`${Math.min(row.depth, 4) * 12}px`}
            aria-label={`Todo ${task.id}: ${task.subject}`}
          >
            <div class="flex items-start gap-2">
              <span class={["mt-0.5 shrink-0", statusTone(task.status)]} title={statusLabel(task.status)}>
                {#if task.status === "completed"}<CheckCircle2 class="h-4 w-4" aria-hidden="true" />
                {:else if task.status === "in_progress"}<Clock3 class="h-4 w-4" aria-hidden="true" />
                {:else if task.status === "deferred"}<CirclePause class="h-4 w-4" aria-hidden="true" />
                {:else}<Circle class="h-4 w-4" aria-hidden="true" />{/if}
              </span>
              <div class="min-w-0 flex-1">
                <h3 class={["break-words text-xs font-medium leading-4 text-foreground", task.status === "completed" && "line-through"]}>
                  <span class="mr-1 font-mono text-[9px] text-muted-foreground">#{task.id}</span>{task.subject}
                </h3>
                {#if task.status === "in_progress" && task.activeForm}
                  <p class="mt-1 break-words text-[10px] leading-3.5 text-[var(--tool-warning)]">{task.activeForm}</p>
                {:else if task.description}
                  <p class="mt-1 line-clamp-3 break-words text-[10px] leading-3.5 text-muted-foreground">{task.description}</p>
                {/if}
              </div>
            </div>
            <div class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[9px] text-muted-foreground">
              <span class={["font-medium", statusTone(task.status)]}>{statusLabel(task.status)}</span>
              {#if task.thinking}<span class="inline-flex items-center gap-1"><Brain class="h-3 w-3" aria-hidden="true" />{task.thinking}</span>{/if}
              {#if task.owner}<span class="inline-flex min-w-0 items-center gap-1"><UserRound class="h-3 w-3 shrink-0" aria-hidden="true" /><span class="truncate">{task.owner}</span></span>{/if}
              {#if task.blockedBy?.length}<span class="text-[var(--tool-warning)]">Blocked by {task.blockedBy.map((id) => `#${id}`).join(", ")}</span>{/if}
            </div>
          </article>
        {/each}
      </div>
    {/if}
  </div>
</section>
