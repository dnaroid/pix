<script lang="ts">
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import type { Snippet } from "svelte";

  let { title, open = true, children }: { title: string; open?: boolean; children: Snippet } = $props();
</script>

<details class="group border-t border-sidebar-border" {open}>
  <summary class="flex h-8 cursor-default list-none items-center gap-1.5 px-3 text-xs font-medium text-muted-foreground hover:bg-panel-hover hover:text-foreground focus-visible:-outline-offset-2 [&::-webkit-details-marker]:hidden">
    <ChevronRight class="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
    <span class="min-w-0 truncate">{title}</span>
  </summary>
  <div class="px-3 pt-1 pb-3">{@render children()}</div>
</details>
