<script lang="ts">
  import Pause from "@lucide/svelte/icons/pause";
  import Play from "@lucide/svelte/icons/play";
  import Radar from "@lucide/svelte/icons/radar";
  import type { SupervisorMandateResponse } from "../../../acp/src/acp/supervisor-contract";

  let { mandate, saving, onSetUp, onEdit, onPause }: {
    /** Null while the first read is in flight or failed. */
    mandate: SupervisorMandateResponse | null;
    saving: boolean;
    onSetUp: () => void;
    onEdit: () => void;
    onPause: (paused: boolean) => void;
  } = $props();

  const state = $derived(!mandate ? "Loading…" : !mandate.enabled ? "Off" : mandate.paused ? "Paused" : "Active");
  const budget = $derived(mandate?.budgetTokens === undefined ? "no limit"
    : `${mandate.budgetUsedTokens?.toLocaleString() ?? "unavailable"} / ${mandate.budgetTokens.toLocaleString()} tokens`);
  const actionClass = "inline-flex h-6 items-center gap-1 rounded-sm px-2 text-foreground transition-colors hover:bg-panel-hover disabled:opacity-40";
</script>

<div class="flex min-h-8 items-center gap-2.5 border-b border-border bg-panel py-1 pr-2 pl-3 text-xs text-muted-foreground"
  role="region" aria-label="Project supervisor mandate" data-supervisor-mandate-bar>
  <Radar class="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
  <span class="shrink-0 text-foreground">Supervisor</span>
  <span class="shrink-0" role="status" data-supervisor-state>{state}</span>
  {#if mandate}
    <span class="min-w-0 flex-1 truncate font-mono tabular-nums" data-supervisor-counters
      title="Running managed sessions out of the parallel limit; managed and taken-back sessions; rework rounds used">
      running {mandate.running}/{mandate.maxConcurrent} · managed {mandate.managed}{#if mandate.manual} · taken back {mandate.manual}{/if}
      · rework {mandate.reworkRounds} (max {mandate.maxReworkRounds}/item)
    </span>
    <span class="shrink-0 font-mono tabular-nums" title="All tokens over the last 24 hours">budget: {budget}</span>
    {#if mandate.budgetHeld}
      <span class="shrink-0 text-foreground" role="status">Budget hold</span>
    {/if}
    {#if !mandate.enabled}
      <button type="button" class={actionClass} disabled={saving} onclick={onSetUp}>Set up</button>
    {:else}
      <button type="button" class={actionClass} disabled={saving} onclick={() => onPause(!mandate.paused)}>
        {#if mandate.paused}
          <Play class="h-3 w-3" aria-hidden="true" /> Resume
        {:else}
          <Pause class="h-3 w-3" aria-hidden="true" /> Pause
        {/if}
      </button>
      {#if mandate.budgetHeld && !mandate.paused}
        <button type="button" class={actionClass} disabled={saving || mandate.budgetUsedTokens === undefined || mandate.budgetUsedTokens >= (mandate.budgetTokens ?? 0)}
          onclick={() => onPause(false)}>
          <Play class="h-3 w-3" aria-hidden="true" /> Resume wakes
        </button>
      {/if}
      <button type="button" class={actionClass} disabled={saving} onclick={onEdit}>Edit mandate</button>
    {/if}
  {:else}
    <span class="flex-1"></span>
  {/if}
</div>
