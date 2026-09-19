<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import type { ModelThinkingModel } from "../../lib/model-thinking";

  let {
    value,
    models,
    onChange,
    ariaLabel = "Model",
    emptyLabel,
  }: {
    value: string;
    models: readonly ModelThinkingModel[];
    onChange: (value: string) => void;
    ariaLabel?: string;
    emptyLabel?: string;
  } = $props();

  const groups = $derived.by(() => {
    const grouped = new Map<string, ModelThinkingModel[]>();
    for (const model of models) {
      const key = model.provider || "Models";
      const list = grouped.get(key) ?? [];
      list.push(model);
      grouped.set(key, list);
    }
    return [...grouped.entries()];
  });
  const configuredOnly = $derived(value.length > 0 && !models.some((model) => model.ref === value));
</script>

<div class="relative">
  <select
    class="h-7 w-full cursor-pointer appearance-none rounded-md border border-input bg-panel-strong py-0 pr-7 pl-2 text-xs text-foreground outline-none hover:bg-panel-hover focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-default disabled:opacity-55"
    {value}
    aria-label={ariaLabel}
    disabled={models.length === 0 && !value && !emptyLabel}
    onchange={(event) => onChange((event.currentTarget as HTMLSelectElement).value)}
  >
    {#if emptyLabel}<option value="">{emptyLabel}</option>{/if}
    {#if configuredOnly}<option value={value}>{value} · Configured</option>{/if}
    {#if models.length === 0 && !value && !emptyLabel}<option value="">Model catalog unavailable</option>{/if}
    {#each groups as [provider, entries] (provider)}
      <optgroup label={provider}>
        {#each entries as model (model.ref)}
          <option value={model.ref}>{model.name} · {model.modelId}</option>
        {/each}
      </optgroup>
    {/each}
  </select>
  <ChevronDown class="pointer-events-none absolute top-1/2 right-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
</div>
