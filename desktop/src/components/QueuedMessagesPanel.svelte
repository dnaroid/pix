<script lang="ts">
  import Hourglass from "@lucide/svelte/icons/hourglass";
  import Pause from "@lucide/svelte/icons/pause";
  import Pencil from "@lucide/svelte/icons/pencil";
  import Play from "@lucide/svelte/icons/play";
  import X from "@lucide/svelte/icons/x";
  import type { QueueAction, QueueItem } from "../lib/acp-client";

  let {
    items,
    disabled = false,
    onAction,
  }: {
    items: readonly QueueItem[];
    disabled?: boolean;
    onAction: (item: QueueItem, action: QueueAction) => void;
  } = $props();

  function label(item: QueueItem): string {
    if (item.source === "deferred") return "paused";
    if (item.source === "auto") return "waiting";
    if (item.source === "sdk-follow-up") return "follow-up";
    return "steering";
  }

  function imageCount(item: QueueItem): number {
    return item.message?.images.length ?? 0;
  }
</script>

{#if items.length > 0}
  <section class="mb-2 flex max-h-44 flex-col gap-2 overflow-y-auto" aria-label="Queued messages">
    {#each items as item (item.id)}
      <article class="group flex min-h-9 shrink-0 items-center gap-2 rounded-md border border-input bg-panel-strong px-2 py-1.5" aria-label={label(item)}>
        {#if item.source === "deferred"}
          <span class="grid h-5 w-5 shrink-0 place-items-center rounded-sm bg-tool-info/10 text-tool-info" aria-hidden="true">
            <Pause class="h-3.5 w-3.5" />
          </span>
        {:else}
          <span class="grid h-5 w-5 shrink-0 place-items-center rounded-sm bg-tool-warning/10 text-tool-warning" aria-hidden="true">
            <Hourglass class="h-3.5 w-3.5" />
          </span>
        {/if}
        <div class="min-w-0 flex-1">
          <div class="flex min-w-0 items-baseline gap-2">
            {#if item.source === "auto" || item.source === "sdk-follow-up"}
              <span class="shrink-0 font-mono text-xs font-medium uppercase tracking-[0.06em] text-muted-foreground">{label(item)}</span>
            {/if}
            <span class="truncate text-xs text-foreground" title={item.text}>{item.text || "(image message)"}</span>
            {#if imageCount(item) > 0}<span class="shrink-0 text-xs text-muted-foreground">+{imageCount(item)} image{imageCount(item) === 1 ? "" : "s"}</span>{/if}
          </div>
        </div>
        <div class="grid w-23 shrink-0 grid-cols-3 items-center gap-1 opacity-65 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <button
            class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-35"
            type="button"
            title="Send immediately"
            aria-label="Send queued message immediately"
            disabled={disabled}
            onclick={() => onAction(item, "send-now")}
          ><Play class="h-3.5 w-3.5" aria-hidden="true" /></button>
          <button
            class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-35"
            type="button"
            title="Move to editor"
            aria-label="Edit queued message"
            disabled={disabled}
            onclick={() => onAction(item, "edit")}
          ><Pencil class="h-3.5 w-3.5" aria-hidden="true" /></button>
          <button
            class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-destructive focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-35"
            type="button"
            title="Cancel queued message"
            aria-label="Cancel queued message"
            disabled={disabled}
            onclick={() => onAction(item, "cancel")}
          ><X class="h-3.5 w-3.5" aria-hidden="true" /></button>
        </div>
      </article>
    {/each}
  </section>
{/if}
