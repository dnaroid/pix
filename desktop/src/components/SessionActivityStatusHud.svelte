<script lang="ts">
  import Brain from "@lucide/svelte/icons/brain";
  import ListTodo from "@lucide/svelte/icons/list-todo";
  import UserRound from "@lucide/svelte/icons/user-round";
  import { agentIcon } from "../lib/agent-icons";
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
    onOpenSessionActivity,
  }: {
    summary: SessionActivitySummary;
    subagentSnapshot: SessionSubagentSnapshot | undefined;
    todoSnapshot: SessionTodoSnapshot | undefined;
    promptRunning: boolean;
    sessionNeedsInput: boolean;
    sessionActivityOpen: boolean;
    onOpenSessionActivity: () => void;
  } = $props();

  const hasTodoProgress = $derived(summary.openTodos > 0 && summary.totalTodos > 0);
  const indicators = $derived(sessionSubagentIndicators(subagentSnapshot));
  const compactIndicators = $derived(indicators.slice(0, 3));
  const hiddenAgentCount = $derived(Math.max(0, indicators.length - compactIndicators.length));
  const currentTodo = $derived(currentSessionTodoTask(todoSnapshot));
  const activityTone = $derived(sessionActivityTone(summary, promptRunning, sessionNeedsInput));
  const activityLabel = $derived(sessionActivityLabel(summary, promptRunning, sessionNeedsInput));
  const visible = $derived(
    !sessionActivityOpen && (summary.activeSubagents > 0 || hasTodoProgress),
  );

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
      <div class="group relative">
        <button
          class={[
            "grid h-6 w-6 cursor-pointer place-items-center rounded-sm bg-transparent transition-colors hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
            subagentStatusTone(indicator.agent.status),
          ]}
          type="button"
          aria-label={"Open session activity. Subagent " + indicator.agent.id + ": " + subagentStatusLabel(indicator.agent.status)}
          aria-describedby={tooltipId}
          onclick={onOpenSessionActivity}
        >
          <AgentIcon class="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <div
          id={tooltipId}
          class="pointer-events-none absolute right-0 bottom-[calc(100%+0.375rem)] z-40 hidden w-80 max-w-[calc(100vw-16px)] rounded-md border border-border bg-popover px-2.5 py-2 text-popover-foreground shadow-md group-hover:block group-focus-within:block"
          role="tooltip"
          data-session-subagent-tooltip
        >
          <div class="flex min-w-0 items-start gap-2">
            <span class={["mt-px shrink-0", subagentStatusTone(indicator.agent.status)]}>
              <AgentIcon class="h-3.5 w-3.5" aria-hidden="true" />
            </span>
            <div class="min-w-0 flex-1">
              <div class="flex min-w-0 items-center gap-2">
                <span class="min-w-0 flex-1 truncate font-mono text-xs font-semibold text-foreground">{indicator.agent.id}</span>
                <span class={["shrink-0 text-xs font-medium", subagentStatusTone(indicator.agent.status)]}>
                  {subagentStatusLabel(indicator.agent.status)}
                </span>
                <span class="shrink-0 font-mono text-xs text-muted-foreground">
                  {formatSessionSubagentElapsed(indicator.agent.startedAt, subagentSnapshot?.checkedAt ?? Date.now())}
                </span>
              </div>
              <div class="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={indicator.runDir}>
                {indicator.runName}
              </div>
              <p class="mt-1 break-words text-xs leading-4 text-foreground/80">{task}</p>
              <div class="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
                <span class="shrink-0 font-mono">{sessionSubagentModelLabel(indicator.preview)}</span>
                {#if indicator.agent.lastActivity}
                  <span class="text-muted-foreground/50">·</span>
                  <span class="min-w-0 truncate font-mono text-foreground/80">
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
        class="h-6 cursor-pointer rounded-sm bg-transparent px-1 font-mono text-xs leading-none tabular-nums text-muted-foreground transition-colors hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
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
            "flex h-6 cursor-pointer items-center gap-0.5 rounded-sm bg-transparent px-1.5 font-mono tabular-nums transition-colors hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
            activityToneClass(),
          ]}
          type="button"
          aria-label={"Open session activity. Plan " + summary.completedTodos + "/" + summary.totalTodos + (currentTodo ? ". Current item " + currentTodo.subject : "")}
          aria-describedby={currentTodo ? "session-todo-status-tooltip" : undefined}
          onclick={onOpenSessionActivity}
        >
          <ListTodo class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{summary.completedTodos}/{summary.totalTodos}</span>
        </button>

        {#if currentTodo}
          <div
            id="session-todo-status-tooltip"
            class="pointer-events-none absolute right-0 bottom-[calc(100%+0.375rem)] z-40 hidden w-80 max-w-[calc(100vw-16px)] rounded-md border border-border bg-popover px-2.5 py-2 text-popover-foreground shadow-md group-hover:block group-focus-within:block"
            role="tooltip"
            data-session-todo-tooltip
          >
            <div class="flex items-center gap-2">
              <span class="font-semibold text-foreground">Plan</span>
              <span class={["ml-auto text-xs font-medium", todoStatusTone(currentTodo.status)]}>
                {todoStatusLabel(currentTodo.status)}
              </span>
            </div>
            <h4 class="mt-1 break-words text-xs font-medium leading-4 text-foreground">
              <span class="mr-1 font-mono text-muted-foreground">#{currentTodo.id}</span>{currentTodo.subject}
            </h4>
            {#if currentTodo.activeForm}
              <p class="mt-1 break-words text-xs leading-4 text-foreground/80">{currentTodo.activeForm}</p>
            {/if}
            {#if currentTodo.description && currentTodo.description !== currentTodo.activeForm}
              <p class="mt-1 break-words text-xs leading-4 text-muted-foreground">{currentTodo.description}</p>
            {/if}
            {#if currentTodo.thinking || currentTodo.owner || currentTodo.blockedBy?.length}
              <div class="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                {#if currentTodo.thinking}
                  <span class="inline-flex items-center gap-1">
                    <Brain class="h-3 w-3" aria-hidden="true" />{currentTodo.thinking}
                  </span>
                {/if}
                {#if currentTodo.owner}
                  <span class="inline-flex min-w-0 items-center gap-1">
                    <UserRound class="h-3 w-3 shrink-0" aria-hidden="true" />
                    <span class="truncate">{currentTodo.owner}</span>
                  </span>
                {/if}
                {#if currentTodo.blockedBy?.length}
                  <span class="text-tool-warning">
                    Blocked by {currentTodo.blockedBy.map((id) => "#" + id).join(", ")}
                  </span>
                {/if}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/if}
