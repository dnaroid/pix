<script lang="ts">
  import type { ComposerActivity } from "../lib/composer-activity";
  import { onDestroy } from "svelte";
  import { createComposerActivityHold } from "../lib/composer-activity-hold";

  let { activity }: { activity: ComposerActivity } = $props();
  let displayed = $state<ComposerActivity>();
  const hold = createComposerActivityHold((value) => { displayed = value; });
  $effect(() => hold.update(activity));
  onDestroy(() => hold.dispose());
  const visible = $derived(displayed ?? activity);
</script>

<div data-composer-activity role="status" class="mb-1.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
  <span class="activity-label min-w-0 truncate">{visible.action}</span>
  {#if visible.moreCount > 0}<span class="shrink-0">+{visible.moreCount} more</span>{/if}
</div>

<style>
  @media (prefers-reduced-motion: no-preference) {
    .activity-label {
      background: linear-gradient(100deg, var(--muted-foreground) 45%, var(--foreground) 50%, var(--muted-foreground) 55%);
      background-size: 220% 100%;
      background-clip: text;
      -webkit-text-fill-color: transparent;
      animation: activity-sweep 1.8s linear infinite;
    }
  }

  @keyframes activity-sweep {
    from { background-position: 100% 0; }
    to { background-position: 0 0; }
  }
</style>
