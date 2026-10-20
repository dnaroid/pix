<script lang="ts">
  import type { PlanProgress } from "../lib/project-documents";

  let { progress }: { progress?: PlanProgress | null } = $props();
  // Saved plan progress uses the same ring as the session Steps HUD; the plan
  // colour (tool-skill) tells them apart. No icon.
  const ratio = $derived(progress?.total ? Math.min(1, Math.max(0, progress.completed / progress.total)) : 0);
</script>

{#if progress && progress.total > 0}
  <span
    class="inline-flex h-6 shrink-0 items-center gap-1 font-mono text-xs tabular-nums text-tool-skill"
    role="progressbar"
    aria-label="Plan checklist progress"
    aria-valuemin={0}
    aria-valuemax={progress.total}
    aria-valuenow={progress.completed}
    aria-valuetext={`${progress.completed} of ${progress.total} checklist items completed`}
    data-plan-checklist-progress
  >
    <svg class="h-3.5 w-3.5 shrink-0 -rotate-90" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle class="text-muted-foreground/25" cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" />
      <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" pathLength="100" stroke-dasharray="100" stroke-dashoffset={100 - ratio * 100} />
    </svg>
    <span>{progress.completed}/{progress.total}</span>
  </span>
{:else}
  <span class="inline-flex h-6 shrink-0 items-center px-1 text-xs text-muted-foreground"
    aria-label={progress ? "No checklist items" : "Checklist progress unavailable"}>—</span>
{/if}
