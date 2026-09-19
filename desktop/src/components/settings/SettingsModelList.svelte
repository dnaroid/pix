<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import X from "@lucide/svelte/icons/x";
  import type { ModelThinkingModel } from "../../lib/model-thinking";
  import SettingsModelSelect from "./SettingsModelSelect.svelte";

  let {
    value,
    models,
    onChange,
    addLabel = "Add model",
  }: {
    value: readonly string[];
    models: readonly ModelThinkingModel[];
    onChange: (value: string[]) => void;
    addLabel?: string;
  } = $props();

  let addValue = $state("");
  const availableToAdd = $derived(models.filter((model) => !value.includes(model.ref)));

  function updateAt(index: number, next: string): void {
    const copy = [...value];
    copy[index] = next;
    onChange(copy);
  }

  function removeAt(index: number): void {
    onChange(value.filter((_item, itemIndex) => itemIndex !== index));
  }

  function add(next: string): void {
    if (!next || value.includes(next)) return;
    onChange([...value, next]);
    addValue = "";
  }
</script>

<div class="space-y-1.5">
  {#each value as modelRef, index (index)}
    <div class="flex items-start gap-1.5">
      <div class="min-w-0 flex-1">
        <SettingsModelSelect value={modelRef} {models} ariaLabel={`Model ${index + 1}`} onChange={(next) => updateAt(index, next)} />
      </div>
      <button
        class="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-md border border-transparent text-muted-foreground hover:border-border hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        type="button"
        aria-label={`Remove model ${index + 1}`}
        title="Remove"
        onclick={() => removeAt(index)}
      ><X class="h-3.5 w-3.5" aria-hidden="true" /></button>
    </div>
  {/each}
  <div class="relative">
    <select
      class="h-7 w-full cursor-pointer appearance-none rounded-md border border-border bg-panel px-2 pr-7 text-xs text-muted-foreground outline-none hover:bg-panel-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-default disabled:opacity-40"
      bind:value={addValue}
      disabled={availableToAdd.length === 0}
      aria-label={addLabel}
      onchange={(event) => add((event.currentTarget as HTMLSelectElement).value)}
    >
      <option value="">+ {availableToAdd.length > 0 ? `${addLabel}…` : "No additional models"}</option>
      {#each availableToAdd as model (model.ref)}
        <option value={model.ref}>{model.name} · {model.ref}</option>
      {/each}
    </select>
    <ChevronDown class="pointer-events-none absolute top-1/2 right-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
  </div>
</div>
