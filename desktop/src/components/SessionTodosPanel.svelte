<script lang="ts">
  import Brain from "@lucide/svelte/icons/brain";
  import CheckCircle2 from "@lucide/svelte/icons/check-circle-2";
  import Circle from "@lucide/svelte/icons/circle";
  import CirclePause from "@lucide/svelte/icons/circle-pause";
  import Clock3 from "@lucide/svelte/icons/clock-3";
  import ListChecks from "@lucide/svelte/icons/list-checks";
  import UserRound from "@lucide/svelte/icons/user-round";
  import type { SessionActivitySummary } from "../lib/session-activity";
  import {
    visibleSessionTodoRows,
    type SessionTodoSnapshot,
    type SessionTodoStatus,
  } from "../lib/session-todos";

  let {
    snapshot,
    summary,
  }: {
    snapshot: SessionTodoSnapshot | undefined;
    summary: SessionActivitySummary;
  } = $props();

  const rows = $derived(visibleSessionTodoRows(snapshot));

  function statusTone(status: SessionTodoStatus): string {
    if (status === "completed") return "text-tool-success";
    if (status === "in_progress") return "text-tool-warning";
    if (status === "deferred") return "text-muted-foreground";
    return "text-tool-info";
  }

  function statusLabel(status: SessionTodoStatus): string {
    if (status === "in_progress") return "In progress";
    return status.charAt(0).toUpperCase() + status.slice(1);
  }
</script>

<section aria-labelledby="session-todos-heading">
  <div class="flex h-8 items-center gap-1.5 border-b border-border px-2.5">
    <ListChecks class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    <h2 id="session-todos-heading" class="text-[11px] font-semibold uppercase tracking-wide text-foreground">Plan</h2>
    {#if summary.openTodos > 0 && summary.totalTodos > 0}
      <span class="ml-auto font-mono text-[11px] text-muted-foreground">{summary.completedTodos}/{summary.totalTodos}</span>
    {/if}
  </div>

  <div>
    {#if rows.length === 0}
      <div class="px-2.5 py-3 text-[11px] text-muted-foreground">No open plan</div>
    {:else}
      <div>
        {#each rows as row (row.task.id)}
          {@const task = row.task}
          <article
            class={["border-b border-border py-1.5 pr-2.5 transition-colors hover:bg-panel-hover", task.status === "completed" && "opacity-60"]}
            style:padding-left={`${10 + Math.min(row.depth, 4) * 12}px`}
            aria-label={`Todo ${task.id}: ${task.subject}`}
          >
            <div class="flex min-w-0 items-start gap-1.5">
              <span class={["mt-px shrink-0", statusTone(task.status)]} title={statusLabel(task.status)}>
                {#if task.status === "completed"}<CheckCircle2 class="h-3.5 w-3.5" aria-hidden="true" />
                {:else if task.status === "in_progress"}<Clock3 class="h-3.5 w-3.5" aria-hidden="true" />
                {:else if task.status === "deferred"}<CirclePause class="h-3.5 w-3.5" aria-hidden="true" />
                {:else}<Circle class="h-3.5 w-3.5" aria-hidden="true" />{/if}
              </span>
              <div class="min-w-0 flex-1">
                <h3 class={["break-words text-[11px] font-medium leading-4 text-foreground", task.status === "completed" && "line-through"]}>
                  <span class="mr-1 font-mono text-[10px] text-muted-foreground">#{task.id}</span>{task.subject}
                </h3>
                {#if task.status === "in_progress" && task.activeForm}
                  <p class="mt-0.5 line-clamp-2 break-words text-[10px] leading-3.5 text-tool-warning">{task.activeForm}</p>
                {:else if task.description}
                  <p class="mt-0.5 line-clamp-2 break-words text-[10px] leading-3.5 text-muted-foreground">{task.description}</p>
                {/if}
                {#if task.thinking || task.owner || task.blockedBy?.length}
                  <div class="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-muted-foreground">
                    {#if task.thinking}<span class="inline-flex items-center gap-1"><Brain class="h-2.5 w-2.5" aria-hidden="true" />{task.thinking}</span>{/if}
                    {#if task.owner}<span class="inline-flex min-w-0 items-center gap-1"><UserRound class="h-2.5 w-2.5 shrink-0" aria-hidden="true" /><span class="truncate">{task.owner}</span></span>{/if}
                    {#if task.blockedBy?.length}<span class="text-tool-warning">Blocked by {task.blockedBy.map((id) => `#${id}`).join(", ")}</span>{/if}
                  </div>
                {/if}
              </div>
            </div>
          </article>
        {/each}
      </div>
    {/if}
  </div>
</section>
