<script lang="ts">
  import type { ToolsSuiteModuleState } from "../../lib/tools-suite-module-visibility";

  let {
    modules,
    unknownNames,
    onChange,
  }: {
    modules: readonly ToolsSuiteModuleState[];
    unknownNames: readonly string[];
    onChange: (name: string, enabled: boolean) => void;
  } = $props();

  const enabledCount = $derived(modules.filter((module) => module.enabled).length);
</script>

<details class="group rounded-md border border-border bg-panel-strong">
  <summary class="flex min-h-7 cursor-pointer list-none items-center justify-between gap-3 px-2 py-1 text-xs font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30 [&::-webkit-details-marker]:hidden">
    <span>Choose enabled modules</span>
    <span class="shrink-0 text-muted-foreground">{enabledCount}/{modules.length} enabled</span>
  </summary>
  <div class="border-t border-border px-2 py-1.5">
    {#each modules as module (module.name)}
      <label
        class="flex min-h-7 cursor-pointer items-center gap-2 py-1 text-xs text-foreground"
        title={module.description}
      >
        <input
          class="h-3.5 w-3.5 accent-primary"
          type="checkbox"
          checked={module.enabled}
          onchange={(event) => onChange(module.name, (event.currentTarget as HTMLInputElement).checked)}
        />
        <span class="min-w-0 flex-1 font-mono">{module.name}</span>
        {#if !module.defaultEnabled}<span class="shrink-0 text-muted-foreground">off by default</span>{/if}
      </label>
    {/each}
    {#if unknownNames.length > 0}
      <div class="mt-1 border-t border-border pt-1.5 text-xs leading-4 text-muted-foreground">
        Unknown configured names are preserved: <span class="font-mono">{unknownNames.join(", ")}</span>
      </div>
    {/if}
  </div>
</details>
