<script lang="ts">
  import Crown from "@lucide/svelte/icons/crown";
  import { onMount } from "svelte";
  import { frontierBadges, hasFrontierBadge } from "../lib/frontier-model-badges";

  let { modelRef }: { modelRef: string } = $props();
  onMount(() => { void frontierBadges.refresh(); });
</script>

{#if hasFrontierBadge(modelRef, $frontierBadges)}
  <span class="inline-flex shrink-0 text-tool-warning" role="img" aria-label="Frontier model" title="Frontier model">
    <Crown class="h-3 w-3" aria-hidden="true" />
  </span>
{/if}
