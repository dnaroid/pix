<script lang="ts">
  import FileCheck2 from "@lucide/svelte/icons/file-check-2";
  import type { PlanProgress } from "../lib/project-documents";

  let { progress }: { progress?: PlanProgress | null } = $props();
  // Saved plan files use a document icon + linear bar so they never read as the
  // session Steps ring shown in the status HUD.
  const percent = $derived(progress?.total ? Math.min(100, Math.max(0, (progress.completed / progress.total) * 100)) : 0);
</script>

{#if progress && progress.total > 0}
  <span
    class="inline-flex h-6 shrink-0 items-center gap-1 font-mono text-xs tabular-nums text-muted-foreground"
    role="progressbar"
    aria-label="Plan checklist progress"
    aria-valuemin={0}
    aria-valuemax={progress.total}
    aria-valuenow={progress.completed}
    aria-valuetext={`${progress.completed} of ${progress.total} checklist items completed`}
    data-plan-checklist-progress
  >
    <FileCheck2 class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
    <span class="relative h-[3px] w-6 shrink-0 overflow-hidden rounded-full bg-muted-foreground/25" aria-hidden="true">
      <span class="absolute inset-y-0 left-0 rounded-full bg-tool-success" style:width={`${percent}%`}></span>
    </span>
    <span>{progress.completed}/{progress.total}</span>
  </span>
{:else}
  <span class="inline-flex h-6 shrink-0 items-center px-1 text-xs text-muted-foreground"
    aria-label={progress ? "No checklist items" : "Checklist progress unavailable"}>—</span>
{/if}
