<script lang="ts">
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
  <SettingsModelSelect
    value=""
    models={availableToAdd}
    ariaLabel={addLabel}
    emptyLabel={availableToAdd.length > 0 ? `+ ${addLabel}…` : "No additional models"}
    disabled={availableToAdd.length === 0}
    onChange={add}
  />
</div>
