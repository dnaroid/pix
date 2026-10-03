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

  function constantSpeedSweep(node: HTMLElement) {
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) {
        // Travel the visible width plus 12px beyond each edge, at 90px/s.
        node.style.setProperty("--sweep-duration", `${(entry.contentRect.width + 24) / 90}s`);
      }
    });
    observer.observe(node);
    return { destroy: () => observer.disconnect() };
  }
</script>

<div data-composer-activity role="status" class="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
  <span use:constantSpeedSweep class="activity-label min-w-0 truncate" title={visible.action}>{visible.action}</span>
</div>

<style>
  @media (prefers-reduced-motion: no-preference) {
    .activity-label {
      background: linear-gradient(90deg, var(--muted-foreground) calc(50% - 12px), var(--foreground) 50%, var(--muted-foreground) calc(50% + 12px));
      background-size: calc(200% + 24px) 100%;
      background-clip: text;
      -webkit-text-fill-color: transparent;
      animation: activity-sweep var(--sweep-duration, 1.8s) linear infinite;
    }
  }

  @keyframes activity-sweep {
    from { background-position: 100% 0; }
    to { background-position: 0 0; }
  }
</style>
