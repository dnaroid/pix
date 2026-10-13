<script lang="ts">
  let { progress }: { progress: { readonly completed: number; readonly total: number } | undefined } = $props();
</script>

{#if progress && progress.total > progress.completed}
  <span class="inline-flex shrink-0 items-center gap-1 font-mono text-xs tabular-nums text-muted-foreground" aria-label={`Plan ${progress.completed}/${progress.total}`} data-session-subagent-todo-progress>
    <svg class="h-3.5 w-3.5 shrink-0 -rotate-90" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle class="text-muted-foreground/25" cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" />
      <circle class="text-tool-info" cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" pathLength="100" stroke-dasharray="100" stroke-dashoffset={100 - (progress.completed / progress.total) * 100} />
    </svg>
    <span>{progress.completed}/{progress.total}</span>
  </span>
{/if}
