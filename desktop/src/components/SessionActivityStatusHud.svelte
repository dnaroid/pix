<script lang="ts">
  import Brain from "@lucide/svelte/icons/brain";
  import CheckCircle2 from "@lucide/svelte/icons/check-circle-2";
  import Circle from "@lucide/svelte/icons/circle";
  import CirclePause from "@lucide/svelte/icons/circle-pause";
  import Clock3 from "@lucide/svelte/icons/clock-3";
  import ListTodo from "@lucide/svelte/icons/list-todo";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import UserRound from "@lucide/svelte/icons/user-round";
  import { agentIcon } from "../lib/agent-icons";
  import { modelProviderBrand } from "../lib/model-display";
  import ModelProviderIcon from "./ModelProviderIcon.svelte";
  import {
    sessionActivityLabel,
    sessionActivityTone,
    type SessionActivitySummary,
  } from "../lib/session-activity";
  import {
    formatSessionSubagentActivity,
    formatSessionSubagentElapsed,
    sessionSubagentIndicators,
    sessionSubagentModelLabel,
    type SessionSubagentSnapshot,
    type SessionSubagentStatus,
  } from "../lib/session-subagents";
  import {
    currentSessionTodoTask,
    visibleSessionTodoRows,
    type SessionTodoSnapshot,
    type SessionTodoStatus,
  } from "../lib/session-todos";

  let {
    summary,
    subagentSnapshot,
    todoSnapshot,
    promptRunning,
    sessionNeedsInput,
    sessionActivityOpen,
    canClearTodos = false,
    onClearTodos,
    onOpenSessionActivity,
  }: {
    summary: SessionActivitySummary;
    subagentSnapshot: SessionSubagentSnapshot | undefined;
    todoSnapshot: SessionTodoSnapshot | undefined;
    promptRunning: boolean;
    sessionNeedsInput: boolean;
    sessionActivityOpen: boolean;
    canClearTodos?: boolean;
    onClearTodos?: () => Promise<boolean>;
    onOpenSessionActivity: () => void;
  } = $props();

  const hasTodoProgress = $derived(summary.openTodos > 0 && summary.totalTodos > 0);
  const indicators = $derived(sessionSubagentIndicators(subagentSnapshot));
  const compactIndicators = $derived(indicators.slice(0, 6));
  const hiddenAgentCount = $derived(Math.max(0, indicators.length - compactIndicators.length));
  const currentTodo = $derived(currentSessionTodoTask(todoSnapshot));
  const todoRows = $derived(visibleSessionTodoRows(todoSnapshot));
  const activityTone = $derived(sessionActivityTone(summary, promptRunning, sessionNeedsInput));
  const activityLabel = $derived(sessionActivityLabel(summary, promptRunning, sessionNeedsInput));
  const visible = $derived(
    !sessionActivityOpen && (summary.activeSubagents > 0 || hasTodoProgress),
  );
  let todoTooltipBody = $state<HTMLDivElement>();
  let clearingTodos = $state(false);

  async function clearTodos(): Promise<void> {
    if (!onClearTodos || !canClearTodos || clearingTodos || todoRows.length === 0) return;
    clearingTodos = true;
    try {
      await onClearTodos();
    } finally {
      clearingTodos = false;
    }
  }

  function scrollTodoTooltipToCurrent(): void {
    if (!currentTodo || !todoTooltipBody) return;
    requestAnimationFrame(() => {
      const body = todoTooltipBody;
      if (!body) return;
      const target = body.querySelector<HTMLElement>('[data-session-todo-current="true"]');
      if (!target) return;
      const bodyRect = body.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const centered = body.scrollTop
        + targetRect.top
        - bodyRect.top
        - Math.max(0, (bodyRect.height - targetRect.height) / 2);
      body.scrollTop = Math.max(0, centered);
    });
  }

  function activityToneClass(): string {
    if (activityTone === "warning") return "text-tool-warning";
    if (activityTone === "info") return "text-tool-info";
    return "text-muted-foreground";
  }

  function subagentStatusTone(status: SessionSubagentStatus): string {
    if (status === "running") return "text-tool-info";
    if (status === "retrying") return "text-tool-warning";
    if (status === "done") return "text-tool-success";
    if (status === "failed") return "text-tool-error";
    return "text-muted-foreground";
  }

  function subagentStatusLabel(status: SessionSubagentStatus): string {
    if (status === "retrying") return "Retrying";
    if (status === "running") return "Running";
    if (status === "done") return "Done";
    if (status === "failed") return "Failed";
    if (status === "stopped") return "Stopped";
    return "Planned";
  }

  function todoStatusTone(status: SessionTodoStatus): string {
    if (status === "completed") return "text-tool-success";
    if (status === "in_progress") return "text-tool-warning";
    if (status === "deferred") return "text-muted-foreground";
    return "text-tool-info";
  }

  function todoStatusLabel(status: SessionTodoStatus): string {
    if (status === "in_progress") return "In progress";
    return status.charAt(0).toUpperCase() + status.slice(1);
  }
</script>

{#if visible}
  <div
    class="flex shrink-0 items-center gap-0.5"
    role="group"
    aria-label={"Session activity. " + activityLabel}
    data-session-activity-summary
  >
    {#each compactIndicators as indicator, index (indicator.runDir + "\0" + indicator.agent.id)}
      {@const tooltipId = "session-subagent-status-tooltip-" + index}
      {@const AgentIcon = agentIcon(indicator.preview?.icon)}
      {@const task = indicator.preview?.task?.trim() || indicator.preview?.scope?.trim() || "Task unavailable"}
      {@const role = indicator.preview?.subagentType?.trim() || "auto"}
      <div class="group relative">
        <button
          class={[
            "grid h-6 w-6 place-items-center rounded-sm bg-transparent transition-colors hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
            subagentStatusTone(indicator.agent.status),
          ]}
          type="button"
          aria-label={"Open session activity. Subagent " + indicator.agent.id + " (" + role + "): " + subagentStatusLabel(indicator.agent.status)}
          aria-describedby={tooltipId}
          onclick={onOpenSessionActivity}
        >
          <AgentIcon
            class={[
              "h-3.5 w-3.5",
              (indicator.agent.status === "running" || indicator.agent.status === "retrying")
                && "animate-pulse motion-reduce:animate-none",
            ]}
            aria-hidden="true"
          />
        </button>
        <div
          id={tooltipId}
          class="pointer-events-auto absolute right-0 bottom-full z-40 hidden w-80 max-w-[calc(100vw-16px)] rounded-md border border-border bg-popover px-2 py-2 text-popover-foreground shadow-md group-hover:block group-focus-within:block"
          role="tooltip"
          data-session-subagent-tooltip
        >
          <div class="min-w-0">
            <div class="min-w-0 flex-1">
              <div class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1" data-session-subagent-header>
                <span class={["grid h-4 w-4 shrink-0 place-items-center", subagentStatusTone(indicator.agent.status)]} data-session-subagent-header-icon>
                  <AgentIcon class="h-3.5 w-3.5" aria-hidden="true" />
                </span>
                <span class="-ml-1 max-w-full shrink-0 break-words rounded-sm bg-muted px-1 font-mono text-xs font-semibold leading-4 text-foreground" data-session-subagent-role>
                  {role}
                </span>
                <span class={["ml-auto shrink-0 text-xs font-medium", subagentStatusTone(indicator.agent.status)]}>
                  {subagentStatusLabel(indicator.agent.status)}
                </span>
                <span class="shrink-0 font-mono text-xs text-muted-foreground">
                  {formatSessionSubagentElapsed(indicator.agent.startedAt, subagentSnapshot?.checkedAt ?? Date.now())}
                </span>
              </div>
              <div class="mt-0.5 truncate font-mono text-xs text-foreground" title={`${indicator.agent.id} · ${indicator.runDir}`} data-session-subagent-name>
                {indicator.agent.id}
              </div>
              <div
                class="mt-0.5 max-h-[min(40vh,18rem)] overflow-y-auto overscroll-contain pr-1"
                data-session-subagent-tooltip-body
              >
                <p class="mt-1 break-words text-xs leading-4 text-foreground/80">{task}</p>
              </div>
              <div class="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 border-t border-border pt-1.5 text-xs font-semibold text-foreground" data-session-subagent-footer>
                <span class="inline-flex shrink-0 items-center gap-1.5 font-mono">
                  {#if modelProviderBrand(indicator.preview?.model ?? "")}
                    <ModelProviderIcon provider={indicator.preview?.model ?? ""} />
                  {/if}
                  {sessionSubagentModelLabel(indicator.preview)}
                </span>
                {#if indicator.agent.lastActivity}
                  <span class="text-muted-foreground/50">·</span>
                  <span class="min-w-0 truncate font-mono">
                    {formatSessionSubagentActivity(indicator.agent.lastActivity)}
                  </span>
                {/if}
                {#if indicator.agent.retryCount}
                  <span class="shrink-0 text-tool-warning">retry {indicator.agent.retryCount}</span>
                {/if}
              </div>
            </div>
          </div>
        </div>
      </div>
    {/each}

    {#if hiddenAgentCount > 0}
      <button
        class="h-6 rounded-sm bg-transparent px-1 font-mono text-xs leading-none tabular-nums text-muted-foreground transition-colors hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
        type="button"
        aria-label={"Open session activity. " + hiddenAgentCount + " more active " + (hiddenAgentCount === 1 ? "subagent" : "subagents")}
        onclick={onOpenSessionActivity}
      >
        +{hiddenAgentCount}
      </button>
    {/if}

    {#if hasTodoProgress}
      <div class="group relative">
        <button
          class={[
            "relative flex h-6 items-center gap-0.5 rounded-sm bg-transparent px-1.5 font-mono tabular-nums transition-colors hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
            activityToneClass(),
          ]}
          type="button"
          aria-label={"Open session activity. Plan " + summary.completedTodos + "/" + summary.totalTodos + (currentTodo ? ". Current item " + currentTodo.subject : "")}
          aria-haspopup={currentTodo ? "dialog" : undefined}
          aria-controls={currentTodo ? "session-todo-status-tooltip" : undefined}
          onmouseenter={scrollTodoTooltipToCurrent}
          onfocus={scrollTodoTooltipToCurrent}
          onclick={onOpenSessionActivity}
        >
          <ListTodo class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{summary.completedTodos}/{summary.totalTodos}</span>
          <span
            class="pointer-events-none absolute inset-x-1.5 bottom-0.5 h-0.5 overflow-hidden bg-tool-info/20"
            aria-hidden="true"
            data-session-todo-progress
          >
            <span
              class="block h-full bg-tool-info"
              style:width={`${(summary.completedTodos / summary.totalTodos) * 100}%`}
            ></span>
          </span>
        </button>

        {#if currentTodo}
          <div
            id="session-todo-status-tooltip"
            class="pointer-events-auto absolute right-0 bottom-full z-40 hidden w-80 max-w-[calc(100vw-16px)] rounded-md border border-border bg-popover px-2.5 py-2 text-popover-foreground shadow-md group-hover:block group-focus-within:block"
            role="dialog"
            aria-label="Session plan"
            data-session-todo-tooltip
          >
            <div class="flex items-center gap-2">
              <span class="font-semibold text-foreground">Plan</span>
              <button
                class="ml-auto grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-panel-hover hover:text-destructive focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
                type="button"
                title="Clear session plan"
                aria-label="Clear session plan"
                disabled={!canClearTodos || clearingTodos || todoRows.length === 0}
                onclick={() => { void clearTodos(); }}
              ><Trash2 class="h-3.5 w-3.5" aria-hidden="true" /></button>
              <span class="font-mono text-xs tabular-nums text-muted-foreground">
                {summary.completedTodos}/{summary.totalTodos}
              </span>
            </div>
            <div
              bind:this={todoTooltipBody}
              class="mt-1 max-h-[min(40vh,18rem)] overflow-y-auto overscroll-contain pr-1"
              data-session-todo-tooltip-body
            >
              <div class="space-y-0.5">
                {#each todoRows as row (row.task.id)}
                  {@const task = row.task}
                  {@const isCurrent = task.id === currentTodo.id}
                  <article
                    class={[
                      "rounded-md border-l-2 py-1.5 pr-1.5",
                      isCurrent ? "border-l-primary bg-panel-selected" : "border-l-transparent",
                      task.status === "completed" && "opacity-60",
                      !isCurrent && (task.status === "pending" || task.status === "deferred") && "opacity-70",
                    ]}
                    style:padding-left={`${6 + Math.min(row.depth, 4) * 10}px`}
                    data-session-todo-current={isCurrent ? "true" : undefined}
                  >
                    <div class="flex min-w-0 items-start gap-1.5">
                      <span class={["mt-px shrink-0", todoStatusTone(task.status)]} title={todoStatusLabel(task.status)}>
                        {#if task.status === "completed"}<CheckCircle2 class="h-3.5 w-3.5" aria-hidden="true" />
                        {:else if task.status === "in_progress"}<Clock3 class="h-3.5 w-3.5" aria-hidden="true" />
                        {:else if task.status === "deferred"}<CirclePause class="h-3.5 w-3.5" aria-hidden="true" />
                        {:else}<Circle class="h-3.5 w-3.5" aria-hidden="true" />{/if}
                      </span>
                      <div class="min-w-0 flex-1">
                        <div class="flex min-w-0 items-start gap-2">
                          <h4 class={["min-w-0 flex-1 break-words text-xs font-medium leading-4 text-foreground", task.status === "completed" && "line-through"]}>
                            <span class="mr-1 font-mono text-muted-foreground">#{task.id}</span>{task.subject}
                          </h4>
                          <span class={["shrink-0 text-xs font-medium", todoStatusTone(task.status)]}>{todoStatusLabel(task.status)}</span>
                        </div>
                        {#if task.activeForm}
                          <p class="mt-0.5 break-words text-xs leading-4 text-foreground/80">{task.activeForm}</p>
                        {/if}
                        {#if task.description && task.description !== task.activeForm}
                          <p class="mt-0.5 break-words text-xs leading-4 text-muted-foreground">{task.description}</p>
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
            </div>
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/if}
