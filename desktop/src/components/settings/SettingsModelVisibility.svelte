<script lang="ts">
  import type { ModelThinkingModel } from "../../lib/model-thinking";
  import SettingsSwitch from "./SettingsSwitch.svelte";

  let {
    explicit,
    value,
    models,
    onChange,
  }: {
    explicit: boolean;
    value: readonly string[];
    models: readonly ModelThinkingModel[];
    onChange: (value: string[] | undefined) => void;
  } = $props();

  const selected = $derived(new Set(value));
  const configuredUnknown = $derived(value.filter((ref) => !models.some((model) => model.ref === ref)));

  function setLimited(limited: boolean): void {
    if (!limited) {
      onChange(undefined);
      return;
    }
    onChange(models.map((model) => model.ref));
  }

  function toggle(ref: string): void {
    const next = new Set(value);
    if (next.has(ref)) next.delete(ref);
    else next.add(ref);
    onChange([...next]);
  }
</script>

<div class="space-y-2">
  <div class="flex items-center justify-between gap-3">
    <div class="min-w-0">
      <div class="text-xs font-medium text-foreground">Limit model picker</div>
      <div class="text-xs leading-4 text-muted-foreground">Off shows every model reported by the current catalog.</div>
    </div>
    <SettingsSwitch value={explicit} disabled={models.length === 0 && !explicit} onChange={setLimited} />
  </div>

  {#if explicit}
    <details class="group rounded-md border border-border bg-panel-strong">
      <summary class="flex h-7 cursor-pointer list-none items-center justify-between px-2 text-xs font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30 [&::-webkit-details-marker]:hidden">
        <span>Choose visible models</span>
        <span class="text-muted-foreground">{value.length} selected</span>
      </summary>
      <div class="border-t border-border px-2 py-1.5">
        {#if models.length === 0}
          <p class="py-1 text-xs leading-4 text-muted-foreground">Model catalog unavailable. Existing configured refs are preserved.</p>
        {:else}
          {#each models as model (model.ref)}
            <label class="flex min-h-7 cursor-pointer items-center gap-2 py-1 text-xs text-foreground">
              <input
                class="h-3.5 w-3.5 accent-primary"
                type="checkbox"
                checked={selected.has(model.ref)}
                onchange={() => toggle(model.ref)}
              />
              <span class="min-w-0 flex-1 truncate">{model.name}</span>
              <span class="max-w-[48%] truncate font-mono text-muted-foreground" title={model.ref}>{model.ref}</span>
            </label>
          {/each}
        {/if}
        {#each configuredUnknown as ref (ref)}
          <label class="flex min-h-7 cursor-pointer items-center gap-2 py-1 text-xs text-foreground">
            <input class="h-3.5 w-3.5 accent-primary" type="checkbox" checked onchange={() => toggle(ref)} />
            <span class="min-w-0 flex-1 truncate font-mono">{ref}</span>
            <span class="text-muted-foreground">configured</span>
          </label>
        {/each}
      </div>
    </details>
  {/if}
</div>
