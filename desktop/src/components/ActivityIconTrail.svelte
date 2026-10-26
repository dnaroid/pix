<script lang="ts">
  import { onMount } from "svelte";
  import { ACTIVITY_ICON_PITCH, activityIconWindow } from "../lib/activity-icon-window";
  import { activityIcon } from "../lib/tool-icons";
  import { activityGroupPresentationLabels } from "../lib/transcript-presentation";
  import type { ActivityEntry } from "../lib/transcript";

  let { entries }: { entries: readonly ActivityEntry[] } = $props();
  let viewport: HTMLSpanElement;
  let scrollLeft = $state(0);
  let viewportWidth = $state(1000);
  const labels = $derived(activityGroupPresentationLabels(entries));
  const accessibleLabel = $derived(labels.join(", "));
  const window = $derived(activityIconWindow(entries.length, scrollLeft, viewportWidth));
  const visibleEntries = $derived(entries.slice(window.start, window.end));
  const totalWidth = $derived(Math.max(0, entries.length * ACTIVITY_ICON_PITCH - 2));

  onMount(() => {
    const observer = new ResizeObserver(() => { viewportWidth = viewport.clientWidth; });
    observer.observe(viewport);
    viewportWidth = viewport.clientWidth;
    return () => observer.disconnect();
  });
</script>

<span
  bind:this={viewport}
  class="activity-icon-trail block h-4 min-w-0 overflow-x-auto text-muted-foreground/45"
  onscroll={() => { scrollLeft = viewport.scrollLeft; }}
>
  <span class="sr-only">{accessibleLabel}</span>
  <span class="relative block h-4" style:width={`${totalWidth}px`} aria-hidden="true">
    <span class="absolute inset-y-0 left-0 flex items-center gap-0.5" style:transform={`translateX(${window.start * ACTIVITY_ICON_PITCH}px)`}>
      {#each visibleEntries as entry, index (entry.id)}
        {@const label = labels[window.start + index] ?? "tool"}
        {@const Icon = activityIcon(label, entry.type === "tool" && entry.imageRead)}
        <span data-activity-name={label} class="flex shrink-0 items-center" title={label} data-activity-icon-id={entry.id}>
          <Icon class="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      {/each}
    </span>
  </span>
</span>

<style>
  .activity-icon-trail { scrollbar-width: none; }
  .activity-icon-trail::-webkit-scrollbar { display: none; }
</style>
