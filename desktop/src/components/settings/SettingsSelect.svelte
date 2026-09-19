<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";

  export type SettingsSelectOption = { value: string; label: string };

  let {
    value,
    options,
    onChange,
  }: {
    value: string;
    options: readonly SettingsSelectOption[];
    onChange: (value: string) => void;
  } = $props();

  const configuredOnly = $derived(value.length > 0 && !options.some((option) => option.value === value));
</script>

<div class="relative">
  <select
    class="h-7 w-full cursor-pointer appearance-none rounded-md border border-input bg-panel-strong py-0 pr-7 pl-2 text-xs text-foreground outline-none hover:bg-panel-hover focus-visible:ring-2 focus-visible:ring-ring/30"
    {value}
    onchange={(event) => onChange((event.currentTarget as HTMLSelectElement).value)}
  >
    {#if configuredOnly}<option value={value}>{value} · Configured</option>{/if}
    {#each options as option (option.value)}
      <option value={option.value}>{option.label}</option>
    {/each}
  </select>
  <ChevronDown class="pointer-events-none absolute top-1/2 right-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
</div>
