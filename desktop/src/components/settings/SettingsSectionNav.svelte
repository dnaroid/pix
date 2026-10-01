<script lang="ts">
  import { SETTINGS_GROUPS } from "../../lib/settings-navigation";
  let { visible, active, onChange }: {
    visible: readonly string[];
    active: string;
    onChange: (id: string) => void;
  } = $props();
</script>

<nav aria-label="Settings chapters" class="min-h-0 overflow-y-auto px-1.5 pb-2">
  {#each Object.entries(SETTINGS_GROUPS) as [kind, group]}
    {#if group.sections.some((section) => visible.includes(`${kind}-${section.id}`))}
      <div class="px-1.5 pt-3 pb-1 text-[11px] font-semibold text-muted-foreground">{group.label}</div>
      {#each group.sections as section (section.id)}
        {@const id = `${kind}-${section.id}`}
        {#if visible.includes(id)}
          <button type="button" aria-current={active === id ? "location" : undefined} onclick={() => onChange(id)} class={["block min-h-7 w-full rounded-md border-l-2 px-1.5 py-1 text-left text-xs focus-visible:outline-2 focus-visible:outline-ring", active === id ? "border-primary bg-panel-selected font-medium text-foreground" : "border-transparent text-muted-foreground hover:bg-panel-hover hover:text-foreground"]}>{section.label}</button>
        {/if}
      {/each}
    {/if}
  {/each}
</nav>
