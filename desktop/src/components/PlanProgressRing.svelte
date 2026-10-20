<script lang="ts">
  import type { PlanProgress } from "../lib/project-documents";

  let { progress }: { progress?: PlanProgress | null } = $props();
  const RADIUS = 5;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
  const ratio = $derived(progress?.total ? Math.min(1, Math.max(0, progress.completed / progress.total)) : 0);
  const done = $derived(Boolean(progress?.total && progress.completed >= progress.total));
</script>

{#if progress && progress.total > 0}
  <span
    class="inline-flex shrink-0 items-center gap-1 font-mono text-xs tabular-nums text-muted-foreground"
    role="progressbar"
    aria-label="Plan checklist progress"
    aria-valuemin={0}
    aria-valuemax={progress.total}
    aria-valuenow={progress.completed}
    aria-valuetext={`${progress.completed} of ${progress.total} checklist items completed`}
    title={`${progress.completed} of ${progress.total} checklist items completed`}
    data-plan-progress-ring
  >
    <svg class="h-3.5 w-3.5 shrink-0 -rotate-90" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r={RADIUS} fill="none" stroke="currentColor" stroke-width="2" class="opacity-25" />
      <circle cx="7" cy="7" r={RADIUS} fill="none" stroke-width="2" stroke-linecap="round"
        class={done ? "stroke-tool-success" : "stroke-primary"}
        stroke-dasharray={CIRCUMFERENCE} stroke-dashoffset={CIRCUMFERENCE * (1 - ratio)} />
    </svg>
    <span>{progress.completed}/{progress.total}</span>
  </span>
{:else}
  <span class="inline-flex shrink-0 items-center px-1 text-xs text-muted-foreground"
    aria-label={progress ? "No checklist items" : "Checklist progress unavailable"}>—</span>
{/if}
