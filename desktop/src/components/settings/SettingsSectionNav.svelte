<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";

  export type SettingsSectionNavItem = { id: string; label: string };

  let {
    items,
    active,
    onChange,
  }: {
    items: readonly SettingsSectionNavItem[];
    active: string;
    onChange: (id: string) => void;
  } = $props();
</script>

<div class="flex items-center gap-2 border-b border-sidebar-border bg-chrome px-2.5 py-1.5">
  <span class="shrink-0 text-xs font-medium text-muted-foreground">Section</span>
  <div class="relative min-w-0 flex-1">
    <select
      class="h-7 w-full cursor-pointer appearance-none rounded-md border border-input bg-panel-strong py-0 pr-7 pl-2 text-xs font-medium text-foreground outline-none hover:bg-panel-hover focus-visible:ring-2 focus-visible:ring-ring/30"
      value={active}
      aria-label="Settings section"
      onchange={(event) => onChange((event.currentTarget as HTMLSelectElement).value)}
    >
      {#each items as item (item.id)}
        <option value={item.id}>{item.label}</option>
      {/each}
    </select>
    <ChevronDown class="pointer-events-none absolute top-1/2 right-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
  </div>
</div>
