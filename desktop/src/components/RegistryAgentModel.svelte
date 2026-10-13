<script lang="ts">
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import SettingsModelSelect from "./settings/SettingsModelSelect.svelte";
  import type { ModelThinkingModel } from "../lib/model-thinking";
  import type { RegistryActionRequest, RegistryItem } from "../lib/registry";

  let { item, models, disabled, onAction }: {
    item: RegistryItem;
    models: readonly ModelThinkingModel[];
    disabled: boolean;
    onAction: (request: RegistryActionRequest, actionId: string) => void;
  } = $props();

  const choices = $derived(models.filter((model) => model.ref !== "pix:auto"));
  const state = $derived(item.agentModel);

  function choose(model: string): void {
    if (!state || disabled || model === (state.override ?? state.original)) return;
    onAction({ action: "set-agent-model", type: "agent", name: item.name, model }, `${item.id}:set-agent-model`);
  }
</script>

{#if item.type === "agent" && item.local && state}
  <div class="min-w-0 space-y-1" data-registry-row="model">
    <div class="flex min-w-0 items-center justify-between gap-2 text-xs text-muted-foreground">
      <span title="Project-local choice for new launches. Fallback candidates and role policies still apply.">Model · new launches</span>
      {#if state.override}<span class="shrink-0">Override</span>{/if}
    </div>
    <div class="flex min-w-0 items-start gap-1">
      <div class="min-w-0 flex-1">
        <SettingsModelSelect value={state.override ?? state.original} models={choices} {disabled}
          ariaLabel={`Model for agent ${item.name}`} onChange={choose} />
      </div>
      <button type="button" class="ui-button ui-button-ghost h-7 w-7 shrink-0 p-0"
        disabled={disabled || !state.override}
        aria-label={`Reset model for agent ${item.name}`}
        title={state.parentAware ? "Reset to the current parent-aware profile and its fallback candidates" : `Reset to profile: ${state.original}`}
        onclick={() => onAction({ action: "reset-agent-model", type: "agent", name: item.name }, `${item.id}:reset-agent-model`)}>
        <RotateCcw class="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
    {#if state.parentAware && !state.override}
      <p class="text-xs text-muted-foreground">Profile varies by parent model</p>
    {/if}
  </div>
{/if}
