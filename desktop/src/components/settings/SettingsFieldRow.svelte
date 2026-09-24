<script lang="ts">
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import type { Snippet } from "svelte";

  let {
    label,
    description,
    defaultLabel,
    explicit = false,
    onReset,
    children,
  }: {
    label: string;
    description?: string;
    defaultLabel?: string;
    explicit?: boolean;
    onReset?: () => void;
    children: Snippet;
  } = $props();
</script>

<div class="group border-b border-sidebar-border/50 px-2.5 py-2.5 last:border-b-0">
  <div class="flex min-w-0 items-start gap-2">
    <div class="min-w-0 flex-1">
      <div class="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        <span class="text-xs font-medium text-foreground">{label}</span>
        {#if !explicit && defaultLabel}
          <span class="text-xs text-muted-foreground">{defaultLabel}</span>
        {/if}
      </div>
      {#if description}
        <p class="mt-0.5 text-xs leading-4 text-muted-foreground">{description}</p>
      {/if}
    </div>
    {#if explicit && onReset}
      <button
        class="grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring group-hover:opacity-100"
        type="button"
        title="Reset to inherited/default value"
        aria-label={`Reset ${label}`}
        onclick={onReset}
      ><RotateCcw class="h-3 w-3" aria-hidden="true" /></button>
    {/if}
  </div>
  <div class="mt-2">{@render children()}</div>
</div>
