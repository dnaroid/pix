<script lang="ts">
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import { getContext, type Snippet } from "svelte";
  import { USAGE_SECTIONS_CONTEXT, type UsageSectionId } from "../../lib/usage-panel-sections";
  import type { UsagePanelSections } from "../../app/usage-panel-sections.svelte";

  let { title, sectionId, open = true, loading = false, children }: { title: string; sectionId?: UsageSectionId; open?: boolean; loading?: boolean; children: Snippet } = $props();
  let localOpen = $state<boolean | undefined>(undefined);
  const sections = getContext<UsagePanelSections | undefined>(USAGE_SECTIONS_CONTEXT);
  const expanded = $derived(sectionId && sections ? sections.isOpen(sectionId) : localOpen ?? open);

  function toggle(event: MouseEvent): void {
    // Commit user intent synchronously; native toggle events also fire on restoration/rendering.
    event.preventDefault();
    if (sectionId && sections) void sections.setOpen(sectionId, !expanded);
    else localOpen = !expanded;
  }
</script>

<details class="group border-t border-sidebar-border" open={expanded}>
  <summary onclick={toggle} class="flex h-8 cursor-default list-none items-center gap-1.5 px-3 text-xs font-medium text-muted-foreground hover:bg-panel-hover hover:text-foreground focus-visible:-outline-offset-2 [&::-webkit-details-marker]:hidden">
    <ChevronRight class="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
    <span class="min-w-0 truncate">{title}</span>
    {#if expanded && loading}<RefreshCw class="ml-auto h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none" aria-label="Updating section" />{/if}
  </summary>
  {#if expanded}<div class="px-3 pt-1 pb-3" aria-busy={loading}>{@render children()}</div>{/if}
</details>
