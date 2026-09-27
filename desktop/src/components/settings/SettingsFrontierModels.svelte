<script lang="ts">
  import ArrowDown from "@lucide/svelte/icons/arrow-down";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import X from "@lucide/svelte/icons/x";
  import { tick } from "svelte";
  import type { ModelThinkingModel } from "../../lib/model-thinking";
  import {
    addFrontierModelRow,
    frontierModelRowDetails,
    frontierOraclePreview,
    moveFrontierModelRow,
    removeFrontierModelRow,
    updateFrontierModelRow,
    type FrontierModelRow,
  } from "../../lib/frontier-models-settings";
  import SettingsModelSelect from "./SettingsModelSelect.svelte";

  let {
    value,
    economy,
    models,
    onChange,
  }: {
    value: readonly FrontierModelRow[];
    economy: boolean;
    models: readonly ModelThinkingModel[];
    onChange: (value: FrontierModelRow[]) => void;
  } = $props();

  let root = $state<HTMLDivElement | null>(null);

  const availableToAdd = $derived(models.filter((model) => !value.some((row) => row.model === model.ref)));
  const preview = $derived(frontierOraclePreview(value, economy));

  const iconButtonBase = "grid h-6 w-6 shrink-0 place-items-center rounded-sm text-muted-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:opacity-30";
  const iconButton = `${iconButtonBase} enabled:hover:bg-panel-hover enabled:hover:text-foreground`;
  const removeButton = `${iconButtonBase} hover:bg-destructive/10 hover:text-destructive`;

  async function focusControl(selector: string): Promise<void> {
    await tick();
    root?.querySelector<HTMLElement>(selector)?.focus();
  }

  function move(index: number, delta: -1 | 1): void {
    const model = value[index]?.model;
    const next = moveFrontierModelRow(value, index, delta);
    onChange(next);
    if (!model) return;
    // Keyed rows are re-inserted, which drops focus; keep it on the moved row.
    const targetIndex = index + delta;
    const atEdge = targetIndex === 0 || targetIndex === next.length - 1;
    const direction = atEdge ? (delta === -1 ? "down" : "up") : (delta === -1 ? "up" : "down");
    void focusControl(`[data-frontier-move="${CSS.escape(model)}:${direction}"]`);
  }

  function remove(index: number): void {
    const next = removeFrontierModelRow(value, index);
    onChange(next);
    const neighbor = next[Math.min(index, next.length - 1)];
    void focusControl(neighbor ? `[data-frontier-remove="${CSS.escape(neighbor.model)}"]` : "[data-frontier-add] button");
  }
</script>

<div bind:this={root} class="space-y-2">
  {#if value.length > 0}
    <ol class="divide-y divide-border overflow-hidden rounded-md border border-border bg-panel-strong" aria-label="Frontier models in preference order">
      {#each value as row, index (row.model)}
        <li class="px-1.5 py-1.5">
          <div class="flex items-center gap-1">
            <span class="w-4 shrink-0 text-right font-mono text-xs text-muted-foreground tabular-nums" aria-hidden="true">{index + 1}</span>
            <div class="min-w-0 flex-1">
              <SettingsModelSelect
                value={row.model}
                models={models.filter((model) => model.ref === row.model || !value.some((other) => other.model === model.ref))}
                ariaLabel={`Frontier model ${index + 1}`}
                onChange={(model) => model && onChange(updateFrontierModelRow(value, index, { model }))}
              />
            </div>
            <button
              class={iconButton}
              type="button"
              title="Move up"
              aria-label={`Move ${row.model} up`}
              data-frontier-move={`${row.model}:up`}
              disabled={index === 0}
              onclick={() => move(index, -1)}
            ><ArrowUp class="h-3.5 w-3.5" aria-hidden="true" /></button>
            <button
              class={iconButton}
              type="button"
              title="Move down"
              aria-label={`Move ${row.model} down`}
              data-frontier-move={`${row.model}:down`}
              disabled={index === value.length - 1}
              onclick={() => move(index, 1)}
            ><ArrowDown class="h-3.5 w-3.5" aria-hidden="true" /></button>
            <button
              class={removeButton}
              type="button"
              title="Remove"
              aria-label={`Remove ${row.model}`}
              data-frontier-remove={row.model}
              onclick={() => remove(index)}
            ><X class="h-3.5 w-3.5" aria-hidden="true" /></button>
          </div>
          <div class="mt-1 flex min-w-0 items-center gap-3 pl-5">
            <label class="flex shrink-0 items-center gap-1.5 text-xs text-foreground">
              <input
                class="h-3.5 w-3.5 accent-primary"
                type="checkbox"
                checked={row.expensive}
                onchange={(event) => onChange(updateFrontierModelRow(value, index, { expensive: event.currentTarget.checked }))}
              />Expensive
            </label>
            <label class="flex shrink-0 items-center gap-1.5 text-xs text-foreground">
              <input
                class="h-3.5 w-3.5 accent-primary"
                type="checkbox"
                checked={row.enabled}
                onchange={(event) => onChange(updateFrontierModelRow(value, index, { enabled: event.currentTarget.checked }))}
              />Enabled
            </label>
            {#if !row.enabled}
              <span class="min-w-0 truncate text-xs text-muted-foreground">Not selected</span>
            {:else if economy && row.expensive}
              <span class="min-w-0 truncate text-xs text-tool-warning">Skipped in economy</span>
            {/if}
          </div>
          <p class="mt-0.5 truncate pl-5 font-mono text-xs text-muted-foreground" title={frontierModelRowDetails(row)}>{frontierModelRowDetails(row)}</p>
        </li>
      {/each}
    </ol>
  {:else}
    <p class="text-xs leading-4 text-tool-warning">No frontier models: oracle, frontier-review, and delivery-review cannot be spawned.</p>
  {/if}

  <div data-frontier-add>
    <SettingsModelSelect
      value=""
      models={availableToAdd}
      ariaLabel="Add frontier model"
      emptyLabel={availableToAdd.length > 0 ? "+ Add frontier model…" : "No additional models"}
      disabled={availableToAdd.length === 0}
      onChange={(model) => onChange(addFrontierModelRow(value, model))}
    />
  </div>

  {#if preview.length > 0}
    <div class="rounded-md border border-border px-2 py-1.5">
      <div class="text-xs font-medium text-muted-foreground">Oracle for a frontier parent</div>
      <dl class="mt-1 space-y-0.5">
        {#each preview as item (item.vendor)}
          <div class="flex min-w-0 items-baseline gap-1.5 font-mono text-xs">
            <dt class="shrink-0 text-foreground">{item.parent}<span class="ml-1.5 text-muted-foreground" aria-hidden="true">→</span></dt>
            {#if item.candidates.length > 0}
              <dd class="min-w-0 truncate text-foreground">{item.candidates.join(", ")}</dd>
            {:else}
              <dd class="min-w-0 truncate text-tool-warning">no other-vendor model · oracle hidden</dd>
            {/if}
          </div>
        {/each}
      </dl>
      <p class="mt-1 text-xs leading-4 text-muted-foreground">Other parents get any frontier model, other vendors first. Vendor, aliases, and role limits are edited in Advanced JSONC.</p>
    </div>
  {/if}
</div>
