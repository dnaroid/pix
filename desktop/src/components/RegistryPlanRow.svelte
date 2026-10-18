<script lang="ts">
  import FileText from "@lucide/svelte/icons/file-text";
  import Play from "@lucide/svelte/icons/play";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import ListTodo from "@lucide/svelte/icons/list-todo";
  import CircleCheck from "@lucide/svelte/icons/circle-check";
  import CirclePause from "@lucide/svelte/icons/circle-pause";
  import CircleX from "@lucide/svelte/icons/circle-x";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import { planRunResumable, type PlanRunStatus } from "../lib/plan-launches";
  import { iconButtonClass } from "../lib/icon-button";
  import type { PlanProgress } from "../lib/project-documents";
  import PlanProgressIndicator from "./PlanProgressIndicator.svelte";
  import TaskFieldSelect from "./TaskFieldSelect.svelte";
  import type { PlanRun } from "../lib/project-task-plans";

  type TaskFieldOption = { value: string; label: string; description?: string };

  /** Visible run rows per plan; older runs stay reachable through the session list. */
  const RUN_LIMIT = 3;

  let {
    plan,
    label,
    active,
    progress,
    owner = null,
    linkTargets = [],
    runs = [],
    actionsDisabled = false,
    runDisabled = false,
    onChoose,
    onKeydown,
    onRun,
    onDelete,
    onLinkTask,
    onOpenRun,
    onResume,
  }: {
    plan: string;
    label: string;
    active: boolean;
    progress: PlanProgress | null | undefined;
    owner?: string | null;
    linkTargets?: readonly TaskFieldOption[];
    runs?: readonly PlanRun[];
    actionsDisabled?: boolean;
    runDisabled?: boolean;
    onChoose: (path: string) => void;
    onKeydown: (event: KeyboardEvent) => void;
    onRun: (path: string) => void;
    onDelete: (path: string) => void;
    onLinkTask?: (taskId: string, path: string) => void;
    onOpenRun?: (sessionId: string) => void;
    onResume?: (path: string) => void;
  } = $props();

  const slash = $derived(label.lastIndexOf("/"));
  const shownRuns = $derived(runs.slice(0, RUN_LIMIT));
  // Only the newest run can be resumed, and never while another run is active.
  const resumable = $derived(Boolean(onResume && runs[0] && planRunResumable(runs[0].status)
    && !runs.some((run) => run.status === "running")));
  const STATUS_LABEL: Record<PlanRunStatus, string> = {
    running: "Running", done: "Done", failed: "Failed", interrupted: "Interrupted",
  };

  function runTime(launchedAt: number): string {
    return new Date(launchedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
</script>

<div class={["min-w-0 rounded-sm border-l-2 hover:bg-sidebar-accent", active ? "border-l-primary bg-sidebar-accent text-foreground" : "border-l-transparent text-muted-foreground"]} data-plan-row={plan}>
  <div class="flex min-w-0 items-start gap-1">
    <button
      class="flex min-w-0 flex-1 items-start gap-2 overflow-hidden rounded-sm px-2 py-1.5 text-left focus-visible:outline-2 focus-visible:outline-ring"
      type="button"
      data-plan-path={plan}
      aria-current={active ? "page" : undefined}
      title={plan}
      onclick={() => onChoose(plan)}
      onkeydown={onKeydown}
    >
      <FileText class="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span class="flex min-w-0 flex-1 flex-col gap-0.5 overflow-hidden">
        <span class="break-words text-xs font-medium text-foreground [overflow-wrap:anywhere]">{label.slice(slash + 1)}</span>
        {#if slash >= 0}<span class="break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">{label.slice(0, slash)}</span>{/if}
        <span class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <PlanProgressIndicator {progress} />
          {#if owner}
            <span class="flex min-w-0 items-center gap-1" data-plan-owner>
              <ListTodo class="h-3 w-3 shrink-0" aria-hidden="true" />
              <span class="truncate">{owner}</span>
            </span>
          {/if}
        </span>
      </span>
    </button>
    <div class="flex shrink-0 items-center gap-0.5 pt-1 pr-1">
      <button class={iconButtonClass("sm", "chrome")} type="button" title="Run plan in a new session"
        aria-label={`Run plan ${label}`} disabled={actionsDisabled || runDisabled} onclick={() => onRun(plan)}>
        <Play class="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <button class={iconButtonClass("sm", "chrome", { extra: "hover:text-destructive" })} type="button" title="Delete plan"
        aria-label={`Delete plan ${label}`} disabled={actionsDisabled} onclick={() => onDelete(plan)}>
        <Trash2 class="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  </div>
  {#if !owner && onLinkTask && linkTargets.length > 0}
    <div class="px-2 pb-1.5 pl-7" data-plan-link>
      <TaskFieldSelect
        value=""
        options={linkTargets}
        onChange={(taskId) => onLinkTask(taskId, plan)}
        ariaLabel={`Link plan ${label} to task`}
        placeholder="Link to task"
        searchable
        size="xs"
        variant="ghost"
        popupMinWidth={220}
        disabled={actionsDisabled}
      />
    </div>
  {/if}
  {#if shownRuns.length > 0 && onOpenRun}
    <ul class="px-2 pb-1.5 pl-7" aria-label={`Runs of ${label}`} data-plan-runs>
      {#each shownRuns as run (run.sessionId)}
        <li>
          <button
            class="flex w-full min-w-0 items-center gap-1.5 rounded-sm px-1 py-0.5 text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            type="button"
            data-plan-run={run.sessionId}
            title={`Open run (${STATUS_LABEL[run.status]}): ${run.title}`}
            onclick={() => onOpenRun(run.sessionId)}
          >
            <span class="flex shrink-0" data-plan-run-status={run.status} title={STATUS_LABEL[run.status]}>
              {#if run.status === "running"}
                <LoaderCircle class="h-3 w-3 animate-spin" aria-hidden="true" />
              {:else if run.status === "done"}
                <CircleCheck class="h-3 w-3 text-tool-success" aria-hidden="true" />
              {:else if run.status === "failed"}
                <CircleX class="h-3 w-3 text-tool-error" aria-hidden="true" />
              {:else}
                <CirclePause class="h-3 w-3 text-tool-warning" aria-hidden="true" />
              {/if}
              <span class="sr-only">{STATUS_LABEL[run.status]}:</span>
            </span>
            <span class="min-w-0 flex-1 truncate">{run.title}</span>
            <span class="shrink-0 tabular-nums">{runTime(run.launchedAt)}</span>
          </button>
        </li>
      {/each}
      {#if resumable}
        <li>
          <button
            class="flex items-center gap-1 rounded-sm px-1 py-0.5 text-xs text-foreground hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
            type="button"
            data-plan-resume
            title="Resume the plan from the first unchecked item in a new session"
            aria-label={`Resume plan ${label}`}
            disabled={actionsDisabled || runDisabled}
            onclick={() => onResume?.(plan)}
          >
            <RotateCcw class="h-3 w-3 shrink-0" aria-hidden="true" />
            Resume
          </button>
        </li>
      {/if}
      {#if runs.length > RUN_LIMIT}
        <li class="px-1 py-0.5 text-xs text-muted-foreground">+{runs.length - RUN_LIMIT} earlier</li>
      {/if}
    </ul>
  {/if}
</div>
