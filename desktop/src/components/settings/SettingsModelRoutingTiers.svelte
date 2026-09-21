<script lang="ts">
  import Plus from "@lucide/svelte/icons/plus";
  import X from "@lucide/svelte/icons/x";
  import type { ModelThinkingModel } from "../../lib/model-thinking";
  import SettingsModelSelect from "./SettingsModelSelect.svelte";
  import SettingsSelect from "./SettingsSelect.svelte";
  import SettingsTextInput from "./SettingsTextInput.svelte";

  export type ModelRoutingTierDraft = {
    id: string;
    description: string;
    modelRef: string;
    thinking: string;
  };

  const THINKING_OPTIONS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
    .map((value) => ({ value, label: value === "xhigh" ? "Extra high" : value[0]!.toUpperCase() + value.slice(1) }));

  let {
    value,
    models,
    onChange,
  }: {
    value: readonly ModelRoutingTierDraft[];
    models: readonly ModelThinkingModel[];
    onChange: (value: ModelRoutingTierDraft[]) => void;
  } = $props();

  function update(index: number, key: keyof ModelRoutingTierDraft, next: string): void {
    onChange(value.map((tier, tierIndex) => tierIndex === index ? { ...tier, [key]: next } : { ...tier }));
  }

  function remove(index: number): void {
    if (value.length <= 1) return;
    onChange(value.filter((_, tierIndex) => tierIndex !== index).map((tier) => ({ ...tier })));
  }

  function add(): void {
    const used = new Set(value.map((tier) => tier.id));
    let counter = value.length + 1;
    let id = `tier-${counter}`;
    while (used.has(id)) id = `tier-${++counter}`;
    onChange([
      ...value.map((tier) => ({ ...tier })),
      {
        id,
        description: "Describe when the router should use this tier.",
        modelRef: models[0]?.ref ?? "",
        thinking: "medium",
      },
    ]);
  }
</script>

<div class="space-y-2">
  {#each value as tier, index (`${tier.id}:${index}`)}
    <div class="rounded-md border border-border bg-panel-strong p-2">
      <div class="grid grid-cols-[minmax(90px,0.7fr)_minmax(0,1.5fr)_28px] gap-1.5">
        <SettingsTextInput
          value={tier.id}
          placeholder="semantic id"
          onChange={(next) => update(index, "id", next.toLowerCase().replace(/[^a-z0-9_-]+/gu, "-"))}
        />
        <SettingsTextInput
          value={tier.description}
          placeholder="When should the router use this tier?"
          onChange={(next) => update(index, "description", next)}
        />
        <button
          class="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:cursor-default disabled:opacity-30"
          type="button"
          title="Remove routing tier"
          aria-label={`Remove ${tier.id || "routing"} tier`}
          disabled={value.length <= 1}
          onclick={() => remove(index)}
        ><X class="h-3.5 w-3.5" aria-hidden="true" /></button>
      </div>
      <div class="mt-1.5 grid grid-cols-[minmax(0,1fr)_120px] gap-1.5">
        <SettingsModelSelect
          value={tier.modelRef}
          {models}
          ariaLabel={`${tier.id || "Routing tier"} model`}
          onChange={(next) => update(index, "modelRef", next)}
        />
        <SettingsSelect
          value={tier.thinking}
          options={THINKING_OPTIONS}
          ariaLabel={`${tier.id || "Routing tier"} thinking`}
          onChange={(next) => update(index, "thinking", next)}
        />
      </div>
    </div>
  {/each}

  <button
    class="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
    type="button"
    onclick={add}
  ><Plus class="h-3.5 w-3.5" aria-hidden="true" />Add tier</button>
</div>
