<script lang="ts">
  import { tick } from "svelte";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import type { SearchIndexEvent } from "../lib/search-index-history";
  import { createHistoryScrollTracker } from "../lib/index-history-scroll";
  let { events, onClear }: { events: readonly SearchIndexEvent[]; onClear?: () => void } = $props();
  let viewport: HTMLDivElement | undefined = $state();
  let content: HTMLOListElement | undefined = $state();
  const scroll = $derived(viewport ? createHistoryScrollTracker(viewport) : undefined);
  const labels = { system: "System", code: "Code", knowledge: "Knowledge", settings: "Settings", tasks: "Tasks", sessions: "Sessions", commits: "Git commits" };

  function trackScroll() {
    scroll?.handleScroll();
  }

  $effect.pre(() => {
    events;
    const tracker = scroll;
    if (!tracker) return;
    const position = tracker.capture();
    let active = true;
    void tick().then(() => {
      if (active) tracker.restore(position);
    });
    return () => { active = false; };
  });

  $effect(() => {
    const node = viewport;
    const list = content;
    const tracker = scroll;
    if (!node || !tracker) return;
    let active = true;
    const resize = new ResizeObserver(() => {
      if (active) tracker.resize();
    });
    resize.observe(node);
    if (list) resize.observe(list);
    return () => { active = false; resize.disconnect(); };
  });
</script>

<section aria-label="Index activity history" class="mt-2 flex min-h-32 min-w-0 flex-1 flex-col border-t border-sidebar-border pt-2">
  <div class="mb-2 flex shrink-0 items-center gap-2">
    <h3 class="flex-1 text-xs font-medium">Activity</h3>
    <span class="text-xs font-normal text-muted-foreground">{events.length}/200</span>
    <button type="button" aria-label="Clear index activity log" title="Clear index activity log"
      class="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
      disabled={!onClear || events.length === 0} onclick={onClear}>
      <Trash2 class="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  </div>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (scrollable history needs keyboard scrolling) -->
  <div bind:this={viewport} onscroll={trackScroll} class="select-text min-h-0 flex-1 overflow-y-auto rounded bg-panel p-2 font-mono text-xs leading-4 [overflow-anchor:none]" role="region" aria-label="Recent index events" tabindex="0">
    {#if events.length === 0}<p class="text-muted-foreground">No events yet</p>{/if}
    <ol bind:this={content} class="space-y-1">
      {#each events as event (event.id)}
        <li data-event-id={event.id} class="break-words" class:text-tool-error={event.level === "error"} class:text-tool-warning={event.level === "warning"}>
          <time class="text-muted-foreground" datetime={new Date(event.time).toISOString()} title={new Date(event.time).toLocaleString()}>{new Date(event.time).toLocaleTimeString()}</time>
          <span class="text-muted-foreground"> · {labels[event.source]} · </span>{event.message}
        </li>
      {/each}
    </ol>
  </div>
</section>
