<script lang="ts">
  import FileCheck2 from "@lucide/svelte/icons/file-check-2";
  import { onMount } from "svelte";
  import { createProjectFilesRefresh } from "../lib/project-files-refresh";
  import { projectDocumentLabel, type PlanProgress } from "../lib/project-documents";
  import type { PlanRunStatus } from "../lib/plan-launches";
  import PlanProgressIndicator from "./PlanProgressIndicator.svelte";
  import StatusBarPopover from "./StatusBarPopover.svelte";

  let { plan, onOpen = () => {}, onRefresh, onResume, resumeDisabled = false }: {
    plan: { path: string; progress: PlanProgress | null; task?: string; status?: PlanRunStatus; resumable?: boolean };
    onOpen?: (path: string) => void;
    onRefresh?: () => Promise<void>;
    onResume?: (path: string) => void;
    resumeDisabled?: boolean;
  } = $props();

  const STATUS_LABEL: Record<PlanRunStatus, string> = {
    running: "Running", done: "Done", failed: "Failed", interrupted: "Interrupted",
  };
  const heading = $derived(plan.status && plan.status !== "running" ? "Plan run" : "Executing plan");

  const label = $derived(projectDocumentLabel(plan.path));
  const counts = $derived(plan.progress && plan.progress.total > 0 ? `${plan.progress.completed}/${plan.progress.total}` : undefined);
  // Keep saved checklist progress fresh only while this chip is mounted in the foreground.
  onMount(() => onRefresh ? createProjectFilesRefresh(() => onRefresh(), undefined, 3_000).dispose : undefined);
</script>

<StatusBarPopover label="Executing plan">
  {#snippet trigger({ open, toggle, id })}
    <button
      class="flex h-6 items-center gap-1 rounded-sm bg-transparent px-1.5 text-muted-foreground transition-colors hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
      type="button"
      aria-label={`${heading} ${label}${plan.status ? `, ${STATUS_LABEL[plan.status]}` : ""}${counts ? `, ${counts} checklist items` : ""}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={id}
      data-session-plan-status
      onclick={toggle}
    >
      {#if plan.progress && plan.progress.total > 0}
        <PlanProgressIndicator progress={plan.progress} />
      {:else}
        <FileCheck2 class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <PlanProgressIndicator progress={plan.progress} />
      {/if}
    </button>
  {/snippet}
  {#snippet children()}
    <div class="flex w-72 flex-col gap-2 rounded-md border border-border bg-popover px-2.5 py-2 text-popover-foreground shadow-md" data-session-plan-tooltip>
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{heading}</span>
        {#if plan.status}
          <span class={["text-xs font-medium", plan.status === "done" ? "text-tool-success" : plan.status === "failed" ? "text-tool-error" : plan.status === "interrupted" ? "text-tool-warning" : "text-muted-foreground"]} data-session-plan-run-status={plan.status}>{STATUS_LABEL[plan.status]}</span>
        {/if}
      </div>
      <nav class="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground" aria-label="Plan context" data-session-plan-breadcrumbs>
        {#if plan.task}<span class="max-w-full truncate" data-breadcrumb-task>{plan.task}</span><span aria-hidden="true">›</span>{/if}
        <span class="max-w-full truncate">{label}</span><span aria-hidden="true">›</span>
        <span class="text-foreground" aria-current="page">This session</span>
      </nav>
      <div class="flex min-w-0 items-start gap-2">
        <FileCheck2 class="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span class="min-w-0 flex-1 break-words text-xs font-medium text-foreground">{label}</span>
        <PlanProgressIndicator progress={plan.progress} />
      </div>
      <p class="text-xs leading-4 text-muted-foreground">Progress counts saved checklist items in the plan file. Steps show the agent's live session checklist.</p>
      <div class="flex flex-wrap items-center gap-1.5">
        <button
          class="rounded-sm border border-border px-2 py-1 text-xs text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring"
          type="button"
          onclick={() => onOpen(plan.path)}
        >Open plan</button>
        {#if plan.resumable && onResume}
          <button
            class="rounded-sm border border-border px-2 py-1 text-xs text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
            type="button"
            data-session-plan-resume
            aria-label="Resume the plan from the first unchecked item in a new session"
            disabled={resumeDisabled}
            onclick={() => onResume(plan.path)}
          >Resume in new session</button>
        {/if}
      </div>
    </div>
  {/snippet}
</StatusBarPopover>
