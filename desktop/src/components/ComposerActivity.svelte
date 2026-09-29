<script lang="ts">
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
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
  <LoaderCircle class="size-3 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
  <span class="min-w-0 truncate">{visible.action}</span>
  {#if visible.moreCount > 0}<span class="shrink-0">+{visible.moreCount} more</span>{/if}
</div>
