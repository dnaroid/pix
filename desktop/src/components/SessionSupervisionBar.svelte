<script lang="ts">
  import Radar from "@lucide/svelte/icons/radar";
  import { supervisionActions, type SupervisionState } from "../lib/session-supervision";

  let { supervision, onSetSupervised }: {
    supervision: SupervisionState;
    onSetSupervised: (supervised: boolean) => void;
  } = $props();

  const actions = $derived(supervisionActions(supervision));
</script>

<!-- Ordinary sessions offer handover only in the context menu, not as a header. -->
{#if supervision.mode && actions.length}
  <div class="flex min-h-8 flex-wrap items-center gap-x-2.5 border-b border-border bg-panel py-1 pr-2 pl-3 text-xs text-muted-foreground">
    <Radar class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
    <span class="flex-1" role="status">
      {supervision.mode === "managed" ? "Supervisor managed" : "Manual control"}
    </span>
    {#each actions as { supervised, label } (supervised)}
      <button type="button"
        class="inline-flex min-h-6 items-center rounded-sm px-2 text-foreground transition-colors hover:bg-panel-hover disabled:opacity-40"
        disabled={!supervision.enabled} onclick={() => onSetSupervised(supervised)}>{label}</button>
    {/each}
  </div>
{/if}
