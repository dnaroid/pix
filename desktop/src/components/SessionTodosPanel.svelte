<script lang="ts">
  import Brain from "@lucide/svelte/icons/brain";
  import CheckCircle2 from "@lucide/svelte/icons/check-circle-2";
  import Circle from "@lucide/svelte/icons/circle";
  import CirclePause from "@lucide/svelte/icons/circle-pause";
  import Clock3 from "@lucide/svelte/icons/clock-3";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import { onMount } from "svelte";
  import ListChecks from "@lucide/svelte/icons/list-checks";
  import Trash2 from "@lucide/svelte/icons/trash-2";
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
    canClearTodos = false,
    onClearTodos,
  }: {
    snapshot: SessionTodoSnapshot | undefined;
    summary: SessionActivitySummary;
    canClearTodos?: boolean;
    onClearTodos?: () => Promise<boolean>;
  } = $props();

  const rows = $derived(visibleSessionTodoRows(snapshot));
  let details = $state<HTMLDetailsElement>();
  let receivedInitialSnapshot = false;
  let manuallyToggled = false;
  let defaultOpen: boolean | undefined;
  let clearingTodos = $state(false);

  function applyInitialOpenState(): void {
    if (receivedInitialSnapshot || snapshot === undefined) return;
    receivedInitialSnapshot = true;
    defaultOpen = rows.length > 0;
    if (details) details.open = defaultOpen;
  }

  $effect(() => {
    if (!manuallyToggled) applyInitialOpenState();
  });

  onMount(applyInitialOpenState);

  function noteToggle(): void {
    if (defaultOpen !== undefined && details?.open === defaultOpen) return;
    manuallyToggled = true;
  }

  async function clearTodos(): Promise<void> {
    if (!onClearTodos || !canClearTodos || clearingTodos || rows.length === 0) return;
    clearingTodos = true;
    try {
      await onClearTodos();
    } finally {
      clearingTodos = false;
    }
  }

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

<div class="relative">
<details bind:this={details} class="group border-b border-border" ontoggle={noteToggle}>
  <summary class="flex h-8 cursor-pointer list-none items-center gap-1.5 px-2.5 pr-9 text-xs hover:bg-panel-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
    <ListChecks class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    <span class="font-semibold text-foreground">Plan</span>
    <span class="ml-auto font-mono tabular-nums text-muted-foreground">{summary.completedTodos}/{summary.totalTodos} tasks</span>
    <ChevronDown class="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
  </summary>

  <div>
    {#if rows.length === 0}
      <div class="px-2.5 py-3 text-xs text-muted-foreground">No open plan</div>
    {:else}
      <div class="space-y-0.5 px-1.5 pb-1.5">
        {#each rows as row (row.task.id)}
          {@const task = row.task}
          <article
            class={[
              "rounded-md border-l-2 py-1.5 pr-2 transition-colors hover:bg-panel-hover",
              task.status === "in_progress" ? "border-l-primary bg-panel-selected" : "border-l-transparent",
              task.status === "completed" && "opacity-60",
            ]}
            style:padding-left={`${8 + Math.min(row.depth, 4) * 12}px`}
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
                <h3 class={["break-words text-xs font-medium leading-4 text-foreground", task.status === "completed" && "line-through"]}>
                  <span class="mr-1 font-mono text-xs text-muted-foreground">#{task.id}</span>{task.subject}
                </h3>
                {#if task.status === "in_progress" && task.activeForm}
                  <p class="mt-0.5 line-clamp-2 break-words text-xs leading-4 text-foreground/80">{task.activeForm}</p>
                {:else if task.description}
                  <p class="mt-0.5 line-clamp-2 break-words text-xs leading-4 text-muted-foreground">{task.description}</p>
                {/if}
                {#if task.thinking || task.owner || task.blockedBy?.length}
                  <div class="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
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
</details>
  <button
    class="absolute top-1 right-1 grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-panel-hover hover:text-destructive focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
    type="button"
    title="Clear session plan"
    aria-label="Clear session plan"
    disabled={!canClearTodos || clearingTodos || rows.length === 0}
    onclick={() => { void clearTodos(); }}
  ><Trash2 class="h-3.5 w-3.5" aria-hidden="true" /></button>
</div>
